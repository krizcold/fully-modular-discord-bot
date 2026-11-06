import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOwnerMessages, _setOwnerRestFactory, readNewestNotice, waitNonce, noticeEmbed, NOTICE_TITLE, sendOwnerDm,
} from '../../src/utils/ownerMessages';
import { discordError, rateLimitError } from '../helpers/fakeOwnerRest';

// NB5 section 8 test 9 (the read side the chooser needs), over a fake REST.

const BOT = '200000000000000001';
const OWNER = '300000000000000001';
const DM = '400000000000000001';

interface Call { method: 'get' | 'post'; route: string; options: any }

function notice(generation: string, machine = 'M', author = BOT, date = '2026-11-01T10:00:00.000Z') {
  return {
    id: `m${generation}${author}`, author: { id: author }, timestamp: date,
    embeds: [{ title: NOTICE_TITLE, timestamp: date, fields: [{ name: 'Machine', value: machine }, { name: 'Generation', value: generation }] }],
  };
}

function fakeRest(script: { app?: any; pins?: any; recent?: any[]; fail?: Record<string, unknown>; hang?: boolean; latencyMs?: number } = {}) {
  const calls: Call[] = [];
  const built: any[] = [];
  const answer = (route: string, value: unknown, signal: AbortSignal) => {
    const failure = script.fail?.[route];
    if (failure) return Promise.reject(failure);
    if (script.hang) return new Promise(() => undefined);
    if (script.latencyMs === undefined) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), script.latencyMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  };
  const rest = {
    get: (route: string, options: any) => {
      calls.push({ method: 'get', route, options });
      if (route === '/applications/@me') return answer(route, script.app ?? { owner: { id: OWNER }, bot: { id: BOT } }, options.signal);
      if (route.endsWith('/messages/pins')) return answer(route, script.pins ?? { items: [], has_more: false }, options.signal);
      return answer(route, script.recent ?? [], options.signal);
    },
    put: async () => undefined,
    delete: async () => undefined,
    post: (route: string, options: any) => {
      calls.push({ method: 'post', route, options });
      if (route === '/users/@me/channels') return answer(route, { id: DM }, options.signal);
      return answer(route, { id: 'sent', channel_id: DM }, options.signal);
    },
  };
  _setOwnerRestFactory(options => { built.push(options); return rest; });
  return { calls, built };
}

afterEach(() => {
  _setOwnerRestFactory(null);
  _resetOwnerMessages();
});

describe('NB5 decision 8: the owner messages client', () => {
  it('builds the client with retries 0, a 10 s timeout and every rate limit rejected; every request carries a signal', async () => {
    const { calls, built } = fakeRest();
    await readNewestNotice();
    expect(built[0]).toMatchObject({ version: '10', retries: 0, timeout: 10_000 });
    expect(built[0].rejectOnRateLimit()).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options.signal).toBeInstanceOf(AbortSignal);
  });

  it("a 429 (the REST's RateLimitError) fails at once with its retry_after", async () => {
    fakeRest({ fail: { '/applications/@me': rateLimitError(30_000, '/applications/@me') } });
    const read = await readNewestNotice();
    expect(read).toEqual({ kind: 'failed', cause: 'HTTP 429 (rate limited, retry after 30 s)', status: 429, retryAfterMs: 30_000 });
  });

  it('D2: with no budget each request has its own 10 s, so a cold read of four 3 s requests answers', async () => {
    vi.useFakeTimers();
    const timeouts: number[] = [];
    const original = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      timeouts.push(ms);
      const controller = new AbortController();
      setTimeout(() => controller.abort(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), ms);
      return controller.signal;
    }) as typeof AbortSignal.timeout;
    try {
      fakeRest({ latencyMs: 3_000, recent: [notice('2', 'B')] });
      const read = readNewestNotice();
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await read).toMatchObject({ kind: 'notice', generation: 2, machine: 'B' });
      expect(timeouts).toEqual([10_000, 10_000, 10_000, 10_000]);
    } finally {
      AbortSignal.timeout = original;
      vi.useRealTimers();
    }
  });

  it('bounds each signal by the caller budget and sends nothing once it has lapsed', async () => {
    const { calls } = fakeRest();
    const timeouts: number[] = [];
    const original = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => { timeouts.push(ms); return original.call(AbortSignal, ms); }) as typeof AbortSignal.timeout;
    try {
      await readNewestNotice({ budgetMs: 60_000 });
      expect(timeouts[0]).toBe(10_000);
      _resetOwnerMessages();
      timeouts.length = 0;
      await readNewestNotice({ budgetMs: 3_000 });
      expect(timeouts[0]).toBeLessThanOrEqual(3_000);
      expect(timeouts[0]).toBeGreaterThan(2_900);
      _resetOwnerMessages();
      calls.length = 0;
      const lapsed = await readNewestNotice({ budgetMs: 0 });
      expect(lapsed).toMatchObject({ kind: 'failed', cause: 'a timeout' });
      expect(calls).toHaveLength(0);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it('two reads at once send one set of requests; a read of its own does not join', async () => {
    const { calls } = fakeRest();
    await Promise.all([readNewestNotice(), readNewestNotice()]);
    const pins = calls.filter(c => c.route.endsWith('/messages/pins')).length;
    expect(pins).toBe(1);
    await Promise.all([readNewestNotice(), readNewestNotice({ own: true })]);
    expect(calls.filter(c => c.route.endsWith('/messages/pins')).length).toBe(3);
  });

  it('the owner is owner.id, or team.owner_user_id when a team owns the application', async () => {
    const { calls } = fakeRest({ app: { owner: { id: '1' }, team: { owner_user_id: OWNER }, bot: { id: BOT } } });
    await readNewestNotice();
    const dm = calls.find(c => c.route === '/users/@me/channels');
    expect(dm?.options.body).toEqual({ recipient_id: OWNER });
  });

  it('creates the DM channel once and caches the ids', async () => {
    const { calls } = fakeRest();
    await readNewestNotice();
    await readNewestNotice();
    expect(calls.filter(c => c.route === '/users/@me/channels')).toHaveLength(1);
    expect(calls.filter(c => c.route === '/applications/@me')).toHaveLength(1);
  });

  it('a 404 drops the cached ids, so the next read looks the owner up again', async () => {
    fakeRest();
    await readNewestNotice();
    const lost = discordError(404, 10003, 'Unknown Channel');
    fakeRest({ fail: { [`/channels/${DM}/messages/pins`]: lost } });
    expect(await readNewestNotice()).toMatchObject({ kind: 'failed', status: 404 });
    const again = fakeRest();
    await readNewestNotice();
    expect(again.calls.filter(c => c.route === '/applications/@me')).toHaveLength(1);
  });

  it('the notice embed has the title, both fields and the timestamp', () => {
    const embed = noticeEmbed({ machine: 'node-b', generation: 3, date: '2026-11-02T08:00:00.000Z' });
    expect(embed.title).toBe('Main database moved');
    expect(embed.description).toBe('The main database of this bot is now on node-b, since 2026-11-02T08:00:00.000Z. A machine whose database was the main before stays stopped until it rejoins as a live copy.');
    expect(embed.fields).toEqual([{ name: 'Machine', value: 'node-b' }, { name: 'Generation', value: '3' }]);
    expect(embed.timestamp).toBe('2026-11-02T08:00:00.000Z');
  });

  it('ignores another author, a Generation of 0, x or 1.5, and takes the highest across pins and recent messages', async () => {
    fakeRest({
      pins: { items: [{ pinned_at: '2026-11-01T10:00:00.000Z', message: notice('2', 'A') }], has_more: false },
      recent: [notice('9', 'X', '999999999999999999'), notice('0'), notice('x'), notice('1.5'), notice('3', 'B'), notice('1', 'C')],
    });
    expect(await readNewestNotice()).toEqual({ kind: 'notice', generation: 3, machine: 'B', date: '2026-11-01T10:00:00.000Z' });
  });

  it('answers none when no notice is found', async () => {
    fakeRest();
    expect(await readNewestNotice()).toEqual({ kind: 'none' });
  });

  it('parses the pin route response fixture', async () => {
    // Shape of GET /channels/{channel.id}/messages/pins in Discord's API reference: { items: [{ pinned_at, message }], has_more }.
    const fixture = { items: [{ pinned_at: '2026-11-03T12:00:00.000000+00:00', message: notice('4', 'D') }], has_more: false };
    fakeRest({ pins: fixture });
    expect(await readNewestNotice()).toMatchObject({ kind: 'notice', generation: 4, machine: 'D' });
  });

  it('the wait DM nonce is 25 characters for a 36-character process id', () => {
    const nonce = waitNonce('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(nonce).toHaveLength(25);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('a DM checks that the answer names the channel it was posted to', async () => {
    const { calls } = fakeRest();
    expect(await sendOwnerDm('hello', 'n1')).toEqual({ ok: true });
    const post = calls.find(c => c.route === `/channels/${DM}/messages`);
    expect(post?.options.body).toEqual({ content: 'hello', nonce: 'n1', enforce_nonce: true });
  });
});

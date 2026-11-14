import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { _setOwnerChannelDeps, _resetOwnerChannel, ownerChannelState, ownerMessagesFile } from '../../src/webui/utils/ownerChannel';
import { _resetWebuiChoice, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest, discordError } from '../helpers/fakeOwnerRest';

const TOKEN = 'rt6-token';
const C = '500000000000000001';
const X = '500000000000000777';
const ENTRY = 'postgres://bot:pw@db.example:5432/bot';
const KEY_BUSY = 'Another request for this key is still running; try again';
const KEY_LAPSED = 'This request waited for an earlier request for this key and ran out of time; nothing was posted; try again';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
const arrivals: string[] = [];

beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(a => {
    a.use((req, _res, next) => { arrivals.push(String(req.body?.text)); next(); });
    a.use('/api/managed', createManagedRoutes({} as BotManager));
  });
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  setBackendKind(null);
});
beforeEach(() => {
  arrivals.length = 0;
  rest = new FakeOwnerRest(5_000);
  _setManagedTiming({ notifyMs: 600 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  _setOwnerChannelDeps({ readRow: async () => null, readMs: 150, readKey: async () => null, recordKey: async () => ({ kind: 'ok' }) });
  setBackendKind('file');
  fs.rmSync(ownerMessagesFile(), { force: true });
  fs.rmSync(dataPath('owner-channel.json'), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setOwnerChannelDeps(null);
  setWebuiDataStoreUrl(null);
  vi.restoreAllMocks();
});

async function notify(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/notify-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  return { status: res.status, body: await res.json() };
}

const channelFile = (id: string) => fs.writeFileSync(dataPath('owner-channel.json'), JSON.stringify({ channelId: id }));
const createsOf = (text: string) => rest.creates().filter(c => c.options.body.content === text);

describe('notify-owner: a request waiting behind another with its key', () => {
  it('answers 503 busy at its own deadline while the earlier one still holds the key, and posts nothing', async () => {
    rest.on('post', /^\/channels\/\d+\/messages$/, call => (call.options.body.content === 'first' ? 'hang' : undefined));
    _setManagedTiming({ notifyMs: 900 });
    const first = notify({ text: 'first', key: 'held' });
    await vi.waitFor(() => expect(createsOf('first')).toHaveLength(1), { timeout: 2_000, interval: 5 });
    _setManagedTiming({ notifyMs: 150 });
    const started = Date.now();
    const second = await notify({ text: 'second', key: 'held' });
    expect(second).toEqual({ status: 503, body: { success: false, error: KEY_BUSY } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(createsOf('second')).toHaveLength(0);
    expect((await first).body.unknown).toBe(true);
    expect(createsOf('second')).toHaveLength(0);
  });

  it('a third request waits for the second once the first released the key, so it is not posted beside it', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    rest.on('post', /^\/channels\/\d+\/messages$/, async call => {
      const text = call.options.body.content;
      if (text === 'a') { await firstGate; throw discordError(403, 50007, 'Cannot send messages to this user'); }
      if (text === 'b') return 'hang';
      return undefined;
    });
    _setManagedTiming({ notifyMs: 800 });
    const a = notify({ text: 'a', key: 'line' });
    await vi.waitFor(() => expect(createsOf('a')).toHaveLength(1), { timeout: 2_000, interval: 5 });
    const b = notify({ text: 'b', key: 'line' });
    await vi.waitFor(() => expect(arrivals).toContain('b'), { timeout: 2_000, interval: 5 });
    releaseFirst();
    expect((await a).status).toBe(502);
    await vi.waitFor(() => expect(createsOf('b')).toHaveLength(1), { timeout: 2_000, interval: 5 });
    _setManagedTiming({ notifyMs: 150 });
    const c = await notify({ text: 'c', key: 'line' });
    expect(c).toEqual({ status: 503, body: { success: false, error: KEY_BUSY } });
    expect(createsOf('c')).toHaveLength(0);
    expect((await b).body.unknown).toBe(true);
  });
});

describe('notify-owner: timers', () => {
  it('a finished request leaves none of the timers of its budget pending', async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const live = new Set<unknown>();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle: unknown = realSet((...a: unknown[]) => { live.delete(handle); fn(...a); }, ms, ...args);
      if (typeof ms === 'number' && ms > 4_000 && ms <= 4_321) live.add(handle);
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: any) => { live.delete(handle); realClear(handle); }) as typeof clearTimeout);
    _setManagedTiming({ notifyMs: 4_321 });
    const res = await notify({ text: 'one', key: 'timers' });
    expect(res.body).toEqual({ success: true, posted: true, place: 'dm' });
    expect(live.size).toBe(0);
  });
});

describe('notify-owner: answers', () => {
  it('an unreadable record answers success false with status 502', async () => {
    fs.writeFileSync(ownerMessagesFile(), '{not json');
    const res = await notify({ text: 'one', key: 'unreadable' });
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(Object.keys(res.body).sort()).toEqual(['error', 'success']);
    expect(rest.calls).toHaveLength(0);
  });

  it('a setting read that ends exactly at the deadline answers 503 lapsed and posts nothing', async () => {
    const T = 1_900_000_000_000;
    let now = T;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    setBackendKind('postgres');
    setWebuiDataStoreUrl({ url: ENTRY });
    _setOwnerChannelDeps({
      readRow: () => Promise.resolve().then(() => { now = T + 600; return null; }),
      readMs: 150,
      readKey: async () => null,
      recordKey: async () => ({ kind: 'ok' }),
    });
    const res = await notify({ text: 'one', key: 'edge' });
    expect(res).toEqual({ status: 503, body: { success: false, error: KEY_LAPSED } });
    expect(rest.creates()).toHaveLength(0);
  });

  it('a create in the chosen channel answered in another channel answers place channel with the note', async () => {
    channelFile(C);
    rest.on('post', new RegExp(`^/channels/${C}/messages$`), () => ({ id: 'other', channel_id: X }));
    const res = await notify({ text: 'one', key: 'elsewhere-c' });
    expect(res.body).toEqual({
      success: true, posted: true, place: 'channel',
      note: `Discord answered with a message in channel ${X} instead of a new one in channel ${C}.`,
    });
  });

  it("a create in the DM answered in a channel names the owner's DMs as the place asked", async () => {
    rest.on('post', new RegExp(`^/channels/${DM}/messages$`), () => ({ id: 'other', channel_id: X }));
    const res = await notify({ text: 'one', key: 'elsewhere-dm' });
    expect(res.body).toEqual({
      success: true, posted: true, place: 'channel',
      note: `Discord answered with a message in channel ${X} instead of a new one in the owner's DMs.`,
    });
  });

  it('a post in the chosen channel drops the refusal kept for the panel', async () => {
    channelFile(C);
    let refuse = true;
    rest.on('post', new RegExp(`^/channels/${C}/messages$`), () => {
      if (refuse) throw discordError(403, 50013, 'Missing Permissions');
      return undefined;
    });
    expect((await notify({ text: 'one', key: 'refused' })).status).toBe(502);
    expect(ownerChannelState().lastRefusal).toMatchObject({ channelId: C });
    refuse = false;
    expect((await notify({ text: 'one', key: 'allowed' })).body).toEqual({ success: true, posted: true, place: 'channel' });
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('two notes are joined by one space', async () => {
    setBackendKind('postgres');
    setWebuiDataStoreUrl({ url: ENTRY });
    _setOwnerChannelDeps({
      readRow: async () => { throw new Error('row read failed'); },
      readMs: 150,
      readKey: async () => { throw new Error('key read failed'); },
      recordKey: async () => ({ kind: 'ok' }),
    });
    const res = await notify({ text: 'one', key: 'two-notes' });
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(
      /^The repeat check in the bot's main database could not be read \(key read failed\), so only this machine's record of posted messages was checked, and this key is recorded only there\. Posted in the owner's DMs: the chosen channel setting could not be read \(.+\)\.$/,
    );
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  _setOwnerRestFactory, readNewestNotice, readNoticesIn, NOTICE_TITLE, OwnerRest, OwnerRestOptions,
} from '../../src/utils/ownerMessages';
import { DM, FakeOwnerRest, discordError, httpError } from '../helpers/fakeOwnerRest';

const CHANNEL = '555000000000000001';
const FAR = () => Date.now() + 5_000;

function embed(generation: string | undefined, machine: string | null = 'M', title = NOTICE_TITLE) {
  const fields: Array<{ name: string; value: string }> = [];
  if (machine !== null) fields.push({ name: 'Machine', value: machine });
  if (generation !== undefined) fields.push({ name: 'Generation', value: generation });
  return { title, timestamp: '2026-11-02T10:00:00.000Z', fields };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function thrower(value: unknown) {
  return () => { throw value; };
}

afterEach(() => FakeOwnerRest.reset());

describe('ra74 owner messages: the client and the request bound', () => {
  it('a shortened request bound makes a hanging request answer a timeout at once', async () => {
    const fake = new FakeOwnerRest(50);
    fake.hang('get', /^\/applications\/@me$/);
    const read = await within(readNewestNotice({ own: true }), 3_000);
    expect(read).toEqual({ kind: 'failed', cause: 'a timeout' });
  });

  it('builds the REST client once across many requests', async () => {
    const fake = new FakeOwnerRest();
    let built = 0;
    _setOwnerRestFactory((options: OwnerRestOptions): OwnerRest => {
      built++;
      expect(options.retries).toBe(0);
      return {
        get: (route, o) => (fake as any).call('get', route, o),
        post: (route, o) => (fake as any).call('post', route, o),
        put: (route, o) => (fake as any).call('put', route, o),
        delete: (route, o) => (fake as any).call('delete', route, o),
      };
    });
    expect((await readNoticesIn({ kind: 'dm' }, FAR())).ok).toBe(true);
    expect((await readNoticesIn({ kind: 'channel', id: CHANNEL }, FAR())).ok).toBe(true);
    expect(fake.calls.length).toBeGreaterThanOrEqual(5);
    expect(built).toBe(1);
  });
});

describe('ra74 owner messages: failure causes', () => {
  it('a plain 429 with a retry after is a rate limit carrying its retry after', async () => {
    new FakeOwnerRest().on('get', /^\/applications\/@me$/, thrower({ status: 429, retryAfter: 5_000, message: 'slow down' }));
    expect(await readNewestNotice({ own: true })).toEqual({
      kind: 'failed', cause: 'HTTP 429 (rate limited, retry after 5 s)', status: 429, retryAfterMs: 5_000,
    });
  });

  it('a plain 429 with no retry after names only the rate limit', async () => {
    new FakeOwnerRest().on('get', /^\/applications\/@me$/, thrower({ status: 429 }));
    expect(await readNewestNotice({ own: true })).toEqual({ kind: 'failed', cause: 'HTTP 429 (rate limited)', status: 429 });
  });

  it('a status with no message says no message', async () => {
    new FakeOwnerRest().on('get', /^\/applications\/@me$/, thrower({ status: 500 }));
    expect(await readNewestNotice({ own: true })).toEqual({ kind: 'failed', cause: 'HTTP 500 (no message)', status: 500 });
  });

  it('a TimeoutError is a timeout', async () => {
    new FakeOwnerRest().on('get', /^\/applications\/@me$/, thrower(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    expect(await readNewestNotice({ own: true })).toEqual({ kind: 'failed', cause: 'a timeout' });
  });

  it('an application with no bot user fails with that cause', async () => {
    new FakeOwnerRest().on('get', /^\/applications\/@me$/, () => ({ owner: { id: '300000000000000001' } }));
    expect(await readNewestNotice({ own: true })).toEqual({ kind: 'failed', cause: 'the application has no owner or bot user' });
  });

  it('a DM channel with no id fails with that cause', async () => {
    new FakeOwnerRest().on('post', /^\/users\/@me\/channels$/, () => ({}));
    expect(await readNewestNotice({ own: true })).toEqual({ kind: 'failed', cause: 'the DM channel has no id' });
  });
});

describe('ra74 owner messages: the cached owner ids', () => {
  async function lookupsAfter(error: Error): Promise<number> {
    const fake = new FakeOwnerRest();
    let failNext = true;
    fake.on('get', new RegExp(`^/channels/${CHANNEL}/messages$`), () => {
      if (failNext) { failNext = false; throw error; }
      return undefined;
    });
    expect((await readNoticesIn({ kind: 'dm' }, FAR())).ok).toBe(true);
    expect((await readNoticesIn({ kind: 'channel', id: CHANNEL }, FAR())).ok).toBe(false);
    expect((await readNoticesIn({ kind: 'channel', id: CHANNEL }, FAR())).ok).toBe(true);
    return fake.calls.filter(c => c.route === '/applications/@me').length;
  }

  it('a 403 drops the cached ids, so the next read looks the owner up again', async () => {
    expect(await lookupsAfter(discordError(403, 50001, 'Missing Access'))).toBe(2);
  });

  it('a 404 drops the cached ids', async () => {
    expect(await lookupsAfter(discordError(404, 10003, 'Unknown Channel'))).toBe(2);
  });

  it('a 500 keeps the cached ids', async () => {
    expect(await lookupsAfter(httpError(500, 'Internal Server Error'))).toBe(1);
  });
});

describe('ra74 owner messages: which messages are notices', () => {
  async function readWith(generation: string | undefined, machine: string | null = 'M', title = NOTICE_TITLE) {
    const fake = new FakeOwnerRest();
    fake.seed(DM, { embeds: [embed(generation, machine, title)] });
    return readNewestNotice({ own: true });
  }

  it('a bot message with another title is no notice', async () => {
    expect(await readWith('3', 'M', 'Something else')).toEqual({ kind: 'none' });
  });

  it.each([' 5', '5 ', '0x10', '1e2', '0', '00', '99999999999999999999'])('a Generation of %j is no notice', async raw => {
    expect(await readWith(raw)).toEqual({ kind: 'none' });
  });

  it('a Generation of several digits is read', async () => {
    expect(await readWith('12')).toMatchObject({ kind: 'notice', generation: 12, machine: 'M' });
  });

  it('a notice with no Machine field reads an empty machine', async () => {
    const read = await readWith('4', null);
    expect(read).toMatchObject({ kind: 'notice', generation: 4, machine: '' });
  });

  it('a notice with no timestamps reads an empty date', async () => {
    const fake = new FakeOwnerRest();
    const e = { title: NOTICE_TITLE, fields: [{ name: 'Machine', value: 'M' }, { name: 'Generation', value: '2' }] };
    fake.seed(DM, { embeds: [e], timestamp: undefined });
    expect(await readNewestNotice({ own: true })).toMatchObject({ kind: 'notice', generation: 2, date: '' });
  });

  it('a pin item with no message is skipped and the recent notice still reads', async () => {
    const fake = new FakeOwnerRest();
    fake.seed(DM, { embeds: [embed('6', 'A')] });
    fake.on('get', new RegExp(`^/channels/${DM}/messages/pins$`), () => ({ items: [{}], has_more: false }));
    expect(await readNewestNotice({ own: true })).toMatchObject({ kind: 'notice', generation: 6, machine: 'A' });
  });
});

describe('ra74 owner messages: reading a place', () => {
  it('asks Discord for 50 pins and 100 recent messages', async () => {
    const fake = new FakeOwnerRest();
    expect((await readNoticesIn({ kind: 'dm' }, FAR())).ok).toBe(true);
    const pins = fake.calls.find(c => c.route === `/channels/${DM}/messages/pins`);
    const recent = fake.calls.find(c => c.route === `/channels/${DM}/messages`);
    expect(pins?.options.query.get('limit')).toBe('50');
    expect(recent?.options.query.get('limit')).toBe('100');
  });

  it('a channel read reads no pins, counts only its messages and lists no recent notice as pinned', async () => {
    const fake = new FakeOwnerRest();
    fake.seed(CHANNEL, { embeds: [embed('3', 'A')] });
    const read = await readNoticesIn({ kind: 'channel', id: CHANNEL }, FAR());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(fake.calls.some(c => c.route.endsWith('/messages/pins'))).toBe(false);
    expect(read.messages).toBe(1);
    expect(read.pinned).toEqual([]);
    expect(read.best).toMatchObject({ generation: 3, machine: 'A', pinned: false });
  });

  it('a notice with no id reads an empty message id', async () => {
    const fake = new FakeOwnerRest();
    fake.seed(CHANNEL, { id: undefined, embeds: [embed('3', 'A')] });
    const read = await readNoticesIn({ kind: 'channel', id: CHANNEL }, FAR());
    expect(read.ok && read.best?.messageId).toBe('');
  });

  it('of two recent notices at one generation, the newest stays the best', async () => {
    const fake = new FakeOwnerRest();
    fake.seed(CHANNEL, { id: 'older', embeds: [embed('3', 'A')] });
    fake.seed(CHANNEL, { id: 'newer', embeds: [embed('3', 'B')] });
    const read = await readNoticesIn({ kind: 'channel', id: CHANNEL }, FAR());
    expect(read.ok && read.best).toMatchObject({ messageId: 'newer', machine: 'B', generation: 3 });
  });

  it('a pinned notice stays the best over a newer recent one at its generation', async () => {
    const fake = new FakeOwnerRest();
    fake.seed(DM, { id: 'pinnedone', embeds: [embed('3', 'A')] }, true);
    fake.seed(DM, { id: 'recentone', embeds: [embed('3', 'B')] });
    const read = await readNoticesIn({ kind: 'dm' }, FAR());
    expect(read.ok && read.best).toMatchObject({ messageId: 'pinnedone', pinned: true });
    expect(read.ok && read.pinned).toEqual([{ messageId: 'pinnedone', generation: 3 }]);
  });
});

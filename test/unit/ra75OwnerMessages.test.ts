import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetOwnerMessages, _setOwnerRestFactory, channelCause, discordWords, hashNonce, noticeEmbed, NOTICE_TITLE,
  placeWords, postInPlace, readNewestNotice, readNoticesIn, sendOwnerDm, waitNonce,
} from '../../src/utils/ownerMessages';

const BOT = '200000000000000001';
const OWNER = '300000000000000001';
const DM = '400000000000000001';
const FAR = () => Date.now() + 5_000;

interface Call { method: string; route: string; options: any }

function notice(id: string, generation: string, machine: string) {
  const date = '2026-11-01T10:00:00.000Z';
  return {
    id, author: { id: BOT }, timestamp: date,
    embeds: [{ title: NOTICE_TITLE, timestamp: date, fields: [{ name: 'Machine', value: machine }, { name: 'Generation', value: generation }] }],
  };
}

const networkError = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const httpError = (status: number) => ({ status, message: 'Forbidden', rawError: { message: 'Missing Access' }, code: 50001 });

function fakeRest(script: { pins?: unknown; recent?: unknown[]; appFail?: unknown; postAnswer?: unknown; postFail?: unknown } = {}) {
  const calls: Call[] = [];
  const rest = {
    get: (route: string, options: any) => {
      calls.push({ method: 'get', route, options });
      if (route === '/applications/@me') {
        return script.appFail ? Promise.reject(script.appFail) : Promise.resolve({ owner: { id: OWNER }, bot: { id: BOT } });
      }
      if (route.endsWith('/messages/pins')) return Promise.resolve(script.pins ?? { items: [], has_more: false });
      return Promise.resolve(script.recent ?? []);
    },
    post: (route: string, options: any) => {
      calls.push({ method: 'post', route, options });
      if (route === '/users/@me/channels') return Promise.resolve({ id: DM });
      if (script.postFail) return Promise.reject(script.postFail);
      return Promise.resolve('postAnswer' in script ? script.postAnswer : { id: 'sent', channel_id: DM });
    },
    put: async () => undefined,
    delete: async () => undefined,
  };
  _setOwnerRestFactory(() => rest);
  return calls;
}

afterEach(() => {
  _setOwnerRestFactory(null);
  _resetOwnerMessages();
});

describe('ra75: reading the notices', () => {
  it('two pinned notices at one generation: the first pinned one is the highest', async () => {
    fakeRest({ pins: { items: [{ message: notice('p1', '4', 'Alpha') }, { message: notice('p2', '4', 'Beta') }], has_more: false } });
    const read = await readNoticesIn({ kind: 'dm' }, FAR());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.best?.messageId).toBe('p1');
    expect(read.best?.machine).toBe('Alpha');
    _resetOwnerMessages();
    const newest = await readNewestNotice();
    expect(newest).toMatchObject({ kind: 'notice', generation: 4, machine: 'Alpha' });
  });

  it('a channel place reads no pins', async () => {
    const calls = fakeRest({ pins: { items: [{ message: notice('p1', '9', 'Alpha') }], has_more: false }, recent: [notice('r1', '2', 'Beta')] });
    const read = await readNoticesIn({ kind: 'channel', id: '500' }, FAR());
    expect(read).toMatchObject({ ok: true, channel: '500', pinned: [] });
    if (!read.ok) return;
    expect(read.best?.messageId).toBe('r1');
    expect(calls.some(c => c.route.endsWith('/messages/pins'))).toBe(false);
  });

  it('a failed read with no status and no retry carries neither field', async () => {
    fakeRest({ appFail: networkError() });
    const read = await readNewestNotice();
    expect(read).toStrictEqual({ kind: 'failed', cause: 'a network error (ECONNRESET)' });
    expect('status' in read).toBe(false);
    expect('retryAfterMs' in read).toBe(false);
  });

  it('an older read that ends after a reset does not end the newer single-flight read', async () => {
    const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const hold = () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    const calls: string[] = [];
    const rest = {
      get: (route: string) => { calls.push(route); return hold(); },
      post: (route: string) => { calls.push(route); return hold(); },
      put: hold, delete: hold,
    };
    _setOwnerRestFactory(() => rest);
    const a = readNewestNotice();
    _resetOwnerMessages();
    const b = readNewestNotice();
    expect(pending.length).toBe(2);
    pending[0].reject(networkError());
    expect((await a).kind).toBe('failed');
    const c = readNewestNotice();
    expect(c).toBe(b);
    expect(calls.length).toBe(2);
    pending[1].reject(networkError());
    expect((await b).kind).toBe('failed');
  });
});

describe('ra75: the notice embed and nonces', () => {
  it('the Machine field holds at most 256 characters', () => {
    const embed = noticeEmbed({ machine: 'x'.repeat(300), generation: 3, date: '2026-11-01T10:00:00.000Z' });
    expect(embed.fields[0]).toEqual({ name: 'Machine', value: 'x'.repeat(256) });
  });

  it("the wait nonce is the hash of wait: and the process id, distinct per process", () => {
    expect(waitNonce('p-1')).toBe(hashNonce('wait:p-1'));
    expect(waitNonce('p-1')).not.toBe(waitNonce('p-2'));
    expect(waitNonce('p-1')).not.toBe(hashNonce(''));
  });
});

describe('ra75: sendOwnerDm', () => {
  it('an answer in another channel is not ok and says so', async () => {
    fakeRest({ postAnswer: { id: 'sent', channel_id: '999' } });
    expect(await sendOwnerDm('hi', 'n1')).toStrictEqual({ ok: false, cause: 'Discord answered with a message in another channel' });
  });

  it('an empty answer is not ok, with the other-channel cause', async () => {
    fakeRest({ postAnswer: undefined });
    expect(await sendOwnerDm('hi', 'n1')).toStrictEqual({ ok: false, cause: 'Discord answered with a message in another channel' });
  });

  it('the answer in the DM is ok', async () => {
    fakeRest();
    expect(await sendOwnerDm('hi', 'n1')).toStrictEqual({ ok: true });
  });

  it("a refusal carries Discord's status", async () => {
    fakeRest({ postFail: httpError(403) });
    expect(await sendOwnerDm('hi', 'n1')).toStrictEqual({ ok: false, cause: 'HTTP 403 (Missing Access)', status: 403 });
  });

  it('a network failure carries no status field', async () => {
    fakeRest({ postFail: networkError() });
    const answer = await sendOwnerDm('hi', 'n1');
    expect(answer).toStrictEqual({ ok: false, cause: 'a network error (ECONNRESET)' });
    expect('status' in answer).toBe(false);
  });
});

describe('ra75: the words for a refusal', () => {
  it('discordWords gives code and message only when both are there', () => {
    expect(discordWords({ cause: 'a timeout' })).toBe('a timeout');
    expect(discordWords({ cause: 'only code', code: 50035 })).toBe('only code');
    expect(discordWords({ cause: 'only message', message: 'Invalid Form Body' })).toBe('only message');
    expect(discordWords({ cause: 'both', code: 50035, message: 'Invalid Form Body' })).toBe('50035 Invalid Form Body');
  });

  it('code 10003 alone reads as a missing channel', () => {
    expect(channelCause({ cause: 'HTTP 400 (Unknown Channel)', status: 400, code: 10003, message: 'Unknown Channel' }))
      .toBe('the channel does not exist, or the bot is not in its server');
  });
});

describe('ra75: postInPlace', () => {
  it('a DM post whose owner lookup failed was never sent and is not unconfirmed', async () => {
    fakeRest({ appFail: networkError() });
    const answer = await postInPlace({ kind: 'dm' }, { content: 'hi' }, 'n1', FAR());
    expect(answer).toStrictEqual({ ok: false, failure: { cause: 'a network error (ECONNRESET)' }, sent: false });
  });

  it('a sent post that timed out is not marked unconfirmed', async () => {
    fakeRest({ postFail: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
    const answer = await postInPlace({ kind: 'channel', id: '500' }, { content: 'hi' }, 'n1', FAR());
    expect(answer).toStrictEqual({ ok: false, failure: { cause: 'a timeout', timeout: true }, sent: true });
  });

  it('a sent post that failed on the network is unconfirmed', async () => {
    fakeRest({ postFail: networkError() });
    const answer = await postInPlace({ kind: 'channel', id: '500' }, { content: 'hi' }, 'n1', FAR());
    expect(answer).toStrictEqual({ ok: false, failure: { cause: 'a network error (ECONNRESET)', unconfirmed: true }, sent: true });
  });

  it('with no nonce the body goes as given', async () => {
    const calls = fakeRest({ postAnswer: { id: 'm1', channel_id: '500' } });
    await postInPlace({ kind: 'channel', id: '500' }, { content: 'hi' }, null, FAR());
    const post = calls.find(c => c.route === '/channels/500/messages');
    expect(post?.options.body).toStrictEqual({ content: 'hi' });
  });

  it('with a nonce the body enforces it', async () => {
    const calls = fakeRest({ postAnswer: { id: 'm1', channel_id: '500' } });
    await postInPlace({ kind: 'channel', id: '500' }, { content: 'hi' }, 'n1', FAR());
    const post = calls.find(c => c.route === '/channels/500/messages');
    expect(post?.options.body).toStrictEqual({ content: 'hi', nonce: 'n1', enforce_nonce: true });
  });

  it('an empty answer is ok with empty channel and message ids', async () => {
    fakeRest({ postAnswer: undefined });
    const answer = await postInPlace({ kind: 'channel', id: '500' }, { content: 'hi' }, 'n1', FAR());
    expect(answer).toStrictEqual({ ok: true, channelId: '', messageId: '', askedChannel: '500' });
  });

  it('an answer missing one id gives that id as empty', async () => {
    fakeRest({ postAnswer: { id: 'm1' } });
    expect(await postInPlace({ kind: 'channel', id: '500' }, { content: 'hi' }, 'n1', FAR()))
      .toStrictEqual({ ok: true, channelId: '', messageId: 'm1', askedChannel: '500' });
    fakeRest({ postAnswer: { channel_id: '500' } });
    expect(await postInPlace({ kind: 'channel', id: '500' }, { content: 'hi' }, 'n1', FAR()))
      .toStrictEqual({ ok: true, channelId: '500', messageId: '', askedChannel: '500' });
  });
});

describe('ra75: placeWords', () => {
  it("names a channel by id and the DM as the owner's DMs", async () => {
    fakeRest();
    expect(await placeWords('500', FAR())).toBe('channel 500');
    expect(await placeWords(DM, FAR())).toBe("the owner's DMs");
  });
});

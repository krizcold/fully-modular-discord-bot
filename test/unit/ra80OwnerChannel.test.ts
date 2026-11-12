import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  post: null as any,
  posts: 0,
  query: null as null | (() => Promise<unknown>),
  count: 0,
  childCase: { kind: 'none' } as any,
}));

vi.mock('../../src/utils/ownerMessages', async orig => {
  const real = await orig<typeof import('../../src/utils/ownerMessages')>();
  return { ...real, postInPlace: async () => { ctl.posts++; return ctl.post; } };
});
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return {
    ...real,
    shortLivedClient: () => ({
      connect: () => Promise.resolve(),
      query: () => (ctl.query ? ctl.query() : Promise.resolve({ rows: [], rowCount: 1 })),
      end: async () => undefined,
      on: () => undefined,
    }),
  };
});
vi.mock('../../src/webui/utils/webuiDataReader', async orig => {
  const real = await orig<typeof import('../../src/webui/utils/webuiDataReader')>();
  return {
    ...real,
    resolveWebuiDatabase: () => ({ entry: 'postgres://bot:pw@a.example:5432/bot', tag: null }),
    webuiFirstCheck: () => null,
    chooseNow: async () => ({ resolution: { entry: 'postgres://bot:pw@a.example:5432/bot', tag: null }, countAtStart: 0 }),
    webuiSecondCheck: () => ({ entry: 'postgres://bot:pw@a.example:5432/bot', tag: null }),
    webuiReportCount: () => ctl.count,
    webuiChildCase: () => ctl.childCase,
  };
});

import {
  _resetOwnerChannel, _setOwnerChannelDeps, noteChannelPosted, noteChannelRefusal, ownerChannelFile, ownerChannelState,
  ownerChannelView, putOwnerChannel, readOwnerChannelSetting, writeOwnerChannelFile, writeOwnerChannelRow,
  type OwnerChannelHost,
} from '../../src/webui/utils/ownerChannel';
import { showEntry } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';

const C = '500000000000000001';
const D = '500000000000000002';
const A = 'postgres://bot:pw@a.example:5432/bot';
const B = 'postgres://bot:pw@b.example:5432/bot';

function host(over: Partial<OwnerChannelHost> = {}): OwnerChannelHost & { ends: number } {
  const h = {
    ends: 0,
    migrationRunning: () => null,
    ownerChannelWriteStart: () => ({ ok: true as const, end: () => { h.ends++; } }),
    ...over,
  };
  return h;
}

beforeEach(() => {
  _resetOwnerChannel();
  _setOwnerChannelDeps(null);
  Object.assign(ctl, { post: { ok: true, channelId: C, messageId: 'm1', askedChannel: C }, posts: 0, query: null, count: 0, childCase: { kind: 'none' } });
  setBackendKind('file');
  fs.rmSync(ownerChannelFile(), { force: true, recursive: true });
});
afterEach(() => {
  _setOwnerChannelDeps(null);
  setBackendKind(null);
  fs.rmSync(ownerChannelFile(), { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe('the refusal kept for the panel', () => {
  it('a reset drops it', () => {
    noteChannelRefusal(C, 'cause');
    _resetOwnerChannel();
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('a post in another channel keeps it', () => {
    noteChannelRefusal(C, 'cause');
    noteChannelPosted(D);
    expect(ownerChannelState().lastRefusal).toMatchObject({ channelId: C, text: 'cause' });
    noteChannelPosted(C);
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('the view shows no refusal of another channel than the setting', async () => {
    writeOwnerChannelFile(C);
    noteChannelRefusal(D, 'cause');
    expect(await ownerChannelView()).toEqual({ readable: true, channelId: C, lastRefusal: null });
  });
});

describe('readOwnerChannelSetting on Postgres', () => {
  beforeEach(() => setBackendKind('postgres'));

  it('an undefined row is none', async () => {
    _setOwnerChannelDeps({ readRow: async () => undefined, readMs: 1000 });
    expect(await readOwnerChannelSetting()).toEqual({ kind: 'none' });
  });

  it('clears its read bound once the row answered', async () => {
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    _setOwnerChannelDeps({ readRow: async () => JSON.stringify(C), readMs: 4321 });
    expect(await readOwnerChannelSetting()).toEqual({ kind: 'id', id: C });
    const index = set.mock.calls.findIndex(call => call[1] === 4321);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = set.mock.results[index].value;
    expect(clear.mock.calls.some(call => call[0] === timer)).toBe(true);
  });
});

describe('writeOwnerChannelRow: only a SQLSTATE error is not saved', () => {
  it.each(['X12345', '123456'])('code %s is unknown', async code => {
    ctl.query = () => Promise.reject(Object.assign(new Error('E'), { code }));
    const out = await writeOwnerChannelRow(A, C);
    expect(out.kind).toBe('unknown');
  });

  it('code 23505 is not saved', async () => {
    ctl.query = () => Promise.reject(Object.assign(new Error('E'), { code: '23505' }));
    expect(await writeOwnerChannelRow(A, C)).toEqual({ kind: 'not-saved', cause: 'SQLSTATE 23505: E' });
  });
});

describe('writeOwnerChannelFile', () => {
  it('none with no file throws nothing', () => {
    expect(() => writeOwnerChannelFile(null)).not.toThrow();
    expect(fs.existsSync(ownerChannelFile())).toBe(false);
  });
});

describe('putOwnerChannel on a JSON bot', () => {
  it.each([`x${C}`, `${C}x`])('%s is refused with 400 and posts nothing', async value => {
    const h = host();
    const res = await putOwnerChannel(h, value);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Enter a channel ID (17 to 20 digits), or clear the field to use the owner's DMs");
    expect(ctl.posts).toBe(0);
    expect(h.ends).toBe(0);
  });

  it('a refused test post keeps the refusal for the panel', async () => {
    ctl.post = { ok: false, failure: { cause: 'c', status: 403, code: 50001, message: 'Missing Access' }, sent: true };
    const res = await putOwnerChannel(host(), C);
    expect(res).toEqual({ status: 400, body: { success: false, error: `The bot cannot post in channel ${C}: the bot cannot see that channel; nothing was changed` } });
    expect(ownerChannelState().lastRefusal).toMatchObject({ channelId: C, text: 'the bot cannot see that channel' });
  });

  it('a test post that worked drops the old refusal even when the setting is not saved', async () => {
    noteChannelRefusal(C, 'old');
    const res = await putOwnerChannel(host({ ownerChannelWriteStart: () => ({ ok: false, running: { jobId: 'J', to: 'postgres' } }) }), C);
    expect(res.status).toBe(409);
    expect(ownerChannelState().lastRefusal).toBeNull();
  });

  it('a file write that fails answers not saved and ends the mark', async () => {
    fs.mkdirSync(ownerChannelFile(), { recursive: true });
    const h = host();
    const res = await putOwnerChannel(h, null);
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/^The setting was not saved \(.+\); owner messages still go where they went before$/);
    expect(h.ends).toBe(1);
    expect(fs.statSync(ownerChannelFile()).isDirectory()).toBe(true);
  });

  it('a saved file ends the mark once', async () => {
    const h = host();
    const res = await putOwnerChannel(h, C);
    expect(res.status).toBe(200);
    expect(h.ends).toBe(1);
    expect(JSON.parse(fs.readFileSync(ownerChannelFile(), 'utf8'))).toEqual({ channelId: C });
  });
});

describe('putOwnerChannel on Postgres when the report changed during the write', () => {
  beforeEach(() => {
    setBackendKind('postgres');
    ctl.count = 1;
  });
  const text = (words: string) => `The setting was written to ${showEntry(A)}, but while it was written ${words}; can't confirm where owner messages go; reload the page once the bot runs`;

  it('a held report with no reason', async () => {
    ctl.childCase = { kind: 'reported', report: { url: B, held: true } };
    const res = await putOwnerChannel(host(), null);
    expect(res).toEqual({ status: 502, body: { success: false, unknown: true, error: text('the bot process reported its database held ()') } });
  });

  it('a report of the same entry', async () => {
    ctl.childCase = { kind: 'reported', report: { url: A } };
    const res = await putOwnerChannel(host(), null);
    expect(res.body.error).toBe(text('the bot process reported a change of its database'));
  });

  it('a report of another entry', async () => {
    ctl.childCase = { kind: 'reported', report: { url: B } };
    const res = await putOwnerChannel(host(), null);
    expect(res.body.error).toBe(text(`the bot process moved to ${showEntry(B)}`));
  });
});

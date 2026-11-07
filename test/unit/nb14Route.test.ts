import fs from 'fs';
import net from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB14 test 4 (wip-redesign/sheets/NB14.md, decisions 2, 12, 13 and 15, rulings C7 to C9, C12, C14 and C18): the
// restore route's replace check, its read of the guild's newest entry N after the plan, its answers, the GET's
// ?guildId=, the reader's bounds, and the CLI's --replace, its GET before the POST, its timeouts and its lines.

const state = vi.hoisted(() => ({
  marker: undefined as undefined | null | { live: string },
  allRows: [] as Array<{ guildId: string; retiredAt: number; reason: string; rows: number }>,
  listAllCalls: 0,
  listGuild: null as null | ((guildId: string) => Promise<Array<{ guildId: string; retiredAt: number; reason: string; rows: number }>>),
  listGuildCalls: [] as string[],
  plan: null as null | Record<string, unknown>,
  send: null as null | ((plan: unknown, payload: any) => Promise<any>),
  order: [] as string[],
  poolConfigs: [] as any[],
  clientQueries: [] as any[],
  realPool: false,
}));

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }) }));
vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    totalCount = 0;
    idleCount = 0;
    constructor(config: any) {
      state.poolConfigs.push(config);
      // A real pool for the held-socket row: returned from the constructor, it stands for this one.
      if (state.realPool) return new real.Pool(config);
    }
    on() { return this; }
    async connect() {
      return {
        query: async (config: any) => { state.clientQueries.push(config); return { rows: [{ guild_id: '5', retired_at: '700', reason: 'webui-operator-delete', row_count: 2 }] }; },
        release: () => undefined,
      };
    }
    async query() { return { rows: [] }; }
    async end() {}
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});
vi.mock('../../src/webui/utils/webuiDataReader', async orig => {
  const actual = await orig<typeof import('../../src/webui/utils/webuiDataReader')>();
  const fake = {
    listGraveyard: async () => { state.listAllCalls += 1; return state.allRows; },
    listGuildGraveyard: async (guildId: string) => {
      state.listGuildCalls.push(guildId);
      state.order.push('read');
      return state.listGuild ? state.listGuild(guildId) : state.allRows.filter(r => r.guildId === guildId);
    },
  };
  return { ...actual, getWebuiDataReader: () => fake };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async orig => {
  const actual = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard')>();
  return { ...actual, recognitionRefusal: () => null, readFileMarker: () => (state.marker === undefined ? actual.readFileMarker() : state.marker) };
});
vi.mock('../../src/webui/utils/guildRequests', async orig => {
  const actual = await orig<typeof import('../../src/webui/utils/guildRequests')>();
  return {
    ...actual,
    planGuildChange: async (...args: Parameters<typeof actual.planGuildChange>) => (state.plan ? { ...state.plan } : actual.planGuildChange(...args)),
    sendGuildChange: async (...args: Parameters<typeof actual.sendGuildChange>) => {
      state.order.push('send');
      return state.send ? state.send(args[1], args[2]) : actual.sendGuildChange(...args);
    },
  };
});

import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import type { BotManager } from '../../src/webui/botManager';
import { remoteRestoreNoAnswerCause } from '../../src/webui/utils/guildRequests';
import { setWebuiDataStoreUrl, WebuiDataReader } from '../../src/webui/utils/webuiDataReader';
import { graveyardGuildDir } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { listGraveyardEntries } from '../../src/bot/internalSetup/utils/dataManager';
import { parseArgs } from '../../src/cli/args';
import { dispatch } from '../../src/cli/commands';
import type { Client } from '../../src/cli/client';
import { EXIT_ERR, EXIT_USAGE } from '../../src/cli/output';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { call, resetData, startApp } from '../helpers/configRig';

const G = '123456789012345678';
const OTHER = '223456789012345678';
const REPLACE_TEXT = 'replace must be true or false';
const MAIN = 'The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.';
const tail = (x: number | undefined) => (x === undefined
  ? `The entry it restored, if any, stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${G} <its retiredAt> --replace is then safe: it copies that entry in and moves whatever the server holds into a new entry, so nothing is lost.`
  : `Entry ${x} stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${G} ${x} --replace is then safe: it copies entry ${x} in and moves whatever the server holds into a new entry, so nothing is lost.`);
const which = (x: number | undefined, n: number | undefined) => (x === undefined
  ? 'whose reason starts with replaced-by-restore- or is empty'
  : `${n === undefined ? '' : `newer than ${n} `}whose reason is replaced-by-restore-${x} or empty`);
const replaceEnding = (x: number | undefined, n: number | undefined) => `Within a minute the outcome is fixed (if the bot stopped mid-step, once it has started again). If \`smdb graveyard list\` then lists an entry for this server ${which(x, n)}, the replace moved the server's data from before into that entry (an empty reason means its note could not be written). If not, either the server had no data or nothing changed. ${tail(x)} ${MAIN}`;
const plainEnding = (x: number | undefined) => `The outcome is fixed within a minute. ${tail(x)} ${MAIN}`;
const liveText = (x: number) => `server ${G} has data saved since entry ${x} was deleted; nothing was restored. To put entry ${x} in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${G} ${x} --replace`;
const WARNING = "The disk did not confirm the move of this server's folder (EIO), so a power cut can undo the restore. Check the disk.";
const row = (guildId: string, retiredAt: number) => ({ guildId, retiredAt, reason: 'webui-operator-delete', rows: 2 });

beforeEach(async () => {
  state.marker = undefined;
  state.allRows = [];
  state.listAllCalls = 0;
  state.listGuild = null;
  state.listGuildCalls = [];
  state.plan = null;
  state.send = null;
  state.order = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setBackendKind('file');
  await resetData();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setBackendKind(null);
});

function graveyardApp(reply: (req: any) => unknown) {
  const requests: any[] = [];
  const manager = { writeGuildData: async (req: any) => { requests.push(req); return reply(req); } } as unknown as BotManager;
  return { requests, start: () => startApp(app => app.use('/api/data/graveyard', createGraveyardRoutes(manager))) };
}

/** A Postgres bot whose plan is local; the send answers reply and records the payload. */
function postgresLocal(reply: unknown) {
  setBackendKind('postgres');
  state.marker = null;
  state.plan = { kind: 'local', op: 'restore-graveyard', deadline: performance.now() + 90_000 };
  const sent: any[] = [];
  state.send = async (_plan, payload) => { sent.push(payload); return reply; };
  return sent;
}

/** A JSON entry as a delete leaves it: the guild's folder moved by graveyardGuildDir. */
async function jsonEntry(guildId: string): Promise<number> {
  fs.mkdirSync(dataPath(guildId, 'm'), { recursive: true });
  fs.writeFileSync(dataPath(guildId, 'm', 'a.json'), '{"a":1}');
  expect(await graveyardGuildDir(guildId, 'webui-operator-delete')).toBe(true);
  return (await listGraveyardEntries(guildId))[0].retiredAt;
}

async function post(body: unknown, reply: (req: any) => unknown = () => ({ ok: true, retiredAt: 5, reason: 'r', keptUntil: 9 })) {
  const { requests, start } = graveyardApp(reply);
  const app = await start();
  try {
    return { res: await call(app.url, 'POST', '/api/data/graveyard/restore', body), requests };
  } finally {
    await app.close();
  }
}

describe('the replace check', () => {
  it('replace true reaches contentJson', async () => {
    const { res, requests } = await post({ guildId: G, retiredAt: 5, replace: true });
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].contentJson)).toEqual({ retiredAt: 5, replace: true });
  });

  it.each([['the string "true"', 'true'], ['1', 1], ['null', null]] as const)('replace as %s answers 400 and sends nothing', async (_name, replace) => {
    const { res, requests } = await post({ guildId: G, retiredAt: 5, replace });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: REPLACE_TEXT });
    expect(requests).toEqual([]);
  });
});

describe('the read of N', () => {
  it('reads the guild through listGuildGraveyard after the plan and before the send', async () => {
    postgresLocal({ ok: true, retiredAt: 5, reason: 'r', keptUntil: 9 });
    state.allRows = [row(G, 300), row(OTHER, 900)];
    const { res } = await post({ guildId: G });
    expect(res.status).toBe(200);
    expect(state.listGuildCalls).toEqual([G]);
    expect(state.listAllCalls).toBe(0);
    expect(state.order).toEqual(['read', 'send']);
  });

  it('a read that fails answers 503 and sends nothing', async () => {
    const sent = postgresLocal({ ok: true });
    state.listGuild = async () => { throw new Error('connection refused'); };
    const { res } = await post({ guildId: G, replace: true });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'the graveyard list could not be read (connection refused); nothing was restored; try again in a moment' });
    expect(sent).toEqual([]);
    expect(state.order).toEqual(['read']);
  });

  it('a read that never answers answers 503 within 5 s and sends nothing', async () => {
    const sent = postgresLocal({ ok: true });
    state.listGuild = () => new Promise(() => undefined);
    const started = Date.now();
    const { res } = await post({ guildId: G });
    const took = Date.now() - started;
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('the graveyard list could not be read (no answer within 5 s); nothing was restored; try again in a moment');
    expect(took).toBeGreaterThanOrEqual(4900);
    expect(took).toBeLessThan(6500);
    expect(sent).toEqual([]);
  }, 10_000);

  it('a refuse plan reads nothing', async () => {
    setBackendKind('postgres');
    state.marker = { live: 'file' };
    state.plan = { kind: 'refuse', op: 'restore-graveyard', deadline: performance.now() + 90_000, reply: { ok: false, code: 'backend-unavailable', error: 'held elsewhere' } };
    await jsonEntry(G);
    const { res } = await post({ guildId: G });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('held elsewhere');
    expect(state.listGuildCalls).toEqual([]);
    expect(state.order).toEqual(['send']);
  });

  it.each([['the database', 1], ['the files', -1]] as const)('with the marker live file and DATA_BACKEND postgres, N is the newest of both stores (newest in %s)', async (_name, sign) => {
    const fileN = await jsonEntry(G);
    postgresLocal({ ok: false, code: 'io-error', noAnswer: 'timeout' });
    state.marker = { live: 'file' };
    const pgN = fileN + sign * 1_000_000;
    state.allRows = [row(G, pgN)];
    const { res } = await post({ guildId: G, replace: true });
    const n = Math.max(fileN, pgN);
    expect(state.listGuildCalls).toEqual([G]);
    expect(res.body.error).toBe(`can't confirm whether server ${G} was restored: the bot did not answer within 50 s. ${replaceEnding(n, n)}`);
  });

  it('a remote no-answer names the cause, servedBy and no prefix, R by its reason, and ends with the main database sentence', async () => {
    postgresLocal({ ok: false, code: 'io-error', noAnswer: 'timeout', servedBy: 'BRAVO' });
    state.allRows = [row(G, 200)];
    const { res } = await post({ guildId: G, retiredAt: 100, replace: true });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: `can't confirm whether server ${G} was restored: ${remoteRestoreNoAnswerCause('timeout', 'BRAVO')}. ${replaceEnding(100, 200)}`, servedBy: 'BRAVO' });
    expect(res.body.error).toContain('replaced-by-restore-100');
    expect(res.body.error.endsWith(MAIN)).toBe(true);
    expect(res.body.error).not.toContain('On BRAVO:');
  });
});

describe('the no-answer endings', () => {
  it('a replace with retiredAt 100 while entry 200 exists names newer than 200 and never calls 200 the replaced data', async () => {
    postgresLocal({ ok: false, code: 'io-error', noAnswer: 'timeout' });
    state.allRows = [row(G, 200)];
    const { res } = await post({ guildId: G, retiredAt: 100, replace: true });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(`can't confirm whether server ${G} was restored: the bot did not answer within 50 s. ${replaceEnding(100, 200)}`);
    expect(res.body.error).toContain('newer than 200');
    expect(res.body.error).not.toContain('entry 200');
  });

  it('with retiredAt absent X and N are both the newest entry', async () => {
    postgresLocal({ ok: false, code: 'io-error', noAnswer: 'stopped' });
    state.allRows = [row(G, 200), row(G, 150)];
    const { res } = await post({ guildId: G, replace: true });
    expect(res.body.error).toBe(`can't confirm whether server ${G} was restored: the bot process stopped before answering. ${replaceEnding(200, 200)}`);
  });

  it('with no entry and a retiredAt, the ending drops "newer than"', async () => {
    postgresLocal({ ok: false, code: 'io-error', noAnswer: 'timeout' });
    const { res } = await post({ guildId: G, retiredAt: 100, replace: true });
    expect(res.body.error).toBe(`can't confirm whether server ${G} was restored: the bot did not answer within 50 s. ${replaceEnding(100, undefined)}`);
  });

  it('with no entry and no retiredAt, X is unknown', async () => {
    postgresLocal({ ok: false, code: 'io-error', noAnswer: 'failed' });
    const { res } = await post({ guildId: G, replace: true });
    expect(res.body.error).toBe(`can't confirm whether server ${G} was restored: the request could not be handed to the bot. ${replaceEnding(undefined, undefined)}`);
  });

  it('a plain restore takes the plain ending', async () => {
    postgresLocal({ ok: false, code: 'io-error', noAnswer: 'timeout' });
    state.allRows = [row(G, 200)];
    const { res } = await post({ guildId: G });
    expect(res.body.error).toBe(`can't confirm whether server ${G} was restored: the bot did not answer within 50 s. ${plainEnding(200)}`);
  });
});

describe('the answers', () => {
  it('the live-data 409 carries refusal and retiredAt from the reply', async () => {
    const { res } = await post({ guildId: G }, () => ({ ok: false, code: 'invalid', refusal: 'live-data', retiredAt: 5, error: liveText(5) }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, refusal: 'live-data', retiredAt: 5, error: liveText(5) });
  });

  it('a reply with the live-data text and no refusal field yields no refusal', async () => {
    const { res } = await post({ guildId: G }, () => ({ ok: false, code: 'invalid', error: liveText(5) }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: liveText(5) });
  });

  it('ok with replaced answers 200 with copied, keptUntil and replaced', async () => {
    const reply = { ok: true, retiredAt: 5, reason: 'webui-operator-delete', keptUntil: 86_400_005, copied: 3, replaced: { retiredAt: 7, moved: 2, reason: 'replaced-by-restore-5' } };
    const { res } = await post({ guildId: G, retiredAt: 5, replace: true }, () => reply);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, retiredAt: 5, reason: 'webui-operator-delete', keptUntil: 86_400_005, copied: 3, replaced: { retiredAt: 7, moved: 2, reason: 'replaced-by-restore-5' } });
  });

  it('ok with replaced null and a failed sync answers both', async () => {
    const { res } = await post({ guildId: G, replace: true }, () => ({ ok: true, retiredAt: 5, reason: 'r', keptUntil: 9, replaced: null, moveUnconfirmed: 'EIO' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, retiredAt: 5, reason: 'r', keptUntil: 9, replaced: null, warning: WARNING });
  });
});

describe('the GET route with ?guildId=', () => {
  it('lists the guild\'s JSON entries only', async () => {
    const mine = await jsonEntry(G);
    await jsonEntry(OTHER);
    const { start } = graveyardApp(() => ({}));
    const app = await start();
    try {
      const res = await call(app.url, 'GET', `/api/data/graveyard?guildId=${G}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, entries: [{ guildId: G, retiredAt: mine, reason: 'webui-operator-delete', backend: 'file' }] });
    } finally {
      await app.close();
    }
  });

  it('reads one guild\'s batches through listGuildGraveyard, never the whole listing', async () => {
    setBackendKind('postgres');
    state.marker = null;
    state.allRows = [row(G, 300), row(G, 400), row(OTHER, 900)];
    const { start } = graveyardApp(() => ({}));
    const app = await start();
    try {
      const res = await call(app.url, 'GET', `/api/data/graveyard?guildId=${G}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([{ ...row(G, 400), backend: 'postgres' }, { ...row(G, 300), backend: 'postgres' }]);
      expect(state.listGuildCalls).toEqual([G]);
      expect(state.listAllCalls).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['an unprovisioned store', Object.assign(new Error('relation "guild_data_graveyard" does not exist'), { code: '42P01' }), 500, 'relation "guild_data_graveyard" does not exist'],
    ['a query timeout', new Error('Query read timeout'), 500, 'Query read timeout'],
    ['an unreachable database', new Error('data backend unreachable (connect ECONNREFUSED)'), 503, 'Data backend unreachable; retry shortly'],
  ] as const)('a failed read of the guild\'s batches answers its own cause (%s)', async (_name, failure, status, text) => {
    setBackendKind('postgres');
    state.marker = null;
    state.listGuild = async () => { throw failure; };
    const { start } = graveyardApp(() => ({}));
    const app = await start();
    try {
      const res = await call(app.url, 'GET', `/api/data/graveyard?guildId=${G}`);
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ success: false, error: text });
    } finally {
      await app.close();
    }
  });

  it('a JSON graveyard folder that cannot be listed answers its error, not an empty list', async () => {
    await jsonEntry(G);
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p) === dataPath('_graveyard')) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      return (readdir as any)(p, ...rest);
    }) as any);
    const { start } = graveyardApp(() => ({}));
    const app = await start();
    try {
      const res = await call(app.url, 'GET', `/api/data/graveyard?guildId=${G}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'EMFILE: too many open files' });
    } finally {
      await app.close();
    }
  });

  it('a JSON graveyard folder that cannot be listed refuses a restore with 503 before the send', async () => {
    await jsonEntry(G);
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p) === dataPath('_graveyard')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readdir as any)(p, ...rest);
    }) as any);
    const { res, requests } = await post({ guildId: G, replace: true });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'the graveyard list could not be read (EACCES: permission denied); nothing was restored; try again in a moment' });
    expect(requests).toEqual([]);
  });
});

/** Waits on setImmediate (fake timers leave it real) until check holds, at most 2000 turns. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
  expect(check()).toBe(true);
}

/**
 * A local server that speaks pg's startup (AuthenticationOk, ReadyForQuery) and never answers a query, until
 * answering is set: then each Sync gets an empty result of the graveyard read's four columns.
 */
async function heldPgServer() {
  const msg = (type: string, body: Buffer) => {
    const head = Buffer.alloc(5);
    head.write(type, 0, 'latin1');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  };
  const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
  const field = (name: string) => Buffer.concat([Buffer.from(`${name}\0`), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]);
  const columns = ['guild_id', 'retired_at', 'reason', 'row_count'];
  const emptyResult = Buffer.concat([
    msg('1', Buffer.alloc(0)),
    msg('2', Buffer.alloc(0)),
    msg('T', Buffer.concat([int16(columns.length), ...columns.map(field)])),
    msg('C', Buffer.from('SELECT 0\0')),
    msg('Z', Buffer.from('I')),
  ]);
  const sockets = new Set<net.Socket>();
  const pg = {
    port: 0, opened: 0, closed: 0, queries: 0, answering: false,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
  const server = net.createServer(socket => {
    sockets.add(socket);
    pg.opened += 1;
    socket.on('close', () => { pg.closed += 1; sockets.delete(socket); });
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
          buffer = buffer.subarray(buffer.readInt32BE(0));
          started = true;
          socket.write(Buffer.concat([msg('R', int32(0)), msg('Z', Buffer.from('I'))]));
          continue;
        }
        if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) return;
        const type = String.fromCharCode(buffer[0]);
        buffer = buffer.subarray(1 + buffer.readInt32BE(1));
        if (type === 'X') socket.end();
        if (type === 'P' || type === 'Q') pg.queries += 1;
        if (pg.answering && type === 'S') socket.write(emptyResult);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  pg.port = (server.address() as net.AddressInfo).port;
  return pg;
}

describe('the reader', () => {
  it('listGuildGraveyard reads one guild with a 5 s query_timeout; the pool bounds every query at 10 s with keepalive', async () => {
    setWebuiDataStoreUrl({ url: 'postgres://reader:pw@db.example:5432/smdb' });
    try {
      state.poolConfigs = [];
      state.clientQueries = [];
      const entries = await new WebuiDataReader().listGuildGraveyard('5');
      expect(entries).toEqual([{ guildId: '5', retiredAt: 700, reason: 'webui-operator-delete', rows: 2 }]);
      expect(state.poolConfigs[0]).toMatchObject({ query_timeout: 10000, keepAlive: true });
      expect(state.clientQueries).toHaveLength(1);
      expect(state.clientQueries[0].text).toMatch(/WHERE guild_id = \$1/);
      expect(state.clientQueries[0].values).toEqual(['5']);
      expect(state.clientQueries[0].query_timeout).toBeGreaterThan(4000);
      expect(state.clientQueries[0].query_timeout).toBeLessThanOrEqual(5000);
    } finally {
      setWebuiDataStoreUrl(null);
    }
  });
  it('two reads held past 10 s are both rejected and both sockets closed; a restore then reads N and sends', async () => {
    const pg = await heldPgServer();
    state.realPool = true;
    setWebuiDataStoreUrl({ url: `postgres://reader:pw@127.0.0.1:${pg.port}/smdb` });
    const reader = new WebuiDataReader();
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reads = [reader.listFiles(G), reader.listFiles(G)].map(p => p.then(() => null, (error: unknown) => error));
      await until(() => pg.queries === 2);
      vi.advanceTimersByTime(10_001);
      const answers = await Promise.all(reads);
      for (const answer of answers) expect(answer).toBeInstanceOf(Error);
      await until(() => pg.closed === 2);
      expect(pg.opened).toBe(2);
      vi.useRealTimers();

      pg.answering = true;
      state.listGuild = guildId => reader.listGuildGraveyard(guildId);
      const sent = postgresLocal({ ok: true, retiredAt: 5, reason: 'r', keptUntil: 9 });
      const { res } = await post({ guildId: G });
      expect(res.status).toBe(200);
      expect(state.order).toEqual(['read', 'send']);
      expect(sent).toHaveLength(1);
      expect(pg.opened).toBe(3);
    } finally {
      vi.useRealTimers();
      state.realPool = false;
      await (reader as unknown as { pool: { end: () => Promise<void> } | null }).pool?.end().catch(() => undefined);
      setWebuiDataStoreUrl(null);
      await pg.close();
    }
  });
});

describe('the CLI verb', () => {
  const exits: number[] = [];
  let stdout: string[];
  let stderr: string[];
  beforeEach(() => {
    exits.length = 0;
    stdout = [];
    stderr = [];
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exits.push(code); throw new Error(`exit ${code}`); }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true; }) as never);
  });

  /** A client whose GET lists entries and whose POST answers post (a function that throws is a request error). */
  function fakeClient(entries: unknown[] | Error, answer: () => unknown) {
    const requests: Array<{ method: string; path: string; body?: unknown; timeoutMs?: number }> = [];
    const client = {
      request: async (method: string, path: string, opts: { body?: unknown; timeoutMs?: number } = {}) => {
        requests.push({ method, path, body: opts.body, timeoutMs: opts.timeoutMs });
        if (method === 'GET') {
          if (entries instanceof Error) throw entries;
          return { status: 200, ok: true, body: { success: true, entries } };
        }
        return { status: 200, ok: true, body: answer() };
      },
    } as unknown as Client;
    return { client, requests };
  }

  async function run(client: Client, argv: string[]) {
    const { positionals, flags } = parseArgs(argv);
    const tty = process.stdout.isTTY;
    (process.stdout as any).isTTY = true;
    try {
      await dispatch(client, positionals, flags).catch(() => undefined);
    } finally {
      (process.stdout as any).isTTY = tty;
    }
  }

  it.each([[['graveyard', 'restore', G, '5', '--replace']], [['graveyard', 'restore', G, '--replace', '5']]])('%j posts the entry with replace true after a 10 s GET of the guild, the POST bounded at 100 s', async argv => {
    const { client, requests } = fakeClient([row(G, 5)], () => ({ success: true, retiredAt: 5, reason: 'r', keptUntil: 9 }));
    await run(client, argv);
    expect(requests).toEqual([
      { method: 'GET', path: `/api/data/graveyard?guildId=${G}`, body: undefined, timeoutMs: 10_000 },
      { method: 'POST', path: '/api/data/graveyard/restore', body: { guildId: G, retiredAt: 5, replace: true }, timeoutMs: 100_000 },
    ]);
  });

  it('--replace=x exits with the usage code and sends nothing', async () => {
    const { client, requests } = fakeClient([], () => ({}));
    await run(client, ['graveyard', 'restore', G, '--replace=x']);
    expect(exits).toEqual([EXIT_USAGE]);
    expect(stderr.join('')).toContain(REPLACE_TEXT);
    expect(requests).toEqual([]);
  });

  it.each([['abc'], ['12a4']])('a guild id %s that is not all digits exits with the usage code and sends nothing', async id => {
    const { client, requests } = fakeClient([], () => ({}));
    await run(client, ['graveyard', 'restore', id, '--replace']);
    expect(exits).toEqual([EXIT_USAGE]);
    expect(stderr.join('')).toContain('Invalid guild ID format');
    expect(stderr.join('')).not.toContain('try again');
    expect(requests).toEqual([]);
  });

  it('a GET that fails exits with its error and posts nothing', async () => {
    const { client, requests } = fakeClient(new Error('no answer within 10s'), () => ({}));
    await run(client, ['graveyard', 'restore', G, '--replace']);
    expect(exits).toEqual([EXIT_ERR]);
    expect(stderr.join('')).toContain('the graveyard list could not be read (no answer within 10s); nothing was restored; try again in a moment');
    expect(requests.map(r => r.method)).toEqual(['GET']);
  });

  it.each([
    ['a replace with retiredAt', ['5', '--replace'], 200, replaceEnding(5, 200)],
    ['a replace without retiredAt', ['--replace'], 200, replaceEnding(200, 200)],
    ['a replace with no entry', ['--replace'], undefined, replaceEnding(undefined, undefined)],
    ['a plain restore', [], 200, plainEnding(200)],
  ] as const)('a POST with no answer prints the cut answer naming N: %s', async (_name, extra, n, ending) => {
    const { client } = fakeClient(n === undefined ? [] : [row(G, n), row(G, 5)], () => { throw new Error('no answer within 100s'); });
    await run(client, ['graveyard', 'restore', G, ...extra]);
    expect(exits).toEqual([EXIT_ERR]);
    expect(stderr.join('')).toBe(`smdb: can't confirm whether server ${G} was restored: the web UI did not answer. ${ending}\n`);
  });

  const iso = (ms: number) => new Date(ms).toISOString();
  const KEPT = 1_700_000_000_000;
  const memory = (x: number) => `A module that kept this server's data in memory from before the restore may save it again over the restored data; until ${iso(KEPT)}, run: smdb graveyard restore ${G} ${x} --replace to put the restored version back (what the module saved moves to a new entry).`;

  it.each([
    ['a plain restore on a database', { copied: 3 }, `restored server ${G} from the entry deleted at ${iso(5000)} (retiredAt 5000, reason webui-operator-delete); 3 row(s) copied; entry 5000 stays in the graveyard until ${iso(KEPT)}`, null],
    ['a plain restore on files', {}, `restored server ${G} from the entry deleted at ${iso(5000)} (retiredAt 5000, reason webui-operator-delete); entry 5000 stays in the graveyard until ${iso(KEPT)}`, null],
    ['a replace that moved rows', { copied: 3, replaced: { retiredAt: 9000, moved: 2, reason: 'replaced-by-restore-5000' } }, `restored server ${G} from the entry deleted at ${iso(5000)} (retiredAt 5000, reason webui-operator-delete); 3 row(s) copied; entry 5000 stays in the graveyard until ${iso(KEPT)}`, `the data it replaced is entry 9000 (deleted at ${iso(9000)}, reason replaced-by-restore-5000, 2 row(s)); to put it back, run: smdb graveyard restore ${G} 9000 --replace`],
    ['a replace whose note was not written', { replaced: { retiredAt: 9000 } }, `restored server ${G} from the entry deleted at ${iso(5000)} (retiredAt 5000, reason webui-operator-delete); entry 5000 stays in the graveyard until ${iso(KEPT)}`, `the data it replaced is entry 9000 (deleted at ${iso(9000)}, listed with an empty reason: its note could not be written; see the bot log); to put it back, run: smdb graveyard restore ${G} 9000 --replace`],
    ['a replace of a server with no data', { replaced: null }, `restored server ${G} from the entry deleted at ${iso(5000)} (retiredAt 5000, reason webui-operator-delete); entry 5000 stays in the graveyard until ${iso(KEPT)}`, 'the server had no data, so nothing was moved to the graveyard'],
  ] as const)('the ok lines: %s', async (_name, extra, first, second) => {
    const { client } = fakeClient([row(G, 5000)], () => ({ success: true, retiredAt: 5000, reason: 'webui-operator-delete', keptUntil: KEPT, ...extra }));
    await run(client, ['graveyard', 'restore', G, ...('replaced' in extra ? ['--replace'] : [])]);
    expect(exits).toEqual([0]);
    expect(stdout.join('')).toBe([first, ...(second ? [second] : []), memory(5000)].join('\n') + '\n');
    expect(stdout.join('')).not.toContain('moved\n');
  });

  it('an ok with a warning prints it on stderr after the ok lines', async () => {
    const { client } = fakeClient([row(G, 5000)], () => ({ success: true, retiredAt: 5000, reason: 'r', keptUntil: KEPT, warning: WARNING }));
    await run(client, ['graveyard', 'restore', G]);
    expect(exits).toEqual([0]);
    expect(stderr.join('')).toBe(`smdb: warning: ${WARNING}\n`);
  });
});

describe('the help', () => {
  it('lists [--replace] on the restore line', async () => {
    let out = '';
    const argv = process.argv;
    process.argv = [argv[0], 'smdb', '--help'];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out += String(chunk); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    let exitsSeen = 0;
    vi.spyOn(process, 'exit').mockImplementation((() => { exitsSeen += 1; if (exitsSeen === 1) throw new Error('exit'); }) as never);
    try {
      vi.resetModules();
      await import('../../src/cli/smdb');
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      process.argv = argv;
    }
    expect(out).toContain('graveyard list | graveyard restore <guildId> [retiredAt | --retired-at MS] [--replace]');
  });
});

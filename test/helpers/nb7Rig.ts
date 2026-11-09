import { vi } from 'vitest';

import { _resetGuildRequests, _setGuildRequestDeps, planGuildChange, type RequestConn, type RequestDb } from '../../src/webui/utils/guildRequests';
import { POLL_SET_SQL, REPLY_READ_SQL, REQUEST_INSERT_SQL, REQUEST_POLL_SQL, SETTLE_INSERT_SQL, SETTLE_UPDATE_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { setBackendKind } from './backendKind';

// NB7's web UI rig: the request route over scripted databases, one per URL, a scripted holder check and database
// read, this machine's node id, and a BotManager whose route and child answers are set by the test.

export type Script = (sql: string, values: unknown[]) => unknown;
export interface Statement { url: string; sql: string; values: unknown[]; boundMs: number }

export const isInsert = (s: Statement) => s.sql === REQUEST_INSERT_SQL;
export const isPoll = (s: Statement) => s.sql === REQUEST_POLL_SQL || s.sql === POLL_SET_SQL;
export const isSettleInsert = (s: Statement) => s.sql === SETTLE_INSERT_SQL;
export const isSettleUpdate = (s: Statement) => s.sql === SETTLE_UPDATE_SQL;

/** A guild of shard 1 of 2 (its id >> 22 is odd). */
export const GUILD = String(1n << 22n);
export const HANG = Symbol('hang');

export function heldRow(over: Record<string, unknown> = {}) {
  return {
    n: 2, shard: 1, holder_process: 'p-b', holder_node: 'n-b', holder_name: 'BRAVO', claim: '4',
    released: false, reserved: false, ttl_ms: '30000', expires_up_ms: '90000',
    renewed_ago_ms: 10, up_ms: '1000', node_process_id: 'p-b', node_takeover_seconds: 30, node_seen_ago_ms: 10,
    ...over,
  };
}

export interface Rig {
  statements: Statement[];
  ended: string[];
  connects: string[];
  script: { [url: string]: Script };
  connectFails: { [url: string]: Error | undefined };
  holder: () => unknown;
  holderCalls: Array<{ guildId: string; boundMs: number }>;
  docs: Map<string, string>;
  readDocCalls: Array<{ guildId: string; module: string; filename: string; boundMs?: number }>;
  url: string;
  nodeId: string | null;
  /** The server instance a connection of the URL reaches, as the request pool reads it at the hand-out. */
  server: { [url: string]: string | undefined };
  /** NB15 decision 21: the class a connection of the URL has; unset is not 'unprotected'. */
  transport: { [url: string]: 'verified' | 'local' | 'unprotected' | undefined };
  /** NB15 decision 22: the reply read's answer for an id; unset reads the row the last poll read. */
  replyRead?: (id: string) => unknown;
}

/** Answers a scripted statement as the server would: a value, an Error to throw, or HANG for no answer by the bound. */
function answerOf(value: unknown, boundMs: number): Promise<any> {
  if (value === HANG) return new Promise((_, reject) => { setTimeout(() => reject(new Error('Query read timeout')), boundMs); });
  if (value instanceof Error) return Promise.reject(value);
  if (value instanceof Promise) return value;
  return Promise.resolve(value ?? { rows: [], rowCount: 0 });
}

/**
 * NB15 decision 22: the poll per pool, answered from the scripts written for one poll per request (each id asked as
 * REQUEST_POLL_SQL); the reply read answers from the row the last poll read.
 */
const lastPolled = new Map<string, any>();

async function pollSet(script: Script, ids: string[], boundMs: number): Promise<any> {
  const rows: any[] = [];
  for (const id of ids) {
    const res = await answerOf(script(REQUEST_POLL_SQL, [id]), boundMs);
    const row = res?.rows?.[0];
    if (row) {
      lastPolled.set(id, row);
      const { reply: _reply, ...states } = row;
      rows.push({ id, ...states });
    }
  }
  return { rows, rowCount: rows.length };
}

export function nb7Rig(): Rig {
  _resetGuildRequests();
  lastPolled.clear();
  const rig: Rig = {
    statements: [], ended: [], connects: [], script: {}, connectFails: {},
    holder: () => ({ rows: [heldRow()] }), holderCalls: [], docs: new Map(), readDocCalls: [], url: 'postgres://one', nodeId: 'n-a', server: {},
    transport: {},
  };
  const dbFor = (url: string): RequestDb => ({
    connect: async (_boundMs: number): Promise<RequestConn> => {
      rig.connects.push(url);
      const fail = rig.connectFails[url];
      if (fail) throw fail;
      return {
        server: rig.server[url],
        get transport() { return rig.transport[url]; },
        query: (sql: string, values: unknown[], boundMs: number) => {
          rig.statements.push({ url, sql, values, boundMs });
          const script = rig.script[url] ?? (() => undefined);
          if (sql === POLL_SET_SQL) return pollSet(script, values[0] as string[], boundMs);
          if (sql === REPLY_READ_SQL) {
            if (rig.replyRead) return answerOf(rig.replyRead(values[0] as string), boundMs);
            const row = lastPolled.get(values[0] as string);
            return Promise.resolve(row && row.state === 'done' ? { rows: [{ reply: row.reply }], rowCount: 1 } : { rows: [], rowCount: 0 });
          }
          return answerOf(script(sql, values), boundMs);
        },
        release: () => undefined,
      };
    },
    end: async () => { rig.ended.push(url); },
  });
  _setGuildRequestDeps({
    holderOf: async (guildId: string, boundMs: number) => {
      rig.holderCalls.push({ guildId, boundMs });
      return answerOf(rig.holder(), boundMs);
    },
    readDoc: async (guildId: string, module: string, filename: string, boundMs?: number) => {
      rig.readDocCalls.push({ guildId, module, filename, boundMs });
      return rig.docs.get(`${guildId}/${module}/${filename}`) ?? null;
    },
    currentUrl: () => rig.url,
    requestDb: dbFor,
    nodeId: () => rig.nodeId,
    nodeName: () => 'ALPHA',
  });
  setBackendKind('postgres');
  return rig;
}

export function resetNb7(): void {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
}

export const fakeTime = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });

/** A BotManager whose guild route and child replies the test sets. */
export function fakeBot(opts: { route?: any; read?: (req: any) => any; write?: (req: any) => any } = {}) {
  const reads: any[] = [];
  const writes: any[] = [];
  const bot = {
    isRunning: () => (opts.route ?? { route: 'child' }).route === 'child',
    writerRoute: () => opts.route ?? { route: 'child' },
    readGuildData: async (req: any) => { reads.push(req); return opts.read ? opts.read(req) : { ok: true }; },
    writeGuildData: async (req: any) => { writes.push(req); return opts.write ? opts.write(req) : { ok: true }; },
  };
  return { bot: bot as any, reads, writes };
}

export const BOT_DOWN = { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' };

/** A request plan: this machine's bot down, the shard held by BRAVO. */
export async function requestPlan(op: 'write' | 'delete' | 'delete-namespace' | 'restore-graveyard' = 'write') {
  const plan = await planGuildChange(fakeBot({ route: BOT_DOWN }).bot, GUILD, op);
  if (plan.kind !== 'request') throw new Error(`expected a request plan, got ${plan.kind}`);
  return plan;
}

export const writeOf = (over: Record<string, unknown> = {}) => ({ guildId: GUILD, module: 'm', filename: 'a.json', op: 'write' as const, contentJson: '{"a":1}', expectSha: 'absent', ...over });

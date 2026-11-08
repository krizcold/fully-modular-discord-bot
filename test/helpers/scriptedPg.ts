import { vi } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from './fixedDatabase';

// The real PostgresBackend over a pool whose clients answer by script, as the server would: the fenced claim
// updates one row, every SELECT reads no row, and each query takes what the script says. A query with a
// query_timeout rejects with pg's 'Query read timeout' when the script answers later than that.

export interface Sent {
  sql: string;
  params?: unknown[];
  /** The first argument exactly as the backend passed it (a string, or a QueryConfig). */
  raw: unknown;
  /** The client it went out on, numbered from 1 in connect order. */
  client: number;
}

export type Answer = (sql: string, params: unknown[] | undefined, call: number, client: number) => unknown | Promise<unknown>;

export function scriptedBackend(answer: Answer = () => undefined) {
  const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
  (backend as unknown as { state: string }).state = 'ready';
  const sent: Sent[] = [];
  let out = 0;
  let maxOut = 0;
  let clients = 0;
  /** Each release in order: its client and whether it was destroyed. */
  const releases: Array<{ client: number; destroyed: boolean }> = [];
  const connect = vi.fn(async () => {
    out += 1;
    maxOut = Math.max(maxOut, out);
    clients += 1;
    const client = clients;
    return {
      query: async (raw: unknown, params?: unknown[]) => {
        const sql = typeof raw === 'string' ? raw : String((raw as { text?: unknown })?.text ?? '');
        sent.push({ sql, params, raw, client });
        if (/INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) return { rows: [], rowCount: 1 };
        const values = params ?? (typeof raw === 'string' ? undefined : (raw as { values?: unknown[] })?.values);
        const timeout = typeof raw === 'string' ? undefined : (raw as { query_timeout?: number })?.query_timeout;
        const answered = Promise.resolve(answer(sql, values, sent.length, client));
        const res = timeout === undefined ? await answered : await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Query read timeout')), timeout);
          answered.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
        });
        if (res instanceof Error) throw res;
        return res ?? { rows: [], rowCount: 0 };
      },
      release: (destroy?: boolean) => { out -= 1; releases.push({ client, destroyed: destroy === true }); },
    };
  });
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, sent, connect, releases, maxOut: () => maxOut, out: () => out };
}

export const bytesOf = (s: Omit<Sent, 'client'>) => Buffer.byteLength(s.sql) + (s.params ?? []).reduce<number>((n, v) => n + (v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);

import { vi } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// The real PostgresBackend over a pool whose clients answer by script, as the server would: the fenced claim
// updates one row, every SELECT reads no row, and each query takes what the script says. A query with a
// query_timeout rejects with pg's 'Query read timeout' when the script answers later than that.

export interface Sent {
  sql: string;
  params?: unknown[];
  /** The first argument exactly as the backend passed it (a string, or a QueryConfig). */
  raw: unknown;
}

export type Answer = (sql: string, params: unknown[] | undefined, call: number) => unknown | Promise<unknown>;

export function scriptedBackend(answer: Answer = () => undefined) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  (backend as unknown as { state: string }).state = 'ready';
  const sent: Sent[] = [];
  let out = 0;
  let maxOut = 0;
  const connect = vi.fn(async () => {
    out += 1;
    maxOut = Math.max(maxOut, out);
    return {
      query: async (raw: unknown, params?: unknown[]) => {
        const sql = typeof raw === 'string' ? raw : String((raw as { text?: unknown })?.text ?? '');
        sent.push({ sql, params, raw });
        if (/INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) return { rows: [], rowCount: 1 };
        const values = params ?? (typeof raw === 'string' ? undefined : (raw as { values?: unknown[] })?.values);
        const timeout = typeof raw === 'string' ? undefined : (raw as { query_timeout?: number })?.query_timeout;
        const answered = Promise.resolve(answer(sql, values, sent.length));
        const res = timeout === undefined ? await answered : await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Query read timeout')), timeout);
          answered.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
        });
        if (res instanceof Error) throw res;
        return res ?? { rows: [], rowCount: 0 };
      },
      release: () => { out -= 1; },
    };
  });
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, sent, connect, maxOut: () => maxOut, out: () => out };
}

export const bytesOf = (s: Sent) => Buffer.byteLength(s.sql) + (s.params ?? []).reduce<number>((n, v) => n + (v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);

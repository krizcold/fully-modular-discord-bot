import { vi } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

export type Answer = { rows?: unknown[]; rowCount?: number } | Error | 'hang' | undefined;
type Late = Promise<Exclude<Answer, 'hang'>>;

export const isBegin = (s: string) => s === 'BEGIN';
export const isFenced = (s: string) => /^INSERT INTO smdb_data\.guild_ownership AS o\b/.test(s);
export const isOwnerInsert = (s: string) => /^INSERT INTO smdb_data\.guild_ownership\s*\(/.test(s);
export const isBatch = (s: string) => /max\(retired_at\)/i.test(s);
export const isLive = (s: string) => /guild_append WHERE guild_id = \$1\) AS present/.test(s);
export const isMove = (s: string) => /^WITH moved AS/.test(s);
export const isOwnerRead = (s: string) => /^SELECT node_id, claim FROM smdb_data\.guild_ownership/.test(s);
export const isGraveInsert = (s: string) => /^INSERT INTO smdb_data\.guild_data_graveyard/.test(s);
export const isBatchExists = (s: string) => !isMove(s) && /^SELECT\b[\s\S]*smdb_data\.guild_data_graveyard\s+WHERE\s+guild_id\s*=\s*\$1\s+AND\s+retired_at\s*=\s*\$2/.test(s);

/** Postgres's rows for the given batch's existence read: SELECT EXISTS gives one boolean row, SELECT 1 a row only when found. */
export function batchExistsAnswer(sql: string, found: boolean): Answer {
  if (/^SELECT\s+EXISTS\b/i.test(sql)) {
    const column = /\)\s+AS\s+(\w+)\s*$/i.exec(sql)?.[1] ?? 'exists';
    return { rows: [{ [column]: found }], rowCount: 1 };
  }
  const one = /^SELECT\s+1(?:\s+AS\s+(\w+))?\s+FROM\b/i.exec(sql);
  if (!one) throw new Error(`[Test] No scripted answer for the batch read: ${sql}`);
  return found ? { rows: [{ [one[1] ?? '?column?']: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
}

/**
 * A provisioned backend whose pool hands out one client like pg's: one active query at a time; a statement scripted
 * to hang, or to answer later than its query_timeout, rejects with pg's own 'Query read timeout' once that timeout
 * passes and leaves the client busy. A statement queued behind a busy client is never sent.
 */
export function scriptedPg(answer: (sql: string) => Answer | Late, onConnect?: () => void) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  const internals = backend as unknown as { state: string; provisioned: boolean };
  internals.state = 'ready';
  internals.provisioned = true;
  const sent: { sql: string; timeout?: number }[] = [];
  const queued: string[] = [];
  const releases: (boolean | undefined)[] = [];
  let busy = false;
  const client = {
    query: (config: string | { text: string; values?: unknown[]; query_timeout?: number }) => {
      const sql = (typeof config === 'string' ? config : config.text).trim();
      const timeout = typeof config === 'string' ? undefined : config.query_timeout;
      if (busy) {
        queued.push(sql);
        return new Promise(() => {});
      }
      sent.push({ sql, timeout });
      const res = answer(sql);
      if (res === 'hang' || res instanceof Promise) {
        busy = true;
        return new Promise((resolve, reject) => {
          let timedOut = false;
          const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; reject(new Error('Query read timeout')); }, timeout);
          if (res === 'hang') return;
          void res.then(value => {
            if (timedOut) return;
            clearTimeout(timer);
            busy = false;
            if (value instanceof Error) reject(value);
            else resolve(value ?? { rows: [], rowCount: 0 });
          });
        });
      }
      if (res instanceof Error) return Promise.reject(res);
      return Promise.resolve(res ?? { rows: [], rowCount: 0 });
    },
    release: (destroy?: boolean) => { releases.push(destroy); },
  };
  const connect = vi.fn(async () => { onConnect?.(); return client; });
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  const statements = () => sent.map(s => s.sql);
  return { backend, sent, queued, releases, connect, statements };
}

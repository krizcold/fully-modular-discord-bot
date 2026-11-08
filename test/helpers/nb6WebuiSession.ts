import { sharedRows } from './sharedRows';

// The web UI's short-lived sessions (NB6 decision 7 as C4 amends it, part 10) over helpers/sharedRows.ts's tables: each
// session is a client of its own, every query records its text, values and query_timeout, and a query whose answer
// comes later than its query_timeout rejects with pg's 'Query read timeout', as node-postgres does.

export interface SessionQuery {
  sql: string;
  params?: unknown[];
  timeout?: number;
  session: number;
}

export function webuiSessions(rows = sharedRows()) {
  const sent: SessionQuery[] = [];
  const configs: Array<Record<string, unknown>> = [];
  /** Each session's end, in order, and each one destroyed. */
  const ended: number[] = [];
  const destroyed: number[] = [];
  const state = {
    connectFault: null as Error | null,
    /** Answers a query before the tables do: a promise to wait on, an Error to throw; undefined lets the tables answer. */
    before: null as null | ((sql: string, session: number) => unknown),
  };
  let count = 0;
  const session = (config: Record<string, unknown>) => {
    count += 1;
    const id = count;
    configs.push(config);
    return {
      connect: async () => {
        if (state.connectFault) throw state.connectFault;
      },
      query: async (q: { text: string; values?: unknown[]; query_timeout?: number }) => {
        sent.push({ sql: q.text, params: q.values, timeout: q.query_timeout, session: id });
        const answered = (async () => {
          const first = await state.before?.(q.text, id);
          if (first instanceof Error) return first;
          return rows.answer(q.text, q.values, sent.length, 1000 + id);
        })();
        const res = q.query_timeout === undefined ? await answered : await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Query read timeout')), q.query_timeout);
          answered.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
        });
        if (res instanceof Error) throw res;
        return (res ?? { rows: [], rowCount: 0 }) as { rows: any[] };
      },
      end: async () => {
        ended.push(id);
      },
      destroy: () => {
        destroyed.push(id);
      },
    };
  };
  return { rows, sent, configs, ended, destroyed, state, session, sessions: () => count };
}

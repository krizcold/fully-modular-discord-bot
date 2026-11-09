import { POLL_SET_SQL, REPLY_READ_SQL, REQUEST_POLL_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

// NB15 decision 22 replaced NB7's poll per request with one states-only poll per pool and one reply read per 'done'
// row. NB7's scripted tests answer REQUEST_POLL_SQL; this shim answers the poll per pool from that script (each id
// asked once, its row given the id) and the reply read from the row the last poll read. One ANY($1) statement fails or
// hangs as a whole, so an id whose script fails or hangs fails or hangs the poll of every id it carries.

type ScriptFn = (sql: string, values?: unknown[]) => unknown;

function withId(value: unknown, id: string, seen: Map<string, any>): unknown {
  const tag = (res: any) => {
    const row = res?.rows?.[0];
    if (!row) return { rows: [], rowCount: 0 };
    seen.set(id, row);
    const { reply: _reply, ...states } = row;
    return { rows: [{ id, ...states }], rowCount: 1 };
  };
  if (value instanceof Promise) return value.then(tag);
  if (value instanceof Error || typeof value === 'symbol') return value;
  return tag(value ?? { rows: [] });
}

/** A script over the new statements, read through the current script at each call. */
export function pollShim(current: () => ScriptFn): (sql: string, values?: unknown[]) => unknown {
  const seen = new Map<string, any>();
  return (sql, values = []) => {
    const script = current();
    if (sql === POLL_SET_SQL) {
      const ids = (values[0] as string[]) ?? [];
      if (ids.length === 1) return withId(script(REQUEST_POLL_SQL, [ids[0]]), ids[0], seen);
      const answers = ids.map(id => script(REQUEST_POLL_SQL, [id]));
      const whole = answers.find(a => a instanceof Error || typeof a === 'symbol');
      if (whole !== undefined) return whole;
      return Promise.all(answers.map((a, i) => Promise.resolve(withId(a, ids[i], seen)))).then(all => {
        const failed = all.find(r => r instanceof Error || typeof r === 'symbol');
        if (failed !== undefined) return failed;
        const rows = all.flatMap((r: any) => r?.rows ?? []);
        return { rows, rowCount: rows.length };
      });
    }
    if (sql === REPLY_READ_SQL) {
      const row = seen.get(values[0] as string);
      return row && row.state === 'done' ? { rows: [{ reply: row.reply }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return script(sql, values);
  };
}

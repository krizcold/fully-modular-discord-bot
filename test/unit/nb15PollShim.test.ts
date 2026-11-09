import { describe, expect, it } from 'vitest';

// The poll shim answers a poll of several ids as one ANY($1) statement does on Postgres: every id's row, or the whole
// poll failing or hanging when one id's script fails or hangs.
import { POLL_SET_SQL, REQUEST_POLL_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { pollShim } from '../helpers/nb15PollShim';

const HANG = Symbol('hang');
const pending = { rows: [{ state: 'pending', reply: null, pickup_over: false, answer_over: false }] };

describe('the poll shim', () => {
  it('a poll of two ids returns both rows, each with its id, and rowCount the number of rows', async () => {
    const shim = pollShim(() => (sql, values) => (sql === REQUEST_POLL_SQL && values?.[0] === 'b' ? { rows: [] } : sql === REQUEST_POLL_SQL ? pending : undefined));
    const res: any = await shim(POLL_SET_SQL, [['a', 'b', 'c']]);
    expect(res.rows.map((r: any) => r.id)).toEqual(['a', 'c']);
    expect(res.rowCount).toBe(2);
  });

  it("one id's failure fails the poll of every id, never a poll with that id left out", async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const shim = pollShim(() => (sql, values) => (sql === REQUEST_POLL_SQL ? (values?.[0] === 'b' ? lost : pending) : undefined));
    expect(await shim(POLL_SET_SQL, [['a', 'b']])).toBe(lost);
  });

  it("one id's hang hangs the poll of every id", async () => {
    const shim = pollShim(() => (sql, values) => (sql === REQUEST_POLL_SQL ? (values?.[0] === 'a' ? HANG : pending) : undefined));
    expect(await shim(POLL_SET_SQL, [['a', 'b']])).toBe(HANG);
  });

  it("one id's rejected answer rejects the poll of every id", async () => {
    const shim = pollShim(() => (sql, values) => (sql === REQUEST_POLL_SQL ? (values?.[0] === 'b' ? Promise.reject(new Error('Query read timeout')) : pending) : undefined));
    await expect(Promise.resolve(shim(POLL_SET_SQL, [['a', 'b']]))).rejects.toThrow('Query read timeout');
  });
});

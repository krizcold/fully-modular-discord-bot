import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 3 (decisions 9 to 12 and 22): the sender of a panel request over scripted pools with fake time. The spans
// and T; the body bound; one states-only poll per pool for the ids of its poll set; one reply read per 'done' row;
// the holder's codes as "nothing was run"; can't confirm when the outcome is unknown; every answer by T.
import { planGuildRequest, runGuildRequest, type PanelPlan } from '../../src/webui/utils/guildRequests';
import { POLL_SET_SQL, REPLY_READ_SQL, REQUEST_INSERT_SQL, SETTLE_INSERT_SQL, SETTLE_UPDATE_SQL, answerSpanS, changeDeadlineMs } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { PANEL_REQUEST_OPS, isReadOp } from '../../src/bot/internalSetup/utils/panelRequestShape';
import { BOT_DOWN, GUILD, HANG, fakeTime, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const URL1 = 'postgres://one';
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const down = { writerRoute: () => BOT_DOWN, isRunning: () => false } as any;

let rig: Rig;
let rows: Map<string, any>;

beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
  rows = new Map();
});
afterEach(() => {
  resetNb7();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A database whose rows the test moves: an insert makes a pending row; the poll per pool reads them. */
function database(onInsert: (id: string) => void = () => undefined, poll?: (ids: string[]) => unknown) {
  rig.script[URL1] = (sql, values) => {
    if (sql === REQUEST_INSERT_SQL) {
      const id = values[0] as string;
      rows.set(id, { state: 'pending', reply: null, pickup_over: false, answer_over: false });
      onInsert(id);
      return { rows: [], rowCount: 1 };
    }
    return undefined;
  };
  // The rig answers POLL_SET_SQL from REQUEST_POLL_SQL per id; this script reads the rows map.
  const inner = rig.script[URL1];
  rig.script[URL1] = (sql, values) => {
    if (sql.includes('WHERE id = $1') && !sql.includes('AND state')) {
      if (poll) return poll([values[0] as string]);
      const row = rows.get(values[0] as string);
      return row ? { rows: [row] } : { rows: [] };
    }
    return inner(sql, values);
  };
}

async function start(op: (typeof PANEL_REQUEST_OPS)[number] = 'panel:button', payload: Record<string, unknown> = { panelId: 'p', buttonId: 'b', userId: 'web-ui-owner', actor: OWNER }) {
  const plan = await planGuildRequest(down, GUILD, op, 'owner');
  const started = performance.now();
  let value: any;
  let at = -1;
  void runGuildRequest(plan, payload, async () => ({})).then(v => { value = v; at = performance.now() - started; });
  return { plan, result: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); return { value, at }; } };
}

describe('spans and T (decision 11)', () => {
  it.each(PANEL_REQUEST_OPS.map(op => [op]))('%s', op => {
    expect(answerSpanS(op)).toBe(isReadOp(op) ? 10 : 30);
    expect(changeDeadlineMs(op)).toBe(isReadOp(op) ? 40_000 : 60_000);
  });

  it('T starts at the turn to the request route: a child that answers not-held after 20 s still leaves 60 s', async () => {
    database();
    const bot = { writerRoute: () => ({ route: 'child' }), isRunning: () => true } as any;
    const plan = await planGuildRequest(bot, GUILD, 'panel:button', 'owner');
    expect(plan.kind).toBe('local');
    const local = () => new Promise(resolve => { setTimeout(() => resolve({ success: false, code: 'not-held' }), 20_000); });
    let value: any;
    void runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: OWNER }, local).then(v => { value = v; });
    await vi.advanceTimersByTimeAsync(20_100);
    expect(rig.statements.filter(s => s.sql === REQUEST_INSERT_SQL)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value).toMatchObject({ status: 503, reply: { code: 'no-answer' } });
  });

  it('no insert with less than the span + 15 s left: too slow, nothing sent', async () => {
    database();
    const plan = await planGuildRequest(down, GUILD, 'panel:button', 'owner');
    await vi.advanceTimersByTimeAsync(16_000);
    const answer = await runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: OWNER }, async () => ({}));
    expect(answer).toMatchObject({ status: 503, reply: { code: 'backend-unavailable', error: 'The database answered too slowly to send the panel action to BRAVO in time; nothing was run. Try again in a moment.' } });
    expect(rig.statements.filter(s => s.sql === REQUEST_INSERT_SQL)).toHaveLength(0);
  });

  it('a body over 16 KiB is refused before any statement', async () => {
    database();
    const { result } = await start('panel:modal', { panelId: 'p', modalId: 'm', fields: { a: 'x'.repeat(17 * 1024) }, actor: OWNER });
    const { value } = await result(10);
    expect(value).toMatchObject({ status: 400, reply: { code: 'invalid' } });
    expect(value.reply.error).toMatch(/^This request is \d+ KiB, more than the 16 KiB one machine sends to another; nothing was run\.$/);
    expect(rig.statements).toHaveLength(0);
  });
});

describe('the poll per pool (decision 22)', () => {
  it('ten requests on one pool send one poll per tick carrying every id; the poll selects no reply', async () => {
    database();
    for (let i = 0; i < 10; i++) await start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);
    const polls = rig.statements.filter(s => s.sql === POLL_SET_SQL);
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.length).toBeLessThanOrEqual(6);
    expect(Math.max(...polls.map(p => (p.values[0] as string[]).length))).toBe(10);
    expect(POLL_SET_SQL).not.toMatch(/reply/);
    expect(polls[0].boundMs).toBe(2000);
  });

  it("a 'done' row's reply is read once by its own statement", async () => {
    database(id => { rows.set(id, { state: 'done', reply: JSON.stringify({ success: true, data: { v: 1 } }), pickup_over: true, answer_over: false }); });
    const { result } = await start();
    const { value } = await result(2000);
    expect(value).toMatchObject({ status: null, reply: { success: true, data: { v: 1 }, servedBy: 'BRAVO' } });
    expect(rig.statements.filter(s => s.sql === REPLY_READ_SQL)).toHaveLength(1);
  });

  it("an id missing from the poll's result after an acknowledged insert answers can't confirm lost", async () => {
    database(id => { rows.delete(id); });
    const { result } = await start();
    const { value } = await result(2000);
    expect(value).toMatchObject({ status: 503, reply: { code: 'no-answer', noAnswer: 'lost' } });
    expect(value.reply.error).toBe("The answer from BRAVO could not be read from the database; can't confirm whether the panel action ran. Check the server before you run it again.");
  });

  it('with an insert held open, polls for other ids never carry its id, and it is not settled', async () => {
    database();
    await start();
    await vi.advanceTimersByTimeAsync(10);
    const script = rig.script[URL1];
    let heldId: string | null = null;
    rig.script[URL1] = (sql, values) => (sql === REQUEST_INSERT_SQL ? (heldId = values[0] as string, HANG) : script(sql, values));
    await start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(heldId).not.toBeNull();
    for (const p of rig.statements.filter(s => s.sql === POLL_SET_SQL)) expect(p.values[0]).not.toContain(heldId);
    const settles = rig.statements.filter(s => (s.sql === SETTLE_INSERT_SQL || s.sql === SETTLE_UPDATE_SQL) && s.values[0] === heldId);
    expect(settles, 'R is not settled while its insert is open').toHaveLength(0);
  });

  it('after an insert with no answer, R joins the poll set only once its insert-form settle returned no row', async () => {
    database();
    const inner = rig.script[URL1];
    let rId: string | null = null;
    rig.script[URL1] = (sql, values) => {
      if (sql === REQUEST_INSERT_SQL) {
        inner(sql, values);
        rId = values[0] as string;
        return new Error('Connection terminated unexpectedly');
      }
      if (sql === SETTLE_INSERT_SQL) return { rows: [], rowCount: 0 };
      return inner(sql, values);
    };
    await start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(rId).not.toBeNull();
    const order = rig.statements.filter(s => s.sql === SETTLE_INSERT_SQL || (s.sql === POLL_SET_SQL && (s.values[0] as string[]).includes(rId!))).map(s => s.sql);
    expect(order[0]).toBe(SETTLE_INSERT_SQL);
    expect(order.filter(q => q === POLL_SET_SQL).length, 'R joined the poll set after the settle').toBeGreaterThan(0);
  });

  it('a request leaves the poll set when it decides', async () => {
    let first: string | null = null;
    database(id => { if (!first) { first = id; rows.set(id, { state: 'done', reply: JSON.stringify({ success: true }), pickup_over: true, answer_over: false }); } });
    const a = await start();
    expect((await a.result(1000)).value.reply.success).toBe(true);
    await start();
    await vi.advanceTimersByTimeAsync(2000);
    const later = rig.statements.filter(s => s.sql === POLL_SET_SQL).slice(-3);
    expect(later.length).toBeGreaterThan(0);
    for (const p of later) expect(p.values[0]).not.toContain(first);
  });

  it("a reply read slowed past its bound leaves the others answering, is tried at each tick, and answers can't confirm lost at T - 5 s", async () => {
    let slow: string | null = null;
    database(id => {
      if (!slow) slow = id;
      rows.set(id, { state: 'done', reply: JSON.stringify({ success: true, data: { big: 'x'.repeat(2 * 1024 * 1024) } }), pickup_over: true, answer_over: false });
    });
    rig.replyRead = id => (id === slow ? HANG : { rows: [{ reply: rows.get(id).reply }], rowCount: 1 });
    const r = await start();
    const other = await start();
    const otherAnswer = await other.result(3000);
    expect(otherAnswer.value?.reply.success, "the other request answered while R's read hangs").toBe(true);
    const { value, at } = await r.result(60_000);
    expect(value).toMatchObject({ status: 503, reply: { code: 'no-answer', noAnswer: 'lost' } });
    expect(at).toBeGreaterThanOrEqual(55_000);
    expect(at).toBeLessThanOrEqual(55_100);
    expect(rig.statements.filter(s => s.sql === REPLY_READ_SQL && s.values[0] === slow).length, 'the read is tried again at later ticks').toBeGreaterThan(2);
    for (const read of rig.statements.filter(s => s.sql === REPLY_READ_SQL)) expect(read.boundMs).toBeLessThanOrEqual(5000);
  });

  it('a follow ends at its own T - 5 s while a poll is in flight', async () => {
    database(id => { rows.set(id, { state: 'applying', reply: null, pickup_over: true, answer_over: false }); }, ids => new Promise(resolve => {
      setTimeout(() => resolve({ rows: ids.map(id => rows.get(id)).filter(Boolean) }), 1900);
    }));
    const { result } = await start();
    const { value, at } = await result(70_000);
    expect(value).toMatchObject({ status: 503, reply: { code: 'no-answer', noAnswer: 'timeout' } });
    expect(at).toBeGreaterThanOrEqual(55_000);
    expect(at).toBeLessThanOrEqual(55_100);
  });

  it("a reply read on an 'unprotected' client is not sent; the request answers can't confirm lost", async () => {
    database(id => {
      rows.set(id, { state: 'done', reply: JSON.stringify({ success: true }), pickup_over: true, answer_over: false });
      rig.transport[URL1] = 'unprotected';
    });
    rig.transport[URL1] = 'verified';
    const { result } = await start();
    const { value } = await result(60_000);
    expect(value).toMatchObject({ status: 503, reply: { code: 'no-answer', noAnswer: 'lost' } });
    expect(rig.statements.filter(s => s.sql === REPLY_READ_SQL)).toHaveLength(0);
  });
});

describe("the holder's answers", () => {
  it.each([
    ['not-held', { success: false, code: 'not-held' }, 'On BRAVO: the bot stopped serving this server before it ran the panel action; nothing was run. Try again in a moment.'],
    ['unapplied', { ok: false, code: 'not-taken', unapplied: true }, 'BRAVO took the panel action but could not start it; nothing was run. Try again in a moment.'],
    ['invalid', { success: false, ran: false, code: 'invalid', error: 'The request for this server was malformed (no actor); nothing was run.' }, 'On BRAVO: the request for this server was malformed (no actor); nothing was run.'],
    ['not-allowed', { success: false, ran: false, code: 'not-allowed', error: 'This panel runs only from the web panel of its own machine; nothing was run.' }, 'On BRAVO: this panel runs only from the web panel of its own machine; nothing was run.'],
    ['not-ready', { success: false, ran: false, code: 'not-ready', error: 'This server is not ready on the bot that runs it yet; nothing was run. Try again in a moment.' }, 'On BRAVO: this server is not ready on the bot that runs it yet; nothing was run. Try again in a moment.'],
  ] as const)('%s answers nothing was run', async (_what, reply, text) => {
    database(id => { rows.set(id, { state: 'done', reply: JSON.stringify(reply), pickup_over: true, answer_over: false }); });
    const { result } = await start();
    const { value } = await result(2000);
    expect(value.reply.error).toBe(text);
  });

  it("'applying' past answer_over answers the op's can't confirm; a read op's no-answer says nothing was changed", async () => {
    database(id => { rows.set(id, { state: 'applying', reply: null, pickup_over: true, answer_over: true }); });
    const action = await start();
    expect((await action.result(2000)).value.reply.error).toBe("BRAVO did not answer in time; can't confirm whether the panel action ran. Check the server before you run it again.");
    const read = await start('guild:channels', { actor: OWNER });
    expect((await read.result(2000)).value.reply.error).toBe('BRAVO did not send the channel list in time; nothing was changed. Try again in a moment.');
  });

  it('every answer comes by T, with the database hanging', async () => {
    rig.script[URL1] = () => HANG;
    const { result, plan } = await start();
    const { value, at } = await result(70_000);
    expect(value).toBeDefined();
    expect(at).toBeLessThanOrEqual((plan as PanelPlan).deadline - (performance.now() - 70_000) + 1);
    expect(at).toBeLessThanOrEqual(60_000);
  });
});

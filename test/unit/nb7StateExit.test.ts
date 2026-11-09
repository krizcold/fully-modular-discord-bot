import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANSWER_SQL, REQUEST_CLAIM_SQL, REQUEST_INSERT_SQL, SETTLE_INSERT_SQL, SETTLE_UPDATE_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { NB7_TEXTS, planGuildChange } from '../../src/webui/utils/guildRequests';
import { ROUTE_TEXT } from '../../src/webui/botManager';
import { BOT_DOWN, fakeBot, GUILD } from '../helpers/nb7Rig';
import { fakeModelTime, flush, quietLogs, resetWorld, World, type Sent } from '../helpers/nb7World';

// NB7 test 8: the cells of section 5's table (phase x exit) on the model of test 7, each with its answer and its number
// of applications. The switch column is NB5's and is left out; the L and J rows are NB10's and NB11's, unchanged.

const T = 60_000;
let logs: ReturnType<typeof quietLogs>;

beforeEach(() => {
  fakeModelTime();
  logs = quietLogs();
});
afterEach(() => {
  resetWorld();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Time passes in 250 ms steps; with sweep, the holder runs a pass each second. */
async function run(w: World, ms: number, opts: { sweep?: boolean; until?: Sent } = {}): Promise<void> {
  for (let t = 0; t < ms; t += 250) {
    if (opts.until?.answer) return;
    if (opts.sweep && t % 1000 === 0) await w.pass();
    await w.advance(250);
  }
}

const NOT_TAKEN = NB7_TEXTS.notTaken('BRAVO', 'saved');
const WITHDRAWN = NB7_TEXTS.withdrawn('BRAVO', 'saved');

function ok(w: World, sent: Sent): void {
  expect(sent.answer).toMatchObject({ ok: true, servedBy: 'BRAVO' });
  expect(w.applications(sent)).toBe(1);
}

async function nothingSaved(w: World, sent: Sent, text: string | RegExp): Promise<void> {
  if (typeof text === 'string') expect(sent.answer).toMatchObject({ ok: false, error: text });
  else expect(String(sent.answer?.error)).toMatch(text);
  await w.drain();
  expect(w.applications(sent), 'nothing was saved, through every later step').toBe(0);
}

function cantConfirm(sent: Sent, cause?: 'timeout' | 'lost'): void {
  expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer', servedBy: 'BRAVO' });
  if (cause) expect(sent.answer.noAnswer).toBe(cause);
}

const loggedWith = (spy: ReturnType<typeof vi.spyOn>, re: RegExp) => spy.mock.calls.some((c: unknown[]) => re.test(String(c[0])));

describe('W1: the plan and the holder check', () => {
  it('continue: held elsewhere, sent, applied: ok', async () => {
    const w = new World();
    const sent = await w.send();
    await run(w, 3000, { sweep: true, until: sent });
    await w.finish('ok');
    await run(w, 1000, { until: sent });
    ok(w, sent);
    await w.drain();
  });

  it('sender stop: the exit flag before the insert answers NB10\'s shutting-down text; nothing sent', async () => {
    const w = new World();
    await w.exit();
    const sent = await w.send();
    expect(sent.answer).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
    expect(w.model.sentInserts).toHaveLength(0);
  });

  it('sender crash: a plan alone sends nothing', async () => {
    const w = new World();
    expect((await planGuildChange(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'write')).kind).toBe('request');
    expect(w.model.sentSql).toHaveLength(0);
  });

  it('holder stop, the row released (kept): refused with its text, nothing sent', async () => {
    const w = new World();
    w.model.claim.released = true;
    const sent = await w.send();
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-holder', error: NB7_TEXTS.kept(1, 2, 'BRAVO', 'saved') });
    expect(w.model.sentInserts).toHaveLength(0);
  });

  it('holder stop, the row still held while it drains: sent, then pickup passes, not-taken', async () => {
    const w = new World();
    w.stopping = true;
    const sent = await w.send();
    await run(w, 10_000, { sweep: true, until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('holder crash, the row held until it expires: sent, then pickup passes, not-taken', async () => {
    const w = new World();
    w.kill();
    const sent = await w.send();
    await run(w, 10_000, { sweep: true, until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('takeover: the row names the new holder, the request goes to it', async () => {
    const w = new World();
    w.takeover();
    const sent = await w.send();
    expect(w.model.rows.get(sent.id!)?.forProcess).toBe('p-c');
    await run(w, 10_000, { sweep: true, until: sent });
    await nothingSaved(w, sent, NB7_TEXTS.notTaken('CHARLIE', 'saved'));
  });

  it('database away: NB10\'s refusal, nothing sent', async () => {
    const w = new World();
    w.away();
    const sent = await w.send();
    expect(sent.answer).toEqual(BOT_DOWN);
    expect(w.model.sentInserts).toHaveLength(0);
  });

  it('maintenance, the login refused: NB10\'s refusal (decision 4), nothing sent', async () => {
    const w = new World();
    w.model.loginRefused = true;
    const sent = await w.send();
    expect(sent.answer).toEqual(BOT_DOWN);
    expect(w.model.sentInserts).toHaveLength(0);
  });

  it('maintenance, the hook: held, sent, the holder answers the maintenance refusal', async () => {
    const w = new World();
    w.script.push('maintenance');
    const sent = await w.send();
    await run(w, 3000, { sweep: true, until: sent });
    expect(sent.answer).toMatchObject({ ok: false, code: 'maintenance', error: 'Back soon', servedBy: 'BRAVO' });
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });
});

describe('W2: the insert on the wire', () => {
  it('continue: committed, then W3 and on: ok', async () => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    w.model.deliver();
    await flush();
    await run(w, 3000, { sweep: true, until: sent });
    await w.finish('ok');
    await run(w, 1000, { until: sent });
    ok(w, sent);
  });

  it('a rollback SQLSTATE: refused, nothing inserted', async () => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    w.model.rows.set(sent.id!, { state: 'expired', op: 'write', forProcess: 'p-x', shardCount: 2, shardId: 1, claimBy: 0, answerBy: 0, batch: null, reply: null });
    w.model.deliver();
    await run(w, 1000, { until: sent });
    expect(sent.answer).toMatchObject({ ok: false, code: 'backend-unavailable' });
    expect(String(sent.answer.error)).toMatch(/^The database refused the change \(SQLSTATE 23505: .*\); nothing was saved\.$/);
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('sender stop: the exit\'s insert-form settle withdraws it and logs it; the late insert is refused', async () => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    await w.exit();
    expect(w.model.sentSql.filter(s => s === SETTLE_INSERT_SQL)).toHaveLength(1);
    expect(loggedWith(logs.log, /^\[Main\] Exiting: withdrew the write of server \d+ sent to BRAVO; nothing was saved$/)).toBe(true);
    w.model.deliver();
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('sender crash: the insert lands, the process it names applies it within 5 s, nobody is answered, the holder logs it', async () => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    w.crashSender();
    w.model.deliver();
    await w.pass();
    await w.finish('ok');
    expect(w.applications(sent)).toBe(1);
    expect(sent.answer).toBeUndefined();
    expect(loggedWith(logs.log, /^\[GuildRequests\] write of m\/.+ for server \d+, sent from ALPHA: saved$/)).toBe(true);
  });

  it('sender crash, the insert landing after claim_by: never applied', async () => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    w.crashSender();
    w.model.deliver();
    await w.advance(6000);
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('database away, the insert cut before it ran: the insert-form settle every 1 s until T, can\'t confirm lost', async () => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    w.away();
    w.model.cut(false);
    await run(w, T, { until: sent });
    cantConfirm(sent, 'lost');
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('database back before T: the insert-form settle withdraws it, nothing was saved', async () => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    w.away();
    w.model.cut(false);
    await run(w, 3000, { until: sent });
    w.back();
    await run(w, 3000, { until: sent });
    await nothingSaved(w, sent, WITHDRAWN);
  });

  it.each([
    ['holder stop', async (w: World) => { await w.stop(); }],
    ['holder crash', (w: World) => { w.crash(); }],
    ['takeover', (w: World) => { w.takeover(); }],
  ] as const)('%s while the insert is on the wire: as W3, the insert lands pending, nobody claims it, pickup passes, not-taken', async (_exit, exit) => {
    const w = new World();
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const sent = await w.send();
    await exit(w);
    w.model.deliver();
    await flush();
    expect(w.model.rows.get(sent.id!)?.state).toBe('pending');
    await run(w, 10_000, { sweep: true, until: sent });
    expect(w.model.rows.get(sent.id!)?.state).toBe('expired');
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('maintenance, the login refused after the plan: the maintenance code, nothing inserted', async () => {
    const w = new World();
    const plan = await planGuildChange(fakeBot({ route: BOT_DOWN }).bot, GUILD, 'write');
    w.model.loginRefused = true;
    const { sendGuildChange } = await import('../../src/webui/utils/guildRequests');
    const reply = await sendGuildChange(fakeBot().bot, plan, { guildId: GUILD, module: 'm', filename: 'a.json', op: 'write', contentJson: '{}' });
    expect(reply).toMatchObject({ ok: false, code: 'maintenance' });
    expect(w.model.sentInserts).toHaveLength(0);
    expect(w.model.rows.size).toBe(0);
  });
});

describe('W3: the row pending', () => {
  it('continue: the holder claims within about 1 s, then W5', async () => {
    const w = new World();
    const sent = await w.send();
    await w.advance(900);
    await w.pass();
    expect(w.model.rows.get(sent.id!)?.state).toBe('applying');
    await w.finish('ok');
    await run(w, 1000, { until: sent });
    ok(w, sent);
  });

  it('pickup passes: the UPDATE-form settle expires it, not-taken', async () => {
    const w = new World();
    const sent = await w.send();
    await run(w, 7000, { until: sent });
    expect(w.model.sentSql.filter(s => s === SETTLE_UPDATE_SQL)).toHaveLength(1);
    expect(w.model.sentSql.filter(s => s === SETTLE_INSERT_SQL)).toHaveLength(0);
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('sender stop before claim_by: the exit\'s settle proves nothing a failover cannot undo, so the log says can\'t confirm', async () => {
    const w = new World();
    const sent = await w.send();
    await w.exit();
    expect(loggedWith(logs.error, /^\[Main\] Exiting; can't confirm whether the write of server \d+ sent to BRAVO was saved$/)).toBe(true);
    await w.drain();
    expect(w.applications(sent)).toBe(0);
    expect(w.model.sentSql.filter(s => s === SETTLE_UPDATE_SQL || s === SETTLE_INSERT_SQL)).toHaveLength(1);
  });

  it('sender crash: the row stays pending, the process it names applies it before claim_by, the holder logs it', async () => {
    const w = new World();
    const sent = await w.send();
    w.crashSender();
    await w.pass();
    await w.finish('ok');
    expect(w.applications(sent)).toBe(1);
    expect(loggedWith(logs.log, /^\[GuildRequests\] write of m\/.+: saved$/)).toBe(true);
  });

  it('holder stop: it claims nothing once stopping, pickup passes', async () => {
    const w = new World();
    const sent = await w.send();
    await w.stop();
    await run(w, 10_000, { sweep: true, until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('holder crash: nothing claims (its successor is another process), pickup passes', async () => {
    const w = new World();
    const sent = await w.send();
    w.crash();
    await run(w, 10_000, { sweep: true, until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('takeover: the row names the old process, which the new holder is not; pickup passes, nothing applied', async () => {
    const w = new World();
    const sent = await w.send();
    w.takeover();
    await run(w, 10_000, { sweep: true, until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('database away: polls fail, at T minus 5 s one settle, which fails: can\'t confirm lost', async () => {
    const w = new World();
    const sent = await w.send();
    w.away();
    await run(w, T, { sweep: true, until: sent });
    cantConfirm(sent, 'lost');
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('database back just before T minus 5 s: the settle withdraws it', async () => {
    const w = new World();
    const sent = await w.send();
    w.away();
    await run(w, T - 5000 - 500, { until: sent });
    w.back();
    await run(w, 5000, { until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('maintenance, the hook: the holder claims and answers the maintenance refusal (W6)', async () => {
    const w = new World();
    w.script.push('maintenance');
    const sent = await w.send();
    await run(w, 3000, { sweep: true, until: sent });
    expect(sent.answer).toMatchObject({ ok: false, code: 'maintenance', servedBy: 'BRAVO' });
  });

  it('maintenance, the login refused: no claim, polls refused, can\'t confirm at T minus 5 s', async () => {
    const w = new World();
    const sent = await w.send();
    w.refuseLogin();
    await run(w, T, { sweep: true, until: sent });
    expect(sent.answer).toMatchObject({ ok: false, code: 'no-answer' });
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });
});

describe('W4: a settle on the wire', () => {
  /** An insert whose answer was lost after it committed, and the insert-form settle that follows on the wire. */
  async function settleOnWire(w: World): Promise<Sent> {
    w.model.forceSql(REQUEST_INSERT_SQL, 'lost-after');
    w.model.forceSql(SETTLE_INSERT_SQL, 'wire');
    return w.send();
  }

  it('continue, a returned row: nothing was saved (withdrawn)', async () => {
    const w = new World();
    const sent = await settleOnWire(w);
    w.model.deliver();
    await run(w, 6000, { until: sent });
    await nothingSaved(w, sent, WITHDRAWN);
  });

  it('continue, no row returned (the holder took it first): the follow, then W6', async () => {
    const w = new World();
    const sent = await settleOnWire(w);
    await w.pass();
    w.model.deliver();
    await w.finish('ok');
    await run(w, 2000, { until: sent });
    ok(w, sent);
  });

  it('sender stop: the exit joins the settle on the wire, one settle, the route\'s follow stopped', async () => {
    const w = new World();
    const sent = await settleOnWire(w);
    const exit = w.exit();
    w.model.deliver();
    await exit;
    await flush();
    expect(w.model.sentSql.filter(s => s === SETTLE_INSERT_SQL || s === SETTLE_UPDATE_SQL)).toHaveLength(1);
    expect(loggedWith(logs.error, /^\[Main\] Exiting; can't confirm whether the write/)).toBe(true);
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('sender crash, the settle lost before it ran: the pending row can still be claimed until claim_by', async () => {
    const w = new World();
    const sent = await settleOnWire(w);
    w.crashSender();
    w.model.cut(false);
    await w.pass();
    await w.finish('ok');
    expect(w.applications(sent)).toBe(1);
    expect(sent.answer).toBeUndefined();
  });

  it.each([
    ['holder stop', async (w: World) => { await w.stop(); }],
    ['holder crash', (w: World) => { w.crash(); }],
    ['takeover', (w: World) => { w.takeover(); }],
  ] as const)('%s while the settle is on the wire: as continue, the settle returns the row, nothing was saved (withdrawn)', async (_exit, exit) => {
    const w = new World();
    const sent = await settleOnWire(w);
    expect(w.model.rows.get(sent.id!)?.state).toBe('pending');
    await exit(w);
    w.model.deliver();
    await run(w, 6000, { until: sent });
    expect(w.model.rows.get(sent.id!)?.state).toBe('expired');
    await nothingSaved(w, sent, WITHDRAWN);
  });

  it('database away: retried every 1 s until T, can\'t confirm', async () => {
    const w = new World();
    const sent = await settleOnWire(w);
    w.away();
    w.model.cut(false);
    await run(w, T, { until: sent });
    cantConfirm(sent);
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('maintenance, the login refused: retried until T, can\'t confirm', async () => {
    const w = new World();
    const sent = await settleOnWire(w);
    w.refuseLogin();
    w.model.cut(false);
    await run(w, T, { until: sent });
    cantConfirm(sent);
  });
});

describe('W5 and H2: the row applying', () => {
  async function applying(w: World): Promise<Sent> {
    const sent = await w.send();
    await w.pass();
    expect(w.model.rows.get(sent.id!)?.state).toBe('applying');
    return sent;
  }

  it('continue: the holder\'s answer (W6)', async () => {
    const w = new World();
    const sent = await applying(w);
    await w.finish('ok');
    await run(w, 1000, { until: sent });
    ok(w, sent);
  });

  it('sender stop: logged as can\'t confirm', async () => {
    const w = new World();
    const sent = await applying(w);
    await w.exit();
    expect(loggedWith(logs.error, /^\[Main\] Exiting while BRAVO applies the write of server \d+; can't confirm whether it was saved$/)).toBe(true);
    await w.drain();
    expect(w.applications(sent)).toBe(1);
  });

  it('sender crash: the holder finishes and writes its answer, nobody reads it, the holder logs the outcome', async () => {
    const w = new World();
    const sent = await applying(w);
    w.crashSender();
    await w.finish('ok');
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'done', reply: '{"ok":true}' });
    expect(sent.answer).toBeUndefined();
    expect(loggedWith(logs.log, /^\[GuildRequests\] write of m\/.+: saved$/)).toBe(true);
  });

  it('holder stop: the apply runs on, the stop step waits for its answer, the sender reads it', async () => {
    const w = new World();
    const sent = await applying(w);
    w.stopping = true;
    await w.finish('ok');
    await w.sweep.stopStep();
    await run(w, 1000, { until: sent });
    ok(w, sent);
  });

  it('holder crash: no answer, can\'t confirm at answer_by + 5 s', async () => {
    const w = new World();
    const sent = await applying(w);
    w.crash();
    await run(w, T, { sweep: true, until: sent });
    cantConfirm(sent, 'timeout');
    expect(w.model.now).toBeLessThanOrEqual(26_000);
  });

  it('takeover: the holder\'s flush is refused deposed, not-owner with the holder\'s name', async () => {
    const w = new World();
    const sent = await applying(w);
    w.takeover();
    await w.finish('deposed');
    await run(w, 1000, { until: sent });
    expect(sent.answer).toMatchObject({ ok: false, code: 'not-owner', servedBy: 'BRAVO' });
    expect(sent.answer.sender).toBeUndefined();
  });

  it('database away: the answer write fails and the polls fail, can\'t confirm', async () => {
    const w = new World();
    const sent = await applying(w);
    w.away();
    await w.finish('pending');
    await run(w, T, { until: sent });
    cantConfirm(sent);
    expect(w.applications(sent)).toBe(1);
  });

  it('maintenance, the hook during the apply: the maintenance refusal (W6)', async () => {
    const w = new World();
    const sent = await applying(w);
    await w.finish('maintenance');
    await run(w, 1000, { until: sent });
    expect(sent.answer).toMatchObject({ ok: false, code: 'maintenance', servedBy: 'BRAVO' });
  });

  it('maintenance, the login refused: the answer cannot be written, can\'t confirm', async () => {
    const w = new World();
    const sent = await applying(w);
    w.refuseLogin();
    await w.finish('ok');
    await run(w, T, { until: sent });
    cantConfirm(sent);
  });
});

describe('H1: the claim on the wire', () => {
  async function claimOnWire(w: World): Promise<{ sent: Sent; pass: Promise<void> }> {
    const sent = await w.send();
    w.model.forceSql(REQUEST_CLAIM_SQL, 'wire');
    const pass = w.sweep.pass();
    await flush();
    return { sent, pass };
  }

  it('continue: rows returned, each applied (H2)', async () => {
    const w = new World();
    const { sent, pass } = await claimOnWire(w);
    w.model.deliver();
    await pass;
    await flush();
    await w.finish('ok');
    await run(w, 1000, { until: sent });
    ok(w, sent);
  });

  it('holder stop: rows returned after the stop began start nothing; the pass answers them unapplied', async () => {
    const w = new World();
    const { sent, pass } = await claimOnWire(w);
    w.stopping = true;
    w.model.deliver();
    await pass;
    await w.pass();
    await run(w, 6000, { until: sent });
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'done' });
    await nothingSaved(w, sent, NB7_TEXTS.unapplied('BRAVO', 'saved'));
  });

  it('holder crash: rows applying with no applier, their sender can\'t confirm, nothing applied', async () => {
    const w = new World();
    const { sent } = await claimOnWire(w);
    w.model.cut(true);
    w.crash();
    await run(w, T, { sweep: true, until: sent });
    cantConfirm(sent);
    await w.drain();
    expect(w.applications(sent)).toBe(0);
  });

  it('takeover: the claims join finds another holder, nothing claimed', async () => {
    const w = new World();
    const { sent, pass } = await claimOnWire(w);
    w.takeover();
    w.model.deliver();
    await pass;
    expect(w.model.rows.get(sent.id!)?.state).toBe('pending');
    await run(w, 10_000, { until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });

  it('database away: the claim committed without an answer; its batch is answered unapplied once the database is back', async () => {
    const w = new World();
    const { sent, pass } = await claimOnWire(w);
    w.model.cut(true);
    await pass;
    expect(w.sweep.unanswered()).toHaveLength(1);
    await w.pass();
    await run(w, 6000, { until: sent });
    await nothingSaved(w, sent, NB7_TEXTS.unapplied('BRAVO', 'saved'));
  });

  it('maintenance, the login refused: the claim fails, nothing is taken', async () => {
    const w = new World();
    const sent = await w.send();
    w.model.loginRefused = true;
    await w.pass();
    expect(w.sweep.unanswered()).toHaveLength(0);
    w.model.loginRefused = false;
    await run(w, 10_000, { until: sent });
    await nothingSaved(w, sent, NOT_TAKEN);
  });
});

describe('H3: the answer\'s write on the wire', () => {
  async function answerOnWire(w: World, kind: 'ok' | 'pending' = 'ok'): Promise<Sent> {
    const sent = await w.send();
    await w.pass();
    w.model.forceSql(ANSWER_SQL, 'wire');
    await w.finish(kind);
    return sent;
  }

  it('continue: written, the sender reads it (W6)', async () => {
    const w = new World();
    const sent = await answerOnWire(w);
    w.model.deliver();
    await run(w, 1000, { until: sent });
    ok(w, sent);
  });

  it('sender stop: the answer lands; nobody reads it', async () => {
    const w = new World();
    const sent = await answerOnWire(w);
    await w.exit();
    w.model.deliver();
    await flush();
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'done', reply: '{"ok":true}' });
    expect(w.applications(sent)).toBe(1);
  });

  it('holder stop: the stop step waits up to 2 s; written within it, the sender reads it', async () => {
    const w = new World();
    const sent = await answerOnWire(w);
    w.stopping = true;
    let ended = false;
    void w.sweep.stopStep().then(() => { ended = true; });
    await w.advance(500);
    expect(ended).toBe(false);
    w.model.deliver();
    await flush();
    expect(ended).toBe(true);
    await run(w, 1000, { until: sent });
    ok(w, sent);
  });

  it('holder stop: not written within 2 s, the stop step ends and the sender can\'t confirm', async () => {
    const w = new World();
    const sent = await answerOnWire(w);
    w.stopping = true;
    let ended = false;
    void w.sweep.stopStep().then(() => { ended = true; });
    await w.advance(2100);
    expect(ended).toBe(true);
    w.crash();
    w.model.cut(false);
    await run(w, T, { until: sent });
    cantConfirm(sent);
  });

  it('holder crash: not written, can\'t confirm', async () => {
    const w = new World();
    const sent = await answerOnWire(w);
    w.crash();
    w.model.cut(false);
    await run(w, T, { sweep: true, until: sent });
    cantConfirm(sent);
    expect(w.applications(sent)).toBe(1);
  });

  it('database away: retried every 1 s until left_ms + 5 s, then logged with the outcome; the sender can\'t confirm', async () => {
    const w = new World();
    const sent = await answerOnWire(w, 'pending');
    w.away();
    w.model.cut(false);
    await run(w, T, { until: sent });
    cantConfirm(sent);
    expect(loggedWith(logs.error, /^\[GuildRequests\] Can't confirm whether the answer to the write of server \d+ sent from ALPHA was recorded: an attempt that got no answer may have landed, and no later attempt confirmed it \(.+\); its sender reads that answer or can't confirm\. The answer was: accepted, not confirmed as saved yet$/)).toBe(true);
  });

  it('takeover: the deposed answer is written; it already says what the fence did, not-owner with the holder\'s name', async () => {
    const w = new World();
    const sent = await w.send();
    await w.pass();
    w.model.forceSql(ANSWER_SQL, 'wire');
    await w.finish('deposed');
    w.takeover();
    w.model.deliver();
    await run(w, 1000, { until: sent });
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'done', reply: JSON.stringify({ ok: false, code: 'not-owner', error: 'another bot process took ownership of this guild mid-write; it was not saved' }) });
    expect(sent.answer).toMatchObject({ ok: false, code: 'not-owner', servedBy: 'BRAVO' });
    expect(sent.answer.sender).toBeUndefined();
    expect(w.applications(sent)).toBe(1);
  });

  it('maintenance, the login refused (28000) while the answer is on the wire: as database away, retried every 1 s until left_ms + 5 s, logged, can\'t confirm', async () => {
    const w = new World();
    const sent = await answerOnWire(w);
    const leftMs = w.model.rows.get(sent.id!)!.answerBy - w.model.now;
    const tries: number[] = [];
    const run0 = w.model.run.bind(w.model);
    w.model.run = (sql, values, pid, boundMs) => {
      if (sql === ANSWER_SQL) tries.push(w.model.now);
      return run0(sql, values, pid, boundMs);
    };
    w.refuseLogin();
    w.model.cut(false);
    await run(w, T, { until: sent });
    cantConfirm(sent);
    expect(tries.length).toBeGreaterThanOrEqual(Math.floor((leftMs + 5000) / 1000) - 1);
    expect(tries.length).toBeLessThanOrEqual(Math.ceil((leftMs + 5000) / 1000) + 1);
    for (let i = 1; i < tries.length; i++) expect(tries[i] - tries[i - 1]).toBeGreaterThanOrEqual(1000);
    expect(tries[tries.length - 1]).toBeLessThanOrEqual(leftMs + 5000);
    expect(loggedWith(logs.error, /^\[GuildRequests\] Can't confirm whether the answer to the write of server \d+ sent from ALPHA was recorded: an attempt that got no answer may have landed, and no later attempt confirmed it \(SQLSTATE 28000: role is not permitted to log in\); its sender reads that answer or can't confirm\. The answer was: saved$/)).toBe(true);
    expect(w.model.rows.get(sent.id!)?.state).toBe('applying');
    expect(w.applications(sent)).toBe(1);
  });

  it('written to a database without the row (failover): 0 rows, the read-back finds none, the other-answer line', async () => {
    const w = new World();
    const sent = await answerOnWire(w);
    w.failover();
    await run(w, 3000);
    expect(loggedWith(logs.warn, /^\[GuildRequests\] The write of server \d+ sent from ALPHA was applied \(saved\), but its row holds another answer \(none\) or none/)).toBe(true);
    await run(w, T, { until: sent });
    cantConfirm(sent);
  });
});

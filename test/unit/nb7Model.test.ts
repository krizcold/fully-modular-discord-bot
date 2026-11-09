import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REQUEST_CLAIM_SQL, REQUEST_INSERT_SQL, UNANSWERED_BATCHES_SQL, UNAPPLIED_REPLY } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import type { GuildRequestOp } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { ModelDb, type Bites, type Fate } from '../helpers/nb7Model';
import { fakeModelTime, flush, quietLogs, resetWorld, World, type Outcome } from '../helpers/nb7World';
import { GUILD } from '../helpers/nb7Rig';

// NB7 test 7: the real sender and holder over a model store whose statements can lose their answer before or after
// they commit, or run later than sent, a database that goes away and comes back or fails over to a standby that lacks
// the newest rows, and processes that stop, crash and exit. After every command: a request is applied at most once;
// once its sender answered "nothing was ...", it is never applied; an ok answer means it was applied with the
// executor's ok; can't confirm comes only when the sender could not observe a commit (a statement lost its answer,
// the holder took the row, the database went away or failed over, or the sender itself exited).

const RUNS = Number(process.env.SMDB_NB7_MODEL_RUNS ?? 200);
const BITE_RUNS = Number(process.env.SMDB_NB7_BITE_RUNS ?? 3000);

type Cmd = fc.AsyncCommand<object, World>;

function cmd(name: string, step: (w: World) => Promise<void> | void): Cmd {
  return {
    check: () => true,
    async run(_m: object, w: World) {
      await step(w);
      w.check();
    },
    toString: () => name,
  };
}

const OPS: GuildRequestOp[] = ['write', 'delete', 'delete-namespace', 'restore-graveyard'];
const FATES: Fate[] = ['ok', 'lost-after', 'late', 'lost-before'];
const OUTCOMES: Outcome[] = ['ok', 'pending', 'refused'];

const send = (op: GuildRequestOp) => cmd(`send ${op}`, w => w.send(op).then(() => undefined));
const sweep = () => cmd('holder sweep', w => w.pass());
const next = (fate: Fate) => cmd(`next statement ${fate}`, w => { w.model.force(fate); });
const advance = (ms: number) => cmd(`advance ${ms}`, w => w.advance(ms));
const late = () => cmd('run a late statement', w => { w.model.runLate(); });

const commands = [
  fc.constantFrom(...OPS).map(send),
  fc.constant(sweep()),
  fc.constantFrom(...OUTCOMES).map(kind => cmd(`finish an apply ${kind}`, w => w.finish(kind))),
  fc.constantFrom(...FATES).map(next),
  fc.constant(cmd('holder crash', w => { w.crash(); })),
  fc.constant(cmd('holder stop', w => w.stop())),
  fc.constant(cmd('takeover', w => { w.takeover(); })),
  fc.constant(cmd('sender exit', w => w.exit())),
  fc.integer({ min: 100, max: 7000 }).map(advance),
  fc.constant(cmd('sender poll', w => w.advance(250))),
  fc.constant(cmd('database away', w => { w.away(); })),
  fc.constant(cmd('database back', w => { w.back(); })),
  fc.constant(cmd('standby catches up', w => { w.model.ship(); })),
  fc.constant(cmd('failover behind the same URL', w => { w.failover(); })),
  fc.constant(cmd('claim, then fail over before the claim ships', async w => { w.model.ship(); await w.pass(); w.failover(); })),
  fc.constant(late()),
];

/** The draft's fault in full: a lost claim's pass runs late, after a later claim committed a row being applied. */
const lateStartedMapPass = (): [Fate[], Cmd[]] => [['ok'], [
  send('write'), next('lost-after'), next('late'), sweep(), send('write'), sweep(), late(), advance(250), advance(1000),
]];
/** A settle that withdraws with no row to hold the id, and the insert that lands after it. */
const lateInsertAfterSettle = (): [Fate[], Cmd[]] => [['ok'], [
  next('late'), send('write'), advance(10), late(), sweep(), advance(1000),
]];
/** NB7-R3-DL1's sequence: the standby has the row as pending, the holder claimed it on the old primary and is offered it again. */
const claimAgainAfterFailover = (): [Fate[], Cmd[]] => [['ok'], [
  send('write'), cmd('standby catches up', w => { w.model.ship(); }), sweep(), cmd('failover behind the same URL', w => { w.failover(); }), sweep(),
  cmd('finish an apply ok', w => w.finish('ok')), advance(7000),
]];
/** The same, with the first apply finished before the failover: its change is in the holder's memory, not on the standby. */
const claimAgainAfterApply = (): [Fate[], Cmd[]] => [['ok'], [
  send('write'), cmd('standby catches up', w => { w.model.ship(); }), sweep(), cmd('finish an apply ok', w => w.finish('ok')),
  cmd('failover behind the same URL', w => { w.failover(); }), sweep(), advance(7000),
]];
/** Ruling 8: the claim lost in the failover comes back in a claim that commits and loses its answer. */
const secondClaimLost = (): [Fate[], Cmd[]] => [['ok'], [
  send('write'), cmd('standby catches up', w => { w.model.ship(); }), sweep(), cmd('failover behind the same URL', w => { w.failover(); }),
  cmd('the next claim loses its answer', w => { w.model.forceSql(REQUEST_CLAIM_SQL, 'lost-after'); }), sweep(), sweep(),
  cmd('finish an apply ok', w => w.finish('ok')), advance(7000), advance(7000), advance(7000), advance(7000),
]];
/** NB7-R3-T2: nobody takes the row and the sender's settle leaves it pending; the follow ends with can't confirm. */
const pendingUnanswered = (): [Fate[], Cmd[]] => [['ok'], [
  send('write'), advance(7000), advance(7000), advance(7000), advance(7000), advance(7000), advance(7000), advance(7000), advance(7000), advance(7000),
]];
/** The holder applies and answers at once; the sender then follows its row to the end. */
const answerMissed = (): [Fate[], Cmd[]] => [['ok'], [
  send('write'), sweep(), cmd('finish an apply ok', w => w.finish('ok')), advance(7000), advance(7000), advance(7000), advance(7000), advance(7000),
]];
const fates = fc.array(fc.constantFrom<Fate>('ok', 'ok', 'ok', 'lost-after', 'late', 'lost-before'), { minLength: 1, maxLength: 12 });

function property(bites: Bites = {}) {
  return fc.asyncProperty(fates, fc.commands(commands, { maxCommands: 30 }), async (f, cmds) => {
    vi.clearAllTimers();
    const w = new World(f, bites);
    await fc.asyncModelRun(() => ({ model: {}, real: w }), cmds);
    await w.drain();
    for (const sent of w.sends) if (!sent.crashed) expect(sent.answer, 'every sender answers by its deadline').toBeDefined();
  });
}

beforeEach(() => {
  fakeModelTime();
  quietLogs();
});
afterEach(() => {
  resetWorld();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB7 test 7: the request route against a model store', () => {
  it('applies a request at most once, never after "nothing was saved", answers ok only when applied, and can\'t confirm only when unobserved', async () => {
    await fc.assert(property(), { numRuns: RUNS });
  }, 600_000);

  // NB15 gatekeeper ruling 2 (the second defect NB22 named): this seed gave the shutdown "nothing was saved" answer for
  // a request a failover behind the same URL brought back and the holder applied; an exit's withdrawal before the
  // row's claim_by now proves nothing.
  it('regression: seed -286170851, an exit then a failover behind the same URL, answers no false "nothing was saved"', async () => {
    await fc.assert(property(), { numRuns: 200, seed: -286170851 });
  }, 600_000);

  it('bite: the draft\'s started-map pass in place of the unanswered-batch statement finds a false "nothing was saved"', async () => {
    const out = await fc.check(property({ startedMap: () => new Set() }), { numRuns: BITE_RUNS, seed: 7, examples: [lateStartedMapPass() as any] });
    expect(out.failed, 'the property run found no counterexample with the started-map pass').toBe(true);
    expect(String(out.errorInstance)).toMatch(/nothing was/);
  }, 600_000);

  it('bite: a settle that does not hold the id finds a late insert applied after "nothing was saved"', async () => {
    const out = await fc.check(property({ settleHoldsNothing: true }), { numRuns: BITE_RUNS, seed: 7, examples: [lateInsertAfterSettle() as any] });
    expect(out.failed, 'the property run found no counterexample with a settle that holds nothing').toBe(true);
    expect(String(out.errorInstance)).toMatch(/nothing was/);
  }, 600_000);

  it('the bites\' command runs hold on the real statements', async () => {
    await fc.assert(property(), { numRuns: 1, examples: [lateStartedMapPass() as any, lateInsertAfterSettle() as any, answerMissed() as any, claimAgainAfterFailover() as any, claimAgainAfterApply() as any, secondClaimLost() as any] });
  }, 60_000);

  it('bite (NB7-R2-T2): a sender that misses a \'done\' row it polled answers can\'t confirm, and the check finds it', async () => {
    const out = await fc.check(property({ doneReadsApplying: true }), { numRuns: 1, seed: 7, examples: [answerMissed() as any] });
    expect(out.failed, 'the check took a can\'t confirm for an answer the sender could read').toBe(true);
    expect(String(out.errorInstance)).toMatch(/can't confirm \(timeout\) answered for request/);
  }, 60_000);

  it('bite (NB7-R2-T2): the holder answered and the sender read it, so can\'t confirm is a defect even after a claim', async () => {
    const w = new World([], { doneReadsApplying: true });
    const sent = await w.send('write');
    await w.pass();
    await w.finish('ok');
    expect(w.model.doneAt.get(sent.id!)).toBe(0);
    for (let i = 0; i < 70 && !sent.answer; i++) await w.advance(1000);
    expect(sent.answer).toMatchObject({ code: 'no-answer', noAnswer: 'timeout' });
    expect(() => w.check()).toThrow(/can't confirm \(timeout\) answered for request/);
  });

  it('bite (NB7-R3-T2): can\'t confirm for a row nobody took, with every statement answered, is a defect the check finds', async () => {
    const out = await fc.check(property({ settleLeavesPending: true }), { numRuns: 1, seed: 7, examples: [pendingUnanswered() as any] });
    expect(out.failed, 'the check took a can\'t confirm for a row nobody claimed').toBe(true);
    expect(String(out.errorInstance)).toMatch(/can't confirm \(timeout\) answered for request/);
  }, 60_000);

  it('bite (NB7-R3-T2), one run: the row stays pending and unclaimed, and the sender\'s timeout fails the check', async () => {
    const w = new World([], { settleLeavesPending: true });
    const sent = await w.send('write');
    for (let i = 0; i < 70 && !sent.answer; i++) await w.advance(1000);
    expect(sent.answer).toMatchObject({ code: 'no-answer', noAnswer: 'timeout' });
    expect(w.model.rows.get(sent.id!)?.state).toBe('pending');
    expect(w.model.claimed.has(sent.id!)).toBe(false);
    expect(() => w.check()).toThrow(/can't confirm \(timeout\) answered for request/);
  });

  it('ruling 8 with the holder\'s rule removed: an unapplied answer read on the failed-over server proves nothing, so the sender never says "nothing was saved"', async () => {
    const out = await fc.check(property({ leavesNoneOut: true }), { numRuns: 1, seed: 7, examples: [secondClaimLost() as any] });
    expect(out.failed, String(out.errorInstance)).toBe(false);
  });

  it('the model counts each insert the sender sends', () => {
    const m = new ModelDb(['ok']);
    void m.run(REQUEST_INSERT_SQL, ['x', GUILD, 2, 1, 'p-b', 'write', '{}', 'ALPHA', 5, 20]);
    expect(m.sentInserts).toEqual(['x']);
  });
});

describe('NB7 ruling 6 (R3-DL1): a claim lost in a failover is claimed again and answered from the holder\'s memory', () => {
  it('the apply is in flight at the failover: the second claim starts nothing, and its row gets the first apply\'s answer', async () => {
    const w = new World();
    const sent = await w.send('write');
    w.model.ship();
    await w.pass();
    expect(w.started.get(sent.id!)).toBe(1);
    expect(w.model.rows.get(sent.id!)?.state).toBe('applying');
    w.failover();
    expect(w.model.rows.get(sent.id!)?.state).toBe('pending');
    await w.pass();
    expect(w.model.rows.get(sent.id!)?.state).toBe('applying');
    expect(w.started.get(sent.id!)).toBe(1);
    await w.finish('ok');
    for (let i = 0; i < 70 && !sent.answer; i++) await w.advance(1000);
    expect(w.started.get(sent.id!)).toBe(1);
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'done', reply: JSON.stringify({ ok: true }) });
    expect(sent.answer).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    w.check();
  });

  it('the apply finished before the failover: the second claim answers its outcome, never the executor\'s "changed"', async () => {
    const w = new World();
    const sent = await w.send('write');
    w.model.ship();
    await w.pass();
    await w.finish('ok');
    w.failover();
    expect(w.model.rows.get(sent.id!)?.state).toBe('pending');
    await w.pass();
    for (let i = 0; i < 70 && !sent.answer; i++) await w.advance(1000);
    expect(w.started.get(sent.id!)).toBe(1);
    expect(w.outcomes.get(sent.id!)).toBe('ok');
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'done', reply: JSON.stringify({ ok: true }) });
    expect(sent.answer).toMatchObject({ ok: true, servedBy: 'BRAVO' });
    expect(String(sent.answer.error ?? '')).not.toMatch(/nothing was/);
    w.check();
  });
});

describe('NB7 ruling 8 (R4-DL1, R4-T1, R4-1): a second claim with no answer never gets "nothing was saved" for a started request', () => {
  /** The ruling-6 sequence up to the second claim: the holder started the request on the old primary, the standby holds it pending. */
  async function claimedThenFailedOver(w: World) {
    const sent = await w.send('write');
    w.model.ship();
    await w.pass();
    expect(w.started.get(sent.id!)).toBe(1);
    w.failover();
    expect(w.model.rows.get(sent.id!)?.state).toBe('pending');
    return sent;
  }

  async function followToEnd(w: World, sent: Awaited<ReturnType<World['send']>>) {
    await w.finish('ok');
    for (let i = 0; i < 70 && !sent.answer; i++) await w.advance(1000);
    expect(w.started.get(sent.id!)).toBe(1);
    expect(sent.answer).toBeDefined();
    expect(String(sent.answer.error ?? '')).not.toMatch(/nothing was/i);
    expect(w.model.rows.get(sent.id!)?.reply ?? null).not.toBe(UNAPPLIED_REPLY);
    w.check();
  }

  it('the second claim commits and loses its answer: the row stays applying under its batch, never done unapplied', async () => {
    const w = new World();
    const sent = await claimedThenFailedOver(w);
    w.model.forceSql(REQUEST_CLAIM_SQL, 'lost-after');
    await w.pass();
    expect(w.sweep.unanswered()).toHaveLength(1);
    expect(w.model.sentSql.filter(s => s === UNANSWERED_BATCHES_SQL).length).toBeGreaterThanOrEqual(1);
    const row = w.model.rows.get(sent.id!)!;
    expect(row).toMatchObject({ state: 'applying', reply: null, batch: w.sweep.unanswered()[0] });
    await w.pass();
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'applying', reply: null });
    await followToEnd(w, sent);
  });

  it('the second claim\'s rows come back after the stop began: the started row gets its apply\'s answer, the new row unapplied', async () => {
    const w = new World();
    const sent = await claimedThenFailedOver(w);
    const fresh = await w.send('write');
    w.model.forceSql(REQUEST_CLAIM_SQL, 'wire');
    const pass = w.sweep.pass();
    await flush();
    w.stopping = true;
    w.model.deliver();
    await pass;
    await flush();
    expect(w.sweep.unanswered()).toHaveLength(1);
    const batch = w.sweep.unanswered()[0];
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'applying', reply: null, batch });
    expect(w.model.rows.get(fresh.id!)).toMatchObject({ state: 'done', reply: UNAPPLIED_REPLY, batch });
    expect(w.started.get(fresh.id!) ?? 0).toBe(0);
    const stopped = w.sweep.stopStep();
    await w.finish('ok');
    await stopped;
    expect(w.model.rows.get(sent.id!)).toMatchObject({ state: 'done', reply: JSON.stringify({ ok: true }), batch });
    await followToEnd(w, sent);
    expect(sent.answer).toMatchObject({ ok: true, servedBy: 'BRAVO' });
  });

  it('a request this process never started, in the same lost batch, still gets the unapplied answer', async () => {
    const w = new World();
    const first = await claimedThenFailedOver(w);
    const second = await w.send('write');
    w.model.forceSql(REQUEST_CLAIM_SQL, 'lost-after');
    await w.pass();
    expect(w.model.rows.get(second.id!)).toMatchObject({ state: 'done', reply: UNAPPLIED_REPLY });
    expect(w.model.rows.get(first.id!)).toMatchObject({ state: 'applying', reply: null });
    expect(w.started.get(second.id!) ?? 0).toBe(0);
    w.check();
  });
});

describe('NB7 ruling 2 (DL1, RS-2): after an insert with no answer, "nothing was saved" only on proof', () => {
  it('a failover behind the same URL after the holder applied: the settle on the standby answers can\'t confirm', async () => {
    const w = new World();
    w.model.force('lost-after');
    w.model.force('lost-before');
    const sent = await w.send('write');
    await w.pass();
    expect(w.started.get(sent.id!)).toBe(1);
    w.failover();
    await w.finish('ok');
    for (let i = 0; i < 70 && !sent.answer; i++) await w.advance(1000);
    expect(sent.answer).toMatchObject({ code: 'no-answer', servedBy: 'BRAVO' });
    expect(String(sent.answer.error ?? '')).not.toMatch(/nothing was/);
    w.check();
  });

  it('the settle commits but loses its answer, and its retry finds the row expired: never the not-taken text', async () => {
    const w = new World();
    w.model.force('lost-after');
    w.model.force('lost-after');
    const sent = await w.send('write');
    for (let i = 0; i < 70 && !sent.answer; i++) await w.advance(1000);
    expect(w.started.get(sent.id!) ?? 0).toBe(0);
    expect(String(sent.answer.error ?? '')).not.toMatch(/did not take the change within 5 s/);
    expect(sent.answer.code === 'no-answer' || /did not confirm that the change was sent to BRAVO, so it was withdrawn/.test(sent.answer.error)).toBe(true);
    w.check();
  });

  it('the settle that lands on the server the insert went to and finds the row pending withdraws it: nothing was saved', async () => {
    const w = new World();
    w.model.force('lost-after');
    const sent = await w.send('write');
    for (let i = 0; i < 5 && !sent.answer; i++) await w.advance(1000);
    expect(sent.answer).toMatchObject({ code: 'backend-unavailable', error: 'The database did not confirm that the change was sent to BRAVO, so it was withdrawn; nothing was saved. Try again in a moment.' });
    await w.drain();
    expect(w.started.get(sent.id!) ?? 0).toBe(0);
  });
});

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const { stubs } = await import('../helpers/nb15Stubs');
  return { ...real, getPanelManager: () => stubs.manager };
});
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', async () => {
  const { stubs } = await import('../helpers/nb15Stubs');
  return { default: () => stubs.commands };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  const { premiumStub } = await import('../helpers/nb15Stubs');
  return { ...real, getPremiumManager: () => premiumStub };
});

import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import type { PanelRequestOp } from '../../src/bot/internalSetup/utils/panelRequestShape';
import type { Fate } from '../helpers/nb7Model';
import { fakeModelTime, quietLogs } from '../helpers/nb7World';
import { resetWorld15, World15, type Bites15, type Finish } from '../helpers/nb15World';

// NB15 test 6: the real sender, the real holder's sweep and start checks and the real live layer over the model store,
// with statements that lose their answer or run late, a database that goes away or fails over, holders that stop,
// crash, lose the lease or latch, and a web UI that exits. After every command: module code ran at most once, only in
// the process its row names while it served the guild, never for a system or dev-only panel; no run after "nothing was
// run"; success only from a holder's ok verdict; can't confirm only when the sender could not observe a start; every
// answer by T; no poll carried an unanswered insert's id; no claimed row keeps its body; reads are taken while read
// places are free; cleanups run; and a panel shown live shows the holder's latest state once the live layer ran out.

const RUNS = Number(process.env.SMDB_NB15_MODEL_RUNS ?? 200);
const BITE_RUNS = Number(process.env.SMDB_NB15_BITE_RUNS ?? 500);

type Cmd = fc.AsyncCommand<object, World15>;

function cmd(name: string, step: (w: World15) => Promise<void> | void): Cmd {
  return {
    check: () => true,
    async run(_m: object, w: World15) {
      await step(w);
      w.check();
    },
    toString: () => name,
  };
}

const SENDS: Array<[PanelRequestOp, 'owner' | 'member', string]> = [
  ['panel:button', 'owner', 'p'], ['panel:button', 'member', 'p'], ['panel:execute', 'owner', 'q'], ['panel:button', 'owner', 'sys'],
  ['panel:modal', 'owner', 'dev'], ['command:invoke', 'owner', 'p'], ['command:invoke', 'owner', 'dev'], ['command:invoke', 'member', 'p'],
  ['guild:channels', 'owner', 'p'], ['guild:roles', 'member', 'p'], ['panel:list', 'owner', 'p'], ['panel:live', 'owner', 'p'],
  ['guild:membership', 'member', 'p'],
];
const FINISHES: Finish[] = ['ok', 'pending', 'refused', 'oversize', 'unserializable', 'throws'];
const FATES: Fate[] = ['ok', 'lost-after', 'late', 'lost-before'];

const send = (op: PanelRequestOp, audience: 'owner' | 'member', panel: string) => cmd(`send ${op} ${audience} ${panel}`, w => w.send(op, audience, panel).then(() => undefined));
const sweep = () => cmd('holder sweep', w => w.pass());
const next = (fate: Fate) => cmd(`next statement ${fate}`, w => { w.model.force(fate); });
const advance = (ms: number) => cmd(`advance ${ms}`, w => w.advance(ms));
const finish = (kind: Finish) => cmd(`finish an action ${kind}`, w => w.finish(kind));

const commands = [
  fc.constantFrom(...SENDS).map(([op, a, p]) => send(op, a, p)),
  fc.constant(sweep()),
  fc.constantFrom(...FINISHES).map(finish),
  fc.constantFrom(...FATES).map(next),
  fc.constant(cmd('hang an action', () => undefined)),
  fc.constant(cmd('holder loses the lease', w => { w.leaseLost = true; })),
  fc.constant(cmd('holder keeps the lease', w => { w.leaseLost = false; })),
  fc.constant(cmd('holder crash', w => { w.crash(); })),
  fc.constant(cmd('holder stop', w => w.stop())),
  fc.constant(cmd('takeover', w => { w.takeover(); })),
  fc.constant(cmd('epoch change (the main switches)', w => { w.switchMain(); })),
  fc.constant(cmd('sender exit', w => w.exit())),
  fc.integer({ min: 100, max: 7000 }).map(advance),
  fc.constant(cmd('sender poll', w => w.advance(250))),
  fc.constant(cmd('cleanup period', w => w.advance(61_000))),
  fc.constant(cmd('database away', w => { w.away(); })),
  fc.constant(cmd('database back', w => { w.back(); })),
  fc.constant(cmd('standby catches up', w => { w.model.ship(); })),
  fc.constant(cmd('failover behind the same URL', w => { w.failover(); })),
  fc.constant(cmd('run a late statement', w => { w.model.runLate(); })),
  fc.constant(cmd('member panel turned off', w => { w.guildWebUi = false; })),
  fc.constant(cmd('member panel turned on', w => { w.guildWebUi = true; })),
  fc.constant(cmd('watch the remote panel', w => { w.watch('p'); })),
  fc.constant(cmd('close the remote panel', w => { w.closePanel(); })),
  fc.constant(cmd('change the watched panel', w => { w.changePanel('p'); })),
  fc.constant(cmd('change another panel', w => { w.changePanel('q'); })),
  fc.constant(cmd('listener drop', w => { w.dropListener(); })),
  fc.constant(cmd('live layer runs out', w => w.settle())),
];

const fates = fc.array(fc.constantFrom<Fate>('ok', 'ok', 'ok', 'lost-after', 'late', 'lost-before'), { minLength: 1, maxLength: 12 });

let world: World15 | undefined;

function property(bites: Bites15 = {}) {
  return fc.asyncProperty(fates, fc.commands(commands, { maxCommands: 30 }), async (f, cmds) => {
    vi.clearAllTimers();
    resetWorld15(world);
    world = new World15(f, bites);
    const w = world;
    await fc.asyncModelRun(() => ({ model: {}, real: w }), cmds);
    await w.drain();
    for (const sent of w.sends) if (!sent.crashed) expect(sent.answer, `request ${sent.tag} answered by its deadline`).toBeDefined();
  });
}

/** Hand-written examples for the bites; each also holds on the real code (the last test). */
const lostLease = (): [Fate[], Cmd[]] => [['ok'], [
  send('panel:button', 'owner', 'p'), cmd('holder loses the lease', w => { w.leaseLost = true; }), sweep(), finish('ok'), advance(7000),
]];
const systemFromRow = (): [Fate[], Cmd[]] => [['ok'], [send('panel:button', 'owner', 'sys'), sweep(), finish('ok'), advance(7000)]];
/** One start a second, so the real rate limit (5, then 1 a second) lets all 8 run and hang. */
const hungActions = (): [Fate[], Cmd[]] => [['ok'], [
  ...Array.from({ length: 8 }, () => [send('panel:button', 'owner', 'p'), sweep(), advance(1000)]).flat(), send('guild:channels', 'owner', 'p'), sweep(), advance(7000),
]];
const claimedBody = (): [Fate[], Cmd[]] => [['ok'], [send('panel:button', 'owner', 'p'), sweep()]];
/** A followed request keeps the poll set polling while a second request's insert waits on the wire. */
const wiredInsert = (): [Fate[], Cmd[]] => [['ok'], [
  send('panel:button', 'owner', 'p'), cmd('the next insert waits on the wire', w => { w.model.forceSql(REQUEST_INSERT_SQL, 'wire'); }),
  send('panel:execute', 'owner', 'q'), advance(250), advance(250), advance(250), advance(250), advance(1000),
]];
const staleWatched = (): [Fate[], Cmd[]] => [['ok'], [
  cmd('watch the remote panel', w => { w.watch('p'); }), cmd('live layer runs out', w => w.settle()),
  cmd('change the watched panel', w => { w.changePanel('p'); }), cmd('live layer runs out', w => w.settle()),
  cmd('change the watched panel', w => { w.changePanel('p'); }),
  ...Array.from({ length: 64 }, () => cmd('change another panel', w => { w.changePanel(`o${Math.random().toString(36).slice(2, 8)}`); })),
  cmd('live layer runs out', w => w.settle()),
]];

beforeEach(() => {
  fakeModelTime();
  quietLogs();
});
afterEach(() => {
  resetWorld15(world);
  world = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NB15 test 6: panel requests against a model store', () => {
  it('runs module code at most once where served, never after "nothing was run", success only from an ok verdict, can\'t confirm only when unobserved', async () => {
    await fc.assert(property(), { numRuns: RUNS });
  }, 600_000);

  it('regression (ruling 2), one run: an exit, then a failover behind the same URL that brings the row back to its holder', async () => {
    const w = (world = new World15());
    const sent = await w.send('panel:button', 'owner', 'p');
    w.model.ship();
    await w.exit();
    w.failover();
    await w.pass();
    await w.finish('ok');
    await w.drain();
    expect(w.runsOf(sent)).toBe(1);
    expect(sent.answer?.reply).toEqual({ success: true, data: { shown: 'next' }, liveSince: expect.any(Number), liveVersion: 1, servedBy: 'BRAVO' });
    w.check();
  });

  it('the bites\' examples hold on the real code', async () => {
    await fc.assert(property(), { numRuns: 1, examples: [lostLease() as any, systemFromRow() as any, hungActions() as any, claimedBody() as any, staleWatched() as any, wiredInsert() as any] });
  }, 120_000);

  it('bite: with the start\'s lease check removed, a request runs in a process that lost the shard', async () => {
    const out = await fc.check(property({ noLeaseCheck: true }), { numRuns: BITE_RUNS, seed: 7, examples: [lostLease() as any] });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/no longer served its guild/);
  }, 600_000);

  it('bite: with decision 3\'s rule removed, a row runs a system panel', async () => {
    const out = await fc.check(property({ noScopeRule: true }), { numRuns: BITE_RUNS, seed: 7, examples: [systemFromRow() as any] });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/ran a (system|dev) panel from a row/);
  }, 600_000);

  it('bite: with the action places shared with the read pick, 8 hung actions leave a read untaken', async () => {
    const out = await fc.check(property({ sharedPlaces: true }), { numRuns: BITE_RUNS, seed: 7, examples: [hungActions() as any] });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/left a read untaken/);
  }, 600_000);

  it('bite: with the claim\'s body = \'\' removed, an applying row keeps its body', async () => {
    const out = await fc.check(property({ claimKeepsBody: true }), { numRuns: BITE_RUNS, seed: 7, examples: [claimedBody() as any] });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/row .* keeps its body/);
  }, 600_000);

  it('bite: with the interest replaced by a map of the 64 latest changes, a watched panel shows a stale state with no line', async () => {
    const out = await fc.check(property({ latestMap: true }), { numRuns: 1, seed: 7, examples: [staleWatched() as any] });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/shown live with a state older than the holder's/);
  }, 600_000);

  it('bite: with the poll set\'s join rule removed (an id joins at its send), a poll carries an id whose insert is still on the wire', async () => {
    const out = await fc.check(property({ joinAtSend: true }), { numRuns: 1, seed: 7, examples: [wiredInsert() as any] });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/a poll carried the id of a request whose insert had no answer/);
  }, 600_000);

  it('the real sender never polls an insert on the wire: R joins the poll set only once its insert-form settle returned no row', async () => {
    const w = (world = new World15());
    const other = await w.send('panel:button', 'owner', 'p');
    w.model.forceSql(REQUEST_INSERT_SQL, 'wire');
    const held = await w.send('panel:execute', 'owner', 'q');
    for (let i = 0; i < 8; i++) await w.advance(250);
    expect(w.model.earlyPolls).toEqual([]);
    w.model.cut(false);
    for (let i = 0; i < 20 && !held.answer; i++) await w.advance(1000);
    expect(w.model.earlyPolls).toEqual([]);
    expect(held.answer?.reply.error).toMatch(/nothing was run/);
    expect(w.runsOf(held)).toBe(0);
    expect(other.id).toBeDefined();
    w.check();
  });
});

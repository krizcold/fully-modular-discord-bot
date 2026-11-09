import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { stopSteps } from '../helpers/stopRig';

// NB4 decisions 15 and 16, ruling N1: a restart for shards is asked only while fit and never while a save fails; a loss
// goes through NB2's leave; with no web UI process every leave ends in the process's own stop handler, which releases
// the held pairs once, sends no renewal after it and exits once; while a save fails nothing is released and the
// process does not exit. The modules are loaded fresh for each test, since a stop marks its module for good; the held
// write is a real working set's, over a store whose flushes fail until the test lets them land.

const h = vi.hoisted(() => ({ exits: 0 }));

const T = claimTimings(30);
let lines: string[] = [];
let sent: any[] = [];
const realSend = process.send;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  (process as { send?: unknown }).send = undefined;
  h.exits = 0;
  lines = [];
  sent = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(process, 'exit').mockImplementation(((() => { h.exits += 1; }) as unknown) as typeof process.exit);
});
afterEach(() => {
  (process as { send?: unknown }).send = realSend;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function rig(opts: { ipc?: boolean; fitness?: () => string | null } = {}) {
  const m = await import('../../src/bot/internalSetup/utils/maintenance');
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  const gate = await import('../../src/bot/internalSetup/utils/maintenanceGate');
  const { initWorkingSet } = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
  const { ShardClaims } = await import('../../src/bot/internalSetup/fleet/shardClaims');
  m._setMaintenanceTiming({ leaveRetryMs: 1000, filePollMs: 600_000, leaveSaveBoundMs: 2000 });
  if (opts.ipc) m._setMaintenanceSender(message => { sent.push(message); });
  const data = new FakeStore();
  const ws = initWorkingSet(data);
  const store = new MemClaimStore(() => Date.now());
  const calls = { stopStep: 0 };
  const fitness = opts.fitness ?? (() => (ws.heldGuilds().some(g => g.reason !== null) ? 'a save is failing' : null));
  const claims = new ShardClaims({
    store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
    returns: true, restartable: m.canRestart(), startedAt: 0, fitness, gateClosed: gate.isMaintenanceGateClosed,
    isStopping: dm.isStopping,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: m.noteClaimsLapsed,
    noteLost: lost => m.startLeave(`Shard ${lost.map(p => p.shardId).join(', ')} ${lost.length > 1 ? 'are' : 'is'} no longer held by this process`),
    restartForShards: reason => m.restartForShards(reason, fitness),
  });
  const stop = stopSteps(dm, { claims: () => claims });
  const released = () => lines.filter(l => l.startsWith('[Shards] Released shards'));
  /** A guild holding a write whose flush fails; the fitness function then names the failing save. */
  const hold = async () => {
    data.mode = 'unavailable';
    const guildId = String(9n << 22n);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(ws.save(guildId, 'm', 'a.json', '{"n":1}')).toBe('accepted');
    await ws.flushAllDirty();
    expect(fitness()).toBe('a save is failing');
    return guildId;
  };
  const land = () => { data.mode = 'commit'; };
  return { m, dm, gate, store, claims, calls, stop, released, hold, land, data, ws, fitness };
}

async function bootTwo(r: Awaited<ReturnType<typeof rig>>) {
  r.claims.start();
  await r.claims.firstRenewal();
  const taken = await r.claims.bootTake(async () => 2);
  r.claims.noteGranted();
  return taken!;
}

describe('with no web UI process, every leave ends in the stop handler', () => {
  it('a loss: the pairs still held are released once, no renewal follows, the process exits once; while a save fails, neither', async () => {
    const r = await rig();
    await bootTwo(r);
    await r.hold();
    Object.assign(r.store.rows.get('2:1')!, { claim: 99, holderProcess: 'p-x', holderNode: 'node-x' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(lines).toContain('[Maintenance] Shard 1 is no longer held by this process; saving what this process holds before it stops (no web UI process runs to restart it)');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.store.releases).toEqual([]);
    expect(h.exits).toBe(0);
    r.land();
    await vi.advanceTimersByTimeAsync(1000);
    expect(lines).toContain('[Maintenance] Shard 1 is no longer held by this process, but no web UI process runs to restart this bot process, so it stops; start it again by hand');
    expect(r.store.releases).toHaveLength(1);
    expect(r.released()).toEqual(["[Shards] Released shards 0: kept for this machine's next start for 30 s, then free to any machine with room"]);
    expect(lines.some(l => l.includes('was no longer held by this process at the release'))).toBe(false);
    expect(h.exits).toBe(1);
    const renewals = r.store.renewals.length;
    await vi.advanceTimersByTimeAsync(T.renewMs * 4);
    expect(r.store.renewals.length).toBe(renewals);
    expect(lines.some(l => l.startsWith('[Shards] Restarting'))).toBe(false);
  });

  it('a lapse: the watcher\'s next answer starts the leave, which ends in the release and one exit', async () => {
    const r = await rig();
    await bootTwo(r);
    let answer: 'answers' | 'unreachable' | 'refused' = 'unreachable';
    const watcher = r.m.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => answer } as any, { retryMs: 600_000 })!;
    r.m.markDiscordStarted();
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
    await watcher.probeNow();
    expect(r.store.releases).toEqual([]);
    answer = 'answers';
    await watcher.probeNow();
    expect(lines).toContain('[Maintenance] The shard claims lapsed (no renewal for 20 s) and the database answers; saving what this process holds before it stops (no web UI process runs to restart it)');
    await vi.advanceTimersByTimeAsync(2500);
    expect(r.store.releases).toHaveLength(1);
    expect(r.released()).toEqual(["[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room"]);
    expect(h.exits).toBe(1);
  });

  it('after a 28000 maintenance: the login returns, the leave ends in the release and one exit', async () => {
    const r = await rig();
    await bootTwo(r);
    let refusedCb: () => void = () => undefined;
    let answer: 'answers' | 'refused' = 'refused';
    const watcher = r.m.watchDataBackend({ onLoginRefused: (cb: () => void) => { refusedCb = cb; }, askDatabase: async () => answer } as any, { retryMs: 600_000 })!;
    r.m.markDiscordStarted();
    refusedCb();
    expect(r.gate.isMaintenanceGateClosed()).toBe(true);
    r.store.renewMode = Object.assign(new Error('role is not permitted to log in'), { code: '28000' });
    await vi.advanceTimersByTimeAsync(T.deadlineMs + T.renewMs);
    expect(r.calls.stopStep).toBe(0);
    r.store.renewMode = 'ok';
    answer = 'answers';
    await watcher.probeNow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.store.releases).toHaveLength(1);
    expect(r.released()).toHaveLength(1);
    expect(h.exits).toBe(1);
  });

  it('SIGINT during the stop the leave started: one release line, no "no longer held" line, one exit', async () => {
    const r = await rig();
    await bootTwo(r);
    r.store.releaseMode = 'hang';
    r.m.startLeave('The hook says running');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.releases).toHaveLength(1);
    void r.stop();
    void r.stop();
    r.store.releaseMode = 'ok';
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.releases).toHaveLength(1);
    expect(r.released()).toHaveLength(1);
    expect(lines.some(l => l.includes('was no longer held by this process at the release'))).toBe(false);
    expect(h.exits).toBe(1);
  });

  it('before the boot take: a leave that ends sends no take, no release and no "Released" line, and the process exits', async () => {
    const r = await rig();
    r.claims.start();
    await r.claims.firstRenewal();
    r.m.startLeave('The database refused the login (SQLSTATE 28000) while the bot process booted');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.exits).toBe(1);
    expect(await r.claims.bootTake(async () => 2)).toBeNull();
    expect(r.store.takes).toEqual([]);
    expect(r.store.releases).toEqual([]);
    expect(r.released()).toEqual([]);
    expect(r.store.renewals.every(q => q.pairs.length === 0)).toBe(true);
  });

  it.each([
    [true, ["[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room"]],
    [false, []],
  ])('with the boot take on the wire when the leave ends (its COMMIT landed before the destroy: %s): the connection is destroyed, the release covers what committed, nothing is granted', async (commits, releasedLines) => {
    const r = await rig();
    r.claims.start();
    await r.claims.firstRenewal();
    r.store.takeMode = 'hang';
    r.store.takeCommitsAtDestroy = commits;
    const boot = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    const before = lines.length;
    r.m.startLeave('The hook says running');
    await vi.advanceTimersByTimeAsync(T.renewMs + 2500);
    expect(await boot).toBeNull();
    expect(r.store.abandoned.work).toBe(1);
    expect(r.store.takes).toHaveLength(1);
    expect(r.store.releases).toHaveLength(1);
    expect(r.released()).toEqual(releasedLines);
    expect(lines.slice(before).filter(l => l.startsWith('[Shards]'))).toEqual(releasedLines);
    expect(r.store.releases[0].reserved).toEqual([]);
    const rows = [...r.store.rows.values()];
    expect(rows).toHaveLength(commits ? 2 : 0);
    expect(rows.every(row => row.released && row.holderProcess === 'p-a')).toBe(true);
    expect(r.claims.heldPairs()).toEqual([]);
    expect(r.store.renewals.every(q => q.pairs.length === 0)).toBe(true);
    expect(h.exits).toBe(1);
  });

  it('reserves nothing, decides no return, logs the boot line once and never a restart line', async () => {
    const r = await rig();
    await bootTwo(r);
    Object.assign(r.store.rows.get('2:1')!, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 1);
    r.store.rows.get('2:0')!.homeNode = 'node-b';
    const b = {
      nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
      seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now() - 301_000,
    };
    r.store.nodes.set('node-b', b);
    setInterval(() => { b.seenAt = Date.now(); }, 1_000);
    await vi.advanceTimersByTimeAsync(T.renewMs * 4);
    expect(r.store.takes).toHaveLength(1);
    expect(r.claims.snapshot().returning).toEqual([]);
    expect(lines.filter(l => l === '[Shards] No web UI process runs to restart this bot process, so it takes shards only when it starts')).toHaveLength(1);
    expect(lines.some(l => l.startsWith('[Shards] Restarting'))).toBe(false);
    r.claims.beginStop();
    await r.claims.finishStop();
    expect(r.store.releases.at(-1)!.handOvers).toEqual([]);
    expect(r.store.rows.get('2:0')).toMatchObject({ holderNode: 'node-a', holderProcess: 'p-a', released: true });
    expect(lines.some(l => l.startsWith('[Shards] Handed'))).toBe(false);
  });

  it('the same fleet with a web UI process: the return to B is decided, asked and handed at the stop', async () => {
    const r = await rig({ ipc: true });
    await bootTwo(r);
    r.store.rows.get('2:0')!.homeNode = 'node-b';
    const b = {
      nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
      seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now() - 301_000,
    };
    r.store.nodes.set('node-b', b);
    setInterval(() => { b.seenAt = Date.now(); }, 1_000);
    await vi.advanceTimersByTimeAsync(T.renewMs * 4);
    expect(r.claims.snapshot().returning).toEqual([0]);
    expect(sent).toContainEqual({ type: 'control:restart-bot', data: { reason: 'return shard 0 to B' } });
    r.claims.beginStop();
    await r.claims.finishStop();
    expect(r.store.releases.at(-1)!.handOvers).toEqual([{ shardId: 0, receiver: 'node-b', move: false }]);
    expect(lines).toContain('[Shards] Handed shard 0 to B');
  });

  it('a lapse while SELECT 1 answers all along: the first probe after D starts the leave with its reason; the release and one exit follow, and a module timer finds the process exited', async () => {
    const r = await rig();
    await bootTwo(r);
    let posts = 0;
    setInterval(() => { posts += 1; }, 1000);
    vi.mocked(process.exit).mockImplementation(((() => { h.exits += 1; vi.clearAllTimers(); }) as unknown) as typeof process.exit);
    const watcher = r.m.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' } as any, { retryMs: 600_000 })!;
    r.m.markDiscordStarted();
    await watcher.probeNow();
    expect(lines.some(l => l.includes('saving what this process holds'))).toBe(false);
    r.store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(1);
    await watcher.probeNow();
    expect(lines).toContain('[Maintenance] The shard claims lapsed (no renewal for 20 s) and the database answers; saving what this process holds before it stops (no web UI process runs to restart it)');
    await vi.advanceTimersByTimeAsync(2500);
    expect(r.store.releases).toHaveLength(1);
    expect(r.released()).toEqual(["[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room"]);
    expect(h.exits).toBe(1);
    const atExit = posts;
    expect(atExit).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toBe(atExit);
  });

  it('the leave after hook maintenance (maintenance.json turns to running): one release line and one exit', async () => {
    const r = await rig();
    const mf = await import('../../src/utils/maintenanceFile');
    try {
      await bootTwo(r);
      r.m._setMaintenanceTiming({ filePollMs: 1000 });
      mf.writeMaintenanceFile('maintenance', 'm');
      await r.m.enterMaintenance('m');
      expect(r.gate.isMaintenanceGateClosed()).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(r.store.releases).toEqual([]);
      expect(h.exits).toBe(0);
      mf.writeMaintenanceFile('running', 'm');
      await vi.advanceTimersByTimeAsync(1000 + 3000);
      expect(lines).toContain('[Maintenance] maintenance.json says running; saving what this process holds before it stops (no web UI process runs to restart it)');
      expect(r.store.releases).toHaveLength(1);
      expect(r.released()).toEqual(["[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room"]);
      expect(h.exits).toBe(1);
    } finally {
      fs.rmSync(mf.maintenanceFilePath(), { force: true });
    }
  });
});

// The bot entry (index.ts) installs the one stop handler before the boot runs; each case does the same.
describe('the maintenance boot with no web UI process ends through the one stop handler', () => {
  const listeners = () => ({ term: new Set(process.listeners('SIGTERM')), int: new Set(process.listeners('SIGINT')) });
  function added(before: ReturnType<typeof listeners>) {
    return {
      term: process.listeners('SIGTERM').filter(l => !before.term.has(l)),
      int: process.listeners('SIGINT').filter(l => !before.int.has(l)),
    };
  }
  function removeAdded(before: ReturnType<typeof listeners>) {
    const extra = added(before);
    for (const l of extra.term) process.removeListener('SIGTERM', l);
    for (const l of extra.int) process.removeListener('SIGINT', l);
  }

  it('a Postgres maintenance boot whose login returns exits once', async () => {
    const kind = await import('../helpers/backendKind');
    kind.setBackendKind('postgres');
    const m = await import('../../src/bot/internalSetup/utils/maintenance');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const before = listeners();
    dm.installStopHandler();
    let probe: 'refused' | 'accepted' = 'refused';
    let atLogin: number[] = [];
    const login = vi.fn(async () => { const a = added(before); atLogin = [a.term.length, a.int.length]; });
    try {
      const client = await m.runMaintenanceBoot({ cause: 'login-refused', message: 'm' }, {
        shardRecord: () => ({ shardCount: 2, shardIds: [0, 1], processId: 'p', at: '' }), login, loginProbe: async () => probe, retryMs: 1000,
      });
      expect(client).not.toBeNull();
      expect(login).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.exits).toBe(0);
      probe = 'accepted';
      await vi.advanceTimersByTimeAsync(1000 + 8000);
      expect(lines).toContain('[Maintenance] The database accepted the login again, but no web UI process runs to restart this bot process, so it stops; start it again by hand');
      expect(h.exits).toBe(1);
      expect(vi.mocked(process.exit).mock.calls).toEqual([[0]]);
      expect(atLogin).toEqual([1, 1]);
      expect(lines).not.toContain('[Data] No stop handler is built yet; the bot process exits');
    } finally {
      removeAdded(before);
      kind.setBackendKind(null);
    }
  });

  it.each(['file says running', 'SIGTERM'] as const)('a JSON hook maintenance boot whose shard count fetch keeps failing: on %s the handler exits within its bounds while the Discord retry still loops', async how => {
    const kind = await import('../helpers/backendKind');
    kind.setBackendKind('file');
    const m = await import('../../src/bot/internalSetup/utils/maintenance');
    const mf = await import('../../src/utils/maintenanceFile');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const before = listeners();
    dm.installStopHandler();
    const shards = vi.fn(async (): Promise<number> => { throw new Error('connect ECONNRESET'); });
    try {
      m._setMaintenanceTiming({ filePollMs: 1000 });
      mf.writeMaintenanceFile('maintenance', 'm');
      void m.runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards, login: async () => undefined });
      const handlers = added(before);
      expect(handlers.term).toHaveLength(1);
      expect(handlers.int).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(shards).toHaveBeenCalled();
      expect(h.exits).toBe(0);
      if (how === 'SIGTERM') handlers.term[0]('SIGTERM');
      else mf.writeMaintenanceFile('running', 'm');
      await vi.advanceTimersByTimeAsync(1000 + 6000);
      expect(h.exits).toBe(1);
      expect(vi.mocked(process.exit).mock.calls).toEqual([[0]]);
      if (how !== 'SIGTERM') expect(lines).toContain('[Maintenance] maintenance.json says running, but no web UI process runs to restart this bot process, so it stops; start it again by hand');
      const tries = shards.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(shards.mock.calls.length).toBeGreaterThan(tries);
      expect(h.exits).toBe(1);
    } finally {
      removeAdded(before);
      fs.rmSync(mf.maintenanceFilePath(), { force: true });
      kind.setBackendKind(null);
    }
  });
});

describe("NB2's content-refusal leave lines, worded by whether a web UI process can restart this one", () => {
  it.each([
    [false, 'after 3 saves in a row that fail this way it stops and drops them', 'the bot process stops, which drops these changes'],
    [true, 'after 3 saves in a row that fail this way it restarts and drops them', 'the bot process asks for its restart, which drops these changes'],
  ])('with an IPC channel %s', async (ipc, heldTail, droppedTail) => {
    const r = await rig({ ipc });
    await bootTwo(r);
    const a = String(21n << 22n);
    const b = String(22n << 22n);
    expect(await r.ws.hydrate(a, tokenFor())).toBe('ready');
    expect(await r.ws.hydrate(b, tokenFor())).toBe('ready');
    let healAt = Infinity;
    vi.spyOn(r.data, 'flushGuild').mockImplementation(async (guildId: string) => {
      if (guildId === a) return { ok: false, reason: 'unavailable', detail: 'SQLSTATE 22P05: unsupported Unicode escape sequence', code: '22P05' } as any;
      return Date.now() < healAt ? { ok: false, reason: 'unavailable', detail: 'timeout exceeded when trying to connect' } as any : { ok: true };
    });
    expect(r.ws.save(a, 'm', 'a.json', '1')).toBe('accepted');
    expect(r.ws.save(b, 'm', 'b.json', '1')).toBe('accepted');
    const watcher = r.m.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' } as any, { retryMs: 600_000 })!;
    await watcher.probeNow();
    await vi.advanceTimersByTimeAsync(0);
    healAt = Date.now() + 2500;
    r.m.startLeave('The hook says running');
    await vi.advanceTimersByTimeAsync(30_000);
    const held = lines.filter(l => l.includes('the database refuses these for their content'));
    expect(held).toHaveLength(1);
    expect(held[0].endsWith(heldTail)).toBe(true);
    const dropped = lines.filter(l => l.includes('saves in a row left changes the database refuses for their content'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0].endsWith(droppedTail)).toBe(true);
    if (ipc) {
      expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1);
      expect(h.exits).toBe(0);
    } else {
      expect(r.released()).toHaveLength(1);
      expect(h.exits).toBe(1);
      expect([...held, ...dropped].some(l => /restart/.test(l))).toBe(false);
    }
  });
});

describe('a restart for shards with a web UI process', () => {
  it('asks at once while members write and no save fails, never reports held and never leaves', async () => {
    const r = await rig({ ipc: true });
    const guildId = String(11n << 22n);
    expect(await r.ws.hydrate(guildId, tokenFor())).toBe('ready');
    let n = 0;
    const answers: unknown[] = [];
    const writer = setInterval(() => { answers.push(r.ws.save(guildId, 'm', 'w.json', JSON.stringify({ n: ++n }))); void r.ws.flushAllDirty(); }, 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.m.restartForShards('take shard 3', r.fitness)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    clearInterval(writer);
    await r.ws.flushAllDirty();
    expect(answers.length).toBeGreaterThanOrEqual(19);
    expect(answers.every(a => a === 'accepted')).toBe(true);
    expect(JSON.parse(r.data.doc(guildId, 'w.json')!)).toEqual({ n });
    expect(sent).toContainEqual({ type: 'control:restart-bot', data: { reason: 'take shard 3' } });
    expect(sent.some(s => s.type === 'maintenance:mode' && s.data.mode === 'held')).toBe(false);
    expect(r.m.maintenanceUnfit()).toBe('restarting');
    expect(lines.some(l => l.includes('saving what this process holds'))).toBe(false);
  });

  it('a reservation while a flush fails is neither decided nor asked; the request goes out at the first tick after the flush lands', async () => {
    const r = await rig({ ipc: true });
    await bootTwo(r);
    const freed = r.store.rows.get('2:1')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 1);
    await r.hold();
    const takes = r.store.takes.length;
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    expect(r.store.takes.length).toBe(takes);
    expect(sent.some(s => s.type === 'control:restart-bot')).toBe(false);
    r.land();
    for (let waited = 0; waited < T.renewMs && r.ws.heldGuilds().length > 0; waited += 500) {
      expect(r.store.takes.length).toBe(takes);
      await vi.advanceTimersByTimeAsync(500);
    }
    await r.ws.flushAllDirty();
    expect(r.ws.heldGuilds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.takes.length).toBe(takes + 1);
    expect(sent).toContainEqual({ type: 'control:restart-bot', data: { reason: 'take shard 1' } });
    expect(lines).toContain('[Shards] Restarting this bot process to take shard 1');
  });

  it('a guild that starts failing between the decision and the request holds the request until it lands', async () => {
    let failing = false;
    let asks = 0;
    const r = await rig({ ipc: true, fitness: () => { asks += 1; return failing ? 'a save is failing' : null; } });
    await bootTwo(r);
    const freed = r.store.rows.get('2:1')!;
    Object.assign(freed, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
    r.claims['held'] = r.claims['held'].filter((p: { shardId: number }) => p.shardId !== 1);
    const realReserve = r.store.take.bind(r.store);
    r.store.take = async (request, onBegin) => {
      const answer = await realReserve(request, onBegin);
      if (request.reserve) failing = true;
      return answer;
    };
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([1]);
    expect(sent.some(s => s.type === 'control:restart-bot')).toBe(false);
    expect(asks).toBeGreaterThan(0);
    failing = false;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(sent).toContainEqual({ type: 'control:restart-bot', data: { reason: 'take shard 1' } });
  });

  it('a loss while a flush on a still-held shard fails starts the leave and asks no restart until the flush lands', async () => {
    const r = await rig({ ipc: true });
    await bootTwo(r);
    await r.hold();
    Object.assign(r.store.rows.get('2:1')!, { claim: 99, holderProcess: 'p-x', holderNode: 'node-x' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(lines).toContain('[Maintenance] Shard 1 is no longer held by this process; saving what this process holds before it restarts');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.some(s => s.type === 'control:restart-bot')).toBe(false);
    r.land();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.filter(s => s.type === 'control:restart-bot')).toHaveLength(1);
    expect(h.exits).toBe(0);
  });
});

describe("NB2's held line, worded by whether a web UI process can restart this one", () => {
  it.each([
    [false, 'does not stop until they are saved or the operator stops it, which drops them'],
    [true, 'does not restart until they are saved or the operator restarts it, which drops them'],
  ])('with an IPC channel %s', async (ipc, tail) => {
    const r = await rig({ ipc });
    await r.hold();
    r.m.startLeave('The hook says running');
    await vi.advanceTimersByTimeAsync(20_000);
    const held = lines.filter(l => l.includes('saves in a row left changes unsaved'));
    expect(held).toHaveLength(1);
    expect(held[0].endsWith(tail)).toBe(true);
    if (!ipc) expect(held[0]).not.toMatch(/restart/);
    expect(h.exits).toBe(0);
  });
});

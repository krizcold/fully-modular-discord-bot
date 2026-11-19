import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB37's mutation gate, survivors in maintenance.ts from line 800 on (sheets/NX5.md section 7): the leave's waits
// while counted work runs (G8-14), the watcher's answers after a lapse or a refused login, decideBoot's order read and
// the maintenance boot's poll. Maintenance boots mark the process for good, so their rows come last; the rows whose
// working set keeps a refused guild come right before them.

const fileReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/utils/maintenanceFile', async orig => {
  const real = await orig<typeof import('../../src/utils/maintenanceFile')>();
  return { ...real, readMaintenanceFile: () => { fileReads.count += 1; return real.readMaintenanceFile(); } };
});
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: any) => (globalThis as any).__nb37dSession(config),
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { addHeldSaver, removeHeldSaver } from '../../src/bot/internalSetup/utils/dataManager';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';
import { setBackendKind } from '../helpers/backendKind';
import { ME, MESSAGE, OrderStore, entry, fakeSession, order, orderRow, pgError, settle, world } from '../helpers/nx5Rig';

const sessions = { made: 0 };
(globalThis as any).__nb37dSession = (config: any) => { sessions.made += 1; return fakeSession(config); };

const m = maintenance as any;
const W = 'premium: 1 change(s) waiting for a payment provider';
const W2 = 'premium: 2 change(s) waiting for a payment provider';
let sent: any[] = [];
let logs: string[] = [];
let warns: string[] = [];
let errors: unknown[][] = [];
let warnedAt: number[] = [];

beforeEach(() => {
  sent = [];
  logs = [];
  warns = [];
  warnedAt = [];
  errors = [];
  sessions.made = 0;
  world.clear();
  maintenance._setMaintenanceSender(message => { sent.push(message); });
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])); warnedAt.push(Date.now()); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => {
  m.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  setBackendKind(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const restarts = () => sent.filter(s => s.type === 'control:restart-bot');
const modes = () => sent.filter(s => s.type === 'maintenance:mode');
const nothingHeld = () => warns.filter(l => l.startsWith('[Maintenance] Nothing is held, but work this process accepted still runs'));
const contentWaits = () => warns.filter(l => l.includes('refuses for their content') && l.includes('work this process accepted still runs'));
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** A held saver whose open work the row sets; resaves counts the leave's save passes. */
function workSaver(work: string | null = W) {
  const s = { work, resaves: 0, resaveHeld: () => { s.resaves += 1; }, heldFiles: () => [] as string[], openWork: () => s.work };
  addHeldSaver(s);
  return s;
}

const UNTIL = (end: 'stop for the hand-over' | 'stop' | 'restart', verb: 'stops' | 'restarts') =>
  `does not ${end} until it ends, or the operator ${verb} it, which cuts that work and drops any change it has not saved`;

describe('the nothing-held wait names the leave\'s end', () => {
  it('a hand-over: does not stop for the hand-over until the work ends, or the operator stops it', async () => {
    const saver = workSaver();
    try {
      m.startLeave('The shards changed', { attempt: 'a-1' });
      await vi.waitFor(() => expect(nothingHeld()).toHaveLength(1), { timeout: 3000, interval: 20 });
      expect(nothingHeld()[0]).toBe(`[Maintenance] Nothing is held, but work this process accepted still runs and may save changes (${W}); the bot process keeps running and ${UNTIL('stop for the hand-over', 'stops')}`);
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('with no web UI process to restart it: does not stop until the work ends, or the operator stops it', async () => {
    const saver = workSaver();
    maintenance._setMaintenanceSender(null);
    const own = process.send;
    try {
      (process as any).send = undefined;
      try {
        m.startLeave('The hook says running');
      } finally {
        (process as any).send = own;
      }
      await vi.waitFor(() => expect(nothingHeld()).toHaveLength(1), { timeout: 3000, interval: 20 });
      expect(nothingHeld()[0]).toBe(`[Maintenance] Nothing is held, but work this process accepted still runs and may save changes (${W}); the bot process keeps running and ${UNTIL('stop', 'stops')}`);
    } finally {
      removeHeldSaver(saver);
    }
  });
});

describe('the nothing-held wait', () => {
  it('the wait ends at its bound: the next save pass starts at that instant, not one poll later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    maintenance._setMaintenanceTiming({ leaveRetryMs: 100, leaveSaveBoundMs: 50 });
    const saver = workSaver();
    try {
      m.startLeave('The hook says running');
      for (let i = 0; i < 100 && nothingHeld().length === 0; i++) await vi.advanceTimersByTimeAsync(1);
      expect(nothingHeld()).toHaveLength(1);
      expect(saver.resaves).toBe(1);
      const waitStart = warnedAt[warns.indexOf(nothingHeld()[0])];
      await vi.advanceTimersByTimeAsync(waitStart + 100 - Date.now());
      expect(saver.resaves).toBe(2);
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('the work ends long before the retry interval: the restart follows at once, not after the interval', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 20_000 });
    const saver = workSaver();
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(nothingHeld()).toHaveLength(1), { timeout: 3000, interval: 20 });
      saver.work = null;
      await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 5000, interval: 20 });
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('several passes with the same work: one log line, and no mode report while nothing was reported held', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 50 });
    const saver = workSaver();
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(saver.resaves).toBeGreaterThanOrEqual(4), { timeout: 5000, interval: 20 });
      expect(nothingHeld()).toHaveLength(1);
      expect(modes()).toEqual([]);
      expect(restarts()).toEqual([]);
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('a reset during the wait ends the leave: no save pass after it', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 100, leaveSaveBoundMs: 50 });
    const saver = workSaver();
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(nothingHeld()).toHaveLength(1), { timeout: 3000, interval: 20 });
      maintenance._resetMaintenance();
      const passes = saver.resaves;
      await pause(400);
      expect(saver.resaves).toBe(passes);
    } finally {
      removeHeldSaver(saver);
    }
  });
});

/** A serving process with the watcher over a fake backend and the claims pool's order source. */
function serving() {
  const db = { answer: 'answers' as 'answers' | 'refused' | 'unreachable' };
  const watcher = maintenance.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => db.answer }, { retryMs: 3_600_000 })!;
  const store = new OrderStore();
  m.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  const probe = async (answer: typeof db.answer) => {
    db.answer = answer;
    await watcher.probeNow();
    await settle();
  };
  return { store, probe };
}

describe('the watcher\'s answers', () => {
  it('a refused login kept by an unknown read: after the lapse the database answers twice; one lapse line, and no login-accepted line', async () => {
    const s = serving();
    m.noteSaveOrder(null);
    await settle();
    await s.probe('refused');
    maintenance.noteClaimsLapsed(25);
    await s.probe('answers');
    await s.probe('answers');
    await pause(100);
    expect(logs.filter(l => l.startsWith('[Maintenance] The database answers again after the shard claims lapsed'))).toEqual([
      '[Maintenance] The database answers again after the shard claims lapsed; the bot process stays off Discord in maintenance until it reads the main database\'s maintenance order again',
    ]);
    expect(logs.filter(l => l.startsWith('[Maintenance] The database accepted the login again'))).toEqual([]);
    expect(restarts()).toEqual([]);
  });

  it('cause order: the database answers after the lapse while the order holds; the line names the order', async () => {
    const s = serving();
    m.noteSaveOrder(order());
    await settle();
    maintenance.noteClaimsLapsed(25);
    await s.probe('answers');
    expect(logs).toContain('[Maintenance] The database answers again after the shard claims lapsed, but the main database holds a maintenance order; the bot process stays off Discord in maintenance');
  });

  it('a refused login, then the login accepted while the read is unknown: the line says it waits for the order read', async () => {
    const s = serving();
    m.noteSaveOrder(null);
    await settle();
    await s.probe('refused');
    await s.probe('answers');
    expect(logs).toContain('[Maintenance] The database accepted the login again; the bot stays in maintenance until it reads the main database\'s maintenance order again');
  });

  it('the hook\'s leave on an open gate finds the login refused; after the lapse the database answers: with no gate cause it leaves', async () => {
    const s = serving();
    s.store.saveOrder = pgError('28000');
    const reply = await maintenance.handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l-1', data: {} });
    expect(reply?.data).toMatchObject({ leaving: false, heldBy: 'login' });
    s.store.saveOrder = null;
    maintenance.noteClaimsLapsed(25);
    await s.probe('answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 3000, interval: 20 });
  });
});

describe('decideBoot reads every writable entry', () => {
  it('a lower-generation writable entry answers first; the highest one, later, holds the order: maintenance, with the log line', async () => {
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', `${entry('db-low')}, ${entry('db-high')}`);
    world.set('db-low', { generation: 2, order: null });
    world.set('db-high', { generation: 3, connectMs: 100, order: orderRow() });
    expect(await maintenance.decideBoot()).toEqual({ mode: 'maintenance', cause: 'order', message: MESSAGE });
    expect(warns).toContain('[Maintenance] The main database holds a maintenance order; booting in maintenance mode');
  });
});

/** One guild whose save the database refuses for its content, under a watcher whose database answers. */
async function refusedGuild() {
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  const refused = { ok: false, reason: 'unavailable', detail: 'SQLSTATE 23505: duplicate key value', code: '23505' } as any;
  const flush = vi.spyOn(store, 'flushGuild').mockResolvedValue(refused);
  const add = async () => {
    const guildId = freshGuild();
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    expect(ws.save(guildId, 'm', 'refused.json', '1')).toBe('accepted');
    return guildId;
  };
  const first = await add();
  const watcher = m.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' }, { retryMs: 3_600_000 });
  await watcher.probeNow();
  return { first, add, flush };
}

// The working set these rows start keeps its refused guilds for the rest of the file.
describe('the content-refusal wait', () => {
  it('a second guild refused for its content while the same work runs: the wait logs again with both guilds', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 100 });
    const { first, add } = await refusedGuild();
    const saver = workSaver();
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      const second = await add();
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(2), { timeout: 5000, interval: 20 });
      expect(contentWaits()[1]).toContain(`guild ${first} (SQLSTATE 23505`);
      expect(contentWaits()[1]).toContain(`guild ${second} (SQLSTATE 23505`);
      expect(restarts()).toEqual([]);
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('the running work changes while the held guilds stay the same: the wait logs again with the new work', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 30, leaveSaveBoundMs: 100 });
    await refusedGuild();
    const saver = workSaver();
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      saver.work = W2;
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(2), { timeout: 5000, interval: 20 });
      expect(contentWaits()[1]).toContain(`(${W2})`);
    } finally {
      removeHeldSaver(saver);
    }
  });

  it('a reset during the content-refusal wait ends the leave: no save pass after it', async () => {
    maintenance._setMaintenanceTiming({ leaveRetryMs: 100, leaveSaveBoundMs: 100 });
    await refusedGuild();
    const saver = workSaver();
    try {
      m.startLeave('The hook says running');
      await vi.waitFor(() => expect(contentWaits()).toHaveLength(1), { timeout: 5000, interval: 20 });
      maintenance._resetMaintenance();
      const passes = saver.resaves;
      await pause(400);
      expect(saver.resaves).toBe(passes);
    } finally {
      removeHeldSaver(saver);
    }
  });
});

// Last: these rows boot in maintenance, which no reset undoes.
describe('the maintenance boot\'s poll', () => {
  async function postgresBoot(cause: 'order' | 'hook' | 'login-refused'): Promise<void> {
    setBackendKind('postgres');
    vi.stubEnv('DATA_BACKEND_URL', `${entry('db-low')}, ${entry('db-high')}`);
    expect(await maintenance.runMaintenanceBoot({ cause, message: MESSAGE }, { shardRecord: () => null, login: async () => undefined })).toBeNull();
    await settle();
  }
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const poll = async (times = 1) => {
    for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(5_000);
    await settle();
  };

  it('cause order: the highest writable entry still holds the order while a lower one answers first: the boot stays', async () => {
    fake();
    world.set('db-low', { generation: 2, order: null });
    world.set('db-high', { generation: 3, connectMs: 1000, order: orderRow() });
    await postgresBoot('order');
    await poll(3);
    expect(restarts()).toEqual([]);
  });

  it('cause order: the order ends; the leave names the order\'s end', async () => {
    fake();
    world.set('db-low', { generation: 3, order: orderRow({ state: 'running' }) });
    world.set('db-high', { generation: 2, order: null });
    await postgresBoot('order');
    await poll();
    expect(restarts()).toHaveLength(1);
    expect(logs).toContain('[Maintenance] The main database\'s maintenance order ended; saving what this process holds before it restarts');
  });

  it('cause hook: the leave starts while the poll\'s pass runs; once the pass answers, the poll reads maintenance.json no more', async () => {
    fake();
    writeMaintenanceFile('maintenance', 'm');
    world.set('db-low', { generation: 3, connectMs: 1000, order: null });
    world.set('db-high', { generation: 2, connectMs: 1000, order: null });
    await postgresBoot('hook');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sessions.made).toBe(2);
    m.startLeave('The test starts the leave');
    await settle();
    expect(restarts()).toHaveLength(1);
    const reads = fileReads.count;
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(fileReads.count).toBe(reads);
  });

  it('a pass still running when the next poll is due: the poll does not start a second pass', async () => {
    fake();
    world.set('db-low', { hang: true });
    world.set('db-high', { hang: true });
    await postgresBoot('order');
    await poll();
    expect(sessions.made).toBe(2);
    await poll();
    expect(sessions.made).toBe(2);
  });

  it('cause hook with maintenance.json gone: the poll does not leave until the hook writes running', async () => {
    maintenance._setMaintenanceTiming({ filePollMs: 20, leaveRetryMs: 30 });
    writeMaintenanceFile('maintenance', 'm');
    await maintenance.runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 1, login: async () => undefined });
    fs.rmSync(maintenanceFilePath(), { force: true });
    await pause(300);
    expect(logs.filter(l => l.includes('saving what this process holds'))).toEqual([]);
    expect(restarts()).toEqual([]);
    writeMaintenanceFile('running', 'm');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(logs).toContain('[Maintenance] maintenance.json says running; saving what this process holds before it restarts');
  });

  it('a poll that throws is logged as the poll\'s failure', async () => {
    maintenance._setMaintenanceTiming({ filePollMs: 20, leaveRetryMs: 30 });
    writeMaintenanceFile('maintenance', 'm');
    await maintenance.runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 1, login: async () => undefined });
    const boom = new Error('the log failed');
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('saving what this process holds')) throw boom;
      logs.push(String(args[0]));
    });
    writeMaintenanceFile('running', 'm');
    await vi.waitFor(() => expect(errors.filter(e => e[0] === '[Maintenance] The maintenance poll failed:')).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(errors.find(e => e[0] === '[Maintenance] The maintenance poll failed:')).toEqual(['[Maintenance] The maintenance poll failed:', boom]);
  });
});

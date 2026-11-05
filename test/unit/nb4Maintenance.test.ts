import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB4 decisions 15, 16 and 22: a Postgres maintenance boot connects the shards of its record; a 28000 closes an open
// gate whatever leaving and discordStarted are; a process with no web UI stops through its stop handler; the leave
// lines say so; a restart for shards is asked only while fit.

const stops = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  stopProcess: () => { stops.calls += 1; },
}));

import { setBackendKind } from '../helpers/backendKind';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  _setMaintenanceTiming,
  canRestart,
  closeMaintenanceGate,
  installMaintenanceGate,
  maintenanceMode,
  maintenanceUnfit,
  markDiscordStarted,
  noteClaimsLapsed,
  restartForShards,
  startLeave,
  watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { isMaintenanceGateClosed, maintenanceCause, maintenanceText, setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { EventEmitter } from 'events';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { rawCommand, rig, storeGuild, textOf, tick } from '../helpers/gateRig';
import { setManifestReader } from '../../src/bot/internalSetup/utils/dataBackends/dataContract';
import { withModule } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';

const sent: any[] = [];
let logs: string[] = [];
const realSend = process.send;
beforeEach(() => {
  // vitest's fork has an IPC channel; a bot run with no web UI has none.
  (process as { send?: unknown }).send = undefined;
  sent.length = 0;
  stops.calls = 0;
  logs = [];
  const capture = (...args: unknown[]) => { logs.push(String(args[0])); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  (process as { send?: unknown }).send = realSend;
  _resetMaintenance();
  _setMaintenanceSender(null);
  setManifestReader(null);
  vi.restoreAllMocks();
});

const withIpc = () => _setMaintenanceSender(message => { sent.push(message); });

describe('a refused login (28000)', () => {
  const backend = () => {
    let fire: () => void = () => undefined;
    return { onLoginRefused: (cb: () => void) => { fire = cb; }, askDatabase: async () => 'refused' as const, fire: () => fire() };
  };

  it('before the login: the gate closes with login-refused and the leave starts', () => {
    withIpc();
    const b = backend();
    watchDataBackend(b, { retryMs: 600_000 });
    b.fire();
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(maintenanceCause()).toBe('login-refused');
    expect(logs.some(l => l.startsWith('[Maintenance] The database refused the login (SQLSTATE 28000) while the bot process booted'))).toBe(true);
  });

  it('a first 28000 after leaving was set still closes the open gate', () => {
    withIpc();
    _setMaintenanceTiming({ leaveRetryMs: 600_000 });
    const b = backend();
    watchDataBackend(b, { retryMs: 600_000 });
    markDiscordStarted();
    startLeave('The shard claims lapsed (no renewal for 20 s) and the database answers');
    expect(isMaintenanceGateClosed()).toBe(false);
    b.fire();
    expect(isMaintenanceGateClosed()).toBe(true);
  });
});

describe('a process with no web UI', () => {
  it('canRestart reads the IPC channel', () => {
    expect(canRestart()).toBe(false);
    withIpc();
    expect(canRestart()).toBe(true);
  });

  it('the leave says it stops, and its end runs the stop handler instead of asking for a restart', async () => {
    startLeave('The hook says running');
    expect(logs).toContain('[Maintenance] The hook says running; saving what this process holds before it stops (no web UI process runs to restart it)');
    await vi.waitFor(() => expect(stops.calls).toBe(1));
    expect(logs).toContain('[Maintenance] The hook says running, but no web UI process runs to restart this bot process, so it stops; start it again by hand');
    expect(logs.some(l => /restart it by hand/.test(l))).toBe(false);
  });

  it('with a web UI the leave keeps its restart line and asks for the restart', async () => {
    withIpc();
    startLeave('The hook says running');
    expect(logs).toContain('[Maintenance] The hook says running; saving what this process holds before it restarts');
    await vi.waitFor(() => expect(sent.some(m => m.type === 'control:restart-bot')).toBe(true));
    expect(stops.calls).toBe(0);
  });
});

describe('restartForShards', () => {
  it('asks only while fit and with a web UI, and logs the restart line only when it sends', () => {
    expect(restartForShards('take shard 3', () => null)).toBe(false);
    withIpc();
    expect(restartForShards('take shard 3', () => 'a save is failing')).toBe(false);
    expect(logs.some(l => l.startsWith('[Shards] Restarting'))).toBe(false);
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    expect(logs).toContain('[Shards] Restarting this bot process to take shard 3');
    expect(sent).toContainEqual({ type: 'control:restart-bot', data: { reason: 'take shard 3' } });
  });
});

describe('28000 renewals and watcher probes during module loading with a held write (T13 (b), unit 2)', () => {
  const T = claimTimings(30);

  it.each([false, true])('the leave already started: %s; the gate closes before the login, serves nothing after it, D does not lapse, and the return saves G and asks the restart once', async leaveFirst => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    try {
      withIpc();
      _setMaintenanceTiming({ leaveRetryMs: 1000, filePollMs: 600_000, leaveSaveBoundMs: 2000 });
      const { guildId, store: data, options } = await storeGuild();
      data.mode = 'unavailable';
      saveData('g.json', options, { v: 1 });
      await getWorkingSet()!.flushAllDirty();
      expect(data.doc(guildId, 'g.json')).toBeUndefined();

      let answer: 'refused' | 'answers' = 'refused';
      let fire: () => void = () => undefined;
      const watcher = watchDataBackend({ onLoginRefused: cb => { fire = cb; }, askDatabase: async () => answer }, { retryMs: 600_000 })!;
      const store = new MemClaimStore(() => Date.now());
      const renew = store.renew.bind(store);
      store.renew = async request => {
        try { return await renew(request); } catch (error) {
          if ((error as { code?: string }).code === '28000') fire();
          throw error;
        }
      };
      let stopStep = 0;
      const claims = new ShardClaims({
        store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
        returns: true, restartable: true, startedAt: 0, fitness: maintenanceUnfit, gateClosed: isMaintenanceGateClosed,
        isStopping: () => false, stopServingStep: () => { stopStep += 1; }, noteLapsed: () => undefined,
        noteLost: () => undefined, restartForShards: () => false,
        log: { log: () => undefined, warn: () => undefined, error: () => undefined },
      });
      claims.start();
      await claims.firstRenewal();
      await claims.bootTake(async () => 2);
      claims.noteGranted();

      if (leaveFirst) startLeave('The hook says running');
      store.renewMode = Object.assign(new Error('role "bot" is not permitted to log in'), { code: '28000' });
      await vi.advanceTimersByTimeAsync(T.renewMs);
      expect(isMaintenanceGateClosed()).toBe(true);
      expect(maintenanceCause()).toBe('login-refused');
      if (!leaveFirst) expect(logs).toContain('[Maintenance] The database refused the login (SQLSTATE 28000) while the bot process booted; saving what this process holds before it restarts');
      await watcher.probeNow();
      expect(isMaintenanceGateClosed()).toBe(true);

      markDiscordStarted();
      const client = Object.assign(new EventEmitter(), { options: { ws: {} } }) as any;
      installMaintenanceGate(client);
      const handler = vi.fn();
      client.on('interactionCreate', handler);
      const reply = vi.fn(async () => undefined);
      client.emit('interactionCreate', { guildId, isRepliable: () => true, replied: false, deferred: false, reply });
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(1);
      expect((reply.mock.calls[0] as any[])[0].content).toBe(maintenanceText());
      let refusal: any = null;
      try { saveData('h.json', options, { v: 2 }); } catch (error) { refusal = error; }
      expect(refusal?.causeKey).toBe('maintenance');

      await vi.advanceTimersByTimeAsync(T.deadlineMs + T.renewMs);
      expect(stopStep).toBe(0);
      expect(claims.snapshot().stopped).toBeNull();
      expect(data.doc(guildId, 'g.json')).toBeUndefined();
      expect(sent.filter(m => m.type === 'control:restart-bot')).toEqual([]);

      store.renewMode = 'ok';
      answer = 'answers';
      data.mode = 'commit';
      await watcher.probeNow();
      await vi.advanceTimersByTimeAsync(3000);
      expect(JSON.parse(data.doc(guildId, 'g.json')!)).toEqual({ v: 1 });
      expect(data.doc(guildId, 'h.json')).toBeUndefined();
      expect(sent.filter(m => m.type === 'control:restart-bot')).toHaveLength(1);
      claims.beginStop();
      await claims.finishStop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a dataContract 2 module and a 28000 (T13 (b), unit 2)', () => {
  const refusedLogin = () => {
    let fire: () => void = () => undefined;
    watchDataBackend({ onLoginRefused: cb => { fire = cb; }, askDatabase: async () => 'refused' as const }, { retryMs: 600_000 });
    return () => fire();
  };

  it('the gate closed by a 28000 before the login: after the login its interaction gets only the maintenance text, and its handler, save and payload never run', async () => {
    withIpc();
    setManifestReader(name => (name === 'flagmod' ? { dataContract: 2 } : undefined));
    const fire = refusedLogin();
    fire();
    expect(maintenanceCause()).toBe('login-refused');
    markDiscordStarted();
    const { client, wire, emit } = rig();
    installMaintenanceGate(client);
    const { store, options } = await storeGuild();
    const ran = vi.fn();
    void emit(rawCommand('nb4dc-before-login'), i => withModule('flagmod', async () => {
      ran();
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    }));
    await tick(50);
    expect(ran).not.toHaveBeenCalled();
    expect(wire.map(textOf)).toEqual([maintenanceText()]);
    expect(store.doc(options.guildId, 'x.json')).toBeUndefined();
  });

  it('a 28000 while its handler runs: the save is refused, and the reply carries the maintenance truth, never its own payload', async () => {
    withIpc();
    setManifestReader(name => (name === 'flagmod' ? { dataContract: 2 } : undefined));
    const fire = refusedLogin();
    markDiscordStarted();
    const { client, wire, emit } = rig();
    installMaintenanceGate(client);
    const { store, options } = await storeGuild();
    let refusal: any = null;
    const { error } = await emit(rawCommand('nb4dc-in-handler'), i => withModule('flagmod', async () => {
      fire();
      expect(isMaintenanceGateClosed()).toBe(true);
      try { saveData('x.json', options, { v: 1 }); } catch (e) { refusal = e; }
      await i.reply({ content: 'Saved!' });
    }));
    expect(error).toBeUndefined();
    await tick(50);
    expect(refusal?.causeKey).toBe('maintenance');
    expect(wire.map(textOf)).toEqual([truthText('maintenance', false)]);
    expect(wire.map(textOf)).not.toContain('Saved!');
    expect(store.doc(options.guildId, 'x.json')).toBeUndefined();
  });
});

describe('maintenanceUnfit, each key alone (T1, unit 2)', () => {
  it('a serving process is fit', () => {
    expect(maintenanceUnfit()).toBeNull();
  });

  it('a leave with the gate open and no restart asked: leaving', async () => {
    withIpc();
    _setMaintenanceTiming({ leaveRetryMs: 600_000, leaveSaveBoundMs: 500 });
    const { store, options } = await storeGuild();
    store.mode = 'unavailable';
    saveData('g.json', options, { v: 1 });
    startLeave('The hook says running');
    expect(maintenanceUnfit()).toBe('leaving');
    await vi.waitFor(() => expect(logs.some(l => l.includes('hold changes that could not be saved'))).toBe(true));
    expect(isMaintenanceGateClosed()).toBe(false);
    expect(maintenanceMode()).toBe('running');
    expect(sent.filter(m => m.type === 'control:restart-bot')).toEqual([]);
    expect(maintenanceUnfit()).toBe('leaving');
  });

  it('the claims lapsed with the gate open: maintenance mode outage', () => {
    noteClaimsLapsed(20);
    expect(isMaintenanceGateClosed()).toBe(false);
    expect(maintenanceUnfit()).toBe('maintenance mode outage');
  });

  it('the hook closed the gate: maintenance mode maintenance', () => {
    closeMaintenanceGate('hook', 'down for maintenance');
    expect(maintenanceUnfit()).toBe('maintenance mode maintenance');
  });

  it('the gate closed while the mode still reads running: the maintenance gate is closed', () => {
    setMaintenanceGate({ cause: 'hook', message: 'down for maintenance' });
    expect(maintenanceMode()).toBe('running');
    expect(maintenanceUnfit()).toBe('the maintenance gate is closed');
  });

  it('a restart for shards was asked: restarting', () => {
    withIpc();
    expect(restartForShards('take shard 3', maintenanceUnfit)).toBe(true);
    expect(maintenanceUnfit()).toBe('restarting');
  });

  const T = claimTimings(30);

  it.each([false, true])('a ShardClaims run on the real fitness, leave started: %s; a freed shard is reserved and the restart asked only without the leave', async leave => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    try {
      withIpc();
      _setMaintenanceTiming({ leaveRetryMs: 600_000, filePollMs: 600_000, leaveSaveBoundMs: 500 });
      const store = new MemClaimStore(() => Date.now());
      const claims = new ShardClaims({
        store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
        returns: true, restartable: true, startedAt: 0, fitness: maintenanceUnfit, gateClosed: isMaintenanceGateClosed,
        isStopping: () => false, stopServingStep: () => undefined, noteLapsed: () => undefined,
        noteLost: () => undefined, restartForShards: reason => restartForShards(reason, maintenanceUnfit),
        log: { log: () => undefined, warn: () => undefined, error: () => undefined },
      });
      claims.start();
      await claims.firstRenewal();
      await claims.bootTake(async () => 4);
      claims.noteGranted();
      Object.assign(store.rows.get('4:3')!, { holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
      (claims as any)['held'] = (claims as any)['held'].filter((p: { shardId: number }) => p.shardId !== 3);
      if (leave) {
        const { store: data, options } = await storeGuild();
        data.mode = 'unavailable';
        saveData('g.json', options, { v: 1 });
        startLeave('The hook says running');
      }
      const before = store.takes.length;
      await vi.advanceTimersByTimeAsync(T.renewMs * 3);
      expect(isMaintenanceGateClosed()).toBe(false);
      if (leave) {
        expect(maintenanceUnfit()).toBe('leaving');
        expect(store.takes.length).toBe(before);
        expect(claims.snapshot().reserved).toEqual([]);
        expect(store.rows.get('4:3')!.holderProcess).toBe('p-dead');
        expect(sent.filter(m => m.type === 'control:restart-bot')).toEqual([]);
      } else {
        expect(store.takes.length).toBe(before + 1);
        expect(claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
        expect(store.rows.get('4:3')!.holderProcess).toBe('p-a');
        expect(sent).toContainEqual({ type: 'control:restart-bot', data: { reason: 'take shard 3' } });
      }
      claims.beginStop();
      await claims.finishStop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the 300 s outage rule is gone (T4, unit 11, decision 22)', () => {
  const T = claimTimings(30);

  it('a watcher that cannot reach the database for 301 s while the claims renew: nothing leaves Discord and the mode stays running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    try {
      withIpc();
      let probes = 0;
      watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => { probes += 1; return 'unreachable'; } }, { retryMs: 5_000 });
      markDiscordStarted();
      const store = new MemClaimStore(() => Date.now());
      let stopStep = 0;
      const lapsed: number[] = [];
      const claims = new ShardClaims({
        store, me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 4, takeoverSeconds: 30,
        returns: true, restartable: true, startedAt: 0, fitness: maintenanceUnfit, gateClosed: isMaintenanceGateClosed,
        isStopping: () => false, stopServingStep: () => { stopStep += 1; },
        noteLapsed: seconds => { lapsed.push(seconds); noteClaimsLapsed(seconds); },
        noteLost: () => undefined, restartForShards: reason => restartForShards(reason, maintenanceUnfit),
        log: { log: () => undefined, warn: () => undefined, error: () => undefined },
      });
      claims.start();
      await claims.firstRenewal();
      await claims.bootTake(async () => 2);
      claims.noteGranted();
      const renewalsBefore = store.renewals.length;
      await vi.advanceTimersByTimeAsync(301_000);
      expect(probes).toBeGreaterThanOrEqual(60);
      expect(store.renewals.length - renewalsBefore).toBeGreaterThanOrEqual(Math.floor(301_000 / T.renewMs) - 1);
      expect(stopStep).toBe(0);
      expect(lapsed).toEqual([]);
      expect(claims.stoppedServing()).toBe(false);
      expect(maintenanceMode()).toBe('running');
      expect(isMaintenanceGateClosed()).toBe(false);
      expect(maintenanceUnfit()).toBeNull();
      expect(logs.some(l => l.startsWith('[Maintenance] The database has not answered'))).toBe(false);
      expect(sent.filter(m => m.type === 'control:restart-bot')).toEqual([]);
      expect(stops.calls).toBe(0);
      claims.beginStop();
      await claims.finishStop();
    } finally {
      vi.useRealTimers();
    }
  });
});

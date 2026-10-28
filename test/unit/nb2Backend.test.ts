import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB2 rulings 6 and 7 (the boot decision, a refused login at boot and at run time, 28P01 kept apart) and K (the
// watcher that asks the database every 5 seconds and takes the bot off Discord after 300 seconds without an answer).

const pg = vi.hoisted(() => ({ connect: null as null | (() => Promise<void>), connects: 0 }));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<typeof import('../../src/bot/internalSetup/utils/pgClient')>()),
  shortLivedClient: () => ({
    connect: () => { pg.connects += 1; return pg.connect ? pg.connect() : Promise.resolve(); },
    end: async () => undefined,
  }),
}));

import { isLoginRefused, PostgresBackend, PostgresUnreachableError } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { saveData, flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import {
  _resetMaintenance,
  _setMaintenanceSender,
  closeMaintenanceGate,
  decideBoot,
  markDiscordStarted,
  maintenanceMode,
  probeLoginAtBoot,
  watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { DEFAULT_MAINTENANCE_MESSAGE, isMaintenanceGateClosed, maintenanceCause, maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { setBackendKind } from '../helpers/backendKind';
import { storeGuild } from '../helpers/gateRig';

const sent: any[] = [];
const restarts = () => sent.filter(m => m.type === 'control:restart-bot');
const sqlError = (code: string) => Object.assign(new Error(`sqlstate ${code}`), { code });
// The watcher's own timer never fires in these tests: each probe is driven by probeNow.
const NEVER = 3_600_000;
const SECOND = 1000;

beforeEach(() => {
  _resetMaintenance();
  sent.length = 0;
  _setMaintenanceSender(message => { sent.push(message); });
  fs.rmSync(maintenanceFilePath(), { force: true });
  pg.connect = null;
  pg.connects = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.restoreAllMocks();
});

type Answer = 'answers' | 'refused' | 'unreachable';

/** A backend whose answers to SELECT 1 are set by the test; fire() is the backend seeing a refused login. */
function fakeBackend(first: Answer | 'silent' = 'answers') {
  let refused: (() => void) | null = null;
  const state = { answer: first as Answer | 'silent', probes: 0 };
  return {
    state,
    onLoginRefused: (cb: () => void) => { refused = cb; },
    askDatabase: () => {
      state.probes += 1;
      return state.answer === 'silent' ? new Promise<Answer>(() => undefined) : Promise.resolve(state.answer);
    },
    fire: () => refused?.(),
  };
}

/** The watcher on a clock the test moves. */
function watched(backend: ReturnType<typeof fakeBackend>, extra: { probeTimeoutMs?: number } = {}) {
  const clock = { now: 0 };
  const disconnect = vi.fn(async () => undefined);
  const watcher = watchDataBackend(backend, { retryMs: NEVER, now: () => clock.now, disconnect, ...extra })!;
  markDiscordStarted();
  const at = async (ms: number, answer?: Answer | 'silent') => {
    clock.now = ms;
    if (answer) backend.state.answer = answer;
    await watcher.probeNow();
  };
  return { clock, disconnect, at, watcher };
}

describe('ruling 7: SQLSTATE 28000 only', () => {
  it('28000 is a refused login; 28P01 (a wrong password) and other errors are not', () => {
    expect(isLoginRefused(sqlError('28000'))).toBe(true);
    expect(isLoginRefused(new PostgresUnreachableError('cannot reach the data backend', sqlError('28000')))).toBe(true);
    expect(isLoginRefused(sqlError('28P01'))).toBe(false);
    expect(isLoginRefused(sqlError('57P01'))).toBe(false);
    expect(isLoginRefused(new Error('connect ECONNREFUSED'))).toBe(false);
    expect(isLoginRefused(null)).toBe(false);
  });

  it('the backend tells its listeners of a 28000 failure and never of a 28P01 one', async () => {
    const backend = new PostgresBackend({ url: 'postgresql://u:p@127.0.0.1:1/none' });
    const listener = vi.fn();
    backend.onLoginRefused(listener);
    (backend as any).noteFailure(sqlError('28P01'));
    expect(listener).not.toHaveBeenCalled();
    (backend as any).noteFailure(sqlError('28000'));
    expect(listener).toHaveBeenCalledTimes(1);
    await backend.stop();
  });

  it('F4c: the outage probe loop moving from 57P01 (sessions ended) to 28000 tells the listeners once', async () => {
    const backend = new PostgresBackend({ url: 'postgresql://u:p@127.0.0.1:1/none' });
    const listener = vi.fn();
    backend.onLoginRefused(listener);
    const answers = [sqlError('57P01'), sqlError('57P01'), sqlError('28000')];
    (backend as any).pool = {
      query: vi.fn(async () => { const next = answers.shift(); if (next) throw next; return { rows: [] }; }),
      end: async () => undefined,
    };
    (backend as any).sleep = async () => undefined;
    (backend as any).state = 'outage';
    await (backend as any).outageProbeLoop();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(backend.connectionState().state).toBe('ready');
    await backend.stop();
  });

  it('F4b: updateData, appendData and deleteData are refused as maintenance', async () => {
    const { updateData, appendData, deleteData } = await import('../../src/bot/internalSetup/utils/dataManager');
    const { options } = await storeGuild();
    closeMaintenanceGate('hook', 'm');
    const causeOf = (fn: () => unknown) => {
      try { fn(); } catch (error) { return (error as { causeKey?: string }).causeKey; }
      return 'accepted';
    };
    expect(causeOf(() => updateData('u.json', options, {}, current => current))).toBe('maintenance');
    expect(causeOf(() => appendData('a.jsonl', options, 'line'))).toBe('maintenance');
    expect(causeOf(() => deleteData('d.json', options))).toBe('maintenance');
  });
});

describe('rulings 6 and 7: the boot decision, read before the data backend opens', () => {
  it('the file says maintenance: maintenance mode with its message, and the database is not asked', async () => {
    writeMaintenanceFile('maintenance', 'Moving to the new server.');
    const probe = vi.fn(async () => 'accepted' as const);
    expect(await decideBoot(probe)).toEqual({ mode: 'maintenance', cause: 'hook', message: 'Moving to the new server.' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('no file and a refused login: maintenance mode with the default text', async () => {
    expect(await decideBoot(async () => 'refused')).toEqual({ mode: 'maintenance', cause: 'login-refused', message: DEFAULT_MAINTENANCE_MESSAGE });
  });

  it("the file says running and the login is refused: the file's last message", async () => {
    writeMaintenanceFile('running', 'Back soon.');
    expect(await decideBoot(async () => 'refused')).toEqual({ mode: 'maintenance', cause: 'login-refused', message: 'Back soon.' });
  });

  it('an unreachable database, an accepted login or a JSON bot boots normally (nothing changes at boot)', async () => {
    for (const answer of ['unreachable', 'accepted', 'none'] as const) {
      expect(await decideBoot(async () => answer)).toEqual({ mode: 'normal' });
    }
  });

  it('the boot probe: 28000 is refused, 28P01 is not, a JSON bot is not asked', async () => {
    setBackendKind('file');
    expect(await probeLoginAtBoot()).toBe('none');
    expect(pg.connects).toBe(0);
    setBackendKind('postgres');
    process.env.DATA_BACKEND_URL = 'postgresql://u:p@127.0.0.1:1/none';
    try {
      pg.connect = () => Promise.reject(sqlError('28000'));
      expect(await probeLoginAtBoot()).toBe('refused');
      pg.connect = () => Promise.reject(sqlError('28P01'));
      expect(await probeLoginAtBoot()).toBe('unreachable');
      pg.connect = null;
      expect(await probeLoginAtBoot()).toBe('accepted');
    } finally {
      delete process.env.DATA_BACKEND_URL;
    }
  });
});

describe('ruling 7 at run time', () => {
  it('closes the gate with the saved message, keeps what the process holds, and asks for the restart once the database answers while the file says running', async () => {
    const { store, options, guildId } = await storeGuild();
    store.mode = 'unavailable';
    saveData('held.json', options, { v: 1 });
    writeMaintenanceFile('running', 'Owner message.');
    const backend = fakeBackend('refused');
    const { at, disconnect } = watched(backend);
    backend.fire();
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(maintenanceCause()).toBe('login-refused');
    expect(maintenanceText()).toBe('Owner message.');
    expect(maintenanceMode()).toBe('login-refused');
    await at(5 * SECOND);
    await at(400 * SECOND);
    expect(restarts()).toHaveLength(0);
    expect(disconnect).not.toHaveBeenCalled();
    expect(getWorkingSet()!.dirtyGuildIds()).toContain(guildId);
    store.mode = 'commit';
    await at(405 * SECOND, 'answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1), { timeout: 10_000 });
    expect(getWorkingSet()!.dirtyGuildIds()).not.toContain(guildId);
    _resetMaintenance();
    await flushAll();
  }, 20_000);

  it('the database answering again while the file says maintenance changes nothing', async () => {
    const backend = fakeBackend('refused');
    const { at } = watched(backend);
    backend.fire();
    writeMaintenanceFile('maintenance', 'm');
    await at(5 * SECOND, 'answers');
    await at(10 * SECOND);
    expect(restarts()).toHaveLength(0);
    expect(isMaintenanceGateClosed()).toBe(true);
  });

  it('a refused login while the hook already holds maintenance changes nothing', async () => {
    const backend = fakeBackend('refused');
    const { at } = watched(backend);
    closeMaintenanceGate('hook', 'hook message');
    backend.fire();
    await at(5 * SECOND);
    expect(maintenanceCause()).toBe('hook');
    expect(maintenanceText()).toBe('hook message');
  });

  it('a refused login before the boot reached Discord asks for the restart (it holds nothing), which boots in maintenance mode', async () => {
    const backend = fakeBackend('refused');
    watchDataBackend(backend, { retryMs: NEVER });
    backend.fire();
    expect(isMaintenanceGateClosed()).toBe(false);
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
  });
});

describe('ruling K: the watcher decides when the bot leaves Discord', () => {
  it('R5-4: with its defaults the watcher probes every 5 seconds, gives a silent probe up after 5 seconds and disconnects after 300 seconds', async () => {
    vi.useFakeTimers();
    try {
      const backend = fakeBackend('silent');
      const disconnect = vi.fn(async () => undefined);
      watchDataBackend(backend, { disconnect });
      markDiscordStarted();
      await vi.advanceTimersByTimeAsync(5 * SECOND - 1);
      expect(backend.state.probes).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(backend.state.probes).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(backend.state.probes).toBeGreaterThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(290 * SECOND);
      expect(disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20 * SECOND);
      expect(disconnect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60 * SECOND);
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a JSON bot has no watcher', () => {
    expect(watchDataBackend(null)).toBeNull();
  });

  it('the Postgres backend asks SELECT 1 through its pool: an answer, 28000 as refused, anything else unreachable', async () => {
    const backend = new PostgresBackend({ url: 'postgresql://u:p@127.0.0.1:1/none' });
    const replies: Array<Error | null> = [null, sqlError('28000'), sqlError('28P01'), new Error('connect ECONNREFUSED')];
    const query = vi.fn(async (_config: { text: string; query_timeout?: number }) => { const next = replies.shift(); if (next) throw next; return { rows: [] }; });
    (backend as any).pool = { query, end: async () => undefined };
    expect(await backend.askDatabase()).toBe('answers');
    expect(await backend.askDatabase()).toBe('refused');
    expect(await backend.askDatabase()).toBe('unreachable');
    expect(await backend.askDatabase()).toBe('unreachable');
    expect(query.mock.calls.every(call => call[0].text === 'SELECT 1' && call[0].query_timeout === 5 * SECOND)).toBe(true);
    await backend.stop();
  });

  it('every probe unreachable for 300 seconds in a row disconnects every shard once, keeps the gate open and reports the outage', async () => {
    const backend = fakeBackend('unreachable');
    const { at, disconnect } = watched(backend);
    await at(0);
    await at(100 * SECOND);
    await at(299 * SECOND);
    expect(disconnect).not.toHaveBeenCalled();
    expect(maintenanceMode()).toBe('running');
    await at(300 * SECOND);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(maintenanceMode()).toBe('outage');
    expect(isMaintenanceGateClosed()).toBe(false);
    expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'outage' } });
    await at(400 * SECOND);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(restarts()).toHaveLength(0);
  });

  it('any answer starts the count again', async () => {
    const backend = fakeBackend('unreachable');
    const { at, disconnect } = watched(backend);
    await at(0);
    await at(250 * SECOND);
    await at(255 * SECOND, 'answers');
    await at(260 * SECOND, 'unreachable');
    await at(555 * SECOND);
    expect(disconnect).not.toHaveBeenCalled();
    await at(560 * SECOND);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('a probe with no answer within its bound counts as unreachable', async () => {
    const backend = fakeBackend('silent');
    const { at, disconnect } = watched(backend, { probeTimeoutMs: 10 });
    await at(0);
    await at(300 * SECOND);
    expect(backend.state.probes).toBe(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('after the disconnect the first answer starts the leave step, which asks for the restart', async () => {
    const backend = fakeBackend('unreachable');
    const { at } = watched(backend);
    await at(0);
    await at(300 * SECOND);
    await at(305 * SECOND, 'refused');
    expect(restarts()).toHaveLength(0);
    expect(isMaintenanceGateClosed()).toBe(false);
    await at(310 * SECOND, 'answers');
    await vi.waitFor(() => expect(restarts()).toHaveLength(1));
    expect(restarts()[0]).toEqual({ type: 'control:restart-bot', data: { reason: 'The database answers again' } });
  });

  it('R4-1: write acceptance closed by a guild the database refuses, then one failed probe days later, keeps the bot on Discord', async () => {
    const { store, options } = await storeGuild();
    store.mode = 'unavailable';
    saveData('stuck.json', options, { v: 1 });
    const ws = getWorkingSet()!;
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 301 * SECOND);
    (ws as any).checkBounds(Date.now());
    expect(ws.getBackendHealth().state).toBe('refusing');
    const backend = fakeBackend('answers');
    const { at, disconnect } = watched(backend);
    for (let s = 0; s <= 60; s += 5) await at(s * SECOND);
    await at(2 * 86_400 * SECOND, 'unreachable');
    await at(2 * 86_400 * SECOND + 10 * SECOND, 'answers');
    expect(disconnect).not.toHaveBeenCalled();
    expect(maintenanceMode()).toBe('running');
    expect(restarts()).toHaveLength(0);
    expect(ws.getBackendHealth().state).toBe('refusing');
    clock.mockRestore();
    store.mode = 'commit';
    await flushAll();
  });

  it('R4-3: acceptance closing and reopening around the probes decides nothing; a single failed probe later disconnects nothing', async () => {
    const { store, options } = await storeGuild();
    store.mode = 'unavailable';
    saveData('blip.json', options, { v: 1 });
    const ws = getWorkingSet()!;
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 301 * SECOND);
    (ws as any).checkBounds(Date.now());
    expect(ws.getBackendHealth().state).toBe('refusing');
    const backend = fakeBackend('answers');
    const { at, disconnect } = watched(backend);
    await at(0);
    store.mode = 'commit';
    await flushAll();
    expect(ws.getBackendHealth().state).not.toBe('refusing');
    clock.mockRestore();
    await at(5 * SECOND, 'unreachable');
    await at(10 * SECOND, 'answers');
    expect(disconnect).not.toHaveBeenCalled();
    expect(restarts()).toHaveLength(0);
    expect(maintenanceMode()).toBe('running');
  });

  it('R4-5: a probe answered with 28000 is ruling 7, never a disconnect, however long it lasts', async () => {
    writeMaintenanceFile('running', 'Saved message.');
    const backend = fakeBackend('refused');
    const { at, disconnect } = watched(backend);
    await at(0);
    expect(isMaintenanceGateClosed()).toBe(true);
    expect(maintenanceCause()).toBe('login-refused');
    expect(maintenanceText()).toBe('Saved message.');
    await at(301 * SECOND);
    await at(900 * SECOND);
    expect(disconnect).not.toHaveBeenCalled();
    expect(maintenanceMode()).toBe('login-refused');
  });

  it('in maintenance through the hook an unreachable database does not take the bot off Discord', async () => {
    const backend = fakeBackend('unreachable');
    const { at, disconnect } = watched(backend);
    closeMaintenanceGate('hook', 'm');
    await at(0);
    await at(600 * SECOND);
    expect(disconnect).not.toHaveBeenCalled();
    expect(maintenanceMode()).toBe('maintenance');
  });

  it('the watcher runs on its own timer every retryMs', async () => {
    const backend = fakeBackend('answers');
    watchDataBackend(backend, { retryMs: 5 });
    await vi.waitFor(() => expect(backend.state.probes).toBeGreaterThanOrEqual(3));
  });
});

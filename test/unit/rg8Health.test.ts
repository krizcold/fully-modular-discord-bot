import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const A = 'postgres://bot@db1:5432/bot';
const SILENT_A = 'the database did not answer; this process checks that db1:5432/bot is still the main before writing to it';
const CAUSE = { kind: 'replaced', machine: 'node-b', generation: 4 } as const;

const sqlState = (code: string, severity = 'ERROR') => Object.assign(new Error(`scripted ${code}`), { code, severity });
const sysError = (code: string) => Object.assign(new Error(`connect ${code} 10.0.0.1:5432`), { code, errno: -1, syscall: 'connect' });

const backends: PostgresBackend[] = [];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  for (const b of backends.splice(0)) await b.stop().catch(() => undefined);
  vi.restoreAllMocks();
});

function fakePool(query: () => Promise<unknown>) {
  const emitter = new EventEmitter();
  const pool = {
    connect: vi.fn(async () => { throw new Error('connect is not part of this fake'); }),
    query: vi.fn(query),
    end: vi.fn(async () => undefined),
    on: (event: string, fn: (...args: unknown[]) => void) => { emitter.on(event, fn); return pool; },
  };
  return pool;
}

function rig(opts: { entry?: string | null; ready?: boolean; query?: () => Promise<unknown> } = {}) {
  const entry = opts.entry === undefined ? A : opts.entry;
  const chooser = {
    chosen: () => entry,
    awaitChoice: async () => entry,
    lastPassLogin: () => 'unreachable' as const,
    holdStarted: vi.fn(),
    confirmNow: vi.fn(),
    stop: () => undefined,
  };
  const backend = new PostgresBackend({ chooser } as never);
  backends.push(backend);
  const internals = backend as unknown as { pool: unknown; state: string; provisioned: boolean; latchSchemaMismatch(found: string): void };
  if (entry !== null) internals.pool = fakePool(opts.query ?? (async () => { throw new Error('unused'); }));
  if (opts.ready !== false) {
    internals.state = 'ready';
    internals.provisioned = true;
  }
  const loginRefused = vi.fn();
  backend.onLoginRefused(loginRefused);
  const holds: Array<string | null> = [];
  backend.onHoldChanged(words => holds.push(words));
  const alerts: Array<[string, string]> = [];
  backend.onAlert((event, detail) => alerts.push([event, detail]));
  return { backend, chooser, internals, loginRefused, holds, alerts };
}

const errorLines = () => vi.mocked(console.error).mock.calls.map(c => c.map(String).join(' '));
const warnLines = () => vi.mocked(console.warn).mock.calls.map(c => c.map(String).join(' '));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
  expect(check()).toBe(true);
}

function hold(r: ReturnType<typeof rig>) {
  r.backend.noteObservation(sysError('ECONNREFUSED'), r.backend.databaseEpoch());
  expect(r.backend.connectionState().state).toBe('outage');
}

function confirming(r: ReturnType<typeof rig>) {
  hold(r);
  r.backend.noteEntryAnswered(r.backend.databaseEpoch());
  expect(r.backend.connectionState().state).toBe('confirming');
}

describe('a bootstrap attempt the database refused at the login', () => {
  it('tells the login-refused listeners once for a refusal observed now', async () => {
    const refused = sqlState('28000', 'FATAL');
    const r = rig({ ready: false, query: async () => { throw refused; } });
    r.backend.start();
    await until(() => warnLines().some(l => l.includes('Bootstrap attempt 1 failed')));
    expect(r.loginRefused).toHaveBeenCalledTimes(1);
  });

  it('tells no one when that refusal was observed under an earlier epoch', async () => {
    const refused = sqlState('28000', 'FATAL');
    const r = rig({ ready: false, query: async () => { throw refused; } });
    r.backend.noteObservation(refused, r.backend.databaseEpoch() - 1);
    expect(r.loginRefused).not.toHaveBeenCalled();
    r.backend.start();
    await until(() => warnLines().some(l => l.includes('Bootstrap attempt 1 failed')));
    expect(r.loginRefused).not.toHaveBeenCalled();
  });
});

describe('an observation changes nothing while the backend may not act on it', () => {
  it('a refusal of the backend itself is no observation: a confirming hold stays confirming', async () => {
    const r = rig();
    confirming(r);
    const refusal = await r.backend.sweepGraveyard(1000).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(r.backend.connectionState().state).toBe('confirming');
    r.backend.noteObservation(refusal, r.backend.databaseEpoch());
    expect(r.backend.connectionState().state).toBe('confirming');
    expect(r.backend.confirmingWords()).toBe('checking');
    expect(r.chooser.holdStarted).toHaveBeenCalledTimes(1);
  });

  it('latched: a refused login neither reaches the listeners nor starts a hold', () => {
    const r = rig();
    r.backend.latch(CAUSE);
    r.backend.noteObservation(sqlState('28000', 'FATAL'), r.backend.databaseEpoch());
    expect(r.loginRefused).not.toHaveBeenCalled();
    expect(r.chooser.holdStarted).not.toHaveBeenCalled();
    expect(r.backend.connectionState().state).toBe('latched');
  });

  it('stopped: a refused login neither reaches the listeners nor starts a hold', async () => {
    const r = rig();
    await r.backend.stop();
    r.backend.noteObservation(sqlState('28000', 'FATAL'), r.backend.databaseEpoch());
    expect(r.loginRefused).not.toHaveBeenCalled();
    expect(r.chooser.holdStarted).not.toHaveBeenCalled();
    expect(r.backend.connectionState().state).toBe('ready');
  });

  it('before any database is chosen: a refused login neither reaches the listeners nor starts a hold', () => {
    const r = rig({ entry: null, ready: false });
    r.backend.noteObservation(sqlState('28000', 'FATAL'), r.backend.databaseEpoch());
    expect(r.loginRefused).not.toHaveBeenCalled();
    expect(r.chooser.holdStarted).not.toHaveBeenCalled();
    expect(r.backend.connectionState().state).toBe('connecting');
  });

  it('a refused login observed now does reach the listeners and starts the hold', () => {
    const r = rig();
    r.backend.noteObservation(sqlState('28000', 'FATAL'), r.backend.databaseEpoch());
    expect(r.loginRefused).toHaveBeenCalledTimes(1);
    expect(r.chooser.holdStarted).toHaveBeenCalledTimes(1);
  });
});

describe('a watch observation that is not at a login', () => {
  it('a FATAL that ended the session starts the hold', () => {
    const r = rig();
    r.backend.noteObservation(sqlState('53300', 'FATAL'), r.backend.databaseEpoch());
    expect(r.backend.connectionState().state).toBe('outage');
    expect(r.backend.holdWords()).toBe(SILENT_A);
  });

  it('the same FATAL at a login starts nothing', () => {
    const r = rig();
    r.backend.noteObservation(sqlState('53300', 'FATAL'), r.backend.databaseEpoch(), true);
    expect(r.backend.connectionState().state).toBe('ready');
  });
});

describe('a lapse of the shard claims', () => {
  it('holds the backend and logs no database failure', () => {
    const r = rig();
    r.backend.noteLapse();
    expect(r.backend.connectionState().state).toBe('outage');
    expect(r.chooser.holdStarted).toHaveBeenCalledTimes(1);
    expect(errorLines().filter(l => l.includes('entering outage'))).toEqual([]);
  });

  it('an observed failure does log its outage line', () => {
    const r = rig();
    hold(r);
    expect(errorLines().filter(l => l.includes('[PostgresBackend] Database connection failed; entering outage:'))).toHaveLength(1);
  });

  it('starts no hold while latched', () => {
    const r = rig();
    r.backend.latch(CAUSE);
    r.backend.noteLapse();
    expect(r.chooser.holdStarted).not.toHaveBeenCalled();
    expect(r.holds).toEqual([]);
  });

  it('starts no hold once stopped', async () => {
    const r = rig();
    await r.backend.stop();
    r.backend.noteLapse();
    expect(r.chooser.holdStarted).not.toHaveBeenCalled();
    expect(r.backend.connectionState().state).toBe('ready');
  });

  it('starts no hold before any database is chosen', () => {
    const r = rig({ entry: null, ready: false });
    r.backend.noteLapse();
    expect(r.chooser.holdStarted).not.toHaveBeenCalled();
    expect(r.backend.connectionState().state).toBe('connecting');
  });
});

describe('the outage alert', () => {
  it('fires ten seconds into a hold', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = rig();
    hold(r);
    vi.advanceTimersByTime(9999);
    expect(r.alerts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.alerts).toEqual([['outage', 'data backend unreachable for 10s']]);
  });
});

describe('the watch saw the entry answer', () => {
  it('a backend that is not held stays ready', () => {
    const r = rig();
    r.backend.noteEntryAnswered(r.backend.databaseEpoch());
    expect(r.backend.connectionState().state).toBe('ready');
    expect(r.holds).toEqual([]);
  });

  it('an answer seen under an earlier epoch leaves the hold in outage', () => {
    const r = rig();
    hold(r);
    r.backend.noteEntryAnswered(r.backend.databaseEpoch() - 1);
    expect(r.backend.connectionState().state).toBe('outage');
    expect(r.backend.holdWords()).toBe(SILENT_A);
  });
});

describe('the confirming cause', () => {
  it('a cause seen under an earlier epoch does not change the confirming words', () => {
    const r = rig();
    confirming(r);
    const reported = r.holds.length;
    r.backend.noteConfirmingCause('the database refused the check', r.backend.databaseEpoch() - 1);
    expect(r.backend.confirmingWords()).toBe('checking');
    expect(r.holds).toHaveLength(reported);
  });

  it('a cause under the current epoch does change them', () => {
    const r = rig();
    confirming(r);
    r.backend.noteConfirmingCause('the database refused the check', r.backend.databaseEpoch());
    expect(r.backend.confirmingWords()).toBe('the database refused the check');
  });

  it('a cause while the store was refused tells the hold listeners nothing', () => {
    const r = rig();
    hold(r);
    expect(r.holds).toEqual([SILENT_A]);
    r.internals.latchSchemaMismatch('{"v":1}');
    expect(r.backend.holdWords()).toBeNull();
    r.backend.noteConfirmingCause('the database refused the check', r.backend.databaseEpoch());
    expect(r.holds).toEqual([SILENT_A]);
  });
});

describe('a confirmation', () => {
  it('of a backend that was never held records no confirmation', () => {
    const r = rig();
    r.backend.confirmHold(r.backend.databaseEpoch());
    expect(r.backend.heldUntil()).toBeNull();
    expect(r.backend.connectionState().state).toBe('ready');
  });

  it('of a held backend ends the hold', () => {
    const r = rig();
    hold(r);
    r.backend.confirmHold(r.backend.databaseEpoch());
    expect(r.backend.connectionState().state).toBe('ready');
    expect(typeof r.backend.heldUntil()).toBe('number');
  });
});

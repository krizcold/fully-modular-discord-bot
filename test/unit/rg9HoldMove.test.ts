import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser, MoveSteps } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const FROM = 'postgres://nobody@127.0.0.1:9/from';
const TO = 'postgres://nobody@127.0.0.1:9/to';
const ALERT_MS = 10000;
const CAUSE = { kind: 'replaced', machine: 'machine-b', generation: 2 } as const;
const backends: PostgresBackend[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const backend of backends.splice(0)) await backend.stop();
  vi.restoreAllMocks();
});

function chooser(): DatabaseChooser {
  return {
    chosen: () => FROM,
    awaitChoice: async () => FROM,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

function make(): { backend: PostgresBackend; alerts: Array<[string, string]> } {
  const backend = new PostgresBackend({ chooser: chooser() });
  backends.push(backend);
  const alerts: Array<[string, string]> = [];
  backend.onAlert((event, detail) => alerts.push([event, detail]));
  return { backend, alerts };
}

function steps(over: Partial<MoveSteps> = {}) {
  return {
    checkTarget: vi.fn(async (_entry: string): Promise<null | string> => null),
    claims: vi.fn(async () => true),
    settleRetires: vi.fn(async () => true),
    moved: vi.fn(),
    attemptEnded: vi.fn(),
    ...over,
  };
}

function errorTexts(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(call => String(call[0]));
}

function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

describe('confirmHold ends only the hold of the current epoch', () => {
  it('a confirmation under another epoch leaves the hold in place', () => {
    const { backend } = make();
    backend.noteLapse();
    const epoch = backend.databaseEpoch();
    backend.confirmHold(epoch - 1);
    backend.confirmHold(epoch + 1);
    expect(backend.holdWords()).not.toBeNull();
    expect(backend.connectionState().state).toBe('outage');
    backend.confirmHold(epoch);
    expect(backend.holdWords()).toBeNull();
    expect(backend.connectionState().state).toBe('connecting');
  });

  it('a hold confirmed before the outage alert fired sends no recovered alert and logs no recovery', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { backend, alerts } = make();
    backend.noteLapse();
    backend.confirmHold(backend.databaseEpoch());
    expect(alerts).toEqual([]);
    expect(errorTexts(log)).not.toContain('[PostgresBackend] Recovered from outage');
  });

  it('a hold confirmed after the outage alert fired sends the recovered alert', () => {
    fakeClock();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { backend, alerts } = make();
    backend.noteLapse();
    vi.advanceTimersByTime(ALERT_MS + 1);
    expect(alerts.map(a => a[0])).toEqual(['outage']);
    backend.confirmHold(backend.databaseEpoch());
    expect(alerts).toEqual([['outage', expect.any(String)], ['recovered', 'connection to the data backend restored']]);
    expect(errorTexts(log)).toContain('[PostgresBackend] Recovered from outage');
  });
});

describe('hold listeners', () => {
  it('a hold listener that throws is logged and the hold still starts', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = make();
    const thrown = new Error('listener broke');
    backend.onHoldChanged(() => { throw thrown; });
    backend.noteLapse();
    expect(error).toHaveBeenCalledWith('[PostgresBackend] A hold listener threw:', thrown);
    expect(backend.holdWords()).not.toBeNull();
  });
});

describe('the latch ends a hold', () => {
  it('a latch taken while held reports no hold words', () => {
    const { backend } = make();
    backend.noteLapse();
    expect(backend.holdWords()).not.toBeNull();
    backend.latch(CAUSE);
    expect(backend.holdWords()).toBeNull();
    expect(backend.confirmingWords()).toBeNull();
  });

  it('the outage alert of a hold the latch ended does not fire for a later hold', async () => {
    fakeClock();
    const { backend, alerts } = make();
    backend.noteLapse();
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, steps())).toBe(true);
    vi.advanceTimersByTime(ALERT_MS / 2);
    backend.noteLapse();
    vi.advanceTimersByTime(ALERT_MS / 2 + 1);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(ALERT_MS / 2);
    expect(alerts.map(a => a[0])).toEqual(['outage']);
  });

  it('a hold after a latch whose hold had alerted alerts again', async () => {
    fakeClock();
    const { backend, alerts } = make();
    backend.noteLapse();
    vi.advanceTimersByTime(ALERT_MS + 1);
    expect(alerts.map(a => a[0])).toEqual(['outage']);
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, steps())).toBe(true);
    backend.noteLapse();
    vi.advanceTimersByTime(ALERT_MS + 1);
    expect(alerts.map(a => a[0])).toEqual(['outage', 'outage']);
  });
});

describe('useDatabase', () => {
  it('refuses to move while not latched', async () => {
    const { backend } = make();
    const s = steps();
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.checkTarget).not.toHaveBeenCalled();
    expect(backend.chosenEntry()).toBe(FROM);
  });

  it('refuses to move once stopped', async () => {
    const { backend } = make();
    backend.latch(CAUSE);
    await backend.stop();
    const s = steps();
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.checkTarget).not.toHaveBeenCalled();
    expect(backend.chosenEntry()).toBe(FROM);
  });

  it('logs a refused target with only its own line when the refusal is a bare reason', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = make();
    backend.latch(CAUSE);
    const s = steps({ checkTarget: vi.fn(async () => 'the target is wrong') });
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(errorTexts(error)).toHaveLength(1);
    expect(errorTexts(error)[0]).toMatch(/^\[Database\] Not moving to .*: the target is wrong; this process keeps/);
  });

  it('logs the same refusal again after a move ended the latch it was logged under', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = make();
    const refuse = steps({ checkTarget: vi.fn(async () => 'the target is wrong') });
    backend.latch(CAUSE);
    await backend.useDatabase(TO, refuse);
    await backend.useDatabase(TO, refuse);
    expect(errorTexts(error).filter(t => t.includes('Not moving to'))).toHaveLength(1);
    expect(await backend.useDatabase(TO, steps())).toBe(true);
    backend.latch(CAUSE);
    await backend.useDatabase(TO, refuse);
    expect(errorTexts(error).filter(t => t.includes('Not moving to'))).toHaveLength(2);
  });

  it('a latch taken during the target check ends the attempt before the pools are built', async () => {
    const { backend } = make();
    const s = steps({ checkTarget: vi.fn(async () => { backend.latch(CAUSE); return null; }) });
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.claims).not.toHaveBeenCalled();
    expect(backend.chosenEntry()).toBe(FROM);
    expect(backend.latchReason()).not.toBeNull();
  });

  it('a stop during the target check ends the attempt before the pools are built', async () => {
    const { backend } = make();
    const s = steps({ checkTarget: vi.fn(async () => { await backend.stop(); return null; }) });
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.claims).not.toHaveBeenCalled();
    expect(backend.chosenEntry()).toBe(FROM);
  });

  it('logs a left pool that does not end cleanly', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = make();
    await backend.getPool().end();
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, steps())).toBe(true);
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith('[PostgresBackend] The pool of the database this process left did not end cleanly:', expect.any(Error));
    }, { timeout: 1000, interval: 5 });
  });

  it('a database listener that throws is logged and the move goes on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = make();
    const thrown = new Error('listener broke');
    backend.onDatabaseChanged(() => { throw thrown; });
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, steps())).toBe(true);
    expect(error).toHaveBeenCalledWith('[PostgresBackend] A database listener threw:', thrown);
    expect(backend.chosenEntry()).toBe(TO);
  });

  it('claims that fail end the attempt before the retires are settled', async () => {
    const { backend } = make();
    const s = steps({ claims: vi.fn(async () => false) });
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.settleRetires).not.toHaveBeenCalled();
    expect(s.moved).not.toHaveBeenCalled();
    expect(backend.isMoving()).toBe(false);
    expect(backend.latchReason()).not.toBeNull();
  });

  it('a latch during the claims ends the attempt before the retires are settled', async () => {
    const { backend } = make();
    const s = steps({ claims: vi.fn(async () => { backend.latch(CAUSE); return true; }) });
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.settleRetires).not.toHaveBeenCalled();
    expect(s.attemptEnded).not.toHaveBeenCalled();
    expect(s.moved).not.toHaveBeenCalled();
  });

  it('retires that do not settle end the attempt and keep the latch', async () => {
    const { backend } = make();
    const s = steps({ settleRetires: vi.fn(async () => false) });
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.attemptEnded).toHaveBeenCalledTimes(1);
    expect(s.moved).not.toHaveBeenCalled();
    expect(backend.latchReason()).not.toBeNull();
    expect(backend.isMoving()).toBe(false);
  });

  it('a latch while the retires settle ends the attempt and keeps the latch', async () => {
    const { backend } = make();
    const s = steps({ settleRetires: vi.fn(async () => { backend.latch(CAUSE); return true; }) });
    backend.latch(CAUSE);
    expect(await backend.useDatabase(TO, s)).toBe(false);
    expect(s.attemptEnded).toHaveBeenCalledTimes(1);
    expect(s.moved).not.toHaveBeenCalled();
    expect(backend.latchReason()).not.toBeNull();
  });
});

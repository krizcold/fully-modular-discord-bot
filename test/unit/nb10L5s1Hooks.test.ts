import { afterAll, describe, expect, it, vi } from 'vitest';

// NB10 decisions 12 and 20: a cache registered for the stop is marked stopped at a deposition, also when it registers
// after one; at process exit each registered cache logs what the stop loses, a failure there is logged by its cause,
// and a cache taken off the list is left alone. The tests run in order: the first registration installs the hooks.

const ctl = vi.hoisted(() => ({ deposed: null as unknown, listeners: [] as Array<(holder: unknown) => void> }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/writerLock')>();
  return {
    ...real,
    deposedHolder: () => ctl.deposed,
    onDeposed: (fn: (holder: unknown) => void) => { ctl.listeners.push(fn); },
  };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let current: any = null;
  return { ...real, getPaymentRegistry: () => (current ??= new real.PaymentProviderRegistry()) };
});

import { registerCacheStop, unregisterCacheStop, type StopKind } from '../../src/bot/internalSetup/utils/premiumManager';

interface Fake {
  name: string;
  stops: StopKind[];
  exits: number;
  finalStop(): void;
  markStopped(kind: StopKind): void;
  logLossesAtExit(): void;
}

function fake(name: string, throws = false): Fake {
  const t: Fake = {
    name,
    stops: [],
    exits: 0,
    finalStop: () => undefined,
    markStopped: kind => { t.stops.push(kind); },
    logLossesAtExit: () => {
      t.exits += 1;
      if (throws) throw new Error(`${name} could not read its lines`);
    },
  };
  return t;
}

const made: Fake[] = [];
let exitHandler: (() => void) | null = null;

afterAll(() => {
  for (const t of made) unregisterCacheStop(t);
  vi.restoreAllMocks();
});

describe('the stop hooks of the premium cache', () => {
  it('the first registration adds one exit handler and one deposition handler; later ones add none', () => {
    const before = process.listeners('exit');
    const a = fake('a');
    made.push(a);
    registerCacheStop(a);
    const added = process.listeners('exit').filter(l => !before.includes(l));
    expect(added).toHaveLength(1);
    exitHandler = added[0] as () => void;
    expect(ctl.listeners).toHaveLength(1);
    const count = process.listenerCount('exit');
    const b = fake('b');
    made.push(b);
    registerCacheStop(b);
    expect(process.listenerCount('exit')).toBe(count);
    expect(ctl.listeners).toHaveLength(1);
    ctl.listeners[0]({ pid: 1 });
    expect(a.stops).toEqual(['deposed']);
    expect(b.stops).toEqual(['deposed']);
  });

  it('at exit every registered cache logs its losses; one that throws is logged and the next still runs', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = fake('bad', true);
    const after = fake('after');
    made.push(bad, after);
    registerCacheStop(bad);
    registerCacheStop(after);
    exitHandler!();
    expect(made.map(t => t.exits)).toEqual([1, 1, 1, 1]);
    const lines = error.mock.calls.filter(c => c[0] === '[PremiumManager] Could not log what this stop loses:');
    expect(lines).toHaveLength(1);
    expect(String(lines[0][1])).toBe('Error: bad could not read its lines');
    error.mockRestore();
  });

  it('a cache taken off the list is neither logged at exit nor marked at a deposition', () => {
    const gone = fake('gone');
    registerCacheStop(gone);
    unregisterCacheStop(gone);
    for (const t of made) unregisterCacheStop(t);
    exitHandler!();
    ctl.listeners[0]({ pid: 1 });
    expect(gone.exits).toBe(0);
    expect(gone.stops).toEqual([]);
  });

  it('a cache registered after a deposition is marked deposed at once', () => {
    ctl.deposed = { pid: 1 };
    const late = fake('late');
    registerCacheStop(late);
    expect(late.stops).toEqual(['deposed']);
    unregisterCacheStop(late);
    ctl.deposed = null;
  });
});

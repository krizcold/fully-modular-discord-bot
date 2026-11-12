import { createHook } from 'async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPremiumItems,
  failItems,
  forgetItems,
  itemsSettled,
  makeItem,
  openItemsOf,
  runItems,
  type Item,
  type ItemKind,
} from '../../src/bot/internalSetup/utils/premiumItems';
import { currentLedger, currentModule, openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

const FAIL = '[PremiumManager] A premium side effect failed:';
let errors: ReturnType<typeof vi.spyOn>;

function item(kind: ItemKind, run: () => unknown = () => undefined, owner: object = {}, extra: Partial<Item> = {}): Item {
  return makeItem({ kind, id: `${kind}-${Math.random()}`, owner, run, drop: () => undefined, ...extra });
}

async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise(r => setImmediate(r));
  }
}

async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
}

function tracked<T>(p: Promise<T>): { done: () => boolean; error: () => unknown; p: Promise<T> } {
  let done = false;
  let error: unknown;
  p.then(() => { done = true; }, e => { done = true; error = e; });
  return { done: () => done, error: () => error, p };
}

beforeEach(() => {
  _resetPremiumItems();
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetPremiumItems();
});

describe('ra69 premium items: async resource', () => {
  it('names each item scope PremiumItem and destroys it once, however often it is settled', async () => {
    const inits = new Map<number, string>();
    const destroys: number[] = [];
    const hook = createHook({
      init(id, type) { inits.set(id, type); },
      destroy(id) { destroys.push(id); },
    }).enable();
    try {
      const it1 = item('audit');
      const id = it1.scope.asyncId();
      expect(inits.get(id)).toBe('PremiumItem');
      forgetItems([it1]);
      expect(it1.open).toBe(false);
      forgetItems([it1]);
      await until(() => destroys.includes(id));
      await ticks(3);
      expect(destroys.filter(d => d === id)).toHaveLength(1);
    } finally {
      hook.disable();
    }
  });

  it('marks a settled item closed and drops it from its owner list', () => {
    const owner = {};
    const a = item('event', undefined, owner);
    expect(a.open).toBe(true);
    forgetItems([a]);
    expect(a.open).toBe(false);
    expect(openItemsOf(owner)).toEqual([]);
  });
});

describe('ra69 premium items: effects', () => {
  it('runs an effect of a sealed ledger item in a console ledger named premium', async () => {
    const ledger = openLedger('panel');
    ledger.seal();
    let seen: { module: string | undefined; kind: string | undefined } | null = null;
    const thenable = {
      then(resolve: (v: unknown) => void) {
        seen = { module: currentModule(), kind: currentLedger()?.kind };
        resolve(1);
      },
    };
    const it1 = runInLedger(ledger, 'mod', () => item('event', () => thenable));
    runItems([it1]);
    await until(() => !it1.open);
    expect(seen).toEqual({ module: 'premium', kind: 'console' });
  });

  it('logs a synchronous throw and closes the item at once', () => {
    const boom = new Error('boom');
    const it1 = item('event', () => { throw boom; });
    runItems([it1]);
    expect(it1.open).toBe(false);
    expect(errors).toHaveBeenCalledWith(FAIL, boom);
  });

  it('keeps an event open until its promise settles', async () => {
    let finish!: () => void;
    const it1 = item('event', () => new Promise<void>(r => { finish = r; }));
    runItems([it1]);
    await ticks();
    expect(it1.open).toBe(true);
    finish();
    await until(() => !it1.open);
  });

  it('closes a notice once handed over, before its delivery settles', () => {
    const it1 = item('notice', () => new Promise<void>(() => undefined));
    runItems([it1]);
    expect(it1.open).toBe(false);
  });

  it('logs a rejected effect and closes the item', async () => {
    const boom = new Error('late');
    const it1 = item('event', () => Promise.reject(boom));
    runItems([it1]);
    await until(() => !it1.open);
    expect(errors).toHaveBeenCalledWith(FAIL, boom);
  });
});

describe('ra69 premium items: failItems', () => {
  it("marks an unconfirmed op's audit line with not-landed", () => {
    const causes: string[] = [];
    const audit = item('audit', undefined, {}, { marked: (cause, at) => { causes.push(cause); return `m:${cause}:${at}`; } });
    const written: Array<Array<{ id: string; line: string }>> = [];
    failItems([audit], 'unconfirmed', { stopWords: () => null, writeMarked: lines => written.push(lines) });
    expect(causes).toEqual(['not-landed']);
    expect(written).toHaveLength(1);
    expect(written[0][0].id).toBe(audit.id);
    expect(written[0][0].line.startsWith('m:not-landed:')).toBe(true);
  });

  it('writes no marked lines when no audit line was marked', () => {
    const writeMarked = vi.fn();
    const notice = item('notice');
    failItems([notice], { refused: 'io', words: 'the disk failed' }, { stopWords: () => null, writeMarked });
    expect(writeMarked).not.toHaveBeenCalled();
  });
});

describe('ra69 premium items: owners and settling', () => {
  it("lists only the owner's open items", () => {
    const a = {};
    const b = {};
    const ia = item('event', undefined, a);
    item('event', undefined, b);
    expect(openItemsOf(a)).toEqual([ia]);
  });

  it('waits with no bound until the ledger item closes', async () => {
    const ledger = openLedger('console');
    const it1 = runInLedger(ledger, null, () => item('event'));
    const w = tracked(itemsSettled(ledger, null));
    await ticks();
    expect(w.done()).toBe(false);
    forgetItems([it1]);
    await until(w.done);
    expect(w.error()).toBeUndefined();
  });

  it('waits within a bound until the ledger item closes', async () => {
    const ledger = openLedger('console');
    const it1 = runInLedger(ledger, null, () => item('event'));
    const w = tracked(itemsSettled(ledger, 10_000));
    await ticks();
    expect(w.done()).toBe(false);
    forgetItems([it1]);
    await until(w.done);
    expect(w.error()).toBeUndefined();
  });

  it('gives up once the bound passes', async () => {
    const ledger = openLedger('console');
    runInLedger(ledger, null, () => item('event'));
    const w = tracked(itemsSettled(ledger, 20));
    await until(w.done);
    expect(w.error()).toBeUndefined();
  });

  it("does not wait for another ledger's items", async () => {
    const mine = openLedger('console');
    const other = openLedger('console');
    runInLedger(other, null, () => item('event'));
    item('event');
    const w = tracked(itemsSettled(mine, null));
    await until(w.done);
    expect(w.error()).toBeUndefined();
  });

  it('skips the items skip names', async () => {
    const ledger = openLedger('console');
    runInLedger(ledger, null, () => item('event'));
    const w = tracked(itemsSettled(ledger, null, () => true));
    await until(w.done);
  });

  it('answers at once when the bound is used up at the first check', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const ledger = openLedger('console');
    runInLedger(ledger, null, () => item('event'));
    const w = tracked(itemsSettled(ledger, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(w.done()).toBe(true);
  });

  it('clears its timer once, and a later close does not touch it again', async () => {
    const ledger = openLedger('console');
    const it1 = runInLedger(ledger, null, () => item('event'));
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    const w = tracked(itemsSettled(ledger, 10_000));
    await ticks(2);
    forgetItems([it1]);
    await until(w.done);
    const after = clears.mock.calls.length;
    forgetItems([item('event')]);
    forgetItems([item('event')]);
    expect(clears.mock.calls.length).toBe(after);
  });

  it('waits under timers that have no unref', async () => {
    const real = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms: number) => {
      const t = real(fn, ms);
      t.unref();
      return { ref: () => undefined, [Symbol.toPrimitive]: () => Number(t), t };
    }) as unknown as typeof setTimeout);
    vi.stubGlobal('clearTimeout', ((h: any) => globalThis.clearInterval(h?.t ?? h)) as unknown as typeof clearTimeout);
    const ledger = openLedger('console');
    const it1 = runInLedger(ledger, null, () => item('event'));
    const w = tracked(itemsSettled(ledger, 10_000));
    await ticks();
    forgetItems([it1]);
    await until(w.done);
    expect(w.error()).toBeUndefined();
  });
});

describe('ra69 premium items: reset', () => {
  it('forgets every item and wakes a waiter', async () => {
    const owner = {};
    const ledger = openLedger('console');
    runInLedger(ledger, null, () => item('event', undefined, owner));
    const w = tracked(itemsSettled(ledger, null));
    await ticks();
    expect(w.done()).toBe(false);
    _resetPremiumItems();
    expect(openItemsOf(owner)).toEqual([]);
    await until(w.done);
  });
});

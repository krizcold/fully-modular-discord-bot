import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { getPending, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

// NB12 code review round 9 (NB12-T-R9-1, wip-redesign/sheets/NB12.md decision 8 'Cost'): placing a guild write adds
// no walk of the process queue on top of what an equal global write already costs.

let guilds = 9_810_000_000;
const fresh = () => String(++guilds);
let globals = 0;

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
  setGuildViewCache(false);
});

/**
 * Counts every step of any walk (for-of, spread, keys, values, entries, forEach) over a map holding more than `over`
 * entries; queueSteps counts those over a map that holds `queued()`, the path the caller queued last.
 */
function countLargeMapSteps(over: number, fn: () => void, queued: () => string = () => ''): { steps: number; queueSteps: number } {
  const proto = Map.prototype as any;
  const iterProto = Object.getPrototypeOf(new Map().entries());
  const large = new WeakMap<object, boolean>();
  let steps = 0;
  let queueSteps = 0;
  const isQueue = (m: Map<unknown, unknown>) => m.has(queued());
  const saved: Array<[any, PropertyKey, any]> = [];
  const patch = (holder: any, name: PropertyKey, make: (real: any) => any) => {
    saved.push([holder, name, holder[name]]);
    holder[name] = make(holder[name]);
  };
  for (const name of ['keys', 'values', 'entries', Symbol.iterator] as PropertyKey[]) {
    patch(proto, name, real => function (this: Map<unknown, unknown>) {
      const it = real.call(this);
      if (this.size > over) large.set(it, isQueue(this));
      return it;
    });
  }
  patch(iterProto, 'next', real => function (this: object) {
    const step = real.call(this);
    if (!step.done && large.has(this)) {
      steps += 1;
      if (large.get(this)) queueSteps += 1;
    }
    return step;
  });
  patch(proto, 'forEach', real => function (this: Map<unknown, unknown>, cb: (...a: unknown[]) => void, thisArg?: unknown) {
    if (this.size <= over) return real.call(this, cb, thisArg);
    const queue = isQueue(this);
    return real.call(this, (...a: unknown[]) => {
      steps += 1;
      if (queue) queueSteps += 1;
      cb.apply(thisArg, a);
    });
  });
  try {
    fn();
    return { steps, queueSteps };
  } finally {
    for (const [holder, name, real] of saved.reverse()) holder[name] = real;
  }
}

describe('the probe', () => {
  it('counts every way of walking a large map, none over a small one, and the queue apart', () => {
    const big = new Map(Array.from({ length: 300 }, (_, i) => [`k${i}`, i] as const));
    const small = new Map(Array.from({ length: 10 }, (_, i) => [`k${i}`, i] as const));
    const walks: Array<(m: Map<string, number>) => void> = [
      m => { for (const e of m) void e; },
      m => void [...m],
      m => void [...m.keys()].filter(k => k.startsWith('k1')),
      m => { for (const v of m.values()) void v; },
      m => { for (const [k] of m.entries()) void k; },
      m => m.forEach(() => undefined),
    ];
    for (const walk of walks) {
      expect(countLargeMapSteps(200, () => walk(big), () => 'k7')).toEqual({ steps: 300, queueSteps: 300 });
      expect(countLargeMapSteps(200, () => walk(big), () => 'absent')).toEqual({ steps: 300, queueSteps: 0 });
      expect(countLargeMapSteps(200, () => walk(small), () => 'k7')).toEqual({ steps: 0, queueSteps: 0 });
    }
    const sub = new (class extends Map<string, number> {})(big);
    expect(countLargeMapSteps(200, () => void [...sub.entries()], () => 'k7')).toEqual({ steps: 300, queueSteps: 300 });
  });
});

describe.each([true, false])('600 writes in one synchronous loop (cache %s)', cache => {
  it('walks the queue no more for guild writes than for global writes, and no other large map', async () => {
    setGuildViewCache(cache);
    const run = ++globals;
    const ids = Array.from({ length: 600 }, fresh);
    let last = '';
    const globalRun = countLargeMapSteps(200, () => {
      for (let i = 0; i < 600; i++) {
        expect(dm.saveDataTracked(`totals-${run}-${i}.json`, { scope: 'global', category: 'nb12' }, { n: 1 }).outcome).toBe('saved');
        last = dataPath('global', 'nb12', `totals-${run}-${i}.json`);
      }
    }, () => last);
    expect(getPending(last)?.op).toBe('write');
    await dm.flushAll();
    last = '';
    const guildRun = countLargeMapSteps(200, () => {
      for (const guildId of ids) {
        expect(dm.saveDataTracked('m/totals.json', { guildId }, { n: 1 }).outcome).toBe('saved');
        last = dataPath(guildId, 'm', 'totals.json');
      }
    }, () => last);
    for (const guildId of [ids[0], ids[599]]) expect(getPending(dataPath(guildId, 'm', 'totals.json'))?.op).toBe('write');
    expect(globalRun.queueSteps).toBeGreaterThan(0);
    expect(guildRun.queueSteps).toBe(globalRun.queueSteps);
    expect(guildRun.steps).toBe(guildRun.queueSteps);
  });
});

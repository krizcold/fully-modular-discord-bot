import { getEventListeners } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimPausedError, classifyFailure } from '../../src/bot/internalSetup/fleet/claimStore';
import { SlotThrottler, l23Line, parentSlotAsker, type SlotThrottlerDeps } from '../../src/bot/internalSetup/fleet/identifySlots';

afterEach(() => {
  vi.restoreAllMocks();
});

async function flush(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function track<T>(p: Promise<T>): { state: () => string; value: () => unknown } {
  let state = 'pending';
  let value: unknown;
  p.then(v => { state = 'resolved'; value = v; }, e => { state = 'rejected'; value = e; });
  return { state: () => state, value: () => value };
}

function quietLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function throttler(deps: Partial<SlotThrottlerDeps> & { mode: SlotThrottlerDeps['mode'] }) {
  const log = quietLog();
  const t = new SlotThrottler(1, { renewMs: 1, log, random: () => 0, ...deps });
  return { t, log };
}

function fakeChannel(send?: (message: any) => boolean) {
  const listeners = new Set<(message: any) => void>();
  const sent: any[] = [];
  return {
    sent,
    listeners,
    channel: {
      send: send ?? ((message: any) => { sent.push(message); return true; }),
      on(_event: 'message', fn: (message: any) => void) { listeners.add(fn); return this; },
      off(_event: 'message', fn: (message: any) => void) { listeners.delete(fn); return this; },
    },
    emit(message: any) { for (const fn of [...listeners]) fn(message); },
  };
}

async function answerWith(waitMs: unknown): Promise<unknown> {
  const f = fakeChannel();
  const p = parentSlotAsker(f.channel)(0);
  const nonce = f.sent[0].data.nonce;
  f.emit({ type: 'identify:slot', data: { nonce, waitMs } });
  return p;
}

describe('SlotThrottler: an aborted shard never takes a login slot', () => {
  it('a shard aborted after its queue turn and before the slot is asked rejects instead of taking a local slot', async () => {
    const { t } = throttler({ mode: 'local' });
    const ac = new AbortController();
    const p = track(t.waitForIdentify(0, ac.signal));
    queueMicrotask(() => ac.abort());
    await flush();
    expect(p.state()).toBe('rejected');
    expect((p.value() as Error).name).toBe('AbortError');
  });

  it('an abort during the database reserve rejects without a database warning', async () => {
    const ac = new AbortController();
    const { t, log } = throttler({ mode: 'database', reserve: () => { ac.abort(); return new Promise(() => undefined); } });
    const p = track(t.waitForIdentify(0, ac.signal));
    await flush();
    expect(p.state()).toBe('rejected');
    expect((p.value() as Error).name).toBe('AbortError');
    expect(log.warn).not.toHaveBeenCalled();
    expect(t.mode()).toBe('database');
  });

  it('a grant that arrives after the signal aborted is not taken', async () => {
    const ac = new AbortController();
    const { t } = throttler({ mode: 'database', reserve: async () => { ac.abort(); return { granted: true as const }; } });
    const p = track(t.waitForIdentify(0, ac.signal));
    await flush();
    expect(p.state()).toBe('rejected');
    expect((p.value() as Error).name).toBe('AbortError');
  });

  it('an abort while the web UI has not answered rejects at once and leaves no abort listener', async () => {
    const ac = new AbortController();
    const { t } = throttler({ mode: 'parent', askParent: () => new Promise(() => undefined) });
    const p = track(t.waitForIdentify(0, ac.signal));
    await flush();
    expect(p.state()).toBe('pending');
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(1);
    ac.abort();
    await flush();
    expect(p.state()).toBe('rejected');
    expect((p.value() as Error).name).toBe('AbortError');
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});

describe('SlotThrottler: the abort listeners are removed when a wait ends', () => {
  it('a granted local slot leaves no listener on the signal', async () => {
    const { t } = throttler({ mode: 'local' });
    const ac = new AbortController();
    await t.waitForIdentify(0, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('a reserve that failed and then granted leaves no listener on the signal', async () => {
    let calls = 0;
    const { t } = throttler({
      mode: 'database',
      reserve: async () => {
        calls += 1;
        if (calls === 1) throw new ClaimPausedError();
        return { granted: true as const };
      },
    });
    const ac = new AbortController();
    await t.waitForIdentify(0, ac.signal);
    expect(calls).toBe(2);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});

describe('SlotThrottler: the first local slot of a bucket is granted at once', () => {
  it('resolves within microtasks, without waiting on a timer', async () => {
    const { t } = throttler({ mode: 'local' });
    const p = track(t.waitForIdentify(0, new AbortController().signal));
    await flush();
    expect(p.state()).toBe('resolved');
  });
});

describe('SlotThrottler: the database failure warning is rate limited', () => {
  it('warns again when exactly 30 s passed since the last warning', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const ac = new AbortController();
    const err = new Error('connect ECONNREFUSED');
    let calls = 0;
    const { t, log } = throttler({
      mode: 'database',
      reserve: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(err);
        if (calls === 2) { clock += 30_000; return Promise.reject(err); }
        ac.abort();
        return new Promise(() => undefined);
      },
    });
    await expect(t.waitForIdentify(3, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const line = l23Line(classifyFailure(err), 3, 1);
    expect(log.warn.mock.calls).toEqual([[line], [line]]);
  });

  it('warns at the first failure after a reserve that answered', async () => {
    let clock = 2_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const ac = new AbortController();
    const err = new Error('connect ECONNREFUSED');
    let calls = 0;
    const { t, log } = throttler({
      mode: 'database',
      reserve: () => {
        calls += 1;
        clock += 1;
        if (calls === 1) return Promise.resolve({ granted: false as const, waitMs: 0 });
        if (calls === 2) return Promise.reject(err);
        ac.abort();
        return new Promise(() => undefined);
      },
    });
    await expect(t.waitForIdentify(0, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(log.warn.mock.calls).toEqual([[l23Line(classifyFailure(err), 0, 1)]]);
  });
});

describe('SlotThrottler and parentSlotAsker on timers without unref', () => {
  function timersWithoutUnref() {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => ({ id: realSet(fn, ms) })) as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: any) => realClear(handle?.id)) as any);
  }

  it('the web UI wait still sleeps and then grants', async () => {
    timersWithoutUnref();
    let calls = 0;
    const { t } = throttler({ mode: 'parent', askParent: async () => (++calls === 1 ? 1 : 0) });
    await t.waitForIdentify(0, new AbortController().signal);
    expect(calls).toBe(2);
  });

  it('the parent ask still answers null when the message cannot be sent', async () => {
    timersWithoutUnref();
    const f = fakeChannel(() => false);
    await expect(parentSlotAsker(f.channel)(0)).resolves.toBeNull();
    expect(f.listeners.size).toBe(0);
  });
});

describe('parentSlotAsker: which answers count', () => {
  it('ignores a message of another type that carries the same nonce', async () => {
    const f = fakeChannel();
    const p = parentSlotAsker(f.channel)(2);
    const nonce = f.sent[0].data.nonce;
    expect(f.sent[0]).toEqual({ type: 'identify:slot', data: { nonce, bucket: 2 } });
    f.emit({ type: 'other', data: { nonce, waitMs: 7 } });
    f.emit(undefined);
    f.emit(null);
    f.emit({ type: 'identify:slot' });
    f.emit({ type: 'identify:slot', data: { nonce: 'not-mine', waitMs: 9 } });
    f.emit({ type: 'identify:slot', data: { nonce, waitMs: 3 } });
    await expect(p).resolves.toBe(3);
    expect(f.listeners.size).toBe(0);
  });

  it('a positive wait is passed on as it came', async () => {
    expect(await answerWith(3)).toBe(3);
    expect(await answerWith('250')).toBe(250);
  });

  it('a wait that is not a positive finite number grants at once (0)', async () => {
    for (const waitMs of [-5, 'abc', undefined, Infinity, -Infinity, 0]) {
      expect(await answerWith(waitMs)).toBe(0);
    }
    expect(Object.is(await answerWith(-0), 0)).toBe(true);
  });

  it('a send that throws answers null at once and stops listening', async () => {
    const f = fakeChannel(() => { throw new Error('channel closed'); });
    const p = track(parentSlotAsker(f.channel)(0));
    await flush();
    expect(p.state()).toBe('resolved');
    expect(p.value()).toBeNull();
    expect(f.listeners.size).toBe(0);
  });
});

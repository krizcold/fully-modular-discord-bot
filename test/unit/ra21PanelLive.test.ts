import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({ pools: [] as any[] }));

vi.mock('pg', async importOriginal => {
  const real = await importOriginal<typeof import('pg')>();
  class Pool {
    readonly options: any;
    handlers: Record<string, Array<(...a: any[]) => void>> = {};
    constructor(options: any) { this.options = options; pg.pools.push(this); }
    on(event: string, fn: (...a: any[]) => void) { (this.handlers[event] ??= []).push(fn); return this; }
    async connect() {
      const client: any = { release: vi.fn(), on: () => client, query: () => Promise.resolve({ rows: [] }) };
      for (const fn of this.handlers.connect ?? []) fn(client);
      return client;
    }
    async end() { return undefined; }
  }
  return { ...real, Pool, default: { ...(real as any).default, Pool } };
});
vi.mock('../../src/bot/internalSetup/fleet/guildRequests', () => ({
  pgBackendOf: () => ({ chosenEntry: () => 'postgres://bot@localhost:5432/bot', onDatabaseChanged: () => undefined }),
  backendGate: { refusal: () => null, epoch: () => null, stopWhy: () => null },
}));

import {
  _interestCount, _resetPanelLive, _setNotifyDb, isNotifying, liveAnswer, liveVersionOf, noteLiveChange, notifyTick, registerInterest,
} from '../../src/bot/internalSetup/fleet/panelLive';
import { ANSWER_LIMIT_BYTES } from '../../src/bot/internalSetup/utils/transportJson';

const G = '4194304';
const payload = (p: string) => JSON.stringify({ g: G, p });

function okDb() {
  return { notify: vi.fn(async (_payloads: string[]) => undefined) };
}

function deferredDb() {
  let reject!: (error: Error) => void;
  const db = {
    notify: vi.fn((_payloads: string[]) => new Promise<void>((_, rej) => { reject = rej; })),
  };
  return { db, fail: (message: string) => reject(new Error(message)) };
}

let errors: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _resetPanelLive();
  pg.pools.length = 0;
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetPanelLive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the notify pool name', () => {
  it('names its connections smdb-panel-notify', async () => {
    _setNotifyDb(null, () => false);
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    await notifyTick();
    expect(pg.pools).toHaveLength(1);
    expect(pg.pools[0].options.application_name).toBe('smdb-panel-notify');
  });
});

describe('interest expiry at the 90 s bound', () => {
  it('a pair renewed exactly 90 s ago still has its kept state', () => {
    _setNotifyDb(okDb(), () => false);
    registerInterest(G, 'a');
    noteLiveChange(G, 'a', { v: 1 });
    vi.advanceTimersByTime(90_000);
    expect(liveVersionOf(G, 'a')).toBe(1);
  });

  it('registering another pair exactly 90 s later keeps the first pair watched', () => {
    _setNotifyDb(okDb(), () => false);
    const since = registerInterest(G, 'a');
    vi.advanceTimersByTime(90_000);
    registerInterest(G, 'b');
    noteLiveChange(G, 'a', { v: 1 });
    expect(liveAnswer(G, 'a', since)).toMatchObject({ since, version: 1, data: { v: 1 } });
  });

  it('a full set of 128 expired interests makes room for a new one', () => {
    _setNotifyDb(okDb(), () => false);
    for (let i = 0; i < 128; i++) expect(registerInterest(G, `p${i}`)).not.toBeNull();
    expect(registerInterest(G, 'late')).toBeNull();
    vi.advanceTimersByTime(90_001);
    expect(registerInterest(G, 'late')).toEqual(expect.any(Number));
    expect(_interestCount()).toBe(1);
  });
});

describe('since values', () => {
  it('a new interest takes the clock time as its since', () => {
    _setNotifyDb(okDb(), () => false);
    const now = Date.now();
    expect(registerInterest(G, 'a')).toBe(now);
  });

  it('two interests registered in the same millisecond get different sinces', () => {
    _setNotifyDb(okDb(), () => false);
    const first = registerInterest(G, 'a') as number;
    const second = registerInterest(G, 'b') as number;
    expect(second).toBe(first + 1);
  });

  it('liveVersionOf answers 0 for a since of another interest', () => {
    _setNotifyDb(okDb(), () => false);
    const since = registerInterest(G, 'a') as number;
    noteLiveChange(G, 'a', { v: 1 });
    expect(liveVersionOf(G, 'a', since + 1000)).toBe(0);
    expect(liveVersionOf(G, 'a', since)).toBe(1);
  });

  it('liveAnswer with a null since gives no state, even for a watched pair', () => {
    _setNotifyDb(okDb(), () => false);
    registerInterest(G, 'a');
    noteLiveChange(G, 'a', { v: 1 });
    expect(liveAnswer(G, 'a', null)).toEqual({ success: true, data: null, since: null, version: 0, notifying: null });
  });
});

describe('noteLiveChange and kept views', () => {
  it('ignores a panel id that is not a string', () => {
    _setNotifyDb(okDb(), () => false);
    registerInterest(G, '123');
    noteLiveChange(G, 123 as unknown as string, { v: 1 });
    expect(liveVersionOf(G, '123')).toBe(0);
  });

  it('keeps a view whose answer is exactly at the size limit as data, not as oversize', () => {
    _setNotifyDb(okDb(), () => false);
    const since = registerInterest(G, 'a');
    const base = JSON.stringify({ success: true, data: { s: '' } }).length;
    const view = { s: 'x'.repeat(ANSWER_LIMIT_BYTES - base) };
    expect(Buffer.byteLength(JSON.stringify({ success: true, data: view }))).toBe(ANSWER_LIMIT_BYTES);
    noteLiveChange(G, 'a', view);
    const answer = liveAnswer(G, 'a', since);
    expect(answer.oversize).toBeUndefined();
    expect(answer.data).toEqual(view);
  });
});

describe('starting the notifier', () => {
  it('a change on a pair registered while the notifier was off starts it', async () => {
    const db = okDb();
    _setNotifyDb(db, () => false);
    registerInterest(G, 'a');
    _setNotifyDb(db, () => true);
    noteLiveChange(G, 'a', { v: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.notify).toHaveBeenCalledWith([payload('a')]);
  });

  it('a new interest while announcing works starts no notifier', async () => {
    const db = okDb();
    _setNotifyDb(db, () => false);
    registerInterest(G, 'a');
    noteLiveChange(G, 'a', { v: 1 });
    await notifyTick();
    expect(isNotifying()).toBe(true);
    _setNotifyDb(db, () => true);
    registerInterest(G, 'b');
    await vi.advanceTimersByTimeAsync(92_000);
    expect(db.notify).toHaveBeenCalledTimes(1);
    expect(isNotifying()).toBe(true);
  });

  it('a new interest after a failed announce starts the notifier, which announces again', async () => {
    const failing = { notify: vi.fn(async () => { throw new Error('down'); }) };
    _setNotifyDb(failing, () => false);
    registerInterest(G, 'a');
    noteLiveChange(G, 'a', { v: 1 });
    await notifyTick();
    expect(isNotifying()).toBe(false);
    const db = okDb();
    _setNotifyDb(db, () => true);
    registerInterest(G, 'b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.notify).toHaveBeenCalledWith([payload('a')]);
    expect(isNotifying()).toBe(true);
  });

  it('starts when the timer handle has no unref', () => {
    _setNotifyDb(okDb(), () => true);
    vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 987654) as any);
    let since: number | null = null;
    expect(() => { since = registerInterest(G, 'a'); }).not.toThrow();
    expect(since).toEqual(expect.any(Number));
  });
});

describe('panel ids too long to announce', () => {
  it('a 201-character panel id is left out of the statement', async () => {
    const db = okDb();
    _setNotifyDb(db, () => false);
    registerInterest(G, 'p'.repeat(201));
    registerInterest(G, 'short');
    noteLiveChange(G, 'p'.repeat(201), { v: 1 });
    noteLiveChange(G, 'short', { v: 1 });
    await notifyTick();
    expect(db.notify).toHaveBeenCalledTimes(1);
    expect(db.notify).toHaveBeenCalledWith([payload('short')]);
  });

  it('a 200-character panel id is announced', async () => {
    const db = okDb();
    _setNotifyDb(db, () => false);
    const id = 'p'.repeat(200);
    registerInterest(G, id);
    noteLiveChange(G, id, { v: 1 });
    await notifyTick();
    expect(db.notify).toHaveBeenCalledWith([payload(id)]);
  });

  it('with only a too-long id marked, no statement is sent', async () => {
    const db = okDb();
    _setNotifyDb(db, () => false);
    registerInterest(G, 'p'.repeat(201));
    noteLiveChange(G, 'p'.repeat(201), { v: 1 });
    await notifyTick();
    expect(db.notify).not.toHaveBeenCalled();
    expect(isNotifying()).toBeNull();
  });

  it('a skipped too-long id is unmarked, so the next tick probes with an empty statement', async () => {
    const db = okDb();
    _setNotifyDb(db, () => false);
    registerInterest(G, 'p'.repeat(201));
    noteLiveChange(G, 'p'.repeat(201), { v: 1 });
    await notifyTick();
    await notifyTick();
    expect(db.notify).toHaveBeenCalledTimes(1);
    expect(db.notify).toHaveBeenCalledWith([]);
    expect(isNotifying()).toBe(true);
  });
});

describe('the failure log', () => {
  it('logs nothing when every interest expired while the failed statement ran', async () => {
    const { db, fail } = deferredDb();
    _setNotifyDb(db, () => false);
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    const tick = notifyTick();
    expect(db.notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(90_001);
    fail('connection refused');
    await tick;
    expect(isNotifying()).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  });
});

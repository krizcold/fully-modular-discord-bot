import fs from 'fs';
import v8 from 'v8';
import vm from 'vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRowQueue,
  configureRowFlush,
  kickRows,
  rowOutcome,
  rowQueue,
  type RowBackend,
  type RowTicket,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { docRecordPath } from '../../src/bot/internalSetup/utils/sharedRecords';
import { dataPath } from '../../src/utils/dataRoot';

// L5 run A, chunk rp8: the row flush lets go of what it is done with (a settled op and its waiters, a timer that fired
// or was replaced), so a long run or a long outage does not grow the process; and a wake already due at the same time
// is kept, so it fires before a timer set after it.

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

let n = 0;
let sharedTx: (spec: unknown) => Promise<unknown>;
let calls = 0;

const macrotask = () => new Promise(resolve => setImmediate(resolve));

async function settleTurns(turns = 5) {
  for (let i = 0; i < turns; i++) await macrotask();
}

async function until(done: () => boolean, turns = 2000) {
  for (let i = 0; i < turns && !done(); i++) await macrotask();
  expect(done()).toBe(true);
}

async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await macrotask();
    gc();
    await macrotask();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

type Made = Array<{ ms: number; ref: WeakRef<object> }>;

/** Every timer made while fn runs, with its delay; each held weakly. */
async function timersMadeIn(fn: (made: Made) => Promise<void>): Promise<Made> {
  const real = globalThis.setTimeout;
  const made: Made = [];
  globalThis.setTimeout = ((cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = real(cb, ms, ...args);
    made.push({ ms: ms ?? 0, ref: new WeakRef(timer as unknown as object) });
    return timer;
  }) as typeof setTimeout;
  try {
    await fn(made);
  } finally {
    globalThis.setTimeout = real;
  }
  return made;
}

const hanging = () => new Promise<never>(() => undefined);

function workOp(retryIn?: number): RowTicket {
  const ticket = rowQueue.acceptWork(`rp8t:lines:${++n}`, `/rp8t/${n}.jsonl`, { bytes: 1, spec: () => ({ check: null, statements: () => [] }) });
  if (retryIn !== undefined) ticket.op.retryAt = Date.now() + retryIn;
  return ticket;
}

beforeEach(() => {
  _resetRowQueue();
  calls = 0;
  sharedTx = () => hanging();
  const backend = { sharedTx: (spec: unknown) => { calls += 1; return sharedTx(spec); } } as unknown as RowBackend;
  configureRowFlush({ backend: () => backend });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetRowQueue();
  configureRowFlush({ backend: () => null });
});

describe('a settled op is let go', () => {
  it('an op a save waited on is freed once it lands: the queue keeps neither it nor its waiters', async () => {
    sharedTx = async () => ({ kind: 'committed' });
    const ref = await (async () => {
      const ticket = workOp();
      expect(await rowOutcome(ticket)).toBe('landed');
      expect(rowQueue.ops(ticket.key)).toEqual([]);
      return new WeakRef(ticket.op);
    })();
    expect(await collected(ref)).toBe(true);
  });
});

describe("the flush's wake timers are let go", () => {
  it('a wake that fired is freed after its try starts', async () => {
    const made = await timersMadeIn(async () => {
      workOp(5);
      await settleTurns();
    });
    const wake = made.filter(t => t.ms > 0 && t.ms <= 5);
    expect(wake).toHaveLength(1);
    await until(() => calls === 1);
    expect(await collected(wake[0].ref)).toBe(true);
  });

  it('a wake replaced by an earlier one is freed at once, before the earlier one fires', async () => {
    const made = await timersMadeIn(async () => {
      const ticket = workOp(60_000);
      await settleTurns();
      ticket.op.retryAt = Date.now() + 30_000;
      kickRows();
      await settleTurns();
    });
    const first = made.filter(t => t.ms > 30_000);
    const second = made.filter(t => t.ms > 0 && t.ms <= 30_000);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(calls).toBe(0);
    expect(await collected(first[0].ref)).toBe(true);
    expect(second[0].ref.deref()).toBeDefined();
  });
});

describe("a failed mirror write's retry timer is let go", () => {
  it('the retry timer is freed once it fired and the next write was tried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const record = docRecordPath();
    fs.mkdirSync(dataPath(), { recursive: true });
    fs.writeFileSync(record, 'not json');
    try {
      sharedTx = async () => ({ kind: 'committed' });
      let errors = 0;
      vi.mocked(console.error).mockImplementation(() => { errors += 1; });
      const made = await timersMadeIn(async () => {
        const ticket = rowQueue.accept(`global/rp8t/${++n}.json`, dataPath('global', 'rp8t', `${n}.json`), { body: Buffer.from('{}') }, { sha: 'absent', caller: false });
        await until(() => ticket.op.state === 'mirror' && errors === 1);
        await settleTurns();
      });
      const retry = made.filter(t => t.ms === 1000);
      expect(retry).toHaveLength(1);
      await timersMadeIn(async again => {
        await vi.advanceTimersByTimeAsync(1000);
        await until(() => again.some(t => t.ms === 2000));
      });
      expect(await collected(retry[0].ref)).toBe(true);
    } finally {
      fs.rmSync(record, { force: true });
    }
  });
});

describe('a wake due at the same time as a later timer', () => {
  it('a kick that finds the wake already due then keeps it: the try starts before a timer set after the wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    workOp(500);
    await settleTurns();
    let seen = -1;
    setTimeout(() => { seen = calls; }, 500);
    kickRows();
    await settleTurns();
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toBe(1);
    expect(calls).toBe(1);
  });
});

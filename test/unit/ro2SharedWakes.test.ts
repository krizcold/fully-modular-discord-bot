import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRowQueue,
  configureRowFlush,
  deposeRows,
  kickRows,
  nodeOf,
  rowQueue,
  type RowBackend,
  type RowTicket,
} from '../../src/bot/internalSetup/utils/sharedStore';

// L5 run A, chunk ro2: when the row flush wakes for an op on its backoff, how kicks in one turn run it once, and what a
// deposition stops.

let n = 0;
let backendReads = 0;
let sharedTx: ReturnType<typeof vi.fn>;

function workOp(): RowTicket {
  return rowQueue.acceptWork(`ro2w:lines:${++n}`, `/ro2w/${n}.jsonl`, { bytes: 1, spec: () => ({ check: null, statements: () => [] }) });
}

const macrotask = () => new Promise(resolve => setImmediate(resolve));

async function settleTurns(turns = 5) {
  for (let i = 0; i < turns; i++) await macrotask();
}

beforeEach(() => {
  _resetRowQueue();
  backendReads = 0;
  sharedTx = vi.fn(() => new Promise(() => undefined));
  const backend = { sharedTx } as unknown as RowBackend;
  configureRowFlush({ backend: () => { backendReads += 1; return backend; } });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetRowQueue();
  configureRowFlush({ backend: () => null });
});

const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

describe("the flush's wake for an op on its backoff", () => {
  it('an op whose due time moves earlier is tried at the earlier time, not at the first wake', async () => {
    fakeClock();
    const ticket = workOp();
    ticket.op.retryAt = Date.now() + 1000;
    await settleTurns();
    ticket.op.retryAt = Date.now() + 100;
    kickRows();
    await settleTurns();
    expect(sharedTx).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(sharedTx).toHaveBeenCalledTimes(1);
  });

  it('a wake already pending before a later due time is kept and fires at its own time', async () => {
    fakeClock();
    const ticket = workOp();
    ticket.op.retryAt = Date.now() + 100;
    await settleTurns();
    ticket.op.retryAt = Date.now() + 5000;
    kickRows();
    await settleTurns();
    ticket.op.retryAt = Date.now();
    await vi.advanceTimersByTimeAsync(150);
    expect(sharedTx).toHaveBeenCalledTimes(1);
  });

  it('a wake replaced by an earlier one never fires: nothing is tried at the replaced time', async () => {
    fakeClock();
    const ticket = workOp();
    ticket.op.retryAt = Date.now() + 1000;
    await settleTurns();
    ticket.op.retryAt = Date.now() + 100;
    kickRows();
    await settleTurns();
    ticket.op.retryAt = Date.now() + 5000;
    await vi.advanceTimersByTimeAsync(150);
    expect(sharedTx).toHaveBeenCalledTimes(0);
    ticket.op.retryAt = Date.now();
    await vi.advanceTimersByTimeAsync(900);
    expect(sharedTx).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sharedTx).toHaveBeenCalledTimes(1);
  });

  it('the wait for a backoff sets one timer for the time left: the flush does not run again before it', async () => {
    fakeClock();
    const ticket = workOp();
    ticket.op.retryAt = Date.now() + 500;
    await settleTurns();
    const reads = backendReads;
    await vi.advanceTimersByTimeAsync(200);
    await settleTurns();
    expect(backendReads).toBe(reads);
    expect(sharedTx).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(350);
    expect(sharedTx).toHaveBeenCalledTimes(1);
  });

  it('a reset of the row queue stops a pending wake: it does not start a later op early', async () => {
    fakeClock();
    const first = workOp();
    first.op.retryAt = Date.now() + 1000;
    await settleTurns();
    _resetRowQueue();
    const second = workOp();
    second.op.retryAt = Date.now() + 5000;
    await settleTurns();
    second.op.retryAt = Date.now();
    await vi.advanceTimersByTimeAsync(1100);
    expect(sharedTx).toHaveBeenCalledTimes(0);
  });

  it('an op due exactly now is tried at the kick, with no timer', async () => {
    fakeClock();
    const ticket = workOp();
    ticket.op.retryAt = Date.now();
    await settleTurns();
    expect(sharedTx).toHaveBeenCalledTimes(1);
  });
});

describe('the kicks of one turn', () => {
  it('three accepts in one turn run the flush once, and it sends each key once', async () => {
    workOp();
    workOp();
    workOp();
    await settleTurns();
    expect(sharedTx).toHaveBeenCalledTimes(3);
    expect(backendReads).toBe(1);
  });
});

describe('after a deposition', () => {
  it('an op accepted after another process took the data files is never sent', async () => {
    deposeRows('pid 4242 on node-b');
    const ticket = workOp();
    await settleTurns();
    expect(sharedTx).toHaveBeenCalledTimes(0);
    expect(ticket.op.attempts).toBe(0);
  });
});

describe("the writer machine named in a refusal (nodeOf)", () => {
  it('a writer with no process part is the machine itself', () => {
    expect(nodeOf('node-a')).toBe('node-a');
  });

  it('a writer with an empty machine part names no machine', () => {
    expect(nodeOf('/1234')).toBe('');
    expect(nodeOf('node-a/1234')).toBe('node-a');
  });
});

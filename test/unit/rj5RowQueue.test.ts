import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmWrite,
  saveHeldWrites,
  setGuildDataBackend,
  unansweredRowOps,
  unsavedRowPaths,
} from '../../src/bot/internalSetup/utils/dataManager';
import type { DataBackend } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { _resetRowQueue, rowQueue, rowsOnDataPool, type RowOp, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';

// L5 run A, chunk rj5: the row ops the facade counts as unsaved or unanswered (C6), the data pool the row flush sends
// on, the exit drain's wait on a row op on the wire, and a row ticket's confirm at its deadline.

let n = 0;

/** A lines-key op: its attempt lands when the backend answers 'committed', with no mirror write. */
function workOp(): RowTicket {
  const key = `rj5:lines:${++n}`;
  return rowQueue.acceptWork(key, `/rj5/${n}.jsonl`, { bytes: 1, spec: () => ({}) as never });
}

function docOp(state: RowOp['state'], unknown = 0): RowTicket {
  const key = `rj5:doc:${++n}`;
  const ticket = rowQueue.accept(key, `/rj5/${n}.json`, { body: Buffer.from('{}') }, { sha: 'absent', caller: false });
  ticket.op.state = state;
  for (let i = 0; i < unknown; i++) ticket.op.unknown.push({ id: `a${i}`, at: null });
  return ticket;
}

/** A backend whose shared transaction waits until the test answers it. */
function gatedBackend() {
  const answers: Array<(outcome: unknown) => void> = [];
  const sharedTx = vi.fn(() => new Promise(resolve => { answers.push(resolve); }));
  return { backend: { sharedTx } as unknown as DataBackend, sharedTx, answer: (outcome: unknown) => answers.shift()!(outcome) };
}

const macrotask = () => new Promise(resolve => setImmediate(resolve));

async function until(cond: () => boolean, maxTurns = 200) {
  for (let i = 0; i < maxTurns && !cond(); i++) await macrotask();
}

beforeEach(() => {
  _resetRowQueue();
  setGuildDataBackend(null);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setGuildDataBackend(null);
  _resetRowQueue();
});

describe('C6: which row ops count as not saved and as unanswered', () => {
  it('an op queued or on the wire with no attempt of unknown fate is not saved, and is not unanswered', () => {
    const queued = docOp('queued');
    const wire = docOp('wire');
    expect(unsavedRowPaths().sort()).toEqual([queued.op.path, wire.op.path].sort());
    expect(unansweredRowOps()).toBe(0);
  });

  it('an op whose mirror write is pending is in the database: it counts in neither list', () => {
    docOp('mirror');
    docOp('store');
    expect(unsavedRowPaths()).toEqual([]);
    expect(unansweredRowOps()).toBe(0);
  });

  it('a queued op holding an attempt of unknown fate is unanswered, and not counted as not saved', () => {
    docOp('queued', 1);
    expect(unansweredRowOps()).toBe(1);
    expect(unsavedRowPaths()).toEqual([]);
  });

  it('an op on the wire holding an attempt of unknown fate is in neither list while its check runs', () => {
    docOp('wire', 1);
    expect(unansweredRowOps()).toBe(0);
    expect(unsavedRowPaths()).toEqual([]);
  });
});

describe('the drain waits for a row op on the wire and gives up on one that is not', () => {
  it('a queued row op with no data pool: the save gives up after 3 s with nothing landing, and names it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    docOp('queued');
    let held: Awaited<ReturnType<typeof saveHeldWrites>> | null = null;
    void saveHeldWrites(10_000).then(answer => { held = answer; });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(held).not.toBeNull();
    expect(held!.unsavedFiles).toBe(1);
  });

  it('a row op on the wire: the save waits past the give-up window, up to its bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    docOp('wire');
    let held: Awaited<ReturnType<typeof saveHeldWrites>> | null = null;
    void saveHeldWrites(10_000).then(answer => { held = answer; });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(held).toBeNull();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(held).not.toBeNull();
    expect(held!.unsavedFiles).toBe(1);
  });
});

describe('the data pool the row flush sends on', () => {
  it('ops accepted before the backend is wired are sent once it is, with no later write', async () => {
    const ticket = workOp();
    await macrotask();
    const { backend, sharedTx, answer } = gatedBackend();
    setGuildDataBackend(backend);
    await until(() => sharedTx.mock.calls.length > 0, 50);
    expect(sharedTx).toHaveBeenCalledTimes(1);
    answer({ kind: 'committed' });
    expect(await confirmWrite(ticket, 500)).toBe('ok');
    expect(rowQueue.keys()).toEqual([]);
  });

  it('a backend with no shared transactions is not a data pool: nothing is tried, the op stays pending', async () => {
    const ticket = workOp();
    setGuildDataBackend({ kind: 'postgres' } as unknown as DataBackend);
    await macrotask();
    expect(rowsOnDataPool()).toBe(false);
    expect(await confirmWrite(ticket, 50)).toBe('pending');
    expect(ticket.op.triesFailed).toBe(0);
    expect(ticket.op.state).toBe('queued');
  });
});

describe("a row ticket's confirm", () => {
  it('a deadline already reached answers pending at once, not a landing that comes after it', async () => {
    const ticket = workOp();
    const { backend, sharedTx, answer } = gatedBackend();
    setGuildDataBackend(backend);
    await until(() => sharedTx.mock.calls.length > 0, 50);
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const confirm = confirmWrite(ticket, 0);
    answer({ kind: 'committed' });
    expect(await confirm).toBe('pending');
    await until(() => rowQueue.keys().length === 0, 50);
    expect(ticket.op.state).toBe('landed');
  });

  it('a confirm answered by the landing leaves no timer to hold the process for the rest of its deadline', async () => {
    const ticket = workOp();
    const { backend, sharedTx, answer } = gatedBackend();
    setGuildDataBackend(backend);
    await until(() => sharedTx.mock.calls.length > 0, 50);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const confirm = confirmWrite(ticket, 5_000);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    answer({ kind: 'committed' });
    expect(await confirm).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});

import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { getNodeName } from '../../src/bot/internalSetup/fleet/nodeName';
import { truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { openLedger, runInLedger, type WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { _resetRowQueue, rowCommitOwed, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock } from '../helpers/nb10Rig';
import { scriptedBackend } from '../helpers/scriptedPg';
import { lost, pgError, sharedRows } from '../helpers/sharedRows';

// NB6 test 72 (wip-redesign/sheets/NB6.md D1 and cells 449 to 451; part 6): each line of D1's state table, with row
// tickets of the real flush over scripted clients that answer as the shared tables do (helpers/sharedRows.ts), through
// the real confirmWrite, confirmSaved, verdictOf and truthText; then the restart text while the bot stops.

const CATEGORY = 'nb6replies';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);

const LOCK = /pg_advisory_xact_lock/;
const UPSERT = /^INSERT INTO smdb_data\.shared_docs/;
const OPS_READ = 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)';

const PENDING = 'Your change is not confirmed as saved yet. Please check again in a moment.';
const PENDING_IN_FULL = 'Your change is not confirmed as saved in full yet. Please check again in a moment.';
const HELD = 'Your change is not saved yet: storage refused it for now, and the bot keeps retrying. Please check again in a few minutes.';
const HELD_IN_FULL = 'Your change is not saved in full yet: storage refused it for now, and the bot keeps retrying. Please check again in a few minutes.';
const UNAVAILABLE = 'The bot cannot confirm whether your change was saved. Please check before you try again.';
const IO = 'The bot could not write to storage, so your change was not saved. Please try again.';
const WRITER_LOST = "Another process took over the bot's data files, so your change was not saved. Please try again in a moment.";
const RESTARTING = 'The bot is restarting and could not confirm your change was saved; it may be lost. Please check once it is back.';

const OTHER = 6363;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let gates: Array<() => void>;
/** Each key's scripted fault: its attempts' statements are told apart by the client that sent the key's lock. */
let faults: Map<string, (sql: string) => unknown>;

const tick = (ms = 1) => new Promise(resolve => { setTimeout(resolve, ms); });

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

/** A promise the scripted answer waits on until the test (or its cleanup) opens it. */
function gate(): Promise<void> {
  return new Promise<void>(resolve => { gates.push(resolve); });
}

beforeEach(() => {
  gates = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  faults = new Map();
  const clients = new Map<number, string>();
  rows.fault = (sql, params, client) => {
    if (LOCK.test(sql) && !clients.has(client)) clients.set(client, String(params?.[0]));
    const key = clients.get(client);
    return (key === undefined ? undefined : faults.get(key)?.(sql)) as Error | 'lose' | undefined;
  };
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  for (const open of gates) open();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  // A fresh take clears a deposition this process saw; the release leaves no lock file.
  freshWriterLock('webui');
  takeWriterLock();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  vi.restoreAllMocks();
});

interface Written {
  ledger: WriteLedger;
  since: dm.SaveMark;
  ticket: RowTicket;
}

/** A save of name in a ledger of its own, with confirmSaved's mark taken before it. */
function written(name: string, value: unknown, ledger = openLedger('console')): Written {
  const since = dm.saveMark();
  const res = runInLedger(ledger, 'm', () => dm.saveDataTracked(name, opts, value));
  expect(res.outcome).toBe('saved');
  const ticket = (res as { ticket: { kind: string } }).ticket;
  expect(ticket.kind).toBe('row');
  return { ledger, since, ticket: ticket as unknown as RowTicket };
}

/** Lands a first version through the real flush, so its row and mirror are the flush's own. */
async function base(name: string, value: unknown): Promise<void> {
  const { ticket } = written(name, value);
  await dm.flushAll();
  expect(rowTicketState(ticket)).toBe('landed');
}

interface Observed {
  state: string;
  confirm: string;
  saved?: string;
  reply: string;
}

/** What each reader answers for the write: rowTicketState, confirmWrite, confirmSaved and the reply the verdict gives. */
async function observe(w: Written, deadlineMs = 50): Promise<Observed> {
  const confirm = await dm.confirmWrite(w.ticket, deadlineMs);
  const saved = await dm.confirmSaved('global', { since: w.since, deadlineMs, category: CATEGORY });
  const verdict = await verdictOf([w.ledger]);
  const reply = verdict.ok ? 'payload' : truthText(verdict.answer, verdict.partial, verdict.changed);
  return { state: rowTicketState(w.ticket), confirm, saved, reply };
}

/** NB5's hold, started by a silence, confirmed as the chooser would. */
const endHold = () => rig.backend.confirmHold((rig.backend as unknown as { epoch: number }).epoch);

/** Another live bot process takes the lock file over, and this holder's check reads it (NB10 decision 20). */
function deposeNow(): void {
  freshWriterLock('bot', new Set([process.pid, OTHER]));
  expect(takeWriterLock().kind).toBe('taken');
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

/** A try of the op that ends without an outcome before COMMIT was sent (a 57014 at its upsert, each try). */
async function heldBeforeCommit(name: string): Promise<Written> {
  faults.set(keyOf(name), sql => (UPSERT.test(sql) ? pgError('57014', 'canceling statement due to statement timeout') : undefined));
  const w = written(name, { v: 1 });
  await dm.flushAll();
  expect(w.ticket.op.state).toBe('queued');
  expect(w.ticket.op.triesFailed).toBeGreaterThanOrEqual(1);
  expect(w.ticket.op.unknown).toEqual([]);
  return w;
}

/** An op whose COMMIT answer was lost, then a try whose landing check got no answer (cell 449). */
async function unknownThenFailed(name: string): Promise<Written> {
  let commits = 0;
  let checks = 0;
  faults.set(keyOf(name), sql => {
    if (sql === 'COMMIT' && ++commits === 1) return 'lose';
    if (sql === OPS_READ && ++checks === 1) return lost();
    return undefined;
  });
  const w = written(name, { v: 1 });
  await dm.flushAll();
  expect(w.ticket.op.unknown).toHaveLength(1);
  endHold();
  await dm.flushAll();
  expect(w.ticket.op.state).toBe('queued');
  expect(w.ticket.op.triesFailed).toBe(2);
  expect(rowCommitOwed(w.ticket)).toBe(true);
  return w;
}

/**
 * Cells 450 and 451: A's first try ends before COMMIT, so its first confirm answers 'held' at once; B's attempt holds
 * the verdict until A's next attempt is on the wire (held at its lock, or with COMMIT sent), and the re-read follows.
 */
async function reread(phase: 'lock' | 'commit'): Promise<Observed> {
  let second = false;
  const bGate = gate();
  const aGate = gate();
  faults.set(keyOf('b.json'), sql => (LOCK.test(sql) ? bGate : undefined));
  faults.set(keyOf('a.json'), sql => {
    if (!second) return UPSERT.test(sql) ? pgError('57014', 'canceling statement due to statement timeout') : undefined;
    if (phase === 'lock' && LOCK.test(sql)) return aGate;
    if (phase === 'commit' && sql === 'COMMIT') return aGate;
    return undefined;
  });
  const ledger = openLedger('console');
  const a = written('a.json', { v: 'a' }, ledger);
  await until(() => a.ticket.op.triesFailed === 1, 'the first try of a.json');
  const b = written('b.json', { v: 'b' }, ledger);
  await until(() => b.ticket.op.state === 'wire', 'the attempt of b.json');
  const verdict = verdictOf([ledger]);
  await tick(20);
  second = true;
  void dm.flushAll();
  if (phase === 'commit') await until(() => a.ticket.op.commitOnWire, "a.json's COMMIT on the wire");
  else await until(() => a.ticket.op.state === 'wire' && a.ticket.op.attempts >= 2, "a.json's second attempt at its lock");
  gates[0]();
  const answer = await verdict;
  expect(rowTicketState(b.ticket)).toBe('landed');
  const observed = {
    state: rowTicketState(a.ticket),
    confirm: await dm.confirmWrite(a.ticket, 0),
    reply: answer.ok ? 'payload' : truthText(answer.answer, answer.partial, answer.changed),
  };
  gates[1]();
  return observed;
}

const LINES: Array<[string, () => Promise<Observed>, Partial<Observed>]> = [
  ['landed: COMMIT answered', async () => {
    const w = written('l1.json', { v: 1 });
    await dm.flushAll();
    return observe(w);
  }, { state: 'landed', confirm: 'ok', saved: 'ok', reply: 'payload' }],

  ['refused changed-elsewhere: T22 names the machine and the time', async () => {
    await base('l2a.json', { v: 1 });
    rows.clock.now = new Date('2026-11-07T11:30:00.000Z');
    rows.put(keyOf('l2a.json'), text({ v: 'bravo' }));
    const w = written('l2a.json', { v: 2 });
    await dm.flushAll();
    return observe(w);
  }, {
    state: 'refused', confirm: 'refused', saved: 'refused',
    reply: 'This data was changed on BRAVO at 2026-11-07T11:30:00.000Z after your change read it, so your change was not saved. Reload to see the current values, then try again.',
  }],

  ['refused changed-elsewhere by this machine (cell 248)', async () => {
    await base('l2t.json', { v: 1 });
    rows.clock.now = new Date('2026-11-07T11:40:00.000Z');
    rows.put(keyOf('l2t.json'), text({ v: 'other process' }), `${getNodeName()}/p-other`);
    const w = written('l2t.json', { v: 2 });
    await dm.flushAll();
    return observe(w);
  }, {
    state: 'refused', confirm: 'refused', saved: 'refused',
    reply: 'This data was changed on this machine at 2026-11-07T11:40:00.000Z after your change read it, so your change was not saved. Reload to see the current values, then try again.',
  }],

  ['refused changed-elsewhere, the stored row gone: T22\'s deleted form', async () => {
    await base('l2b.json', { v: 1 });
    rows.docs.delete(keyOf('l2b.json'));
    const w = written('l2b.json', { v: 2 });
    await dm.flushAll();
    return observe(w);
  }, {
    state: 'refused', confirm: 'refused', saved: 'refused',
    reply: 'This data was deleted after your change read it, so your change was not saved. Reload to see the current values, then try again.',
  }],

  ['refused io', async () => {
    faults.set(keyOf('l2c.json'), sql => (UPSERT.test(sql) ? pgError('22021') : undefined));
    const w = written('l2c.json', { v: 1 });
    await dm.flushAll();
    return observe(w);
  }, { state: 'refused', confirm: 'refused', saved: 'refused', reply: IO }],

  ['refused writer-lost at a deposition: an op not yet sent', async () => {
    dm.setGuildDataBackend(null);
    const w = written('l2d.json', { v: 1 });
    expect(w.ticket.op.attempts).toBe(0);
    deposeNow();
    return observe(w);
  }, { state: 'refused', confirm: 'refused', saved: 'refused', reply: WRITER_LOST }],

  ['unconfirmed: a deposition\'s op of unknown fate', async () => {
    faults.set(keyOf('l3.json'), sql => (sql === 'COMMIT' ? 'lose' : undefined));
    const w = written('l3.json', { v: 1 });
    await dm.flushAll();
    expect(w.ticket.op.unknown).toHaveLength(1);
    deposeNow();
    return observe(w);
  }, { state: 'unconfirmed', confirm: 'unavailable', saved: 'unavailable', reply: UNAVAILABLE }],

  ['queued or on the wire before COMMIT, no try ended, at the deadline', async () => {
    const wait = gate();
    faults.set(keyOf('l4.json'), sql => (LOCK.test(sql) ? wait : undefined));
    const w = written('l4.json', { v: 1 });
    await until(() => w.ticket.op.state === 'wire', 'the attempt at its lock');
    return observe(w);
  }, { state: 'open', confirm: 'pending', saved: 'pending', reply: PENDING }],

  ['COMMIT on the wire, unanswered at the deadline', async () => {
    const wait = gate();
    faults.set(keyOf('l5.json'), sql => (sql === 'COMMIT' ? wait : undefined));
    const w = written('l5.json', { v: 1 });
    await until(() => w.ticket.op.commitOnWire, 'COMMIT on the wire');
    expect(rowCommitOwed(w.ticket)).toBe(true);
    return observe(w);
  }, { state: 'open', confirm: 'pending', saved: 'pending', reply: PENDING }],

  ['a try ended before COMMIT was sent, no unknown id', async () => observe(await heldBeforeCommit('l6.json')),
    { state: 'open', confirm: 'held', saved: 'held', reply: HELD }],

  ['the same, and at the re-read a new attempt is on the wire before COMMIT (cell 451)', () => reread('lock'),
    { state: 'open', confirm: 'held', reply: HELD_IN_FULL }],

  ['holding an unknown id, whatever its later tries (cell 449)', async () => observe(await unknownThenFailed('l8.json')),
    { state: 'open', confirm: 'pending', saved: 'pending', reply: PENDING }],

  ['first held, and at the re-read its op has COMMIT on the wire: pending, kept (cell 450)', () => reread('commit'),
    { state: 'open', confirm: 'pending', reply: PENDING_IN_FULL }],
];

describe("D1's state table", () => {
  it.each(LINES)('%s', async (_name, run, expected) => {
    expect(await run()).toMatchObject(expected);
  }, 30_000);
});

describe('while the bot stops', () => {
  const signals = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };

  afterAll(() => {
    for (const l of process.listeners('SIGTERM')) if (!signals.term.includes(l)) process.off('SIGTERM', l);
    for (const l of process.listeners('SIGINT')) if (!signals.int.includes(l)) process.off('SIGINT', l);
  });

  it("'held' and 'pending' read the restart text; a refusal keeps its own", async () => {
    faults.set(keyOf('s3.json'), sql => (UPSERT.test(sql) ? pgError('22021') : undefined));
    const io = written('s3.json', { v: 1 });
    await dm.flushAll();
    const held = await heldBeforeCommit('s1.json');
    const pending = await unknownThenFailed('s2.json');
    dm.installStopHandler();
    dm.addStopStep(() => new Promise<void>(() => undefined));
    void dm.beginStop();
    expect(dm.isStopping()).toBe(true);
    expect((await observe(held)).reply).toBe(RESTARTING);
    expect((await observe(pending)).reply).toBe(RESTARTING);
    expect((await observe(io)).reply).toBe(IO);
  }, 30_000);
});

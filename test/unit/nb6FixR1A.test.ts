import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import {
  _resetRowQueue, deposeRows, landStoreDoc, latestRowTicket, reopenRows, rowQueue, rowTicketState, useStoreLanding, type RowTicket,
} from '../../src/bot/internalSetup/utils/sharedStore';
import { readDocRecord, readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { pgError, sha, sharedRows } from '../helpers/sharedRows';

// NB6 code review round 1, fixer 1 (out/NB6/part-rulings.md "Code review round 1"): findings A1 to A4, A6, E3 and E4
// through the real facade and the real flush over scripted clients that answer as the shared tables do
// (helpers/sharedRows.ts). A5's row is nb6OpId.test.ts row 176.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const CATEGORY = 'nb6fixr1a';
const file = (name: string) => dataPath('global', CATEGORY, name);
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const storeFile = (name: string) => dataPath('global', 'appstore', name);
const storeKey = (name: string) => `global/appstore/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);
const UPSERT = /^INSERT INTO smdb_data\.shared_docs \(key, body, sha, rev, updated_by\)/;
const MOVED = (target: string) => new RegExp(`^\\[Shared\\] Moved ${target.replace(/[\\.]/g, m => `\\${m}`)} to .+: it differed from the version this machine last took from the database \\(changed outside the bot, or left by a crash\\); the database's version is back in its place$`);
const STORE_LINE = (target: string, errno: string) =>
  `[Shared] ${target} is stored in the database, but this machine could not write its copy (${errno}); the App Store on this machine shows the previous version until it is written, and it tries again`;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let logs: string[];
let warns: string[];
let errors: string[];

const tick = (ms = 5) => new Promise(resolve => { setTimeout(resolve, ms); });

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

beforeEach(() => {
  logs = [];
  warns = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  _resetRowQueue();
  useStoreLanding(null);
  for (const dir of [dataPath('global', CATEGORY), dataPath('global', 'appstore'), dataPath('_superseded')]) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  dm.setGuildDataBackend(null);
  reopenRows();
  useStoreLanding(null);
  _resetRowQueue();
  await rig.backend.stop();
  vi.restoreAllMocks();
});

function ticketOf(res: unknown): RowTicket {
  const ticket = (res as { ticket?: { kind: string } }).ticket;
  expect(ticket?.kind).toBe('row');
  return ticket as unknown as RowTicket;
}

const save = (name: string, value: unknown) => ticketOf(dm.saveDataTracked(name, opts, value));

function saveStore(name: string, value: unknown): RowTicket {
  const written = dm.writeRawAtomicTracked(storeFile(name), text(value));
  expect(written.accepted).toBe(true);
  return latestRowTicket(storeKey(name))!;
}

/** The temp file writes of target fail with errno (the async write of a doc mirror). */
function failAsyncWrites(target: string, errno: string): { restore: () => void } {
  const real = fs.promises.open.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).startsWith(`${target}.`)) throw Object.assign(new Error(`${errno}: refused`), { code: errno });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.promises.open);
  return { restore: () => spy.mockRestore() };
}

/** The temp file writes of target fail with errno (the synchronous write of an App Store mirror). */
function failSyncWrites(target: string, errno: string): { restore: () => void } {
  const real = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).startsWith(`${target}.`)) throw Object.assign(new Error(`${errno}: refused`), { code: errno });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.openSync);
  return { restore: () => spy.mockRestore() };
}

const storeEntry = (key: string) => {
  const record = readStoreRecord();
  if (!record.ok) throw new Error(record.reason);
  return record.record.docs[key];
};

describe('A1: a mirror path that cannot be read is moved aside before the write', () => {
  it('a doc key whose mirror path became a folder: moved aside with T11 (a), the stored body written, the op out of the queue', async () => {
    const ticket = save('a1.json', { v: 1 });
    fs.mkdirSync(file('a1.json'), { recursive: true });
    await dm.flushAll();
    await until(() => ticket.op.state === 'landed', 'the mirror step', 3000);
    expect(fs.readFileSync(file('a1.json'), 'utf8')).toBe(text({ v: 1 }));
    expect(rowQueue.ops(keyOf('a1.json'))).toEqual([]);
    const record = readDocRecord();
    expect(record.ok && record.record.docs[keyOf('a1.json')]?.sha).toBe(sha(text({ v: 1 })));
    expect(warns.filter(line => MOVED(file('a1.json')).test(line))).toHaveLength(1);
    expect(errors.filter(line => line.includes('could not write'))).toEqual([]);
  });

  it('an App Store key whose mirror path became a folder: moved aside, written, and its entry in the store record', async () => {
    const ticket = saveStore('a1.json', { v: 1 });
    fs.mkdirSync(storeFile('a1.json'), { recursive: true });
    await dm.flushAll();
    await until(() => ticket.op.state === 'landed', 'the landing block', 3000);
    expect(fs.readFileSync(storeFile('a1.json'), 'utf8')).toBe(text({ v: 1 }));
    expect(storeEntry(storeKey('a1.json'))?.sha).toBe(sha(text({ v: 1 })));
    expect(warns.filter(line => MOVED(storeFile('a1.json')).test(line))).toHaveLength(1);
    expect(errors.filter(line => line.includes('could not write'))).toEqual([]);
  });
});

describe('A2: two keys whose mirror steps run together keep both record entries', () => {
  it('each key\'s entry holds its own stored sha', async () => {
    const a = save('a2a.json', { v: 'a' });
    const b = save('a2b.json', { v: 'b' });
    await dm.flushAll();
    await until(() => a.op.state === 'landed' && b.op.state === 'landed', 'both mirror steps');
    const record = readDocRecord();
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.record.docs[keyOf('a2a.json')]?.sha).toBe(sha(text({ v: 'a' })));
    expect(record.record.docs[keyOf('a2b.json')]?.sha).toBe(sha(text({ v: 'b' })));
  });
});

describe('A3: an App Store op stored after a failed try, waiting for the store mutex', () => {
  it("confirmWrite answers 'pending', not 'held'", async () => {
    const holds: Array<(v: null) => void> = [];
    useStoreLanding({ acquire: () => new Promise(resolve => { holds.push(resolve); }), locked: fn => fn() });
    let upserts = 0;
    rows.fault = sql => (UPSERT.test(sql) && ++upserts === 1 ? pgError('57014', 'canceling statement due to statement timeout') : undefined);
    const ticket = saveStore('a3.json', { v: 1 });
    await dm.flushAll();
    expect(ticket.op.triesFailed).toBeGreaterThanOrEqual(1);
    await until(() => ticket.op.state === 'store', 'the stored op');
    expect(rows.docs.get(storeKey('a3.json'))?.body.toString('utf8')).toBe(text({ v: 1 }));
    expect(await dm.confirmWrite(ticket as never, 50)).toBe('pending');
    for (const release of holds) release(null);
  });
});

describe('A4: a deposition ends stored ops landed, without their mirror', () => {
  it('an attempt on the wire whose COMMIT is answered after the deposition lands and leaves the queue', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    rows.fault = sql => (sql === 'COMMIT' ? held.then(() => undefined) : undefined);
    const ticket = save('a4.json', { v: 1 });
    const flushing = dm.flushAll();
    await until(() => rig.sent.some(s => s.sql === 'COMMIT'), 'the COMMIT');
    deposeRows('pid 9');
    release();
    await flushing;
    await until(() => ticket.op.state !== 'wire', 'the attempt');
    expect(rowTicketState(ticket)).toBe('landed');
    expect(ticket.op.state).toBe('landed');
    expect(rowQueue.ops(keyOf('a4.json'))).toEqual([]);
    expect(fs.existsSync(file('a4.json'))).toBe(false);
    reopenRows();
    expect(rowQueue.ops(keyOf('a4.json'))).toEqual([]);
  });

  it('an op whose mirror write is pending at the deposition lands and leaves the queue', async () => {
    const failing = failAsyncWrites(file('a4b.json'), 'EACCES');
    const ticket = save('a4b.json', { v: 1 });
    await dm.flushAll();
    await until(() => errors.some(line => line.includes(file('a4b.json'))), 'the failed mirror write');
    expect(ticket.op.state).toBe('mirror');
    deposeRows('pid 9');
    failing.restore();
    expect(ticket.op.state).toBe('landed');
    expect(rowQueue.ops(keyOf('a4b.json'))).toEqual([]);
  });
});

describe('A6: a delete of a shared key on Postgres', () => {
  it('logs no "Deleted" line at the accept', async () => {
    const first = save('a6.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(first)).toBe('landed');
    logs.length = 0;
    const res = dm.deleteDataTracked('a6.json', opts);
    expect(res.outcome).toBe('deleted');
    expect(logs.filter(line => line.startsWith('[DataManager] Deleted'))).toEqual([]);
  });
});

describe('E3: an owed App Store mirror write after a pass wrote the key', () => {
  it('is dropped: the pass\'s version stays in the mirror and the store record', async () => {
    const key = storeKey('installed.json');
    const target = storeFile('installed.json');
    const v1 = Buffer.from(text({ v: 1 }));
    const v2 = Buffer.from(text({ v: 2 }));
    const failing = failSyncWrites(target, 'ENOSPC');
    landStoreDoc(key, v1, sha(v1), null);
    expect(fs.existsSync(target)).toBe(false);
    failing.restore();
    // The pass's writes for a key with no op of this process (sharedMirror.ts applyStoreKey): the mirror, then the entry.
    atomicWriteFileSync(target, v2);
    const record = readStoreRecord();
    if (!record.ok) throw new Error(record.reason);
    writeStoreRecord({ ...record.record, docs: { ...record.record.docs, [key]: { sha: sha(v2), stamp: null, main: null } } });
    await tick(1200);
    expect(fs.readFileSync(target).equals(v2)).toBe(true);
    expect(storeEntry(key)?.sha).toBe(sha(v2));
  });

  it('is written when no pass wrote the key since', async () => {
    const key = storeKey('installed.json');
    const target = storeFile('installed.json');
    const v1 = Buffer.from(text({ v: 1 }));
    const failing = failSyncWrites(target, 'ENOSPC');
    landStoreDoc(key, v1, sha(v1), null);
    failing.restore();
    await until(() => fs.existsSync(target), 'the retry', 3000);
    expect(fs.readFileSync(target).equals(v1)).toBe(true);
    expect(storeEntry(key)?.sha).toBe(sha(v1));
  });
});

describe("E4: an App Store key's mirror failure line", () => {
  it('the flush\'s landing block logs the store form', async () => {
    const failing = failSyncWrites(storeFile('e4.json'), 'ENOSPC');
    const ticket = saveStore('e4.json', { v: 1 });
    await dm.flushAll();
    await until(() => errors.some(line => line.includes(storeFile('e4.json'))), 'the failed mirror write');
    expect(errors).toContain(STORE_LINE(storeFile('e4.json'), 'ENOSPC'));
    expect(rowTicketState(ticket)).toBe('landed');
    failing.restore();
  });

  it('landStoreDoc logs the store form', () => {
    const target = storeFile('installed.json');
    const failing = failSyncWrites(target, 'ENOSPC');
    landStoreDoc(storeKey('installed.json'), Buffer.from('{}'), sha('{}'), null);
    failing.restore();
    expect(errors).toEqual([STORE_LINE(target, 'ENOSPC')]);
  });
});

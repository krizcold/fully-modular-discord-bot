import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, landStoreDoc, latestRowTicket, reopenRows, useStoreLanding, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, applySharedKeys } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

// NB6 code review round 2, fixer 1 (out/NB6/part-rulings.md "Code review round 2"): R2-A1 (a mirror moved aside whose
// write then fails) and R2-E2 (a pass visit of a store key drops its owed write), through the real facade, the real
// flush and the real pass over scripted clients that answer as the shared tables do (helpers/sharedRows.ts).

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const CATEGORY = 'nb6fixr2a';
const file = (name: string) => dataPath('global', CATEGORY, name);
const storeFile = (name: string) => dataPath('global', 'appstore', name);
const storeKey = (name: string) => `global/appstore/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);
const escape = (s: string) => s.replace(/[\\.()[\]^$*+?{}|]/g, m => `\\${m}`);
const MOVED_FAILED = (target: string, errno: string) => new RegExp(`^\\[Shared\\] Moved ${escape(target)} to (.+): it differed from the version this machine last took from the database \\(changed outside the bot, or left by a crash\\); the database's version could not be written \\(${errno}\\); this machine tries again$`);
const STORE_MOVED_LINE = (target: string, errno: string) =>
  `[Shared] ${target} is stored in the database, but this machine could not write its copy (${errno}); its previous copy was moved aside, and it tries again`;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
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
  warns = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  _resetRowQueue();
  _resetSharedMirror();
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
  _resetSharedMirror();
  await rig.backend.stop();
  vi.restoreAllMocks();
});

function ticketOf(res: unknown): RowTicket {
  const ticket = (res as { ticket?: { kind: string } }).ticket;
  expect(ticket?.kind).toBe('row');
  return ticket as unknown as RowTicket;
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

describe('R2-A1: a mirror moved aside whose write then fails', () => {
  it("a doc key: T11 (a) is logged at once with the write's errno, and the moved copy is where it names", async () => {
    const ticket = ticketOf(dm.saveDataTracked('a.json', opts, { v: 1 }));
    // Changed outside the bot after the accept, before the mirror step.
    fs.mkdirSync(dataPath('global', CATEGORY), { recursive: true });
    fs.writeFileSync(file('a.json'), '{"edited":true}');
    const failing = failAsyncWrites(file('a.json'), 'EACCES');
    await dm.flushAll();
    await until(() => warns.some(line => MOVED_FAILED(file('a.json'), 'EACCES').test(line)), 'the move line');
    const dest = MOVED_FAILED(file('a.json'), 'EACCES').exec(warns.find(line => MOVED_FAILED(file('a.json'), 'EACCES').test(line))!)![1];
    expect(fs.readFileSync(dest, 'utf8')).toBe('{"edited":true}');
    expect(fs.existsSync(file('a.json'))).toBe(false);
    expect(ticket.op.state).toBe('mirror');
    failing.restore();
    await until(() => ticket.op.state === 'landed', 'the retry', 5000);
    expect(fs.readFileSync(file('a.json'), 'utf8')).toBe(text({ v: 1 }));
  });

  it("an App Store key: T11 (a) with the write's errno, and E4's line says the previous copy was moved aside", async () => {
    expect(dm.writeRawAtomicTracked(storeFile('a.json'), text({ v: 1 })).accepted).toBe(true);
    const ticket = latestRowTicket(storeKey('a.json'))!;
    fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
    fs.writeFileSync(storeFile('a.json'), '{"edited":true}');
    const failing = failSyncWrites(storeFile('a.json'), 'ENOSPC');
    await dm.flushAll();
    await until(() => errors.some(line => line.includes(storeFile('a.json'))), 'the failed mirror write');
    expect(warns.filter(line => MOVED_FAILED(storeFile('a.json'), 'ENOSPC').test(line))).toHaveLength(1);
    expect(errors).toContain(STORE_MOVED_LINE(storeFile('a.json'), 'ENOSPC'));
    expect(errors.filter(line => line.includes('shows the previous version'))).toEqual([]);
    expect(fs.existsSync(storeFile('a.json'))).toBe(false);
    failing.restore();
    await until(() => ticket.op.state === 'landed', 'the retry', 5000);
    expect(fs.readFileSync(storeFile('a.json'), 'utf8')).toBe(text({ v: 1 }));
  });
});

describe("R2-E2: a pass visit of a store key drops that key's owed write", () => {
  it('another machine stores bytes equal to the mirror: the pass finds them equal and the owed older write is not made', async () => {
    const key = storeKey('installed.json');
    const target = storeFile('installed.json');
    const v1 = Buffer.from(text({ installed: [] }));
    const v2 = Buffer.from(text({ installed: ['m'] }));
    rows.put(key, v1);
    landStoreDoc(key, v1, sha(v1), null);
    expect(storeEntry(key)?.sha).toBe(sha(v1));
    const failing = failSyncWrites(target, 'ENOSPC');
    rows.put(key, v2);
    landStoreDoc(key, v2, sha(v2), null);
    failing.restore();
    expect(fs.readFileSync(target).equals(v1)).toBe(true);
    // Another machine uninstalls m: its body is byte for byte the first one.
    rows.put(key, v1);
    await applySharedKeys([key]);
    await tick(1500);
    expect(fs.readFileSync(target).equals(v1)).toBe(true);
    expect(storeEntry(key)?.sha).toBe(sha(v1));
  });

  it('a pass that writes the key drops the owed write as well (guard)', async () => {
    const key = storeKey('installed.json');
    const target = storeFile('installed.json');
    const v1 = Buffer.from(text({ installed: [] }));
    const v2 = Buffer.from(text({ installed: ['m'] }));
    const v3 = Buffer.from(text({ installed: ['n'] }));
    rows.put(key, v1);
    landStoreDoc(key, v1, sha(v1), null);
    const failing = failSyncWrites(target, 'ENOSPC');
    landStoreDoc(key, v2, sha(v2), null);
    failing.restore();
    rows.put(key, v3);
    await applySharedKeys([key]);
    expect(fs.readFileSync(target).equals(v3)).toBe(true);
    await tick(1500);
    expect(fs.readFileSync(target).equals(v3)).toBe(true);
    expect(storeEntry(key)?.sha).toBe(sha(v3));
  });
});

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _resetRowQueue, rowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runStoreDocsPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord, storeRecordPath, writeStoreRecord, type DocEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';
import { setView, T11 } from '../helpers/nb6Mirror';
import { sha, sharedRows } from '../helpers/sharedRows';

// The web UI's pass of the App Store docs (NB6 decision 31) with no bot child: rows another machine stored, read on
// the reader pool; the walk of /data/global/appstore, and each key's steps against the store record (applyStoreKey).

const BODY_SQL = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const STORE = dataPath('global', 'appstore');
const REPOS_KEY = 'global/appstore/repos.json';
const REPOS_FILE = path.join(STORE, 'repos.json');

let rows: ReturnType<typeof sharedRows>;
let lines: string[];
let applied: string[];
let beforeBody: ((key: string) => void) | null;
let unhook: () => void;

beforeEach(() => {
  lines = [];
  applied = [];
  beforeBody = null;
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.rmSync(dataPath('rd4-target'), { recursive: true, force: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  rows = sharedRows();
  useWebuiSessions({
    target: async () => ({ entry: 'postgres://nobody@127.0.0.1:9/none', tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      if (text === BODY_SQL) beforeBody?.(String(values[0]));
      const res = await rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:ALPHA',
  });
  unhook = dm.onSharedApplied('global/appstore/', key => { applied.push(key); });
});

afterEach(() => {
  unhook();
  useWebuiSessions(null);
  _resetRowQueue();
  _resetSharedMirror();
  setMainChooser(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

const pass = (locked: <T>(fn: () => T) => T = fn => fn()) => runStoreDocsPass(locked);

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function setStoreEntry(key: string, entry: DocEntry): void {
  writeStoreRecord({ docs: { [key]: entry }, modules: {} });
}

function storeEntry(key: string): DocEntry | undefined {
  const record = readStoreRecord();
  if (!record.ok) throw new Error(record.reason);
  return record.record.docs[key];
}

/** Every file moved aside so far, by its path below _superseded/shared-<ms>, with its bytes. */
function superseded(): Record<string, string> {
  const out: Record<string, string> = {};
  const root = dataPath('_superseded');
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(root, abs).split(path.sep).slice(1).join('/')] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

describe('the walk of /data/global/appstore', () => {
  it('a store doc with no row and no entry is moved aside and its move logged', async () => {
    const file = path.join(STORE, 'orphan.json');
    write(file, 'left here');
    expect(await pass()).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(superseded()).toEqual({ 'global/appstore/orphan.json': 'left here' });
    expect(lines.some(l => l.startsWith(`[Shared] Moved ${file} to `) && l.endsWith(T11.noRow))).toBe(true);
    expect(applied).toEqual(['global/appstore/orphan.json']);
  });

  it('a store doc in a folder below the App Store folder is found and moved aside', async () => {
    const file = path.join(STORE, 'sub', 'deep.json');
    write(file, 'deep bytes');
    expect(await pass()).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(superseded()).toEqual({ 'global/appstore/sub/deep.json': 'deep bytes' });
    expect(applied).toEqual(['global/appstore/sub/deep.json']);
  });

  it('a temp file of a write is left as it is', async () => {
    const file = path.join(STORE, 'repos.json.tmp');
    write(file, 'half written');
    expect(await pass()).toEqual({ ok: true });
    expect(read(file)).toBe('half written');
    expect(superseded()).toEqual({});
    expect(applied).toEqual([]);
    expect(fs.existsSync(storeRecordPath())).toBe(false);
  });

  it('an App Store folder that is a link to another folder is walked', async () => {
    const target = dataPath('rd4-target');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'linked.json'), 'linked bytes');
    fs.mkdirSync(dataPath('global'), { recursive: true });
    fs.symlinkSync(target, STORE, 'junction');
    try {
      expect(await pass()).toEqual({ ok: true });
      expect(fs.existsSync(path.join(target, 'linked.json'))).toBe(false);
      expect(superseded()).toEqual({ 'global/appstore/linked.json': 'linked bytes' });
      expect(applied).toEqual(['global/appstore/linked.json']);
    } finally {
      fs.unlinkSync(STORE);
    }
  });
});

describe('one App Store key against the store record', () => {
  it('an op of this process queued while the row was read leaves the key to the op', async () => {
    rows.put(REPOS_KEY, 'v2');
    let queued = false;
    const real = rowQueue.ops.bind(rowQueue);
    vi.spyOn(rowQueue, 'ops').mockImplementation(key => (queued && key === REPOS_KEY ? [{} as never] : real(key)));
    expect(await pass(fn => { queued = true; return fn(); })).toEqual({ ok: true });
    expect(read(REPOS_FILE)).toBe(null);
    expect(applied).toEqual([]);
    expect(fs.existsSync(storeRecordPath())).toBe(false);
  });

  it('a store record that cannot be parsed is logged and nothing is written', async () => {
    write(storeRecordPath(), 'not json');
    rows.put(REPOS_KEY, 'v1');
    expect(await pass()).toEqual({ ok: true });
    const line = lines.find(l => l.startsWith('[Shared] Did not bring the shared files up to date: '));
    expect(line).toBeDefined();
    expect(line).toContain(storeRecordPath());
    expect(line!.endsWith('; the next pass tries again')).toBe(true);
    expect(read(REPOS_FILE)).toBe(null);
    expect(read(storeRecordPath())).toBe('not json');
    expect(applied).toEqual([]);
  });

  it('a mirror that cannot be read is logged as unreadable and left as it is', async () => {
    fs.mkdirSync(REPOS_FILE, { recursive: true });
    rows.put(REPOS_KEY, 'v1');
    expect(await pass()).toEqual({ ok: true });
    expect(lines.filter(l => l.startsWith('[Shared] Could not write '))).toEqual([`[Shared] Could not write ${REPOS_FILE} (unreadable); retrying`]);
    expect(fs.statSync(REPOS_FILE).isDirectory()).toBe(true);
    expect(superseded()).toEqual({});
    expect(applied).toEqual([]);
    expect(fs.existsSync(storeRecordPath())).toBe(false);
  });

  it('an entry whose row and mirror are both gone is dropped', async () => {
    setStoreEntry(REPOS_KEY, { sha: sha('old'), stamp: null, main: '1:ALPHA' });
    expect(await pass()).toEqual({ ok: true });
    expect(readStoreRecord()).toEqual({ ok: true, record: { docs: {}, modules: {} } });
    expect(lines).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('a row deleted between the listing and its read, with no mirror and no entry, writes no record', async () => {
    rows.put(REPOS_KEY, 'v1');
    beforeBody = key => { rows.docs.delete(key); };
    expect(await pass()).toEqual({ ok: true });
    expect(fs.existsSync(storeRecordPath())).toBe(false);
    expect(read(REPOS_FILE)).toBe(null);
    expect(lines).toEqual([]);
  });

  it('a mirror equal to the row with a current entry leaves the record bytes as they are', async () => {
    rows.put(REPOS_KEY, 'v1');
    write(REPOS_FILE, 'v1');
    setStoreEntry(REPOS_KEY, { sha: sha('v1'), stamp: 'kept-stamp', main: '1:ALPHA' });
    const before = fs.readFileSync(storeRecordPath(), 'utf8');
    expect(await pass()).toEqual({ ok: true });
    expect(fs.readFileSync(storeRecordPath(), 'utf8')).toBe(before);
    expect(read(REPOS_FILE)).toBe('v1');
    expect(applied).toEqual([]);
  });

  it('a mirror equal to the row with an entry from an older main gets the entry of the current main', async () => {
    rows.put(REPOS_KEY, 'v1');
    write(REPOS_FILE, 'v1');
    setStoreEntry(REPOS_KEY, { sha: sha('v1'), stamp: 'old-stamp', main: '0:OLD' });
    expect(await pass()).toEqual({ ok: true });
    expect(storeEntry(REPOS_KEY)).toEqual({ sha: sha('v1'), stamp: null, main: '1:ALPHA' });
    expect(read(REPOS_FILE)).toBe('v1');
    expect(applied).toEqual([]);
  });

  it('a mirror changed after the pass compared it is left for the next pass', async () => {
    rows.put(REPOS_KEY, 'v1');
    write(REPOS_FILE, 'v1');
    setStoreEntry(REPOS_KEY, { sha: sha('v1'), stamp: null, main: '1:ALPHA' });
    expect(await pass(fn => { fs.writeFileSync(REPOS_FILE, 'edited'); return fn(); })).toEqual({ ok: true });
    expect(read(REPOS_FILE)).toBe('edited');
    expect(superseded()).toEqual({});
    expect(storeEntry(REPOS_KEY)).toEqual({ sha: sha('v1'), stamp: null, main: '1:ALPHA' });
    expect(applied).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('a mirror deleted by hand gets the row back with no move', async () => {
    rows.put(REPOS_KEY, 'v2');
    setStoreEntry(REPOS_KEY, { sha: sha('v1'), stamp: null, main: '1:ALPHA' });
    expect(await pass()).toEqual({ ok: true });
    expect(read(REPOS_FILE)).toBe('v2');
    expect(storeEntry(REPOS_KEY)).toEqual({ sha: sha('v2'), stamp: null, main: '1:ALPHA' });
    expect(superseded()).toEqual({});
    expect(lines).toEqual([]);
    expect(applied).toEqual([REPOS_KEY]);
  });

  it('a mirror taken from the main before a switch is moved aside before the new row is written', async () => {
    rows.put(REPOS_KEY, 'v2');
    write(REPOS_FILE, 'v1');
    setStoreEntry(REPOS_KEY, { sha: sha('v1'), stamp: null, main: '0:OLD' });
    expect(await pass()).toEqual({ ok: true });
    expect(read(REPOS_FILE)).toBe('v2');
    expect(superseded()).toEqual({ 'global/appstore/repos.json': 'v1' });
    const moved = lines.filter(l => l.startsWith(`[Shared] Moved ${REPOS_FILE} to `));
    expect(moved).toHaveLength(1);
    const dest = moved[0].slice(`[Shared] Moved ${REPOS_FILE} to `.length, moved[0].indexOf(': it '));
    expect(moved[0]).toBe(T11.b(REPOS_FILE, dest, 'ALPHA', 1) + T11.written);
    expect(storeEntry(REPOS_KEY)).toEqual({ sha: sha('v2'), stamp: null, main: '1:ALPHA' });
  });
});

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clock = vi.hoisted(() => ({ queue: [] as bigint[] }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => {
  const real = await importOriginal<any>();
  return { ...real, monoNow: () => clock.queue.shift() ?? real.monoNow() };
});

import {
  enqueueAppend,
  fileTicket,
  fileTicketState,
  flushAll,
  forgetDurableFiles,
  fsyncDataDirs,
  type FileTicket,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { deleteGuildNamespace, restoreGuildFromGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite, type GuildDataWriteRequest } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// NB13F (out/NB13F/design.md): a move between /data and /data/_graveyard whose directory fsync fails is answered with
// the errno, the guild's durable names are forgotten, and the next append runs the directory chain again.

const GRAVEYARD = path.join(DATA_ROOT, '_graveyard');
const L = (i: number) => `{"line":${i}}\n`;

let errors: string[];
let warns: string[];

function quietConsole() {
  errors = [];
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
  setBackendKind(null);
});

type Rules = { open?: string; sync?: string; close?: string };
type Handle = { dir: string; flags: unknown; sync: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const fail = (code: string) => (code === 'none' ? undefined : Object.assign(new Error(code), { code }));

function fakeOpen(rules: { data?: Rules; graveyard?: Rules } = {}): Handle[] {
  const handles: Handle[] = [];
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any) => {
    const dir = path.resolve(String(p));
    const rule = (dir === path.resolve(DATA_ROOT) ? rules.data : dir === path.resolve(DATA_ROOT, '_graveyard') ? rules.graveyard : undefined) ?? {};
    if (rule.open) throw fail(rule.open);
    const handle = {
      dir,
      flags,
      sync: vi.fn(async () => { if (rule.sync) throw fail(rule.sync); }),
      close: vi.fn(async () => { if (rule.close) throw fail(rule.close); }),
    };
    handles.push(handle);
    return handle;
  }) as any);
  return handles;
}

const once = (h: Handle | undefined) => {
  expect(h?.sync).toHaveBeenCalledTimes(1);
  expect(h?.close).toHaveBeenCalledTimes(1);
};
const handleOf = (handles: Handle[], dir: string) => handles.find(h => h.dir === path.resolve(dir));

describe.skipIf(process.platform === 'win32')('fsyncDataDirs answers a failed directory fsync', () => {
  beforeEach(() => quietConsole());

  it('A1: both folders sync: answers not failed, each opened read-only, synced and closed once', async () => {
    const handles = fakeOpen();
    expect(await fsyncDataDirs()).toEqual({ failed: false });
    expect(handles.map(h => [h.dir, h.flags])).toEqual([
      [path.resolve(DATA_ROOT), 'r'],
      [path.resolve(DATA_ROOT, '_graveyard'), 'r'],
    ]);
    for (const h of handles) once(h);
  });

  it.each(['EIO', 'ENOSPC', 'EROFS', 'none'])('A2: a sync rejecting %s answers the folder and the code, and the other folder is still synced', async code => {
    const expected = code === 'none' ? 'EIO' : code;
    let handles = fakeOpen({ data: { sync: code } });
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: DATA_ROOT, code: expected });
    expect(handleOf(handles, DATA_ROOT)?.close).toHaveBeenCalledTimes(1);
    once(handleOf(handles, GRAVEYARD));
    vi.restoreAllMocks();
    quietConsole();
    handles = fakeOpen({ graveyard: { sync: code } });
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: GRAVEYARD, code: expected });
    once(handleOf(handles, DATA_ROOT));
    expect(handleOf(handles, GRAVEYARD)?.close).toHaveBeenCalledTimes(1);
  });

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])('A3: an unsupported sync (%s) answers not failed and logs nothing', async code => {
    for (const rules of [{ data: { sync: code } }, { graveyard: { sync: code } }]) {
      const handles = fakeOpen(rules);
      expect(await fsyncDataDirs()).toEqual({ failed: false });
      expect(handles).toHaveLength(2);
      for (const h of handles) expect(h.close).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
      vi.restoreAllMocks();
      quietConsole();
    }
  });

  it.each(['EACCES', 'EPERM', 'EISDIR'])('A4: an open refused with %s is passed over and the other folder is synced', async code => {
    let handles = fakeOpen({ data: { open: code } });
    expect(await fsyncDataDirs()).toEqual({ failed: false });
    expect(handles.map(h => h.dir)).toEqual([path.resolve(GRAVEYARD)]);
    once(handles[0]);
    vi.restoreAllMocks();
    quietConsole();
    handles = fakeOpen({ graveyard: { open: code } });
    expect(await fsyncDataDirs()).toEqual({ failed: false });
    expect(handles.map(h => h.dir)).toEqual([path.resolve(DATA_ROOT)]);
    once(handles[0]);
  });

  it('A5: a missing graveyard and an open of /data rejecting EIO are failures', async () => {
    let handles = fakeOpen({ graveyard: { open: 'ENOENT' } });
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: GRAVEYARD, code: 'ENOENT' });
    expect(handles.map(h => h.dir)).toEqual([path.resolve(DATA_ROOT)]);
    once(handles[0]);
    vi.restoreAllMocks();
    quietConsole();
    handles = fakeOpen({ data: { open: 'EIO' } });
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: DATA_ROOT, code: 'EIO' });
    expect(handles.map(h => h.dir)).toEqual([path.resolve(GRAVEYARD)]);
    once(handles[0]);
  });

  it('A6: both syncs failing answers the first', async () => {
    const handles = fakeOpen({ data: { sync: 'EIO' }, graveyard: { sync: 'ENOSPC' } });
    expect(await fsyncDataDirs()).toEqual({ failed: true, dir: DATA_ROOT, code: 'EIO' });
    for (const h of handles) expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('A7: a close error after a good sync is logged and changes no answer', async () => {
    const handles = fakeOpen({ data: { close: 'EBADF' } });
    expect(await fsyncDataDirs()).toEqual({ failed: false });
    expect(errors).toEqual([`[Data] ${DATA_ROOT}: the directory could not be closed after its sync (EBADF); this does not change whether the sync succeeded`]);
    once(handleOf(handles, GRAVEYARD));
  });
});

let guilds = 880_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const chainOf = (p: string) => {
  const dirs: string[] = [];
  for (let d = path.dirname(p); ; d = path.dirname(d)) {
    dirs.push(d);
    if (path.resolve(d) === path.resolve(DATA_ROOT)) break;
  }
  return dirs;
};

function append(p: string, text: string): FileTicket {
  enqueueAppend(p, text);
  return fileTicket(p);
}

describe.skipIf(process.platform === 'win32')('a move whose directory fsync failed, then the next append', () => {
  let stub: AppendStub;
  const synced = () => [...stub.dirSyncs];

  beforeEach(() => {
    setBackendKind('file');
    quietConsole();
    stub = stubAppendHandles();
    forgetDurableFiles();
  });
  afterEach(() => stub.restore());

  /** A file of g whose append ran the chain, then g deleted with real fsyncs: the record names the moved file. */
  async function start(g: string): Promise<string> {
    const p = dataPath(g, 'm', 's.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    append(p, L(1));
    await flushAll();
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: true });
    return p;
  }

  const restoredLine = (g: string, dir: string, code: string) => (e: string) =>
    e.startsWith(`[DataManager] Guild ${g} restored from graveyard entry `)
    && e.endsWith(`, but the disk did not confirm the sync of ${dir} (${code}), so a power cut can put the folder back in the graveyard`);

  it.each([
    ['B1: the sync of /data', DATA_ROOT],
    ['B2: the sync of the graveyard', GRAVEYARD],
  ])('%s fails on a restore: the answer names it, a line is logged and the next append runs the chain', async (_name, dir) => {
    const g = freshGuild();
    const p = await start(g);
    stub.failDirSync(dir, 'EIO');
    expect(await restoreGuildFromGraveyard(g)).toMatchObject({ ok: true, reason: 'test', moveUnconfirmed: 'EIO' });
    expect(errors).toHaveLength(1);
    expect(restoredLine(g, dir, 'EIO')(errors[0])).toBe(true);
    stub.dirSyncs.length = 0;
    const t = append(p, L(2));
    await flushAll();
    expect(synced()).toEqual(chainOf(p));
    expect(fileTicketState(t)).toBe('landed');
    expect(fs.readFileSync(p, 'utf8')).toBe(L(1) + L(2));
  });

  it('B3: a restore whose fsyncs succeed answers as before and the next append skips the chain', async () => {
    const g = freshGuild();
    const p = await start(g);
    const answer = await restoreGuildFromGraveyard(g);
    expect(answer).toMatchObject({ ok: true });
    expect(answer).not.toHaveProperty('moveUnconfirmed');
    expect(errors).toEqual([]);
    const retiredAt = (answer as { retiredAt: number }).retiredAt;
    expect(warns.filter(w => w === `[DataManager] Guild ${g} restored from graveyard entry ${g}-${retiredAt}`)).toHaveLength(1);
    stub.dirSyncs.length = 0;
    const t = append(p, L(2));
    await flushAll();
    expect(synced()).toEqual([]);
    expect(fileTicketState(t)).toBe('landed');
  });

  it('B4: an unsupported sync (EINVAL) on a restore forgets nothing', async () => {
    const g = freshGuild();
    const p = await start(g);
    stub.failDirSync(DATA_ROOT, 'EINVAL');
    const answer = await restoreGuildFromGraveyard(g);
    expect(answer).toMatchObject({ ok: true });
    expect(answer).not.toHaveProperty('moveUnconfirmed');
    expect(errors).toEqual([]);
    stub.dirSyncs.length = 0;
    append(p, L(2));
    await flushAll();
    expect(synced()).toEqual([]);
  });

  it('B5: only the moved guild is forgotten, not one whose id starts with it', async () => {
    const g = freshGuild();
    const h = `${g}7`;
    const q = dataPath(h, 'm', 's.jsonl');
    fs.mkdirSync(path.dirname(q), { recursive: true });
    append(q, L(1));
    await flushAll();
    const p = await start(g);
    stub.failDirSync(DATA_ROOT, 'EIO');
    expect(await restoreGuildFromGraveyard(g)).toMatchObject({ ok: true });
    stub.dirSyncs.length = 0;
    append(q, L(2));
    await flushAll();
    expect(synced()).toEqual([]);
    stub.dirSyncs.length = 0;
    append(p, L(2));
    await flushAll();
    expect(synced()).toEqual(chainOf(p));
  });

  it('B6: a delete whose fsync of /data fails answers it, logs it, and a later restore\'s append runs the chain', async () => {
    const g = freshGuild();
    const p = dataPath(g, 'm', 's.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    append(p, L(1));
    await flushAll();
    stub.failDirSync(DATA_ROOT, 'EIO');
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: true, moveUnconfirmed: 'EIO' });
    expect(errors).toEqual([`[DataManager] Guild ${g} moved to graveyard, but the disk did not confirm the sync of ${DATA_ROOT} (EIO), so a power cut can bring its folder back live`]);
    const restored = await restoreGuildFromGraveyard(g);
    expect(restored).toMatchObject({ ok: true });
    expect(restored).not.toHaveProperty('moveUnconfirmed');
    stub.dirSyncs.length = 0;
    append(p, L(2));
    await flushAll();
    expect(synced()).toEqual(chainOf(p));
  });
});

const entryDir = (g: string, ms: number) => dataPath('_graveyard', `${g}-${ms}`);
function bury(g: string, ms: number): void {
  const dir = entryDir(g, ms);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":5}');
  fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }, null, 2));
}
const restoreReq = (g: string, extra: Partial<GuildDataWriteRequest> = {}): GuildDataWriteRequest =>
  ({ guildId: g, module: '', filename: '', op: 'restore-graveyard', ...extra });
const deleteReq = (g: string): GuildDataWriteRequest => ({ guildId: g, module: '', filename: '', op: 'delete-namespace' });

describe.skipIf(process.platform === 'win32')('the operator restore and delete answers', () => {
  let stub: AppendStub;

  beforeEach(() => {
    setBackendKind('file');
    quietConsole();
    stub = stubAppendHandles();
    forgetDurableFiles();
  });
  afterEach(() => stub.restore());

  it('C1: a failed fsync names its errno in the restore and the delete answers', async () => {
    const g = freshGuild();
    bury(g, 2000);
    stub.failDirSync(DATA_ROOT, 'EIO');
    expect(await applyOperatorDataWrite(restoreReq(g))).toStrictEqual({ ok: true, retiredAt: 2000, reason: 'webui-operator-delete', moveUnconfirmed: 'EIO' });
    stub.failDirSync(DATA_ROOT, 'ENOSPC');
    expect(await applyOperatorDataWrite(deleteReq(g))).toStrictEqual({ ok: true, moveUnconfirmed: 'ENOSPC' });
  });

  it('C2: fsyncs that succeed answer as before, with no new key', async () => {
    const g = freshGuild();
    bury(g, 2000);
    expect(await applyOperatorDataWrite(restoreReq(g))).toStrictEqual({ ok: true, retiredAt: 2000, reason: 'webui-operator-delete' });
    expect(await applyOperatorDataWrite(deleteReq(g))).toStrictEqual({ ok: true });
  });
});

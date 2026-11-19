import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 7 (decisions 4, 6, 17, 20, 22, 35, 39 to 42, 52, 53; C20, I1, N5, N6): the take in the bot process.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  syncFolder: null as null | ((dir: string) => Promise<unknown> | null),
  syncFolderSync: null as null | ((dir: string) => unknown | null),
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const nodePath = await import('path');
  return {
    ...real,
    syncFolder: (dir: string) => {
      h.calls.push(`sync ${nodePath.resolve(dir)}`);
      return h.syncFolder?.(dir) ?? real.syncFolder(dir);
    },
    syncFolderSync: (dir: string) => h.syncFolderSync?.(dir) ?? real.syncFolderSync(dir),
  };
});

import { dataPath } from '../../src/utils/dataRoot';

const alive = new Set<number>();
const starts = new Map<number, string>();
const seams = {
  pid: () => process.pid,
  alive: (pid: number) => pid === process.pid || alive.has(pid),
  startOf: (pid: number) => starts.get(pid) ?? `start-${pid}`,
  now: () => Date.now(),
};

const FIXTURE: Record<string, string> = {
  '123/mod/a.json': '{"a":1}',
  '123/b.json': '{"b":1}',
  '456/x.json': '{"x":1}',
  '_graveyard/789-1/y.json': '{"y":1}',
  '_graveyard/.sweep-789-2/z.json': '{"z":1}',
  'global/mod/g.json': '{"g":1}',
  'global/appstore/s.json': '{}',
  'owner-channel.json': '{"o":1}',
  '.env': 'X=1',
  'maintenance.json': '{}',
};
const IN_SET = ['123/b.json', '123/mod/a.json', '456/x.json', '_graveyard/789-1/y.json', 'global/mod/g.json', 'owner-channel.json'];

const abs = (rel: string) => dataPath(...rel.split('/'));
const snaps = () => dataPath('_snapshots');
const HOUR = Date.UTC(2026, 10, 13, 4);
let hour = 0;
const nextName = () => `hourly-${new Date(HOUR + ++hour * 3600_000).toISOString().replace(/[:.]/g, '-')}`;
const workFolders = () => (fs.existsSync(snaps()) ? fs.readdirSync(snaps()).filter(n => n.startsWith('.taking-')) : []);
const err = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });

function writeFixture(files: Record<string, string> = FIXTURE): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  }
}

const locks: Array<{ writerLockDepth(): number; releaseWriterLock(): void }> = [];

async function load(opts: Record<string, unknown> = {}) {
  vi.resetModules();
  const lock = await import('../../src/bot/internalSetup/utils/writerLock');
  fs.rmSync(lock.writerLockPath(), { force: true });
  lock.configureWriterLock('bot', seams);
  const taken = lock.takeWriterLock().kind;
  locks.push(lock);
  const take = await import('../../src/bot/internalSetup/utils/backups/snapshotTake');
  take._setTakeTimingForTests({ pollMs: 5, ...opts }, seams);
  const fb = await import('../../src/bot/internalSetup/utils/dataBackends/fileBackend');
  const chain = await import('../../src/bot/internalSetup/utils/folderChain');
  const verify = await import('../../src/bot/internalSetup/utils/backups/snapshotVerify');
  const list = await import('../../src/bot/internalSetup/utils/backups/snapshotList');
  return { lock, take, fb, chain, verify, list, taken };
}

async function complete(m: Awaited<ReturnType<typeof load>>, name: string) {
  const entry = m.list.readSnapshot(name);
  if (entry.state !== 'complete') throw new Error(`not complete: ${JSON.stringify(entry)}`);
  const verdict = await m.verify.verifyTree(path.join(snaps(), name, 'data'), entry.manifest);
  return { manifest: entry.manifest, verdict, read: (rel: string) => fs.readFileSync(path.join(snaps(), name, 'data', ...rel.split('/')), 'utf8') };
}

beforeEach(() => {
  for (const n of fs.readdirSync(dataPath())) fs.rmSync(dataPath(n), { recursive: true, force: true });
  h.calls.length = 0;
  h.syncFolder = null;
  h.syncFolderSync = null;
  alive.clear();
  starts.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const lock of locks.splice(0)) while (lock.writerLockDepth() > 0) lock.releaseWriterLock();
});

const realOpen = fs.promises.open.bind(fs.promises);
const realLstat = fs.promises.lstat.bind(fs.promises);
const realReadFileSync = fs.readFileSync;
const same = (p: unknown, rel: string) => path.resolve(String(p)) === path.resolve(abs(rel));

describe('a take of a fixture', () => {
  it('copies exactly the set, with the manifest counts and hashes verifyTree checks', async () => {
    writeFixture();
    const m = await load();
    const name = nextName();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await complete(m, name);
    expect(m.taken).toBe('taken');
    expect(answer).toEqual({ ok: true, name, counts: got.manifest.counts, linked: 0 });
    expect(got.verdict).toEqual({ ok: true });
    expect(got.manifest.files.map(f => f.path)).toEqual(IN_SET);
    expect(got.manifest.counts).toEqual({ files: 6, bytes: IN_SET.reduce((s, r) => s + FIXTURE[r].length, 0), dirs: 7, guilds: 2, graveyardEntries: 1 });
    expect(got.manifest.dirs).toEqual(['123', '123/mod', '456', '_graveyard', '_graveyard/789-1', 'global', 'global/mod']);
    expect(got.manifest.kind).toBe('hourly');
    expect(workFolders()).toEqual([]);
  });

  it('an unchanged file shares the previous snapshot inode, a changed one does not', async () => {
    writeFixture();
    const m = await load();
    const first = nextName();
    await m.take.takeSnapshot({ name: first, kind: 'hourly' });
    fs.writeFileSync(abs('456/x.json'), '{"x":22}');
    const second = nextName();
    const answer = await m.take.takeSnapshot({ name: second, kind: 'hourly' });
    const ino = (name: string, rel: string) => fs.statSync(path.join(snaps(), name, 'data', ...rel.split('/'))).ino;
    const got = await complete(m, second);
    expect(answer).toMatchObject({ ok: true, linked: 5 });
    expect(got.verdict).toEqual({ ok: true });
    expect(ino(second, '123/b.json')).toBe(ino(first, '123/b.json'));
    expect(ino(second, '456/x.json')).not.toBe(ino(first, '456/x.json'));
    expect(got.read('456/x.json')).toBe('{"x":22}');
  });

  it('a link that throws EPERM copies the file', async () => {
    writeFixture();
    const m = await load();
    const first = nextName();
    await m.take.takeSnapshot({ name: first, kind: 'hourly' });
    vi.spyOn(fs.promises, 'link').mockRejectedValue(err('EPERM'));
    const second = nextName();
    const answer = await m.take.takeSnapshot({ name: second, kind: 'hourly' });
    const got = await complete(m, second);
    const ino = (name: string) => fs.statSync(path.join(snaps(), name, 'data', '123', 'b.json')).ino;
    expect(answer).toMatchObject({ ok: true, linked: 0 });
    expect(got.verdict).toEqual({ ok: true });
    expect(ino(second)).not.toBe(ino(first));
  });

  it('a recopy of a file linked from the previous snapshot leaves that snapshot unchanged', async () => {
    writeFixture();
    const m = await load();
    const first = nextName();
    await m.take.takeSnapshot({ name: first, kind: 'hourly' });
    const before = fs.statSync(path.join(snaps(), first, 'data', '123', 'b.json'));
    let wrote = false;
    const realLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (from: any, to: any) => {
      if (!wrote && String(from).endsWith(path.join('456', 'x.json'))) {
        wrote = true;
        m.fb.enqueueWrite(abs('123/b.json'), '{"b":"recopied"}');
        await m.fb.flushAll();
      }
      return realLink(from, to);
    });
    const second = nextName();
    await m.take.takeSnapshot({ name: second, kind: 'hourly' });
    const old = await complete(m, first);
    const after = fs.statSync(path.join(snaps(), first, 'data', '123', 'b.json'));
    expect(old.verdict).toEqual({ ok: true });
    expect(old.read('123/b.json')).toBe('{"b":1}');
    expect(after.ino).toBe(before.ino);
    expect((await complete(m, second)).read('123/b.json')).toBe('{"b":"recopied"}');
  });
});

describe('what the walk meets', () => {
  it('an entry that is neither a file nor a folder fails naming it and leaves no folder', async () => {
    writeFixture();
    const m = await load();
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p: any, ...rest: any[]) => {
      if (same(p, '456/x.json')) return { isFile: () => false, isDirectory: () => false } as fs.Stats;
      return realLstat(p, ...rest);
    });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, error: '/data/456/x.json is neither a file nor a folder, so the backup cannot copy it; the backup was not kept.' });
    expect(workFolders()).toEqual([]);
  });

  it('an unreadable file fails naming it and leaves no folder', async () => {
    writeFixture();
    const m = await load();
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
      if (same(p, '456/x.json')) throw err('EACCES');
      return realOpen(p, ...rest);
    });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, error: 'Could not read /data/456/x.json (EACCES); the backup was not kept.' });
    expect(workFolders()).toEqual([]);
  });

  it('a file deleted between its listing and its lstat is left out and the take completes', async () => {
    writeFixture();
    const m = await load();
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p: any, ...rest: any[]) => {
      if (same(p, '456/x.json')) fs.rmSync(abs('456/x.json'), { force: true });
      return realLstat(p, ...rest);
    });
    const name = nextName();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await complete(m, name);
    expect(answer).toMatchObject({ ok: true });
    expect(got.verdict).toEqual({ ok: true });
    expect(got.manifest.files.map(f => f.path)).toEqual(IN_SET.filter(r => r !== '456/x.json'));
  });
});

describe('writes during the take', () => {
  it('a file changed after its copy, a file added and a file removed are right in the snapshot', async () => {
    writeFixture();
    const m = await load();
    let wrote = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
      if (!wrote && same(p, '456/x.json')) {
        wrote = true;
        m.fb.enqueueWrite(abs('123/b.json'), '{"b":2}');
        m.fb.enqueueWrite(abs('123/new.json'), '{"new":1}');
        m.fb.enqueueDelete(abs('123/mod/a.json'));
        await m.fb.flushAll();
      }
      return realOpen(p, ...rest);
    });
    const name = nextName();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await complete(m, name);
    expect(answer).toMatchObject({ ok: true });
    expect(got.verdict).toEqual({ ok: true });
    expect(got.read('123/b.json')).toBe('{"b":2}');
    expect(got.read('123/new.json')).toBe('{"new":1}');
    expect(got.manifest.files.map(f => f.path)).not.toContain('123/mod/a.json');
  });

  it('a removal the turn finds removes its emptied staging folders below the unit and keeps the unit', async () => {
    writeFixture();
    const m = await load({
      beforeTurn: once(async () => {
        m.fb.enqueueDelete(abs('123/mod/a.json'));
        await m.fb.flushAll();
      }),
    });
    const name = nextName();
    await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await complete(m, name);
    expect(got.verdict).toEqual({ ok: true });
    expect(got.manifest.dirs).toContain('123');
    expect(got.manifest.dirs).not.toContain('123/mod');
    expect(fs.existsSync(path.join(snaps(), name, 'data', '123', 'mod'))).toBe(false);
  });

  it('after the turn no folder or file under the data root is listed or stat-ed', async () => {
    writeFixture();
    const reads: string[] = [];
    let cut = false;
    const m = await load();
    const live = (p: unknown) => {
      const at = path.resolve(String(p));
      return at.startsWith(path.resolve(dataPath()) + path.sep) && !at.startsWith(path.resolve(snaps()));
    };
    const realReaddir = fs.promises.readdir.bind(fs.promises) as any;
    const note = (p: unknown) => { if (cut && live(p)) reads.push(String(p)); };
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p: any, ...rest: any[]) => { note(p); return realLstat(p, ...rest); });
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => { note(p); return realReaddir(p, ...rest); }) as any);
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      const out = (realRead as any)(p, ...rest);
      if (String(p).endsWith('.writer.lock')) cut = true;
      return out;
    }) as any);
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: any, ...rest: any[]) => { note(p); return (realLstatSync as any)(p, ...rest); }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toMatchObject({ ok: true });
    expect(cut).toBe(true);
    expect(reads).toEqual([]);
  });

  it('more than 128 files landing before every turn fail after 10 rounds with the cap text', async () => {
    writeFixture();
    let round = 0;
    const m = await load({
      beforeTurn: async () => {
        round += 1;
        for (let i = 0; i < 129; i++) m.fb.enqueueWrite(abs(`123/r${round}-${String(i).padStart(3, '0')}.json`), '{}');
        await m.fb.flushAll();
      },
    });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(round).toBe(10);
    expect(answer).toMatchObject({ ok: false, cause: 'writes' });
    expect((answer as { error: string }).error).toMatch(/^The data kept changing faster than one backup step can copy \(129 files, 0\.0 MiB in the last of 10 catch-up passes, the largest \/data\/123\/r10-\d{3}\.json at 0\.0 MiB; the limit is 128 files and 64\.0 MiB\); the backup was not kept\.$/);
    expect(workFolders()).toEqual([]);
  });

  it('a dirty set under the byte limit cuts, one over it fails after 10 rounds naming the largest path', async () => {
    writeFixture();
    const big = (n: number) => JSON.stringify({ pad: 'x'.repeat(n) });
    const under = await load({ maxBytes: 2048, beforeTurn: once(async () => { under.fb.enqueueWrite(abs('456/big.json'), big(1800)); await under.fb.flushAll(); }) });
    expect(await under.take.takeSnapshot({ name: nextName(), kind: 'hourly' })).toMatchObject({ ok: true });
    let n = 0;
    const over = await load({ maxBytes: 2048, beforeTurn: async () => { over.fb.enqueueWrite(abs('456/big.json'), big(2100 + ++n)); await over.fb.flushAll(); } });
    const answer = await over.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toMatchObject({ ok: false, cause: 'writes' });
    expect((answer as { error: string }).error).toContain('(1 files, 0.0 MiB in the last of 10 catch-up passes, the largest /data/456/big.json at 0.0 MiB;');
  });

  it('a directory move before every turn fails after 10 rounds with the moves text', async () => {
    writeFixture();
    let moves = 0;
    const m = await load({ beforeTurn: () => { moves += 1; m.fb.noteDataOp(); } });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(moves).toBe(10);
    expect(answer).toEqual({
      ok: false,
      cause: 'writes',
      error: "Folders under /data kept being moved during the backup (servers the bot left, or deleted servers' data restored or swept), so no moment without a move came in 10 catch-up passes; the backup was not kept.",
    });
  });

  it('a graveyard move inside the take puts the guild in the snapshot exactly once', async () => {
    writeFixture();
    const m = await load();
    let moved = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
      if (!moved && same(p, '123/b.json')) {
        moved = true;
        expect(await m.fb.graveyardGuildDir('456', 'test')).toBe(true);
      }
      return realOpen(p, ...rest);
    });
    const name = nextName();
    await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await complete(m, name);
    const xs = got.manifest.files.filter(f => f.path.endsWith('/x.json')).map(f => f.path);
    expect(got.verdict).toEqual({ ok: true });
    expect(xs).toHaveLength(1);
    expect(xs[0]).toMatch(/^_graveyard\/456-\d+\/x\.json$/);
  });
});

describe('the lock at the cut', () => {
  it('a lock rewritten by another process before the turn ends the take with no attempt', async () => {
    writeFixture();
    const m = await load({ beforeTurn: once(() => fs.writeFileSync(m.lock.writerLockPath(), JSON.stringify({ pid: 999999, start: 'x', role: 'import' }))) });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, lockLost: true, words: "the data files' lock (/data/.writer.lock) was removed or changed during the backup." });
    expect(workFolders()).toEqual([]);
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it('a lock re-created during the take ends it; one re-created before it does not', async () => {
    writeFixture();
    const during = await load({ beforeTurn: once(() => { fs.unlinkSync(during.lock.writerLockPath()); during.lock.checkWriterLock(); }) });
    const lost = await during.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    const before = await load();
    fs.unlinkSync(before.lock.writerLockPath());
    before.lock.checkWriterLock();
    const kept = await before.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(lost).toMatchObject({ ok: false, lockLost: true });
    expect(kept).toMatchObject({ ok: true });
  });

  it('a lock that cannot be read at the turn ends the take with the can\'t-confirm words', async () => {
    writeFixture();
    const m = await load({ beforeTurn: once(() => fs.unlinkSync(m.lock.writerLockPath())) });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, lockLost: true, words: "can't confirm the bot still held the data files (/data/.writer.lock: ENOENT)." });
  });

  it('reads the lock under DATA_DIR, never /data/.writer.lock', async () => {
    writeFixture();
    const m = await load();
    const spy = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    const lockReads = spy.mock.calls.map(c => String(c[0])).filter(p => p.endsWith('.writer.lock'));
    expect(answer).toMatchObject({ ok: true });
    expect(lockReads.length).toBeGreaterThan(0);
    expect(lockReads.every(p => path.resolve(p) === path.resolve(m.lock.writerLockPath()))).toBe(true);
  });
});

describe('folder syncs and the record', () => {
  it('syncs every staging folder deepest first, then data/ and the work folder, before the manifest; _snapshots after the rename', async () => {
    writeFixture();
    const m = await load();
    const order: string[] = h.calls;
    const realOpenSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).includes('manifest.json')) order.push('manifest');
      return (realOpenSync as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const name = nextName();
    await m.take.takeSnapshot({ name, kind: 'hourly' });
    const manifestAt = order.indexOf('manifest');
    const syncs = order.slice(0, manifestAt).map(c => c.slice(5));
    const taking = path.dirname(syncs[syncs.length - 2]);
    const rel = (p: string) => path.relative(path.join(taking, 'data'), p).split(path.sep).join('/');
    const staged = syncs.slice(0, -2).map(rel);
    const depths = staged.map(d => d.split('/').length);
    expect([...depths].sort((a, b) => b - a)).toEqual(depths);
    expect([...staged].sort()).toEqual(['123', '123/mod', '456', '_graveyard', '_graveyard/789-1', 'global', 'global/mod']);
    expect(syncs.slice(-2)).toEqual([path.join(taking, 'data'), taking]);
    expect(path.basename(taking)).toMatch(/^\.taking-/);
    expect(order.slice(manifestAt + 1)).toEqual([`sync ${path.resolve(snaps())}`]);
  });

  it('opens one folder at a time for its sync', async () => {
    writeFixture();
    const m = await load();
    let open = 0;
    let most = 0;
    const real = await vi.importActual<any>('../../src/bot/internalSetup/utils/folderChain');
    h.syncFolder = async dir => {
      open += 1;
      most = Math.max(most, open);
      try { return await real.syncFolder(dir); } finally { open -= 1; }
    };
    expect(await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' })).toMatchObject({ ok: true });
    expect(most).toBe(1);
  });

  it("a folder sync answering 'sync' fails with the take sync text and keeps nothing", async () => {
    writeFixture();
    const m = await load();
    h.syncFolder = dir => (dir.endsWith(`${path.sep}mod`) ? Promise.resolve({ failed: true, kind: 'sync', dir, errno: 'EIO', error: err('EIO') }) : null);
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toMatchObject({ ok: false });
    expect((answer as { error: string }).error).toMatch(/^The disk reported an error while the backup's folders were synced \(.+mod: EIO\), so can't confirm the backup is on disk; the backup was not kept\.$/);
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it("a folder sync answering 'open' fails with the take sync text's 'open' form", async () => {
    writeFixture();
    const m = await load();
    h.syncFolder = dir => (dir.endsWith(`${path.sep}456`) ? Promise.resolve({ failed: true, kind: 'open', dir, errno: 'EMFILE', error: err('EMFILE') }) : null);
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect((answer as { error: string }).error).toMatch(/^.+456 could not be opened for its sync while the backup's folders were synced \(EMFILE\), so can't confirm the backup is on disk; the backup was not kept\.$/);
    expect(m.chain.folderSyncFlag()).toBeNull();
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it("taker.json's own best-effort sync sets the flag during pass 1; the take fails with N5's text naming that folder and time", async () => {
    writeFixture();
    const m = await load();
    h.syncFolderSync = dir => {
      if (!path.basename(dir).startsWith('.taking-')) return null;
      m.chain.noteFolderSyncFailure(dir, 'EIO');
      return { failed: true, kind: 'sync', dir, errno: 'EIO', error: err('EIO') };
    };
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    const flag = m.chain.folderSyncFlag()!;
    expect(flag.dir).toMatch(/\.taking-/);
    expect(answer).toEqual({
      ok: false,
      error: `The disk reported an error when ${m.chain.containerPath(flag.dir)} was synced at ${m.chain.timeText(flag.at!)} (EIO), so can't confirm the backup is on disk; the backup was not kept.`,
    });
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it("a disk error record written by another process during pass 1 fails the take with N5's text", async () => {
    writeFixture();
    const m = await load();
    m.chain._setBootIdForTests('b1');
    let wrote = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
      if (!wrote && same(p, '456/x.json')) {
        wrote = true;
        vi.resetModules();
        const other = await vi.importActual<typeof m.chain>('../../src/bot/internalSetup/utils/folderChain');
        other._setBootIdForTests('b1');
        other.setDiskRole('web panel');
        other.noteFolderSyncFailure(dataPath('global'), 'EIO');
      }
      return realOpen(p, ...rest);
    });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    const record = JSON.parse(fs.readFileSync(path.join(snaps(), 'disk-error-b1.json'), 'utf8'));
    expect(m.chain.folderSyncFlag()).toBeNull();
    expect(answer).toEqual({
      ok: false,
      error: `The disk reported an error when /data/global was synced at ${m.chain.timeText(record.at)} (EIO), so can't confirm the backup is on disk; the backup was not kept.`,
    });
    expect(fs.readdirSync(snaps())).toEqual(['disk-error-b1.json']);
  });

  it("the child's flag set before the take answers diskFlag and makes no folder", async () => {
    writeFixture();
    const m = await load();
    m.chain.noteFolderSyncFailure(dataPath('123'), 'EIO');
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, diskFlag: m.chain.diskError() });
    expect((answer as { diskFlag: { errno: string } }).diskFlag.errno).toBe('EIO');
    expect(fs.existsSync(snaps())).toBe(false);
  });

  it('ENOSPC on the manifest keeps no snapshot', async () => {
    writeFixture();
    const m = await load();
    const realOpenSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p).includes('manifest.json')) throw err('ENOSPC');
      return (realOpenSync as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, error: "The backup's record (manifest.json) could not be written (ENOSPC); the backup was not kept." });
    expect(fs.readdirSync(snaps())).toEqual([]);
  });

  it('too little free space fails before any copy', async () => {
    writeFixture();
    const m = await load();
    vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 10, bsize: 1024 } as any);
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    const bytes = IN_SET.reduce((s, r) => s + FIXTURE[r].length, 0);
    expect(answer).toEqual({
      ok: false,
      error: `Not enough free disk space under /data: 0.0 MiB free, ${((bytes + 256 * 1024 * 1024) / 1048576).toFixed(1)} MiB needed (the data's size plus 256 MiB kept free for the bot's own writes).`,
    });
    expect(workFolders()).toEqual([]);
  });
});

describe('leftover work folders', () => {
  function leftover(name: string, taker?: object): string {
    const dir = path.join(snaps(), name);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    if (taker) fs.writeFileSync(path.join(dir, 'taker.json'), JSON.stringify(taker));
    return dir;
  }
  const at = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');

  it('removes a dead pid, a live pid with another start and an old one with no taker.json; keeps the rest', async () => {
    writeFixture();
    const now = Date.now();
    alive.add(4242);
    starts.set(4242, 'start-now');
    alive.add(4343);
    starts.set(4343, 'start-4343');
    const dead = leftover(`.taking-${at(now)}-4141`, { pid: 4141, start: 'start-4141' });
    const reused = leftover(`.taking-${at(now)}-4242`, { pid: 4242, start: 'start-then' });
    const live = leftover(`.taking-${at(now)}-4343`, { pid: 4343, start: 'start-4343' });
    const old = leftover(`.taking-${at(now - 16 * 60_000)}-4444`);
    const young = leftover(`.taking-${at(now - 14 * 60_000)}-4545`);
    const m = await load();
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    const left = (d: string) => fs.existsSync(d);
    expect(answer).toMatchObject({ ok: true });
    expect({ dead: left(dead), reused: left(reused), live: left(live), old: left(old), young: left(young) })
      .toEqual({ dead: false, reused: false, live: true, old: false, young: true });
  });
});

describe('the take while it runs', () => {
  function hang(m: Awaited<ReturnType<typeof load>>) {
    vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
      if (same(p, '456/x.json')) return new Promise<never>(() => undefined);
      return realOpen(p, ...rest);
    });
    return m;
  }

  it('the cap stops a take that runs too long and removes its folder', async () => {
    writeFixture();
    const m = hang(await load({ capMs: 200 }));
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, error: 'The backup took longer than 10 minutes and was stopped; the partial copy was removed.' });
    expect(workFolders()).toEqual([]);
  });

  it('a second take while one runs answers busy; the stop step ends the first with stopping', async () => {
    writeFixture();
    const m = hang(await load());
    const first = m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    const second = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    await m.take.abortRunningTake();
    expect(second).toEqual({ ok: false, busy: true });
    expect(await first).toEqual({ ok: false, stopping: true });
    expect(m.take.takeRunning()).toBe(false);
    expect(workFolders()).toEqual([]);
  });

  it('a name that exists answers exists', async () => {
    writeFixture();
    const m = await load();
    const name = nextName();
    await m.take.takeSnapshot({ name, kind: 'hourly' });
    expect(await m.take.takeSnapshot({ name, kind: 'hourly' })).toEqual({ ok: false, exists: true });
  });
});

describe('records, the turn reads and the cleanup', () => {
  it("a second lstat answering another signature around a copy: the manifest holds the first lstat's and the file is recopied", async () => {
    writeFixture();
    const m = await load();
    const answered: Array<{ mtimeMs: number }> = [];
    let calls = 0;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await realLstat(p, ...rest);
      if (!same(p, '456/x.json')) return st;
      calls += 1;
      const out = calls === 2 ? { isFile: () => true, isDirectory: () => false, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs + 1000, ctimeMs: st.ctimeMs } : st;
      answered.push(out);
      return out;
    }) as any);
    const name = nextName();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await complete(m, name);
    const sig = got.manifest.files.find(f => f.path === '456/x.json')!.sig;
    const real = fs.lstatSync(abs('456/x.json'));
    expect(answer).toMatchObject({ ok: true });
    expect(got.verdict).toEqual({ ok: true });
    expect(calls).toBe(4);
    expect(answered[1].mtimeMs).not.toBe(real.mtimeMs);
    expect(sig).toEqual({ ino: real.ino, size: real.size, mtimeMs: real.mtimeMs, ctimeMs: real.ctimeMs });
  });

  it('an emptied staging folder whose rmdir answers ENOTEMPTY stays, with no log line', async () => {
    writeFixture();
    const m: Awaited<ReturnType<typeof load>> = await load({ beforeTurn: once(async () => { m.fb.enqueueDelete(abs('123/mod/a.json')); await m.fb.flushAll(); }) });
    const warn = vi.mocked(console.warn);
    vi.spyOn(fs, 'rmdirSync').mockImplementation((() => { throw err('ENOTEMPTY'); }) as any);
    syncBuiltinESMExports();
    const name = nextName();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    const got = await complete(m, name);
    expect(answer).toMatchObject({ ok: true });
    expect(got.verdict).toEqual({ ok: true });
    expect(got.manifest.files.map(f => f.path)).not.toContain('123/mod/a.json');
    expect(got.manifest.dirs).toContain('123/mod');
    expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('emptied folder'))).toEqual([]);
  });

  it('an emptied staging folder whose rmdir answers EACCES stays, with the log line', async () => {
    writeFixture();
    const m: Awaited<ReturnType<typeof load>> = await load({ beforeTurn: once(async () => { m.fb.enqueueDelete(abs('123/mod/a.json')); await m.fb.flushAll(); }) });
    const warn = vi.mocked(console.warn);
    vi.spyOn(fs, 'rmdirSync').mockImplementation((() => { throw err('EACCES'); }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toMatchObject({ ok: true });
    expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('emptied folder')))
      .toEqual(['[Backup] Could not remove the emptied folder 123/mod from the backup being taken (EACCES)']);
  });

  /** Counts the turn's readFileSync calls and bytes under the data root, from the end of beforeTurn to the lock read. */
  function turnReads() {
    const turns: Array<{ files: number; bytes: number }> = [];
    let open: { files: number; bytes: number } | null = null;
    const live = (p: unknown) => {
      const at = path.resolve(String(p));
      return at.startsWith(path.resolve(dataPath()) + path.sep) && !at.startsWith(path.resolve(snaps())) && !at.endsWith('.writer.lock');
    };
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      const out = (realReadFileSync as any)(p, ...rest);
      if (open && String(p).endsWith('.writer.lock')) open = null;
      else if (open && live(p)) {
        open.files += 1;
        open.bytes += out.length;
      }
      return out;
    }) as any);
    syncBuiltinESMExports();
    return {
      turns,
      begin: () => {
        open = { files: 0, bytes: 0 };
        turns.push(open);
      },
    };
  }

  it('the turn reads each of 128 landed files once, within the byte limit', async () => {
    writeFixture();
    const reads = turnReads();
    const m: Awaited<ReturnType<typeof load>> = await load({
      beforeTurn: async () => {
        if (reads.turns.length === 0) {
          for (let i = 0; i < 128; i++) m.fb.enqueueWrite(abs(`123/t-${String(i).padStart(3, '0')}.json`), '{"t":1}');
          await m.fb.flushAll();
        }
        reads.begin();
      },
    });
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toMatchObject({ ok: true });
    expect(reads.turns).toEqual([{ files: 128, bytes: 128 * 7 }]);
  });

  it('a turn over the file or byte cap reads no file', async () => {
    writeFixture();
    const files = turnReads();
    let round = 0;
    const many: Awaited<ReturnType<typeof load>> = await load({
      beforeTurn: async () => {
        round += 1;
        for (let i = 0; i < 129; i++) many.fb.enqueueWrite(abs(`123/r${round}-${String(i).padStart(3, '0')}.json`), '{}');
        await many.fb.flushAll();
        files.begin();
      },
    });
    expect(await many.take.takeSnapshot({ name: nextName(), kind: 'hourly' })).toMatchObject({ ok: false, cause: 'writes' });
    expect(files.turns).toHaveLength(10);
    expect(files.turns.every(t => t.files === 0)).toBe(true);
    let n = 0;
    const bytes = turnReads();
    const big: Awaited<ReturnType<typeof load>> = await load({
      maxBytes: 2048,
      beforeTurn: async () => {
        big.fb.enqueueWrite(abs('456/big.json'), JSON.stringify({ pad: 'x'.repeat(2100 + ++n) }));
        await big.fb.flushAll();
        bytes.begin();
      },
    });
    expect(await big.take.takeSnapshot({ name: nextName(), kind: 'hourly' })).toMatchObject({ ok: false, cause: 'writes' });
    expect(bytes.turns).toHaveLength(10);
    expect(bytes.turns.every(t => t.files === 0 && t.bytes === 0)).toBe(true);
  });

  it.each([1, 2, 3])("V9: another process deletes and re-takes the lock inside the turn's read %i: no attempt", async k => {
    writeFixture();
    let armed = false;
    let count = 0;
    const m: Awaited<ReturnType<typeof load>> = await load({
      beforeTurn: once(async () => {
        for (const f of ['v1', 'v2', 'v3']) m.fb.enqueueWrite(abs(`123/${f}.json`), `{"${f}":1}`);
        await m.fb.flushAll();
        armed = true;
      }),
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      const at = path.resolve(String(p));
      if (armed && at.startsWith(path.resolve(dataPath('123')) + path.sep) && ++count === k) {
        armed = false;
        fs.unlinkSync(m.lock.writerLockPath());
        fs.writeFileSync(m.lock.writerLockPath(), JSON.stringify({ pid: 999999, start: 'x', role: 'import', at: Date.now() }), { flag: 'wx' });
      }
      return (realReadFileSync as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(count).toBe(k);
    expect(answer).toEqual({ ok: false, lockLost: true, words: "the data files' lock (/data/.writer.lock) was removed or changed during the backup." });
    expect(fs.readdirSync(snaps())).toEqual([]);
  });
});

describe('a take stopped while the disk hangs', () => {
  const never = () => new Promise<never>(() => undefined);
  const within = <T>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<'no answer'>(resolve => { setTimeout(() => resolve('no answer'), ms); })]);
  const CAP = 'The backup took longer than 10 minutes and was stopped; the partial copy was removed.';

  it('a source close that never settles: the cap still answers and the take is no longer running', async () => {
    writeFixture();
    const m = await load({ capMs: 200 });
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (same(p, '456/x.json')) return { read: never, close: never };
      return realOpen(p, ...rest);
    }) as any);
    const answer = await within(m.take.takeSnapshot({ name: nextName(), kind: 'hourly' }));
    expect(answer).toEqual({ ok: false, error: CAP });
    expect(m.take.takeRunning()).toBe(false);
    expect(workFolders()).toEqual([]);
  });

  it("a copy's own close that never settles: the cap still answers", async () => {
    writeFixture();
    const m = await load({ capMs: 200 });
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
      if (flags === 'wx' && path.basename(String(p)).startsWith('x.json.')) return { write: never, close: never };
      return realOpen(p, flags, ...rest);
    }) as any);
    const answer = await within(m.take.takeSnapshot({ name: nextName(), kind: 'hourly' }));
    expect(answer).toEqual({ ok: false, error: CAP });
    expect(m.take.takeRunning()).toBe(false);
  });

  it("a failed link's unlink that never settles: the cap still answers", async () => {
    writeFixture();
    const m = await load();
    await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    m.take._setTakeTimingForTests({ pollMs: 5, capMs: 200 }, seams);
    vi.spyOn(fs.promises, 'link').mockRejectedValue(err('EPERM'));
    vi.spyOn(fs.promises, 'unlink').mockImplementation(never as any);
    const answer = await within(m.take.takeSnapshot({ name: nextName(), kind: 'hourly' }));
    expect(answer).toEqual({ ok: false, error: CAP });
    expect(m.take.takeRunning()).toBe(false);
  });

  it("a cut buffer's close that never settles: the cap still answers", async () => {
    writeFixture();
    const m = await load({
      capMs: 1000,
      beforeTurn: once(async () => {
        m.fb.enqueueWrite(abs('123/late.json'), '{"late":1}');
        await m.fb.flushAll();
      }),
    });
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
      if (flags === 'wx' && path.basename(String(p)).startsWith('late.json.')) return { writeFile: never, close: never };
      return realOpen(p, flags, ...rest);
    }) as any);
    const answer = await within(m.take.takeSnapshot({ name: nextName(), kind: 'hourly' }));
    expect(answer).toEqual({ ok: false, error: CAP });
    expect(m.take.takeRunning()).toBe(false);
  });
});

describe('what the answer says about the partial copy and the placed folder', () => {
  const hangOpen = () => vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
    if (same(p, '456/x.json')) return new Promise<never>(() => undefined);
    return realOpen(p, ...rest);
  }) as any);
  const realRm = fs.promises.rm.bind(fs.promises);
  const stubRm = (fn: () => Promise<void>) => vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: any, ...rest: any[]) => {
    if (path.basename(String(p)).startsWith('.taking-')) return fn();
    return realRm(p, ...rest);
  }) as any);
  const workPath = () => `/data/_snapshots/${workFolders()[0]}`;

  it('the cap with a removal that fails names the folder and the errno', async () => {
    writeFixture();
    const m = await load({ capMs: 200 });
    hangOpen();
    stubRm(() => Promise.reject(err('EACCES')));
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(workFolders()).toHaveLength(1);
    expect(answer).toEqual({ ok: false, error: `The backup took longer than 10 minutes and was stopped; the partial copy at ${workPath()} could not be removed (EACCES).` });
  });

  it("the cap with a removal that does not finish says it can't confirm the removal", async () => {
    writeFixture();
    const m = await load({ capMs: 200, removeMs: 50 } as Record<string, unknown>);
    hangOpen();
    stubRm(() => new Promise<never>(() => undefined));
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({
      ok: false,
      error: `The backup took longer than 10 minutes and was stopped; this machine can't confirm the partial copy at ${workPath()} was removed (its removal did not finish within 5 seconds).`,
    });
  }, 15_000);

  it('a full disk with a removal that fails names the folder and the errno', async () => {
    writeFixture();
    const m = await load();
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
      if (flags === 'wx' && path.basename(String(p)).startsWith('x.json.')) throw err('ENOSPC');
      return realOpen(p, flags, ...rest);
    }) as any);
    stubRm(() => Promise.reject(err('EBUSY')));
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, error: `The disk filled up while the backup was copied (/data/456/x.json); the partial copy at ${workPath()} could not be removed (EBUSY).` });
  });

  it('a failed _snapshots sync whose rename back fails names the folder that stays', async () => {
    writeFixture();
    const m = await load();
    const name = nextName();
    h.syncFolder = dir => (path.resolve(dir) === path.resolve(snaps()) ? Promise.resolve({ failed: true, kind: 'sync', dir, errno: 'EIO', error: err('EIO') }) : null);
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (path.basename(String(from)) === name && path.basename(String(to)).startsWith('.taking-')) throw err('EIO');
      return (realRename as any)(from, to);
    }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    expect(answer).toEqual({
      ok: false,
      error: `The disk reported an error while the backup's folders were synced (/data/_snapshots: EIO), so can't confirm the backup is on disk; ${name} stays in the list (renaming it back failed: EIO).`,
    });
    expect(fs.existsSync(path.join(snaps(), name))).toBe(true);
  });

  it('the cap before the work folder exists says the backup was not kept, not that a copy was removed', async () => {
    writeFixture();
    fs.mkdirSync(snaps(), { recursive: true });
    const m = await load({ capMs: 200 });
    const realReaddir = fs.promises.readdir.bind(fs.promises) as any;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(snaps())) return new Promise<never>(() => undefined);
      return realReaddir(p, ...rest);
    }) as any);
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({ ok: false, error: 'The backup took longer than 10 minutes and was stopped; the backup was not kept.' });
    expect(workFolders()).toEqual([]);
  });

  it('a stop during the _snapshots sync whose rename back fails logs the stop as the cause', async () => {
    writeFixture();
    const m = await load();
    const name = nextName();
    h.syncFolder = dir => {
      if (path.resolve(dir) !== path.resolve(snaps())) return null;
      void m.take.abortRunningTake();
      return new Promise<never>(() => undefined);
    };
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (path.basename(String(from)) === name && path.basename(String(to)).startsWith('.taking-')) throw err('EIO');
      return (realRename as any)(from, to);
    }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    const lines = vi.mocked(console.warn).mock.calls.map(c => String(c[0])).filter(l => l.includes('Could not take back'));
    expect(answer).toEqual({ ok: false, stopping: true });
    expect(lines).toEqual([`[Backup] Could not take back ${name} after the backup was stopped (EIO)`]);
  });

  it('a failed rename into place says the folder could not be renamed', async () => {
    writeFixture();
    const m = await load();
    const name = nextName();
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (path.basename(String(from)).startsWith('.taking-') && path.basename(String(to)) === name) throw err('EIO');
      return (realRename as any)(from, to);
    }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name, kind: 'hourly' });
    expect(answer).toEqual({ ok: false, error: `The backup's folder could not be renamed to ${name} (EIO); the backup was not kept.` });
    expect(fs.readdirSync(snaps())).toEqual([]);
  });
});

describe('a disk error that stands in another form during the take', () => {
  it('a torn record another process left fails the take with the unreadable-record words', async () => {
    writeFixture();
    const m = await load();
    m.chain._setBootIdForTests('b1');
    let wrote = false;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (!wrote && same(p, '456/x.json')) {
        wrote = true;
        fs.writeFileSync(path.join(snaps(), 'disk-error-b1.json'), '{"fol');
      }
      return realOpen(p, ...rest);
    }) as any);
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    expect(answer).toEqual({
      ok: false,
      error: "No folder sync is trusted since /data/_snapshots/disk-error-b1.json records a disk error on this machine, and that record cannot be read, so can't confirm the backup is on disk; the backup was not kept.",
    });
    expect(fs.readdirSync(snaps())).toEqual(['disk-error-b1.json']);
  });

  it('_snapshots that cannot be listed with the boot id unknown fails the take with the folder words', async () => {
    writeFixture();
    const m = await load();
    m.chain._setBootIdForTests(null);
    let armed = false;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (same(p, '456/x.json')) armed = true;
      return realOpen(p, ...rest);
    }) as any);
    const realReaddirSync = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (armed && path.resolve(String(p)) === path.resolve(snaps())) throw err('EACCES');
      return (realReaddirSync as any)(p, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const answer = await m.take.takeSnapshot({ name: nextName(), kind: 'hourly' });
    armed = false;
    expect(answer).toEqual({
      ok: false,
      error: "No folder sync is trusted since /data/_snapshots could not be read (EACCES) to look for a disk error record, so can't confirm the backup is on disk; the backup was not kept.",
    });
    expect(workFolders()).toEqual([]);
  });
});

function once(fn: () => unknown): () => unknown {
  let ran = false;
  return () => {
    if (ran) return undefined;
    ran = true;
    return fn();
  };
}

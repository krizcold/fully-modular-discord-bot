import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { configureWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';

// NB10 test 12 (the edges): a bundle import takes the lock as an import when it holds none, joins a hold the caller
// already has, names an unreadable lock file, and moves no guild dir into place once another process took the data
// files during it.

const live = new Set<number>([process.pid, 6262]);
const seams = { pid: () => process.pid, alive: (p: number) => live.has(p), startOf: () => null, now: () => Date.now() };
let g = 0;
const freshGuild = () => `42424200000000${String(1300 + ++g)}`;

/** A bundle of one guild holding mod/a.json, written from a live dir that is then removed. */
async function bundleOf(guild: string, name: string, text: string): Promise<string> {
  fs.mkdirSync(dataPath(guild, 'mod'), { recursive: true });
  fs.writeFileSync(dataPath(guild, 'mod', 'a.json'), text);
  const file = dataPath(name);
  await writeBundle(guild, file);
  fs.rmSync(dataPath(guild), { recursive: true, force: true });
  return file;
}

beforeEach(() => {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('import', seams);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('import', seams);
});

/** The lock file's role at the moment the import opens the bundle. */
function roleAtOpen(bundle: string): { role: string | null } {
  const seen = { role: null as string | null };
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: any[]) => {
    if (String(p) === bundle && seen.role === null) seen.role = JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).role;
    return (realOpen as any)(p, ...rest);
  }) as typeof fs.promises.open);
  return seen;
}

describe('a bundle import and the writer lock it takes', () => {
  it('a process configured for another role holding no lock imports as role import', async () => {
    const G = freshGuild();
    const bundle = await bundleOf(G, `nb10s12-${G}.bundle`, '{"a":1}');
    configureWriterLock('bot', seams);
    const seen = roleAtOpen(bundle);
    const result = await importBundle(bundle);
    expect(result.guildId).toBe(G);
    expect(seen.role).toBe('import');
    expect(fs.readFileSync(dataPath(G, 'mod', 'a.json'), 'utf8')).toBe('{"a":1}');
    expect(writerLockDepth()).toBe(0);
  });

  it('a caller already holding the lock imports within its hold, which stays held after', async () => {
    const G = freshGuild();
    const bundle = await bundleOf(G, `nb10s12-${G}.bundle`, '{"a":2}');
    configureWriterLock('bot', seams);
    expect(takeWriterLock()).toEqual({ kind: 'taken' });
    const seen = roleAtOpen(bundle);
    const result = await importBundle(bundle);
    expect(result.guildId).toBe(G);
    expect(seen.role).toBe('bot');
    expect(fs.readFileSync(dataPath(G, 'mod', 'a.json'), 'utf8')).toBe('{"a":2}');
    expect(writerLockDepth()).toBe(1);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(process.pid);
  });

  it('a lock file that cannot be read is refused, naming the file and the errno', async () => {
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 6262, start: null, role: 'bot', at: Date.now() }));
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (String(p) === writerLockPath()) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as any)(p, ...rest);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    await expect(importBundle(dataPath('missing.bundle'))).rejects.toThrow(
      `[DataInterchange] can't confirm which process holds the data files (${writerLockPath()}: EACCES); nothing was imported`,
    );
  });

  it('a guild with no live dir is not put in place once another process took the data files during the import', async () => {
    const G = freshGuild();
    const bundle = await bundleOf(G, `nb10s12-${G}.bundle`, '{"a":3}');
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: any[]) => {
      if (String(p) === bundle) fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 6262, start: null, role: 'bot', at: Date.now() }));
      return (realOpen as any)(p, ...rest);
    }) as typeof fs.promises.open);
    await expect(importBundle(bundle)).rejects.toThrow(
      '[DataInterchange] Another process (a bot process, pid 6262) took the data files during the import; the live guild dir was not touched',
    );
    expect(fs.existsSync(dataPath(G))).toBe(false);
    expect(fs.readdirSync(dataPath()).filter(n => n.startsWith(`.bundle-import-${G}`))).toEqual([]);
  });
});

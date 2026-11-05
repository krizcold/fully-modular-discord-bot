import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { configureWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';

// NB10 test 12: a bundle import holds the writer lock (role import) and is refused while another live process holds it.

const live = new Set<number>([process.pid, 6161]);
const seams = { pid: () => process.pid, alive: (p: number) => live.has(p), startOf: () => null, now: () => Date.now() };

beforeEach(() => {
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('import', seams);
});

afterEach(() => vi.restoreAllMocks());

describe('a bundle import and the writer lock', () => {
  it('is refused at once while another live process holds the lock, naming it, and writes no staging dir', async () => {
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 6161, start: null, role: 'bot', at: Date.now() }));
    const before = fs.readdirSync(dataPath()).filter(n => n.startsWith('.bundle-import-'));
    await expect(importBundle(dataPath('missing.bundle'))).rejects.toThrow('the data files are held by a bot process (pid 6161); run the import once it has stopped');
    expect(fs.readdirSync(dataPath()).filter(n => n.startsWith('.bundle-import-'))).toEqual(before);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(6161);
  });

  it('holds the lock with role import while it runs and releases it after a failure', async () => {
    let seenRole: string | null = null;
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: any[]) => {
      if (String(p).endsWith('missing.bundle')) seenRole = JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).role;
      return (realOpen as any)(p, ...rest);
    }) as typeof fs.promises.open);
    await expect(importBundle(dataPath('missing.bundle'))).rejects.toThrow();
    expect(seenRole).toBe('import');
    expect(writerLockDepth()).toBe(0);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('releases the lock after a successful import', async () => {
    const { writeBundle } = await import('../../src/bot/internalSetup/utils/dataInterchange');
    const G = '123456789012345678';
    fs.mkdirSync(dataPath(G, 'mod'), { recursive: true });
    fs.writeFileSync(dataPath(G, 'mod', 'a.json'), '{"a":1}');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await writeBundle(G, dataPath('nb10.bundle'));
    fs.writeFileSync(dataPath(G, 'mod', 'a.json'), '{"a":2}');
    await importBundle(dataPath('nb10.bundle'));
    expect(fs.readFileSync(dataPath(G, 'mod', 'a.json'), 'utf8')).toBe('{"a":1}');
    expect(writerLockDepth()).toBe(0);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('a refused import leaves the live dir as it was', async () => {
    fs.mkdirSync(dataPath('global', 'nb10import'), { recursive: true });
    fs.writeFileSync(dataPath('global', 'nb10import', 'live.json'), '{"live":1}');
    const snapshot = () => fs.readdirSync(dataPath(), { recursive: true }).map(String).filter(n => !n.includes('.writer.lock')).sort();
    const before = snapshot();
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 6161, start: null, role: 'webui', at: Date.now() }));
    await expect(importBundle(dataPath('missing.bundle'))).rejects.toThrow('the data files are held by the web UI (pid 6161)');
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(dataPath('global', 'nb10import', 'live.json'), 'utf8')).toBe('{"live":1}');
  });
});

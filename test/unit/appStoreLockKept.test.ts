import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  failRenameTo: new Set<string>(),
  fsyncs: 0,
  renamesTo: [] as string[],
  execs: [] as { cmd: string; timeout: unknown }[],
  failLockCreate: null as string | null,
}));

vi.mock('fs', async (orig) => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    renameSync: (from: any, to: any) => {
      h.renamesTo.push(path.basename(String(to)));
      if (h.failRenameTo.has(path.basename(String(to)))) {
        throw Object.assign(new Error(`EIO: i/o error, rename '${from}'`), { code: 'EIO' });
      }
      return real.renameSync(from, to);
    },
    fsyncSync: (fd: any) => { h.fsyncs++; return real.fsyncSync(fd); },
    openSync: (file: any, flags: any, ...rest: any[]) => {
      if (h.failLockCreate !== null && flags === 'wx' && path.basename(String(file)) === '.store.lock') {
        throw Object.assign(new Error(`${h.failLockCreate}: refused`), { code: h.failLockCreate });
      }
      return real.openSync(file, flags, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('child_process', async (orig) => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const execSync = (cmd: string, opts: any = {}) => {
    h.execs.push({ cmd, timeout: opts.timeout });
    if (cmd.startsWith('git rev-parse HEAD')) {
      return Buffer.from(fsReal.readFileSync(path.join(opts.cwd, '.git', 'HEAD_HASH'), 'utf-8'));
    }
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    if (cmd.startsWith('git clone')) {
      const target = cmd.match(/"([^"]+)"$/)![1];
      fsReal.mkdirSync(path.join(target, '.git'), { recursive: true });
      fsReal.writeFileSync(path.join(target, '.git', 'HEAD_HASH'), 'e'.repeat(40));
      return Buffer.from('');
    }
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async (orig) => {
  const real = await orig<any>();
  const root = process.env.DATA_DIR as string;
  return {
    ...real,
    getModulesDir: () => path.join(root, 'runtime-modules'),
    getSourceModulesDir: () => path.join(root, 'appstore-modules'),
    getBuildModulesDir: () => path.join(root, 'build-modules'),
    getModulesDevDir: () => path.join(root, 'modulesDev'),
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager, storeLockHolder } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');
const INSTALLED = path.join(STORE, 'installed.json');
const REPOS = path.join(STORE, 'repos.json');
const CLONE = path.join(STORE, 'cache', 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('build-modules');
const LOCK = path.join(STORE, 'cache', '.store.lock');
const GUARD = `${LOCK}.takeover`;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}

const installed = (): Record<string, any> => JSON.parse(fs.readFileSync(INSTALLED, 'utf-8')).modules;

beforeEach(() => {
  for (const dir of [STORE, SOURCE, BUILD, dataPath('runtime-modules')]) fs.rmSync(dir, { recursive: true, force: true });
  h.failRenameTo.clear();
  h.failLockCreate = null;
  vi.restoreAllMocks();
});

// The App Store lock's behaviour, pinned across its move onto processLock.ts (NB10 test 2).
describe('the App Store lock keeps its behaviour', () => {
  it('takes a free lock and leaves none behind', async () => {
    publish('alpha', '1.0.0');
    await new AppStoreManager().installModule('alpha', 'official-modules');
    expect(installed().alpha).toBeDefined();
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it('waits for a live holder of the same run', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    vi.spyOn(storeLockHolder, 'startOf').mockReturnValue('run-1');
    const held = JSON.stringify({ pid: process.ppid, start: 'run-1', at: Date.now() });
    write(LOCK, held);
    let seen: string | undefined;
    setTimeout(() => { seen = fs.readFileSync(LOCK, 'utf-8'); fs.rmSync(LOCK, { force: true }); }, 200);
    await m.installModule('alpha', 'official-modules');
    expect(seen).toBe(held);
  }, 10_000);

  it('takes over a dead holder and a holder with another start', async () => {
    publish('alpha', '1.0.0');
    write(LOCK, JSON.stringify({ pid: 2147483646, at: Date.now() }));
    await new AppStoreManager().installModule('alpha', 'official-modules');
    expect(installed().alpha).toBeDefined();
    publish('beta', '1.0.0');
    vi.spyOn(storeLockHolder, 'startOf').mockReturnValue('run-2');
    write(LOCK, JSON.stringify({ pid: process.ppid, start: 'run-1', at: Date.now() }));
    await new AppStoreManager().installModule('beta', 'official-modules');
    expect(installed().beta).toBeDefined();
    expect(fs.existsSync(LOCK)).toBe(false);
  }, 10_000);

  it('a holder text that does not parse blocks while young and is taken over once old', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    write(LOCK, '{"pid":');
    let seen: string | undefined;
    setTimeout(() => { seen = fs.readFileSync(LOCK, 'utf-8'); fs.rmSync(LOCK, { force: true }); }, 200);
    await m.installModule('alpha', 'official-modules');
    expect(seen).toBe('{"pid":');
    publish('beta', '1.0.0');
    const m2 = new AppStoreManager();
    write(LOCK, 'garbage');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(LOCK, old, old);
    await m2.installModule('beta', 'official-modules');
    expect(installed().beta).toBeDefined();
    expect(fs.existsSync(LOCK)).toBe(false);
  }, 10_000);

  it('a young takeover guard on a stale lock holds the take off until the guard is 5 s old, then it is removed', async () => {
    publish('alpha', '1.0.0');
    write(LOCK, JSON.stringify({ pid: 2147483646, at: Date.now() }));
    write(GUARD, '');
    const started = Date.now();
    await new AppStoreManager().installModule('alpha', 'official-modules');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(installed().alpha).toBeDefined();
    expect(fs.existsSync(LOCK)).toBe(false);
    expect(fs.existsSync(GUARD)).toBe(false);
  }, 10_000);

  it('a create that fails with another error than EEXIST throws', async () => {
    publish('alpha', '1.0.0');
    h.failLockCreate = 'EACCES';
    await expect(new AppStoreManager().installModule('alpha', 'official-modules')).rejects.toThrow(/EACCES/);
  });
});

import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 1, fixer 5 (out/NB6/part-rulings.md "Code review round 1"): findings E1, E2 and E5 through the
// real AppStoreManager, the real publish and fetch over scripted clients that answer as the shared tables do
// (helpers/sharedRows.ts), the real apply with the fake loader of helpers/nb6FakeLoader.ts, and the real module
// auto-updater. E6 and E7 are in nb6FixR1EDocs.test.ts.

const h = vi.hoisted(() => ({
  dirs: { source: '', build: '', dist: '', dev: '' },
  manager: null as unknown,
}));

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getSourceModulesDir: () => h.dirs.source,
    getBuildModulesDir: () => h.dirs.build,
    getModulesDir: () => h.dirs.dist,
    getModulesDevDir: () => h.dirs.dev,
  };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelRecovery', () => ({
  recoverPersistentPanels: async () => undefined,
  needsRecovery: async () => false,
  markAllPanelsRecovered: async () => undefined,
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<any>();
  return { ...real, getAppStoreManager: () => h.manager };
});

import fs from 'fs';
import type { Client } from 'discord.js';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager, type PublishedChange } from '../../src/bot/internalSetup/utils/appStoreManager';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';
import { applyRig, moduleShaOfFiles } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const REPO = 'r1';
const STORE = dataPath('global', 'appstore');
const LOCK = path.join(STORE, 'cache', '.store.lock');
const INSTALLED = 'global/appstore/installed.json';
const V1 = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const V2 = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

beforeEach(async () => {
  await rig.setup();
  h.dirs = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist, dev: path.join(rig.state.root, 'modulesDev') };
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'repos.json'), JSON.stringify({ repositories: [{ id: REPO, name: 'Repo', url: 'https://github.com/example/r', branch: 'main', enabled: true }] }, null, 2));
  fs.writeFileSync(path.join(STORE, 'config.json'), JSON.stringify({ autoUpdate: true }));
});

afterEach(async () => {
  stopModuleAutoUpdater();
  await rig.teardown();
});

function clone(files: Record<string, string>): void {
  const dir = path.join(STORE, 'cache', REPO);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(dir, 'Modules', 'm', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

/** m 1.0.0 installed through the real install; the clone then holds `next`. */
async function installed(next: Record<string, string>): Promise<AppStoreManager> {
  clone(V1);
  const m = new AppStoreManager();
  await m.installModule('m', REPO);
  h.manager = m;
  clone(next);
  return m;
}

const enospc = (call: string) => Object.assign(new Error(`ENOSPC: no space left on device, ${call}`), { code: 'ENOSPC' });

/** Arms `fault` at the next COMMIT the scripted clients answer: the publish has stored its change by then. */
function afterCommit(): { armed: () => boolean; disarm: () => void } {
  let armed = false;
  rig.state.rows.fault = sql => {
    if (sql === 'COMMIT') armed = true;
    return undefined;
  };
  return { armed: () => armed, disarm: () => { armed = false; } };
}

/** The first store lock take after the COMMIT cannot write the lock file (a full disk). */
function lockFailsAfterCommit(): void {
  const at = afterCommit();
  const open = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (at.armed() && path.resolve(String(p)) === path.resolve(LOCK)) {
      at.disarm();
      throw enospc('open');
    }
    return (open as any)(p, ...rest);
  }) as typeof fs.openSync);
}

describe('E1: a publish that answered committed, then the landing or the apply throws', () => {
  it('the store lock cannot be taken for the landing: the update answers the stored change, and the pass applies it', async () => {
    const m = await installed(V2);
    lockFailsAfterCommit();
    const result = await m.updateModule('m');
    vi.mocked(fs.openSync).mockRestore();
    expect(result).toMatchObject({
      success: true,
      newVersion: '2.0.0',
      applied: { text: 'm 2.0.0 is saved for every machine, but this machine could not apply it yet (ENOSPC: no space left on device, open); it tries again at the next pass.' },
    });
    expect(result.published).toMatchObject({ module: 'm', operation: 'update', version: '2.0.0', to: moduleShaOfFiles(V2) });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V2));
    expect(rig.live('m')).toEqual(V1);
    await rig.pass();
    expect(rig.live('m')).toEqual(V2);
    expect(rig.entry('m')).toMatchObject({ sha: moduleShaOfFiles(V2) });
  });

  it("the apply's swap throws: the update answers the stored change with the apply's error and when it tries again", async () => {
    const m = await installed(V2);
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const at = afterCommit();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (at.armed() && path.basename(String(from)).startsWith('.incoming-m-') && path.resolve(String(to)) === path.join(rig.state.source, 'm')) {
        at.disarm();
        throw enospc('rename');
      }
      return (rename as any)(from, to);
    }) as typeof fs.renameSync);
    const result = await m.updateModule('m');
    vi.mocked(fs.renameSync).mockRestore();
    expect(result).toMatchObject({
      success: true,
      newVersion: '2.0.0',
      applied: { text: `m 2.0.0 is saved for every machine, but this machine could not apply it yet (ENOSPC: no space left on device, rename); it tries again after ${new Date(t0 + 600_000).toISOString()}.` },
    });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V2));
    expect(fs.readdirSync(rig.state.source).filter(n => n.startsWith('.incoming-'))).toEqual([]);
    expect(rig.live('m')).toEqual(V1);
    expect(rig.entry('m')).toMatchObject({ sha: moduleShaOfFiles(V1), applying: null, retryAt: t0 + 600_000 });
    vi.setSystemTime(t0 + 599_999);
    await rig.pass();
    expect(rig.live('m')).toEqual(V1);
    vi.setSystemTime(t0 + 600_001);
    await rig.pass();
    expect(rig.live('m')).toEqual(V2);
    expect(rig.entry('m')).toMatchObject({ sha: moduleShaOfFiles(V2), applying: null });
  });

  it("R3-E1: the swap throws and putting the previous version back cannot write the record: the answer says it applies after the bot's next start", async () => {
    const m = await installed(V2);
    const at = afterCommit();
    let swapFailed = false;
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (at.armed() && path.basename(String(from)).startsWith('.incoming-m-') && path.resolve(String(to)) === path.join(rig.state.source, 'm')) {
        at.disarm();
        swapFailed = true;
        throw enospc('rename');
      }
      return (rename as any)(from, to);
    }) as typeof fs.renameSync);
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const name = path.basename(String(p));
      if (swapFailed && name.startsWith('.shared-mirror.json.') && name.endsWith('.tmp')) throw enospc('open');
      return (open as any)(p, ...rest);
    }) as typeof fs.openSync);
    const result = await m.updateModule('m');
    vi.mocked(fs.renameSync).mockRestore();
    vi.mocked(fs.openSync).mockRestore();
    expect(swapFailed).toBe(true);
    expect(result).toMatchObject({
      success: true,
      newVersion: '2.0.0',
      applied: { text: "m 2.0.0 is saved for every machine, but this machine could not apply it yet (ENOSPC: no space left on device, rename); it applies the database's current version of m after the bot's next start." },
    });
    expect(rig.entry('m')?.applying).toBeTruthy();
    await rig.pass();
    expect(rig.live('m')).toEqual(V1);
  });

  it('R3-F1: the build copy of the new version keeps failing: two passes within 10 minutes fetch and swap once, and no copy of it is set aside', async () => {
    await installed(V1);
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    vi.setSystemTime(t0);
    await rig.publish('m', V2, '2.0.0');
    let fetches = 0;
    rig.state.rows.fault = sql => {
      if (sql.startsWith('SELECT rel, mode, octet_length(bytes)')) fetches += 1;
      return undefined;
    };
    let copies = 0;
    const cp = fs.cpSync;
    vi.spyOn(fs, 'cpSync').mockImplementation(((from: any, to: any, opts: any) => {
      if (path.resolve(String(to)) === path.resolve(rig.state.build, 'm') && fs.readFileSync(path.join(String(from), 'module.json'), 'utf8').includes('2.0.0')) {
        copies += 1;
        throw Object.assign(new Error('EACCES: permission denied, copyfile'), { code: 'EACCES' });
      }
      return (cp as any)(from, to, opts);
    }) as typeof fs.cpSync);
    await rig.pass();
    vi.setSystemTime(t0 + 9 * 60_000);
    await rig.pass();
    expect(fetches).toBe(1);
    expect(copies).toBe(1);
    expect(rig.live('m')).toEqual(V1);
    expect(rig.backupsOf('m')).toEqual([]);
    expect(rig.entry('m')).toMatchObject({ sha: moduleShaOfFiles(V1), applying: null, retryAt: t0 + 600_000 });
  });

  it('an uninstall whose landing cannot take the store lock answers the stored removal', async () => {
    const m = await installed(V1);
    lockFailsAfterCommit();
    const change = await m.uninstallModule('m') as PublishedChange;
    vi.mocked(fs.openSync).mockRestore();
    expect(change).toMatchObject({ module: 'm', operation: 'uninstall', to: 'absent' });
    expect(change.applied?.text).toBe('m is uninstalled for every machine, but this machine could not remove it yet (ENOSPC: no space left on device, open); it tries again at the next pass.');
    expect(rig.state.rows.modules.has('m')).toBe(false);
  });
});

describe("R2-B2: a publish refuses a file path the migration's rule refuses", () => {
  const LONG = `${'a'.repeat(210)}.js`;
  const CAUSE = `the part "${'a'.repeat(40)}..." is 213 bytes; one part of a key holds at most 200`;

  it('an install: refused before anything is staged, nothing stored', async () => {
    clone({ ...V1, [`src/${LONG}`]: 'exports.x = 1;\n' });
    const m = new AppStoreManager();
    h.manager = m;
    await expect(m.installModule('m', REPO)).rejects.toThrow(`m was not installed: its file src/${LONG} cannot be stored for every machine (${CAUSE}), so nothing was changed.`);
    expect(rig.state.rows.modules.has('m')).toBe(false);
    expect(rig.state.rows.docs.has(INSTALLED)).toBe(false);
    expect(fs.readdirSync(rig.state.source)).toEqual([]);
  });

  it('an update: refused, the stored version and the folder in place untouched', async () => {
    const m = await installed({ ...V2, [`src/${LONG}`]: 'exports.x = 1;\n' });
    const result = await m.updateModule('m');
    expect(result).toEqual({ success: false, error: `m was not updated: its file src/${LONG} cannot be stored for every machine (${CAUSE}), so nothing was changed.` });
    expect(rig.state.rows.modules.get('m')?.sha).toBe(moduleShaOfFiles(V1));
    expect(rig.live('m')).toEqual(V1);
    expect(fs.readdirSync(rig.state.source).filter(n => n.startsWith('.incoming-'))).toEqual([]);
  });
});

describe('E2: the fetch writes every byte of a file or fails', () => {
  it('a write that takes part of a file is continued, so the apply swaps in the whole file', async () => {
    const sha = await rig.publish('m', V1);
    const write = fs.writeSync;
    const short: number[] = [];
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      if (short.length === 0 && Buffer.isBuffer(data) && data.toString('utf8') === V1['index.js']) {
        short.push(fd);
        return (write as any)(fd, data, Number(rest[0] ?? 0), 3);
      }
      return (write as any)(fd, data, ...rest);
    }) as typeof fs.writeSync);
    const result = await rig.apply('m', sha);
    vi.mocked(fs.writeSync).mockRestore();
    expect(short).toHaveLength(1);
    expect(result.outcome).toBe('applied');
    expect(rig.live('m')).toEqual(V1);
  });

  it('a write that takes no byte fails the fetch: nothing is swapped in', async () => {
    const sha = await rig.publish('m', V1);
    const write = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      if (Buffer.isBuffer(data) && data.toString('utf8').endsWith(V1['index.js'])) return 0;
      return (write as any)(fd, data, ...rest);
    }) as typeof fs.writeSync);
    const result = await rig.apply('m', sha);
    vi.mocked(fs.writeSync).mockRestore();
    expect(result).toMatchObject({ outcome: 'deferred', reason: 'fetch' });
    expect(rig.live('m')).toBeNull();
  });
});

/** One tick of the auto-updater's 30 minute interval; resolves once a line matching `until` is logged. */
async function tick(until: RegExp): Promise<void> {
  let run: (() => void) | null = null;
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { run = fn; return 0; }) as never);
  try {
    startModuleAutoUpdater({} as Client);
  } finally {
    spy.mockRestore();
  }
  run!();
  await vi.waitFor(() => { if (!rig.state.lines.some(l => until.test(l))) throw new Error(`no line ${until}`); }, { timeout: 10_000, interval: 5 });
  await new Promise(resolve => setImmediate(resolve));
}

const updaterLines = () => rig.state.lines.filter(l => l.startsWith('[ModuleAutoUpdater]') && !/Started|Stopped/.test(l));
/** The writer of installed.json and of m's row, as one publish transaction writes them (an uninstall deletes m's row). */
const storedBy = (by: string) => {
  rig.state.rows.docs.get(INSTALLED)!.updated_by = by;
  const row = rig.state.rows.modules.get('m');
  if (row) row.updated_by = by;
};

describe("E5: the auto-updater's lines after a refused update", () => {
  it('this machine stored the newer version meanwhile: the line says this machine', async () => {
    await installed(V2);
    await rig.publish('m', { ...V2, 'other.js': 'exports.o = 1;\n' }, '2.0.0');
    await tick(/was updated on|was not updated/);
    expect(updaterLines()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      '[ModuleAutoUpdater] m was updated on this machine meanwhile; applying that version',
    ]);
  });

  it('this machine changed only another module meanwhile: the line says this machine', async () => {
    await installed(V2);
    await rig.publish('y', { 'module.json': '{"name":"y","version":"1.0.0"}', 'index.js': 'exports.y = 1;\n' }, '1.0.0');
    await tick(/was updated on|was not updated/);
    expect(updaterLines()[1]).toBe('[ModuleAutoUpdater] m was not updated: the installed modules changed on this machine meanwhile; the next check tries again');
  });

  it('another machine uninstalled m meanwhile: the line names it and says m was uninstalled', async () => {
    await installed(V2);
    await rig.unpublish('m');
    storedBy('BRAVO/p-bravo');
    await tick(/was updated on|was not updated/);
    expect(updaterLines()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      '[ModuleAutoUpdater] m was not updated: it was uninstalled on BRAVO meanwhile',
    ]);
  });

  it('another machine updated m meanwhile: the line keeps "another machine"', async () => {
    await installed(V2);
    await rig.publish('m', { ...V2, 'other.js': 'exports.o = 1;\n' }, '2.0.0');
    storedBy('BRAVO/p-bravo');
    await tick(/was updated on|was not updated/);
    expect(updaterLines()[1]).toBe('[ModuleAutoUpdater] m was updated on another machine meanwhile; applying that version');
  });
});

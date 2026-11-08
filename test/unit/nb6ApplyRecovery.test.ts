import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 46 (wip-redesign/sheets/NB6.md decisions 45 (1), 58 and 66): the boot's recovery of an apply a crash cut
// off, `recoverModuleApplies` over entries and folders the real apply left. A crash is the process ending inside the
// apply: the fake load throws (nothing after it runs), or a store record write ends the process right after it lands.
// Rows 127, 128, 201 to 205 and 255. Row 301 is part 18's. Part 17 adds the property over every crash point: a wrapper
// around fs ends the process at the k-th file system step of the apply (and, for a second crash, at a step of the
// recovery); every later step of that process throws.

const h = vi.hoisted(() => ({
  killAfterWrite: null as null | ((record: any) => boolean),
  killBeforeWrite: null as null | ((record: any) => boolean),
  fs: {
    armed: false,
    steps: 0,
    killAt: 0,
    dead: false,
    ops: [] as Array<{ op: string; at: string }>,
    lockFds: new Set<number>(),
  },
}));

vi.mock('fs', async orig => {
  const real = await orig<typeof import('fs')>();
  const s = h.fs;
  const isLock = (target: unknown) => String(target).includes('.store.lock');
  // One file system step: the store lock's own file is the lock's, not the apply's, and never a crash point.
  const step = (op: string, target: unknown): void => {
    if (!s.armed) return;
    if (typeof target === 'number' ? s.lockFds.has(target) : isLock(target)) return;
    if (s.dead) throw Object.assign(new Error('the process ended'), { killed: true });
    s.steps += 1;
    if (s.steps === s.killAt) {
      s.dead = true;
      throw Object.assign(new Error('the process ended'), { killed: true });
    }
    s.ops.push({ op, at: typeof target === 'number' ? `fd ${target}` : String(target) });
  };
  const wrapped = {
    mkdirSync: ((p: any, o?: any) => { step('mkdir', p); return real.mkdirSync(p, o); }) as typeof real.mkdirSync,
    renameSync: ((a: any, b: any) => { step('rename', a); return real.renameSync(a, b); }) as typeof real.renameSync,
    rmSync: ((p: any, o?: any) => { step('rm', p); return real.rmSync(p, o); }) as typeof real.rmSync,
    cpSync: ((a: any, b: any, o?: any) => { step('cp', a); return real.cpSync(a, b, o); }) as typeof real.cpSync,
    unlinkSync: ((p: any) => { step('unlink', p); return real.unlinkSync(p); }) as typeof real.unlinkSync,
    chmodSync: ((p: any, m: any) => { step('chmod', p); return real.chmodSync(p, m); }) as typeof real.chmodSync,
    writeFileSync: ((p: any, d: any, o?: any) => { step('write', p); return real.writeFileSync(p, d, o); }) as typeof real.writeFileSync,
    writeSync: ((fd: number, ...rest: any[]) => { step('write', fd); return (real.writeSync as any)(fd, ...rest); }) as typeof real.writeSync,
    openSync: ((p: any, flags?: any, mode?: any) => {
      const writes = typeof flags === 'string' && /[wa+]/.test(flags);
      if (writes) step('open', p);
      const fd = real.openSync(p, flags, mode);
      if (s.armed && isLock(p)) s.lockFds.add(fd);
      return fd;
    }) as typeof real.openSync,
    closeSync: ((fd: number) => { s.lockFds.delete(fd); return real.closeSync(fd); }) as typeof real.closeSync,
  };
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string | Buffer, keep?: { mode: number; uid: number; gid: number }) => {
      const before = h.killBeforeWrite;
      if (before && String(file).endsWith('.shared-mirror.json') && String(file).includes('appstore') && before(JSON.parse(String(contents)))) {
        h.killBeforeWrite = null;
        throw Object.assign(new Error('the process ended'), { killed: true });
      }
      real.atomicWriteFileSync(file, contents, keep);
      const kill = h.killAfterWrite;
      if (kill && String(file).endsWith('.shared-mirror.json') && String(file).includes('appstore') && kill(JSON.parse(String(contents)))) {
        h.killAfterWrite = null;
        throw Object.assign(new Error('the process ended'), { killed: true });
      }
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import type { Client } from 'discord.js';
import { dataPath } from '../../src/utils/dataRoot';
import { applyRig, fakeLoader, reloaderFakes } from '../helpers/nb6ApplyRig';
import { _resetModuleApply, folderSha, recoverModuleApplies, setModuleApplyClient } from '../../src/bot/internalSetup/utils/moduleApply';
import {
  _resetModuleCrashes, closeWindow, countCrash, crashLineOf, openStarts, openWindow, startModule,
} from '../../src/bot/internalSetup/utils/moduleCrashes';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

class Killed extends Error {}

beforeEach(() => rig.setup());
afterEach(async () => {
  h.killAfterWrite = null;
  Object.assign(h.fs, { armed: false, dead: false, killAt: 0, steps: 0, ops: [] });
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

/** The apply of U cut off during its load (the process ended there); the next process starts. */
async function killedDuringLoad(u: string, extra = {}): Promise<void> {
  fakeLoader.duringLoad = () => { throw new Killed('the process ended'); };
  await expect(rig.apply('m', u, extra)).rejects.toThrow(Killed);
  fakeLoader.duringLoad = null;
  _resetModuleCrashes();
  rig.state.lines.length = 0;
}

describe('the boot recovery of an interrupted apply', () => {
  it('row 205: a crash before the source rename: the live folder holds from and is kept; build emptied and copied again; built null; T4', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'compiled S' });
    h.killAfterWrite = record => record.modules.m?.applying?.to === u;
    await expect(rig.apply('m', u)).rejects.toThrow('the process ended');
    expect(rig.entry('m')?.applying).toMatchObject({ from: s, to: u });
    _resetModuleCrashes();
    rig.state.lines.length = 0;
    recoverModuleApplies();
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.built('m')).toEqual(S_FILES);
    expect(rig.dist('m')).toBeNull();
    expect(rig.entry('m')).toMatchObject({ sha: s, built: null, failedSha: null });
    expect(rig.entry('m')?.applying ?? null).toBeNull();
    expect(shared()).toEqual(["[Shared] m: applying 2.0.0 was cut off when the bot process ended; kept the previous version in place. This machine applies the database's current version of m again at this start."]);
  });

  it('rows 127 and 203: the backup is gone and a cache/backups copy holds from: it is copied into place and stays; T4 names it', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const copy = path.join(rig.state.backups, 'm-1000');
    rig.writeTree(copy, S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await killedDuringLoad(u);
    const backup = rig.entry('m')!.applying!.backup!;
    fs.rmSync(backup, { recursive: true, force: true });
    recoverModuleApplies();
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.built('m')).toEqual(S_FILES);
    expect(rig.readTree(copy)).toEqual(S_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: s, built: null });
    expect(rig.backupsOf('m')).toEqual(expect.arrayContaining(['m-1000', expect.stringMatching(/^m-\d+-interrupted$/)]));
    expect(shared()).toEqual([`[Shared] m: applying 2.0.0 was cut off when the bot process ended; put back the previous version from ${copy}. This machine applies the database's current version of m again at this start.`]);
  });

  it('rows 128 and 204: no copy holds from (an -orphan one is never used): the entry goes, T5; the pass applies the row', async () => {
    const s = await rig.inPlace('m', S_FILES);
    rig.writeTree(path.join(rig.state.backups, 'm-1000-orphan'), S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await killedDuringLoad(u);
    fs.rmSync(rig.entry('m')!.applying!.backup!, { recursive: true, force: true });
    recoverModuleApplies();
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
    expect(rig.readTree(path.join(rig.state.backups, 'm-1000-orphan'))).toEqual(S_FILES);
    expect(shared()).toEqual(["[Shared] m: applying 2.0.0 was cut off when the bot process ended, and no copy of the previous version was found, so this machine has no copy of m. This machine applies the database's current version of m again at this start."]);
    await rig.pass();
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.entry('m')?.sha).toBe(u);
    expect(s).not.toBe(u);
  });

  it('row 202: displaced superseded (from absent), cut off after the swap: the _superseded folder stays, the new folder to -interrupted, the entry dropped, T4 "nothing was put back"', async () => {
    await rig.inPlace('m', S_FILES);
    fs.writeFileSync(path.join(rig.state.source, 'm', 'index.js'), 'edited by hand');
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await killedDuringLoad(u);
    const intent = rig.entry('m')!.applying!;
    expect(intent).toMatchObject({ from: 'absent', displaced: 'superseded' });
    recoverModuleApplies();
    expect(rig.readTree(intent.backup!)).toMatchObject({ 'index.js': 'edited by hand' });
    expect(rig.live('m')).toBeNull();
    expect(rig.built('m')).toBeNull();
    expect(rig.backupsOf('m')).toEqual([expect.stringMatching(/^m-\d+-interrupted$/)]);
    expect(rig.entry('m')).toBeUndefined();
    expect(shared()).toEqual(["[Shared] m: applying 2.0.0 was cut off when the bot process ended; nothing was put back: there was no previous version. This machine applies the database's current version of m again at this start."]);
  });

  it('row 201: killed during the recovery\'s own copy into build: applying stays set, and the next boot runs it again from an emptied build', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await killedDuringLoad(u);
    // The process ends before the recovery's entry write (58 e, its last): applying stays set.
    h.killBeforeWrite = record => !!record.modules.m && !record.modules.m.applying;
    recoverModuleApplies();
    h.killBeforeWrite = null;
    expect(rig.entry('m')?.applying).toMatchObject({ from: s, to: u });
    // A crash during the copy into build leaves part of a copy there; the next boot empties it first.
    fs.rmSync(path.join(rig.state.build, 'm'), { recursive: true, force: true });
    rig.writeTree(path.join(rig.state.build, 'm'), { 'half.js': 'half a copy' });
    rig.state.lines.length = 0;
    recoverModuleApplies();
    expect(rig.built('m')).toEqual(S_FILES);
    expect(rig.live('m')).toEqual(S_FILES);
    expect(rig.entry('m')).toMatchObject({ sha: s, built: null });
    expect(shared()).toEqual(["[Shared] m: applying 2.0.0 was cut off when the bot process ended; kept the previous version in place. This machine applies the database's current version of m again at this start."]);
  });

  it('row 255: a stop during a boot apply\'s load is not counted; the next boot recovers with T4 "when the bot process ended" and applies again', async () => {
    const s = await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    await killedDuringLoad(u, { reason: 'boot' });
    recoverModuleApplies();
    expect(rig.entry('m')).toMatchObject({ sha: s, failedSha: null, status: null });
    expect(shared()[0]).toMatch(/^\[Shared\] m: applying 2\.0\.0 was cut off when the bot process ended; put back the previous version from .+\. This machine applies the database's current version of m again at this start\.$/);
    await rig.pass();
    expect(rig.entry('m')?.sha).toBe(u);
  });
});

describe('the property over every crash point of the apply and of its recovery', () => {
  type Kind = 'backups' | 'superseded' | 'edited' | 'orphan';
  const KINDS: Kind[] = ['backups', 'superseded', 'edited', 'orphan'];
  const ORPHAN_FILES = { 'module.json': '{"name":"m","version":"0.9.0"}', 'index.js': 'exports.v = 0;\n' };
  const realCompile = reloaderFakes.recompileTypeScript;
  const steps = new Map<Kind, number>();

  afterEach(() => {
    reloaderFakes.recompileTypeScript = realCompile;
  });

  /** tsc as the apply and the boot run it: each module's build folder written into dist. */
  async function compile() {
    fakeLoader.compileCalls += 1;
    for (const name of fs.readdirSync(rig.state.build)) {
      fs.rmSync(path.join(rig.state.dist, name), { recursive: true, force: true });
      fs.cpSync(path.join(rig.state.build, name), path.join(rig.state.dist, name), { recursive: true });
    }
    return { success: true, duration: 0, diagnostics: [] };
  }

  function arm(killAt: number): void {
    Object.assign(h.fs, { armed: true, dead: false, killAt, steps: 0 });
  }

  /** Stops the wrapper; true when the process ended at a step. */
  function disarm(): boolean {
    const died = h.fs.dead;
    Object.assign(h.fs, { armed: false, dead: false, killAt: 0 });
    return died;
  }

  /** A new process: nothing of the old one's memory is left. */
  function reboot(): void {
    _resetModuleCrashes();
    _resetModuleApply();
    setModuleApplyClient({} as Client);
    rig.state.lines.length = 0;
  }

  const killed = (error: unknown) => (error as { killed?: boolean } | null)?.killed === true;

  /** A start of U counted at a stop, as guardUncaught counts it. */
  function stopCounted(u: string): void {
    const start = startModule('m', u, '2.0.0', path.join(rig.state.source, 'm'));
    if (typeof start === 'string') throw new Error(start);
    openWindow(start);
    countCrash(new Error('it stopped the bot'));
    closeWindow(start);
    openStarts.delete('m');
  }

  const protectedPath = (at: string) => {
    const parts = path.resolve(at).split(path.sep);
    return parts.includes('_superseded') || parts.some(p => p.endsWith('-orphan'));
  };

  async function setUp(kind: Kind, prior: number) {
    await rig.teardown();
    await rig.setup();
    reloaderFakes.recompileTypeScript = compile;
    let s0 = 'absent';
    if (kind === 'orphan') rig.writeTree(path.join(rig.state.source, 'm'), ORPHAN_FILES);
    else {
      s0 = await rig.inPlace('m', S_FILES);
      if (kind === 'edited') fs.writeFileSync(path.join(rig.state.source, 'm', 'index.js'), 'edited by hand');
    }
    const keptOrphan = rig.writeTree(path.join(rig.state.backups, 'm-1000-orphan'), S_FILES);
    const keptAside = rig.writeTree(dataPath('_superseded', 'shared-1000', 'appstore-modules', 'm'), S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    for (let i = 0; i < prior; i += 1) stopCounted(u);
    const extra = kind === 'superseded' ? { displaced: 'superseded' as const } : kind === 'orphan' ? { displaced: 'orphan' as const } : {};
    const filesOf = (sha: string) => (sha === u ? U_FILES : sha === s0 ? S_FILES : null);
    return { s0, u, extra, filesOf, keptOrphan, keptAside };
  }

  async function applyUntil(u: string, extra: object, killAt: number): Promise<boolean> {
    arm(killAt);
    try {
      await rig.apply('m', u, extra);
    } catch (error) {
      if (!killed(error)) throw error;
    }
    return disarm();
  }

  /** The apply's file system steps when nothing ends it. */
  async function stepsOf(kind: Kind): Promise<number> {
    const known = steps.get(kind);
    if (known !== undefined) return known;
    const { u, extra } = await setUp(kind, 0);
    arm(Number.POSITIVE_INFINITY);
    await rig.apply('m', u, extra);
    const n = h.fs.steps;
    disarm();
    steps.set(kind, n);
    return n;
  }

  /** The heldSha or failedSha of an entry names only a sha whose crash line reached 2. */
  function holdsOnlyCounted(entry: ReturnType<typeof rig.entry>): void {
    for (const sha of [entry?.failedSha, entry?.heldSha]) {
      if (!sha) continue;
      const line = crashLineOf('m');
      expect(line?.sha).toBe(sha);
      expect(line!.n).toBeGreaterThanOrEqual(2);
    }
  }

  async function crashAndRecover(kind: Kind, k: number, r: number, prior: number): Promise<void> {
    const { s0, u, extra, filesOf, keptOrphan, keptAside } = await setUp(kind, prior);
    h.fs.ops = [];
    const died = await applyUntil(u, extra, k);
    expect(died).toBe(true);
    reboot();

    // The copies the recovery may use: the live folder and the backups, never an -orphan or _superseded folder.
    const hasCopy = (sha: string) => sha !== 'absent' && [
      path.join(rig.state.source, 'm'),
      ...(fs.existsSync(rig.state.backups) ? fs.readdirSync(rig.state.backups).filter(n => !n.endsWith('-orphan')).map(n => path.join(rig.state.backups, n)) : []),
    ].some(dir => fs.existsSync(dir) && folderSha(dir) === sha);
    const cut = rig.entry('m');
    const A = cut?.applying ?? null;
    const fromHadCopy = A ? hasCopy(A.from) : false;

    arm(r > 0 ? r : Number.POSITIVE_INFINITY);
    try {
      recoverModuleApplies();
    } catch (error) {
      if (!killed(error)) throw error;
    }
    if (disarm()) {
      reboot();
      arm(Number.POSITIVE_INFINITY);
      recoverModuleApplies();
      disarm();
    }

    const recovered = rig.entry('m');
    expect(recovered?.applying ?? null).toBeNull();
    if (A) expect(recovered?.built ?? null).toBeNull();
    if (fromHadCopy) {
      expect(recovered?.sha).toBe(A!.from);
      expect(rig.live('m')).toEqual(filesOf(A!.from));
    }
    if (recovered && hasCopy(recovered.sha)) expect(rig.live('m')).not.toBeNull();
    holdsOnlyCounted(recovered);

    arm(Number.POSITIVE_INFINITY);
    if (recovered && recovered.built === null) await compile();
    disarm();
    const kept = recovered && recovered.sha !== 'absent' ? filesOf(recovered.sha) : null;
    expect(rig.built('m')).toEqual(kept);
    expect(rig.dist('m')).toEqual(kept);

    arm(Number.POSITIVE_INFINITY);
    await rig.pass();
    disarm();
    const after = rig.entry('m');
    expect(after?.applying ?? null).toBeNull();
    expect(after?.sha === u || after?.failedSha === u).toBe(true);
    holdsOnlyCounted(after);
    const now = after && after.sha !== 'absent' ? filesOf(after.sha) : null;
    expect(rig.live('m')).toEqual(now);
    expect(rig.built('m')).toEqual(now);
    expect(rig.dist('m')).toEqual(now);

    expect(h.fs.ops.filter(o => o.op !== 'mkdir' && o.op !== 'open' && o.op !== 'write' && protectedPath(o.at))).toEqual([]);
    expect(rig.readTree(keptOrphan)).toEqual(S_FILES);
    expect(rig.readTree(keptAside)).toEqual(S_FILES);
  }

  it('every crash point of the apply, for each displaced kind', async () => {
    for (const kind of KINDS) {
      const n = await stepsOf(kind);
      expect(n).toBeGreaterThan(5);
      for (let k = 1; k <= n; k += 1) {
        try {
          await crashAndRecover(kind, k, 0, 0);
        } catch (error) {
          throw new Error(`${kind}, crash at step ${k} of ${n}: ${(error as Error).message}`);
        }
      }
    }
  }, 300_000);

  it('any crash point of the apply, a second crash during the recovery, and the stops counted before', async () => {
    for (const kind of KINDS) await stepsOf(kind);
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...KINDS), fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 20 }), fc.constantFrom(0, 1, 2),
      async (kind, pick, r, prior) => {
        const n = steps.get(kind)!;
        await crashAndRecover(kind, 1 + ((pick - 1) % n), r, prior);
      },
    ), { numRuns: 80 });
  }, 300_000);
});

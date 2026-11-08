import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 62 (wip-redesign/sheets/NB6.md decisions 67, 78, 82, 89, 99, 101, 105 and 109): clientInitializer.ts's
// `runInitializers` at boot, after runBot's boot steps (the recovery, bootShared, the boot compile, loadModules with
// the real ModuleLoader and its load check), with fake modules whose command initializers return promises the row
// controls, under fake timers for the 60 s and 10 minute bounds. Entries from the real apply, crash lines from the real
// count. Rows 251, 252, 263, 264, 290 to 292, 294 to 298, 310, 341 (the applied half), 359, 367 to 369, 382 and 383,
// and test 60's row 384.

const h = vi.hoisted(() => ({
  manifests: (() => []) as () => string[],
  /** The next store record write that clears m's intent throws before it lands. */
  failFinishWrite: false,
  emit: (() => undefined) as () => void,
}));

vi.mock('dotenv/config', () => ({}));
// reloadModule calls the module's own recompileTypeScript: tsc's exec answers as the rig's compile does, after the emit.
vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  const exec = (command: string, options: any, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    if (!command.includes('tsc')) return (real.exec as any)(command, options, callback);
    h.emit();
    callback(null, '', '');
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), findModuleManifests: () => h.manifests() }));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', async orig => ({ ...(await orig<any>()), reRegisterSlashCommands: async () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string | Buffer, keep?: { mode: number; uid: number; gid: number }) => {
      if (h.failFinishWrite && String(file).endsWith('.shared-mirror.json') && String(file).includes('appstore') && !JSON.parse(String(contents)).modules.m?.applying) {
        h.failFinishWrite = false;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      real.atomicWriteFileSync(file, contents, keep);
    },
  };
});

import fs from 'fs';
import path from 'path';
import { bootRig, moduleFiles } from '../helpers/nb6BootRig';
import {
  _resetModuleCrashes, bootStartOf, closeWindow, countCrash, lateStarts, openStarts, openWindow, startEnds, starting, startModule,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { reloadModule } from '../../src/bot/internalSetup/utils/moduleReloader';

const rig = bootRig();
const TODAY = (name: string) => `[Initializer] Error running initialize function for module: ${name}`;

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
  h.emit = rig.emit;
  h.failFinishWrite = false;
});
afterEach(async () => {
  vi.useRealTimers();
  await rig.teardown();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One crash of the module's sha counted in an earlier process, while a window of it was open. */
function countedOnce(module: string, sha: string, version: string): void {
  const start = startModule(module, sha, version, path.join(rig.apply.state.dist, module), { boot: true });
  if (typeof start === 'string') throw new Error(start);
  openWindow(start);
  countCrash(new Error('it stopped the bot'));
  closeWindow(start);
  _resetModuleCrashes();
}

/** S in place, U published and swapped in at this boot; U's code from `code`. */
async function appliedThisBoot(code: Parameters<typeof rig.code.set>[1], opts: { countU?: boolean } = {}) {
  const s = await rig.inPlace('m', '1.0.0');
  const u = await rig.publish('m', '2.0.0');
  if (opts.countU) countedOnce('m', u, '2.0.0');
  rig.code.set('m@2.0.0', code);
  await rig.boot();
  expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
  const backup = rig.apply.entry('m')!.applying!.backup!;
  rig.apply.state.lines.length = 0;
  return { s, u, backup };
}

describe('a module this boot applied (67, 78, 89)', () => {
  it('290: its promises all settle within 60 s with none rejected: step 6, the applied status, the backup rule, its line of to deleted', async () => {
    const { u, backup } = await appliedThisBoot({ initialize: [() => Promise.resolve()] }, { countU: true });
    expect(rig.crashLines().m).toMatchObject({ sha: u, n: 1 });
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null, built: { sha: u, buildId: null } });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: u })]);
    expect(fs.existsSync(backup)).toBe(false);
    expect(rig.crashLines().m).toBeUndefined();
  });

  it('292: no attributed initializer: the entry, status and backup rule at its empty turn, not at the load check', async () => {
    const { u, backup } = await appliedThisBoot({});
    expect(fs.existsSync(backup)).toBe(true);
    await rig.turns();
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
    expect(fs.existsSync(backup)).toBe(false);
  });

  it('251: an initializer promise rejects: unloaded, put back, the previous version loaded with its initializers; T1; a failed status', async () => {
    const { s, u } = await appliedThisBoot({ initialize: [() => Promise.reject(new Error('the initializer gave up'))] });
    rig.fakeLoader.loads = [];
    await rig.turns();
    await vi.waitFor(() => expect(rig.apply.entry('m')?.applying ?? null).toBeNull());
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u });
    expect(rig.fakeLoader.loads).toEqual([{ module: 'm', sha: s }]);
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '1.0.0'));
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'failed', sha: u, error: 'the initializer gave up' })]);
    expect(rig.apply.state.lines.some(l => /^\[Shared\] m 2\.0\.0 from .+ failed to load on this machine \(the initializer gave up\); this machine keeps the previous version/.test(l))).toBe(true);
    expect(rig.apply.state.lines.filter(l => l.startsWith(TODAY('m-cmd0')))).toEqual([]);
  });

  it("294 and 295: past 60 s: T27 with the applying tail, the next turn begins, applying kept, a late start, the line kept; then they settle: step 6, the line deleted", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred();
    const { u, backup } = await appliedThisBoot({ initialize: [() => pending.promise] }, { countU: true });
    rig.code.set('n@1.0.0', { initialize: [() => undefined] });
    const turns = rig.turns();
    await vi.advanceTimersByTimeAsync(60_001);
    await turns;
    expect(rig.apply.state.lines).toContain("[Initializer] m's initializers did not finish within 60 s; the bot goes on with the other modules and waits up to 10 minutes for them; this machine finishes applying 2.0.0 when they finish without an error, or at 10 minutes; an error makes it keep the previous version");
    expect(rig.apply.entry('m')?.applying).toMatchObject({ to: u });
    expect(lateStarts().map(st => st.sha)).toEqual([u]);
    expect(starting.size).toBe(0);
    expect(rig.crashLines().m).toMatchObject({ sha: u, n: 1 });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(rig.apply.entry('m')?.applying ?? null).toBeNull());
    expect(rig.apply.entry('m')).toMatchObject({ sha: u });
    expect(fs.existsSync(backup)).toBe(false);
    expect(rig.crashLines().m).toBeUndefined();
    expect(lateStarts()).toEqual([]);
  });

  it("296: that module's late promise then rejects: 67's failure path", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred();
    const { s, u } = await appliedThisBoot({ initialize: [() => pending.promise] });
    const turns = rig.turns();
    await vi.advanceTimersByTimeAsync(60_001);
    await turns;
    pending.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(rig.apply.entry('m')?.applying ?? null).toBeNull());
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u });
    expect(rig.apply.state.lines.some(l => /^\[Shared\] m 2\.0\.0 from .+ failed to load on this machine \(late failure\)/.test(l))).toBe(true);
  });

  it('298: its promises still open at 10 minutes: T29 with its tail; step 6; the line deleted; a later rejection logs only today\'s line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred();
    const { u } = await appliedThisBoot({ initialize: [() => pending.promise] }, { countU: true });
    const turns = rig.turns();
    await vi.advanceTimersByTimeAsync(60_001);
    await turns;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(rig.apply.entry('m')?.applying ?? null).toBeNull());
    expect(rig.apply.state.lines).toContain("[Initializer] m's initializers did not finish within 10 minutes; the bot counts m as started and keeps 2.0.0");
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, failedSha: null });
    expect(rig.crashLines().m).toBeUndefined();
    const before = rig.apply.state.lines.length;
    pending.reject(new Error('far too late'));
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.apply.state.lines.slice(before)).toEqual([expect.stringContaining(TODAY('m-cmd0'))]);
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, failedSha: null });
  });

  it('263: while its start is open, the pass skips it and an apply ends deferred starting', async () => {
    const pending = deferred();
    const { u } = await appliedThisBoot({ initialize: [() => pending.promise] });
    const u3 = await rig.publish('m', '3.0.0');
    await rig.apply.pass();
    expect(rig.apply.entry('m')?.applying).toMatchObject({ to: u });
    expect(await rig.apply.apply('m', u3, { version: '3.0.0' })).toMatchObject({ outcome: 'deferred', reason: 'starting', state: 'c' });
    const turns = rig.turns();
    await vi.waitFor(() => expect(bootStartOf('m')?.turnAt).not.toBeNull());
    expect(await rig.apply.apply('m', u3, { version: '3.0.0' })).toMatchObject({ outcome: 'deferred', reason: 'starting', state: 'a' });
    pending.resolve();
    await turns;
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
  });

  it('264: the clientReady handler returned early: nothing written, applying kept, no line deleted; the restart recovers and applies again', async () => {
    const { s, u } = await appliedThisBoot({}, { countU: true });
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    expect(rig.crashLines().m).toMatchObject({ sha: u, n: 1 });
    await rig.boot();
    expect(rig.apply.state.lines.some(l => l.startsWith('[Shared] m: applying 2.0.0 was cut off when the bot stopped while it was starting 2.0.0; put back the previous version from'))).toBe(true);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    expect(rig.loaded()).toEqual(['m@2.0.0']);
  });
});

describe('a module not applied this boot', () => {
  it("252 and 291: a rejected initializer promise: today's line, the module stays loaded, the next turn runs; its line of that sha deleted", async () => {
    const s = await rig.inPlace('m', '1.0.0');
    countedOnce('m', s, '1.0.0');
    rig.code.set('m@1.0.0', { initialize: [() => Promise.reject(new Error('it gave up'))] });
    const ran: string[] = [];
    await rig.inPlace('n', '1.0.0');
    rig.code.set('n@1.0.0', { initialize: [() => { ran.push('n'); }] });
    await rig.boot();
    expect(rig.crashLines().m).toMatchObject({ sha: s, n: 1 });
    await rig.turns();
    expect(rig.apply.state.lines.some(l => l.startsWith(TODAY('m-cmd0')))).toBe(true);
    expect(rig.loaded()).toEqual(['m@1.0.0', 'n@1.0.0']);
    expect(ran).toEqual(['n']);
    expect(rig.crashLines().m).toBeUndefined();
    expect(openStarts.size).toBe(0);
  });

  it("297: a rejection after 60 s: today's line, the line deleted, it stays loaded", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await rig.inPlace('m', '1.0.0');
    countedOnce('m', s, '1.0.0');
    const pending = deferred();
    rig.code.set('m@1.0.0', { initialize: [() => pending.promise] });
    await rig.boot();
    const turns = rig.turns();
    await vi.advanceTimersByTimeAsync(60_001);
    await turns;
    expect(rig.apply.state.lines).toContain("[Initializer] m's initializers did not finish within 60 s; the bot goes on with the other modules and waits up to 10 minutes for them");
    pending.reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(rig.crashLines().m).toBeUndefined());
    expect(rig.apply.state.lines.some(l => l.startsWith(TODAY('m-cmd0')))).toBe(true);
    expect(rig.loaded()).toEqual(['m@1.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: null });
  });
});

describe('the turns themselves', () => {
  it("310: a handler another module's late initializer registers while this module's promises are awaited is not filed under this module", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const buttons = new Map<string, { _moduleName?: string }>();
    (rig.client as any).buttonHandlers = buttons;
    const aLate = deferred();
    const bWait = deferred();
    await rig.inPlace('a', '1.0.0');
    await rig.inPlace('b', '1.0.0');
    rig.code.set('a@1.0.0', { initialize: [() => { buttons.set('a-own', {}); return aLate.promise.then(() => { buttons.set('a-late', {}); }); }] });
    rig.code.set('b@1.0.0', { initialize: [() => { buttons.set('b-own', {}); return bWait.promise; }] });
    await rig.boot();
    const turns = rig.turns();
    await vi.advanceTimersByTimeAsync(60_001);
    aLate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    bWait.resolve();
    await turns;
    const reg = getModuleRegistry();
    expect(reg.getModule('a')!.registeredInteractionIds!.buttons).toEqual(['a-own']);
    expect(reg.getModule('b')!.registeredInteractionIds!.buttons).toEqual(['b-own']);
    await reg.unloadModule('b');
    expect(buttons.has('a-late')).toBe(true);
    delete (rig.client as any).buttonHandlers;
  });

  it("367: a throw in a module's turn outside its initializers ends its start { rejected }: an applied one takes 67's failure path; another stays loaded; the next turn runs", async () => {
    const boom = { on: false };
    const map = new Map<string, unknown>();
    Object.defineProperty(rig.client, 'buttonHandlers', {
      configurable: true,
      get() {
        if (boom.on) {
          boom.on = false;
          throw new Error('the bookkeeping failed');
        }
        return map;
      },
    });
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    await rig.inPlace('n', '1.0.0');
    await rig.inPlace('z', '1.0.0');
    const ran: string[] = [];
    rig.code.set('m@2.0.0', { initialize: [() => { boom.on = true; }] });
    rig.code.set('n@1.0.0', { initialize: [() => { boom.on = true; }] });
    rig.code.set('z@1.0.0', { initialize: [() => { ran.push('z'); }] });
    await rig.boot();
    await rig.turns();
    await vi.waitFor(() => expect(rig.apply.entry('m')?.applying ?? null).toBeNull());
    expect(rig.apply.entry('m')).toMatchObject({ sha: s, failedSha: u });
    expect(rig.apply.state.lines.some(l => /^\[Shared\] m 2\.0\.0 from .+ failed to load on this machine \(the bookkeeping failed\)/.test(l))).toBe(true);
    expect(rig.apply.state.lines.some(l => l.startsWith(TODAY('n')))).toBe(true);
    expect(getModuleRegistry().getModule('n')).toBeDefined();
    expect(ran).toEqual(['z']);
    delete (rig.client as any).buttonHandlers;
  });

  it('368: no module collected an initializer: every loaded module gets its empty turn and every boot start ends; an applied one gets step 6 there', async () => {
    await rig.inPlace('a', '1.0.0');
    await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    await rig.boot();
    expect([...openStarts.keys()].sort()).toEqual(['a', 'm']);
    await rig.turns();
    expect(openStarts.size).toBe(0);
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
  });

  it('369: a null-sha boot start replaced by a reload before its turn: its initializers run as at caf9a25, with no window, bound or late task', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rig.apply.writeTree(path.join(rig.apply.state.dist, 'plain'), moduleFiles('plain', '1.0.0'));
    const seen: number[] = [];
    rig.code.set('plain@1.0.0', { initialize: [() => { seen.push(starting.size); return new Promise(() => undefined); }] });
    await rig.boot();
    const boot = bootStartOf('plain')!;
    expect(boot.sha).toBeNull();
    const reload = startModule('plain', null, '1.0.0', path.join(rig.apply.state.dist, 'plain'));
    expect(openStarts.get('plain')).toBe(reload);
    await rig.turns();
    expect(seen).toEqual([0]);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(rig.apply.state.lines.filter(l => l.includes("plain's initializers did not finish"))).toEqual([]);
    expect(openStarts.get('plain')).toBe(reload);
  });

  it("359: a boot start's late task throws: T33 with its tail, no exit, startEnds 'failed' while the entry keeps applying", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred();
    const { u } = await appliedThisBoot({ initialize: [() => pending.promise] });
    const turns = rig.turns();
    await vi.advanceTimersByTimeAsync(60_001);
    await turns;
    h.failFinishWrite = true;
    pending.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(startEnds.get('m')).toBe('failed'));
    expect(rig.apply.state.lines).toContain('[Error] m: finishing its start failed (ENOSPC: no space left on device, write); the bot finishes it at its next start, and until then this machine applies no change of m');
    expect(rig.apply.entry('m')?.applying).toMatchObject({ to: u });
  });
});

describe("45 (6)'s f hands its start to the turn (105)", () => {
  async function failedBootApply() {
    const s = await rig.inPlace('m', '1.0.0');
    countedOnce('m', s, '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    rig.code.set('m@2.0.0', { loadThrows: new Error('index.js threw: boom') });
    return { s, u };
  }

  it("382 and 341 (the applied half): U's load throws; f loads S and hands its start; S's turn runs in its window with the bound and ends it; the line deleted", async () => {
    const { s } = await failedBootApply();
    const seen: Array<{ sha: string | null; size: number }> = [];
    rig.code.set('m@1.0.0', { initialize: [() => { seen.push({ sha: [...starting][0]?.sha ?? null, size: starting.size }); }] });
    await rig.boot();
    const handed = bootStartOf('m')!;
    expect(handed.sha).toBe(s);
    expect(openStarts.get('m')).toBe(handed);
    expect(rig.crashLines().m).toMatchObject({ sha: s, n: 1 });
    await rig.turns();
    expect(seen).toEqual([{ sha: s, size: 1 }]);
    expect(openStarts.has('m')).toBe(false);
    expect(rig.crashLines().m).toBeUndefined();
  });

  it('383: after 382, an apply of the module and a reload of it run, not deferred or refused', async () => {
    const { u } = await failedBootApply();
    await rig.boot();
    await rig.turns();
    rig.code.delete('m@2.0.0');
    const reload = await reloadModule(rig.client, 'm');
    expect(reload).toMatchObject({ success: true });
    const applied = await rig.apply.apply('m', u, { version: '2.0.0' });
    expect(applied.outcome).not.toBe('deferred');
  });

  it("test 60's row 384: an uncaught error in S's turn window after 382 is counted against S's sha", async () => {
    const { s } = await failedBootApply();
    const seen: unknown[] = [];
    rig.code.set('m@1.0.0', { initialize: [() => { countCrash(new Error('S threw')); seen.push(rig.crashLines().m); }] });
    await rig.boot();
    await rig.turns();
    expect(seen).toEqual([expect.objectContaining({ sha: s, n: 2, error: 'S threw' })]);
  });
});

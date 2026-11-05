import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 3, the fixer's regression tests: each case fails on the build the round reviewed.

const h = vi.hoisted(() => ({
  failRead: new Map<string, string>(),
  holdRename: null as null | { target: string; promise: Promise<void> },
}));

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const promises = {
    ...real.promises,
    rename: async (from: any, to: any) => {
      const hold = h.holdRename;
      if (hold && path.resolve(String(to)) === hold.target) await hold.promise;
      return real.promises.rename(from, to);
    },
  };
  const wrapped = { ...real, promises };
  return { ...wrapped, default: wrapped };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    readRawStrict: (p: string) => {
      const errno = h.failRead.get(path.resolve(p));
      if (errno) {
        h.failRead.delete(path.resolve(p));
        throw Object.assign(new Error(`${errno}: refused`), { code: errno });
      }
      return real.readRawStrict(p);
    },
  };
});

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { cancelQueued, enqueueWrite, fileFlushOnTheWire, flushAll as flushFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flushAll, reopenSharedWrites, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { applyOperatorGlobalRead, CHANGED_SINCE_OPEN_TEXT } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { BotManager, deposedRouteText } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { dataPath } from '../../src/utils/dataRoot';
import { put, readJson, resetData, startApp } from '../helpers/configRig';
import { forks } from '../helpers/forkMock';
import { mount } from '../helpers/jsxRig';
import { readSourceText } from '../helpers/sourceText';
import { answering, exitChild, freshWriterLock, logged, report, resetForks, startedWith, tick } from '../helpers/nb10Rig';
import { clearGlobal, DUMMY_STATE, PREMIUM, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.failRead.clear();
  h.holdRename = null;
  delete process.env.BOT_PROCESS_ROLE;
  resetForks();
  freshWriterLock('webui', new Set([process.pid, 4848]));
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  clearGlobal();
});

afterEach(async () => {
  h.holdRename = null;
  h.failRead.clear();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  resetPremiumManager();
  for (const p of reg.current?.listAll() ?? []) (p as any).dispose?.();
  reg.current = null;
  setSharedWriteGate(null);
  reopenSharedWrites();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await settleQueue();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a read error while the web UI checks premium-tiers.json for changes (D1)', () => {
  it('keeps the loaded cache object and logs the cause once', () => {
    writePremium();
    const pm = getPremiumManager();
    expect(pm.getTier('high')?.displayName).toBe('High');
    const cache = (pm as any).config;
    h.failRead.set(path.resolve(PREMIUM), 'EMFILE');
    pm.resolveActiveTier('g1');
    expect((pm as any).config).toBe(cache);
    h.failRead.set(path.resolve(PREMIUM), 'EMFILE');
    pm.resolveActiveTier('g1');
    expect((pm as any).config).toBe(cache);
    expect(logged(errors).filter(l => l.includes('premium-tiers.json could not be read to check for changes (EMFILE)'))).toHaveLength(1);
  });

  it('while the web UI holds the writer lock, neither a read error nor a changed file replaces the cache', () => {
    writePremium();
    const pm = getPremiumManager();
    expect(takeWriterLock().kind).toBe('taken');
    pm.resolveActiveTier('g1');
    const cache = (pm as any).config;
    h.failRead.set(path.resolve(PREMIUM), 'EIO');
    pm.resolveActiveTier('g1');
    fs.writeFileSync(PREMIUM, JSON.stringify({ tiers: {} }));
    pm.resolveActiveTier('g1');
    expect((pm as any).config).toBe(cache);
    releaseWriterLock();
  });

  it('outside a hold, a changed file is still reloaded', () => {
    writePremium();
    const pm = getPremiumManager();
    pm.resolveActiveTier('g1');
    const cache = (pm as any).config;
    writePremium({}, { messages: { moduleBlocked: 'changed' } });
    pm.resolveActiveTier('g1');
    expect((pm as any).config).not.toBe(cache);
  });

  it('the Dummy provider keeps its loaded state on a read error', async () => {
    const dummy = new DummyProvider();
    dummy.adminSetVariant({ variantId: 'kept', label: 'K', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true } as any);
    await settleQueue();
    const state = (dummy as any).state;
    h.failRead.set(path.resolve(DUMMY_STATE), 'EMFILE');
    expect(dummy.adminListVariants().some(v => v.variantId === 'kept')).toBe(true);
    expect((dummy as any).state).toBe(state);
    expect(dummy.cannotReadText()).toBeNull();
    expect(logged(errors).some(l => l.includes('could not be read to check for changes (EMFILE)'))).toBe(true);
  });
});

describe("a deposition's cancel with a flush on the wire (D2)", () => {
  const A = () => path.resolve(dataPath('global', 'nb10fix3', 'a.json'));
  const B = () => path.resolve(dataPath('global', 'nb10fix3', 'b.json'));

  afterEach(() => {
    // A take forgets the deposition, so later cases run as a process that holds nothing.
    freshWriterLock('webui', new Set([process.pid, 4848]));
    expect(takeWriterLock().kind).toBe('taken');
    releaseWriterLock();
  });

  async function holdA(): Promise<() => void> {
    let open!: () => void;
    h.holdRename = { target: A(), promise: new Promise<void>(resolve => { open = resolve; }) };
    enqueueWrite(A(), '{"a":1}');
    for (let i = 0; i < 200 && !fileFlushOnTheWire(); i++) await tick(2);
    expect(fileFlushOnTheWire()).toBe(true);
    return open;
  }

  it('with freeze, a path queued beside the one on the wire never reaches the disk', async () => {
    const open = await holdA();
    enqueueWrite(B(), '{"b":1}');
    const done = cancelQueued([A(), B()], undefined, { freeze: true });
    await tick(20);
    expect(fs.existsSync(B())).toBe(false);
    open();
    const results = await done;
    await flushFiles();
    expect(results.find(r => r.path === B())).toMatchObject({ outcome: 'cancelled' });
    expect(results.find(r => r.path === A())).toMatchObject({ outcome: 'landed' });
    expect(fs.existsSync(B())).toBe(false);
    expect(fs.readFileSync(A(), 'utf8')).toBe('{"a":1}');
  });

  it('a deposition through the holder check logs the queued path as not saved and leaves it off the disk', async () => {
    expect(takeWriterLock().kind).toBe('taken');
    const open = await holdA();
    enqueueWrite(B(), '{"b":1}');
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4848, start: null, role: 'import', at: Date.now() }));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    await tick(20);
    expect(fs.existsSync(B())).toBe(false);
    open();
    for (let i = 0; i < 200 && fileFlushOnTheWire(); i++) await tick(2);
    await tick(10);
    await flushFiles();
    expect(fs.existsSync(B())).toBe(false);
    expect(logged(errors).some(l => l.includes(`Not saved: ${B()}`))).toBe(true);
    expect(logged(errors).some(l => l.includes(`Not saved: ${A()}`))).toBe(false);
  });
});

describe('the data editor save of a global file changed before the executor ran (D3)', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => { await close?.(); close = null; });

  it('answers 409 changed-since-open and keeps the module write', async () => {
    await resetData();
    const file = dataPath('global', 'mod', 'x.json');
    put(file, { a: 1 });
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    answering(child, m => {
      if (m.type === 'data:global-read') return applyOperatorGlobalRead(m.data);
      if (m.type === 'shared:op') {
        put(file, { a: 1, module: true });
        return applySharedOp(m.data);
      }
      return undefined;
    });
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
    close = app.close;
    const call = async (method: string, route: string, body?: unknown) => {
      const res = await fetch(`${app.url}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    const loaded = await call('GET', '/api/config/data/get?file=mod/x.json');
    expect(typeof loaded.body.sha).toBe('string');
    const saved = await call('POST', '/api/config/data/update', { file: 'mod/x.json', data: { a: 2 }, loadedSha: loaded.body.sha });
    expect(saved).toMatchObject({ status: 409, body: { success: false, error: CHANGED_SINCE_OPEN_TEXT } });
    await flushAll();
    expect(readJson(file)).toEqual({ a: 1, module: true });
  });
});

const PANEL = fileURLToPath(new URL('../../src/webui/public/components/BotControlPanel.jsx', import.meta.url));

function panelHelper(): (info: any) => string | null {
  const compiled = ts.transpileModule(fs.readFileSync(PANEL, 'utf-8'), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function('React', `${compiled}\nreturn botDataFilesText;`)({});
}

function statusText(status: any): string {
  const panel = mount(PANEL, 'BotControlPanel', { status, onStart: () => undefined, onRestart: () => undefined, onShutdown: () => undefined, loading: false, configured: true, containerRestarting: false }, {});
  const items = panel.all(el => el.props?.className === 'info-item');
  return panel.text(items[0]);
}

describe('the panel while the bot process waits for the data files (O1)', () => {
  it('a child waiting for a disk that takes no writes: the start answer gives the wait text and the panel shows it, not Running', async () => {
    forks.onFork = child => { setTimeout(() => report(child, { stage: 'waiting', cause: 'EROFS' }), 1); };
    forks.holdExit = true;
    const manager = new BotManager();
    const answer = await manager.start();
    forks.onFork = null;
    expect(answer).toMatchObject({ success: true, cannotLock: 'EROFS' });
    const text = panelHelper()(answer);
    expect(text).toBe('Waiting for the data disk to take writes (/data/.writer.lock: EROFS); check the disk');
    const shown = statusText(manager.getStatus());
    expect(shown).toContain(text!);
    expect(shown).not.toContain('Running');
  });

  it('a child waiting for another holder, one that cannot read the lock, and a deposed child', () => {
    const words = panelHelper();
    expect(words({ waitingFor: { role: 'import', pid: 9 } })).toBe('Waiting for a data bundle import (pid 9) to release the data files');
    expect(words({ cannotRead: 'EACCES' })).toBe('Cannot read /data/.writer.lock (EACCES); check that the bot can read that file');
    expect(words({ success: true })).toBeNull();
    expect(statusText({ running: true, uptime: 3, crashed: false, mode: 'deposed', dataFiles: null })).toContain('Stopping: another process took the data files');
    expect(statusText({ running: true, uptime: 3, crashed: false, mode: 'running', dataFiles: null })).toContain('Running');
  });

  it("app.jsx's start does not toast a successful start for an answer that names a wait", () => {
    const app = readSourceText(path.dirname(fileURLToPath(import.meta.url)), '../../src/webui/public/app.jsx');
    const start = app.slice(app.indexOf('async function startBot()'), app.indexOf('async function restartBot('));
    expect(start.indexOf('botDataFilesText(res)')).toBeGreaterThan(-1);
    expect(start.indexOf('botDataFilesText(res)')).toBeLessThan(start.indexOf("'Bot started successfully!'"));
  });
});

describe('a deposed child during its stop (O2)', () => {
  async function deposedChild() {
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    report(child, { stage: 'deposed', holder: { role: 'import', pid: 4848 } });
    return { manager, child };
  }

  it('requests and reads answer the deposed text, not the starting text', async () => {
    const { manager } = await deposedChild();
    await expect((manager as any).sendIPCMessage('panel:list', {})).rejects.toThrow(
      'The bot process is stopping: another process (a data bundle import, pid 4848) took the data files; nothing was sent to it.');
    const read = await manager.readGlobalData({ root: 'config' });
    expect(read).toEqual({ ok: false, code: 'starting', error: deposedRouteText({ role: 'import', pid: 4848 }) });
    expect(manager.getStatus().mode).toBe('deposed');
  });

  it("maintenance answers at once with can't confirm, never saved", async () => {
    const { manager } = await deposedChild();
    const started = Date.now();
    const entered = await manager.enterMaintenance('m');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(entered.saved).toBeNull();
    expect(entered.note).toBe("The bot process is stopping: another process (a data bundle import, pid 4848) took the data files; can't confirm whether it holds unsaved changes");
    const left = await manager.leaveMaintenance();
    expect(left.restarting).toBeNull();
    expect(left.note).toContain('took the data files');
    expect(left.note).not.toContain('starting');
  });
});

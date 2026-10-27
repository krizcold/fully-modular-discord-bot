import fs from 'fs';
import vm from 'vm';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';
import { describe, expect, it, vi } from 'vitest';

// R13-J10: the App Store card's Uninstall, and an uninstall Retry, confirm as the detail view does; installJobs is
// keyed by job id, and a failed uninstall another session started offers no one-click Retry.

const FILE = new URL('../../src/webui/public/components/AppStorePanel.jsx', import.meta.url);

interface El { type: unknown; props: Record<string, any>; children: unknown[] }

function load(confirmAnswer: boolean) {
  const code = transformSync(fs.readFileSync(FILE, 'utf-8'), {
    presets: [[presetReact, { runtime: 'classic' }]], babelrc: false, configFile: false,
  })!.code!;
  const api = {
    delete: vi.fn(async () => ({ success: true, jobId: 'op-new' })),
    post: vi.fn(async () => ({ success: true, jobId: 'op-new' })),
    get: vi.fn(() => new Promise(() => {})),
  };
  const confirm = vi.fn(() => confirmAnswer);
  const React = {
    useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
    useEffect: () => {},
    useRef: (v: unknown) => ({ current: v }),
    Fragment: 'Fragment',
    createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): El => ({ type, props: props || {}, children }),
  };
  const ctx: Record<string, any> = { React, api, confirm, showToast: vi.fn(), wsClient: { on: () => () => {} }, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, api, confirm };
}

const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'children' in (n as object) && 'props' in (n as object);

function flat(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const c of node) flat(c, out); return out; }
  if (!isEl(node)) return out;
  out.push(node);
  flat(node.children, out);
  return out;
}

function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return isEl(node) ? text(node.children) : '';
}

const buttons = (tree: unknown) => flat(tree).filter(e => e.type === 'button');
const button = (tree: unknown, label: string) => buttons(tree).find(b => text(b).trim() === label);
const click = async (b: El | undefined) => { await b!.props.onClick({ stopPropagation() {} }); };

const MOD = { name: 'm1', displayName: 'Mod One', repoId: 'r1' };
const job = (id: string, kind: string, status: string, enqueuedAt: number) => ({ id, kind, moduleName: 'm1', status, enqueuedAt });

function card(ctx: Record<string, any>, props: Record<string, unknown>) {
  return ctx.ModuleCard({ module: MOD, installed: true, installedEntry: { name: 'm1' }, jobs: [], ownJobIds: new Set(), onJobQueued: vi.fn(), onClick() {}, tiers: {}, ...props });
}

describe('the card asks before an uninstall', () => {
  it('sends nothing when the operator declines the Uninstall confirm', async () => {
    const { ctx, api, confirm } = load(false);
    await click(button(card(ctx, {}), 'Uninstall'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('names the files, the saved credentials and the component settings in the confirm', async () => {
    const { ctx, confirm } = load(false);
    await click(button(card(ctx, {}), 'Uninstall'));
    expect(confirm).toHaveBeenCalledWith("Uninstall Mod One? This removes the module's files, its saved credentials and its component settings.");
  });

  it('queues the uninstall once confirmed and records the job as this session\'s', async () => {
    const { ctx, api } = load(true);
    const onJobQueued = vi.fn();
    await click(button(card(ctx, { onJobQueued }), 'Uninstall'));
    expect(api.delete).toHaveBeenCalledWith('/appstore/modules/m1');
    expect(onJobQueued).toHaveBeenCalledWith('op-new');
  });

  it('asks the same question in the detail view', async () => {
    const { ctx, confirm } = load(false);
    const tree = ctx.ModuleDetailView({ module: MOD, installed: { name: 'm1' }, jobs: [], ownJobIds: new Set(), onJobQueued: vi.fn(), onBack() {}, showSuccess() {}, setError() {} });
    await click(button(tree, 'Uninstall'));
    expect(confirm).toHaveBeenCalledWith("Uninstall Mod One? This removes the module's files, its saved credentials and its component settings.");
  });
});

describe('a failed uninstall on the card', () => {
  it('this session started is retried by a "Retry uninstall" button that confirms first', async () => {
    const { ctx, api, confirm } = load(false);
    const tree = card(ctx, { jobs: [job('op-1', 'uninstall', 'failed', 1)], ownJobIds: new Set(['op-1']) });
    const retry = button(tree, 'Retry uninstall');
    expect(retry).toBeDefined();
    await click(retry);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('another session started shows as failed elsewhere, with no Retry', () => {
    const { ctx } = load(false);
    const tree = card(ctx, { jobs: [job('op-1', 'uninstall', 'failed', 1)], ownJobIds: new Set() });
    expect(buttons(tree).map(b => text(b).trim()).filter(l => /retry/i.test(l))).toEqual([]);
    expect(text(tree)).toContain('Uninstall failed (started elsewhere)');
    expect(button(tree, 'Uninstall')).toBeDefined();
  });
});

describe('installJobs keyed by job id', () => {
  it('keeps an uninstall queued behind a running install, and a completion removes only its own job', () => {
    const { ctx } = load(false);
    let jobs = ctx.appStoreApplyJobEvent({}, 'pending', job('a', 'install', 'running', 1));
    jobs = ctx.appStoreApplyJobEvent(jobs, 'pending', job('b', 'uninstall', 'queued', 2));
    expect(Object.keys(jobs).sort()).toEqual(['a', 'b']);
    jobs = ctx.appStoreApplyJobEvent(jobs, 'completed', job('a', 'install', 'completed', 1));
    expect(Object.keys(jobs)).toEqual(['b']);
    jobs = ctx.appStoreApplyJobEvent(jobs, 'remove', job('x', 'install', 'cancelled', 3));
    expect(Object.keys(jobs)).toEqual(['b']);
  });

  it('drops a failed job once a newer job for the module is queued', () => {
    const { ctx } = load(false);
    let jobs = ctx.appStoreApplyJobEvent({}, 'failed', job('a', 'uninstall', 'failed', 1));
    jobs = ctx.appStoreApplyJobEvent(jobs, 'pending', job('b', 'install', 'queued', 2));
    expect(Object.keys(jobs)).toEqual(['b']);
  });

  it('hydrates from the queue snapshot without a failed job a later job superseded', () => {
    const { ctx } = load(false);
    const jobs = ctx.appStoreJobsFromQueue([job('a', 'uninstall', 'failed', 1), job('b', 'uninstall', 'completed', 2), job('c', 'install', 'failed', 3)]);
    expect(Object.keys(jobs)).toEqual(['c']);
  });

  // The server cancels the newest queued job of a kind (installQueue.ts requestCancel), so only that job offers Cancel.
  const cancels = async (tree: unknown, api: { delete: ReturnType<typeof vi.fn> }) => {
    for (const b of buttons(tree).filter(b => text(b).trim() === 'Cancel')) await click(b);
    return api.delete.mock.calls.map(c => c[0]);
  };
  const detail = (ctx: Record<string, any>, jobs: unknown[]) => ctx.ModuleDetailView({ module: MOD, installed: null, jobs, ownJobIds: new Set(), onJobQueued: vi.fn(), onBack() {}, showSuccess() {}, setError() {} });

  it('offers no Cancel on a queued install an install queued later would be cancelled for', async () => {
    const queue = [job('i1', 'install', 'queued', 1), job('u', 'uninstall', 'queued', 2), job('i2', 'install', 'queued', 3)];
    for (const render of [(ctx: Record<string, any>) => card(ctx, { installed: false, installedEntry: null, jobs: queue }), (ctx: Record<string, any>) => detail(ctx, queue)]) {
      const { ctx, api } = load(false);
      expect(await cancels(render(ctx), api)).toEqual(['/appstore/modules/m1/uninstall', '/appstore/modules/m1/install']);
    }
  });

  it('offers no Cancel on a queued uninstall an uninstall queued later would be cancelled for', async () => {
    const queue = [job('u1', 'uninstall', 'queued', 1), job('i', 'install', 'queued', 2), job('u2', 'uninstall', 'queued', 3)];
    for (const render of [(ctx: Record<string, any>) => card(ctx, { jobs: queue }), (ctx: Record<string, any>) => detail(ctx, queue)]) {
      const { ctx, api } = load(false);
      expect(await cancels(render(ctx), api)).toEqual(['/appstore/modules/m1/install', '/appstore/modules/m1/uninstall']);
    }
  });

  it('shows the running install and the uninstall queued behind it, each with its own Cancel', async () => {
    const { ctx, api } = load(false);
    const tree = card(ctx, { installed: false, installedEntry: null, jobs: [job('a', 'install', 'running', 1), job('b', 'uninstall', 'queued', 2)] });
    expect(text(tree)).toContain('Installing...');
    expect(text(tree)).toContain('then uninstall queued');
    await click(button(tree, 'Cancel'));
    expect(api.delete).toHaveBeenCalledWith('/appstore/modules/m1/uninstall');
  });
});

describe('an uninstall whose module folders are already gone', () => {
  it('still removes the saved credentials and the component settings the confirm names', async () => {
    const name = 'c063-absent-module';
    const { dataPath } = await import('../../src/utils/dataRoot');
    const dir = dataPath('global', 'appstore');
    fs.mkdirSync(`${dir}/credentials`, { recursive: true });
    fs.writeFileSync(`${dir}/installed.json`, JSON.stringify({ modules: { [name]: { name, version: '1.0.0', repoId: 'r1' } } }));
    fs.writeFileSync(`${dir}/credentials/${name}.json`, JSON.stringify({ token: 'x' }));
    fs.writeFileSync(`${dir}/component-config.json`, JSON.stringify({ [`${name}:command:a`]: false, 'other:command:b': false }));
    const { InstallQueue } = await import('../../src/webui/utils/installQueue');
    const queue = new InstallQueue();
    const done = new Promise<any>(resolve => { queue.on('completed', resolve); queue.on('failed', resolve); });
    queue.enqueueUninstall(name);
    const finished = await done;
    expect(finished.status).toBe('completed');
    expect(finished.skipped).toBeUndefined();
    expect(fs.existsSync(`${dir}/credentials/${name}.json`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${dir}/component-config.json`, 'utf-8'))).toEqual({ 'other:command:b': false });
  });
});

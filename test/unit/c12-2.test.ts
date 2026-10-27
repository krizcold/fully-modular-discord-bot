import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const babel = require('@babel/core');

const SRC = path.join(__dirname, '../../src/webui/public/components/update/UpdateStatus.jsx');

type Served = { down: boolean; buildId: string };
type Node = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

function load(served: Served, pageBuildId: string) {
  const code = babel.transformSync(fs.readFileSync(SRC, 'utf8'), {
    presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic' }]],
    babelrc: false,
    configFile: false,
  }).code;
  let state: unknown[] = [];
  let effects: Record<number, (() => void) | true> = {};
  let slot = 0;
  const React = {
    useState(init: unknown) {
      const i = slot++;
      const mine = state;
      if (!(i in mine)) mine[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [mine[i], (v: unknown) => { mine[i] = v; }];
    },
    useEffect(fn: () => (() => void) | void) {
      const i = slot++;
      if (!(i in effects)) effects[i] = fn() || true;
    },
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props, children }),
  };
  const reload = vi.fn();
  const fetch = vi.fn(async () => {
    if (served.down) throw new Error('ECONNREFUSED');
    return { ok: true, text: async () => `window.BOT_BUILD = {"buildId":"${served.buildId}","version":"1.0.0"};` };
  });
  const ctx: Record<string, unknown> = {
    React, fetch, setInterval, clearInterval, setTimeout, clearTimeout, Date, JSON,
    confirm: () => true, disabledButtonStyle: () => ({}),
    window: { location: { reload }, BOT_BUILD: { buildId: pageBuildId } },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const render = () => {
    slot = 0;
    return (ctx.UpdateStatus as (p: unknown) => Node)({ api: ctx.api, status: { crashHistory: [] }, onRefresh: () => {} });
  };
  const unmount = () => {
    for (const c of Object.values(effects)) if (typeof c === 'function') c();
    effects = {};
    state = [];
  };
  return { ctx, reload, fetch, get state() { return state; }, render, unmount };
}

function findHandler(tree: unknown, name: string): (() => Promise<void>) | null {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const t of tree) { const h = findHandler(t, name); if (h) return h; }
    return null;
  }
  const n = tree as Node;
  const onClick = n.props?.onClick as { name?: string } | undefined;
  if (onClick && onClick.name === name) return onClick as () => Promise<void>;
  return findHandler(n.children, name);
}

afterEach(() => { vi.useRealTimers(); });

describe('C12-2: the Update tab reload promise', () => {
  it('a same-build return after the server went down says so instead of waiting silently', async () => {
    vi.useFakeTimers();
    const served = { down: false, buildId: 'A' };
    const { ctx, reload } = load(served, 'A');
    const onSameBuild = vi.fn();
    const onTimeout = vi.fn();
    (ctx.pollForNewBuild as (b: string, o: unknown) => void)('A', { onSameBuild, onTimeout });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSameBuild).not.toHaveBeenCalled();
    served.down = true;
    await vi.advanceTimersByTimeAsync(9000);
    served.down = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSameBuild).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('the safety timeout reports that the outcome could not be confirmed', async () => {
    vi.useFakeTimers();
    const served = { down: true, buildId: 'A' };
    const { ctx, reload } = load(served, 'A');
    const onTimeout = vi.fn();
    (ctx.pollForNewBuild as (b: string, o: unknown) => void)('A', { onSameBuild: vi.fn(), onTimeout });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a different build id reloads the page', async () => {
    vi.useFakeTimers();
    const served = { down: false, buildId: 'B' };
    const { ctx, reload } = load(served, 'A');
    (ctx.pollForNewBuild as (b: string, o: unknown) => void)('A', { onSameBuild: vi.fn(), onTimeout: vi.fn() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('System Update baselines on the build serving when Update is requested, not at page load', async () => {
    vi.useFakeTimers();
    const served = { down: false, buildId: 'B' };
    const rig = load(served, 'A');
    rig.ctx.api = { post: vi.fn(async () => ({ success: true })) };
    rig.render();
    rig.state[1] = { success: true, baseCode: { hasUpdates: true }, modules: { updatesAvailable: 1, updates: [] } };
    const trigger = findHandler(rig.render(), 'triggerSystemUpdate');
    expect(trigger).toBeTruthy();
    await trigger!();
    await vi.advanceTimersByTimeAsync(9000);
    expect(rig.reload).not.toHaveBeenCalled();
    const message = rig.state.find(s => s && typeof s === 'object' && 'text' in (s as object)) as { text: string };
    expect(message.text).not.toMatch(/will reload/);
    expect(message.text).toMatch(/requested/);
  });

  it('the timeout message offers a Reload button', async () => {
    vi.useFakeTimers();
    const served = { down: true, buildId: 'A' };
    const rig = load(served, 'A');
    rig.ctx.api = { post: vi.fn(async () => ({ success: true })) };
    rig.render();
    rig.state[1] = { success: true, baseCode: { hasUpdates: true }, modules: { updatesAvailable: 1, updates: [] } };
    const trigger = findHandler(rig.render(), 'triggerUpdateEverything');
    await trigger!();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const message = rig.state.find(s => s && typeof s === 'object' && 'text' in (s as object)) as { type: string; text: string; reload?: boolean };
    expect(message.type).toBe('error');
    expect(message.text).toMatch(/could not be confirmed/);
    expect(JSON.stringify(rig.render())).toContain('Reload');
  });

  const message = (rig: { state: unknown[] }) =>
    rig.state.find(s => s && typeof s === 'object' && 'text' in (s as object)) as { type: string; text: string } | undefined;
  const withUpdates = (rig: ReturnType<typeof load>) => {
    rig.ctx.api = { post: vi.fn(async () => ({ success: true })) };
    rig.render();
    rig.state[1] = { success: true, baseCode: { hasUpdates: true }, modules: { updatesAvailable: 1, updates: [] } };
    return rig.render();
  };

  it('fewer than 3 failed polls are a blip, and a same-build report keeps polling for a later new build', async () => {
    vi.useFakeTimers();
    const served = { down: false, buildId: 'A' };
    const { ctx, reload } = load(served, 'A');
    const onSameBuild = vi.fn();
    (ctx.pollForNewBuild as (b: string, o: unknown) => void)('A', { onSameBuild, onTimeout: vi.fn() });
    served.down = true;
    await vi.advanceTimersByTimeAsync(6000);
    served.down = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSameBuild).not.toHaveBeenCalled();
    served.down = true;
    await vi.advanceTimersByTimeAsync(9000);
    served.down = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSameBuild).toHaveBeenCalledTimes(1);
    served.buildId = 'B';
    await vi.advanceTimersByTimeAsync(3000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the outcome survives a tab switch: a remounted Update tab shows the poll message', async () => {
    vi.useFakeTimers();
    const served = { down: true, buildId: 'A' };
    const rig = load(served, 'A');
    await findHandler(withUpdates(rig), 'triggerSystemUpdate')!();
    rig.unmount();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    rig.render();
    expect(message(rig)?.text).toMatch(/could not be confirmed/);
  });

  it('a second System Update stops the first poll, whose timeout cannot overwrite the second message', async () => {
    vi.useFakeTimers();
    const served = { down: true, buildId: 'A' };
    const rig = load(served, 'A');
    await findHandler(withUpdates(rig), 'triggerSystemUpdate')!();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await findHandler(rig.render(), 'triggerSystemUpdate')!();
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    rig.render();
    expect(message(rig)?.type).toBe('success');
    expect(message(rig)?.text).toMatch(/requested/);
  });
});

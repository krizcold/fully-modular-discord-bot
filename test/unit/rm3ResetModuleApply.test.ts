import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// _resetModuleApply is the tests' new process: after it the module apply holds none of the memory of the process
// before (the applies it runs, the modules it named as listed but missing, the swaps of a boot). Run over the apply
// rig of NB6 part 16.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import type { Client } from 'discord.js';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { dataPath } from '../../src/utils/dataRoot';
import { _resetModuleApply, beginBootApplies, bootCompileModules, setModuleApplyClient } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n' };

beforeEach(() => rig.setup());
afterEach(() => rig.teardown());

describe('_resetModuleApply', () => {
  it('rm3 reset swaps: a boot swap of the process before is not compiled by the next boot compile', async () => {
    const u = await rig.publish('m', U_FILES, '2.0.0');
    beginBootApplies();
    expect(await rig.apply('m', u)).toMatchObject({ outcome: 'loaded' });
    expect(rig.entry('m')?.applying).toMatchObject({ to: u });
    _resetModuleApply();
    const calls = fakeLoader.compileCalls;
    await bootCompileModules();
    expect(fakeLoader.compileCalls).toBe(calls);
  });

  it('rm3 reset listed: a module listed as installed with no files is named again by the first pass of the next process', async () => {
    fs.mkdirSync(path.join(rig.state.source, 'x'), { recursive: true });
    fs.writeFileSync(path.join(rig.state.source, 'x', 'index.js'), 'exports.v = 1;\n');
    fs.mkdirSync(dataPath('global', 'appstore'), { recursive: true });
    fs.writeFileSync(dataPath('global', 'appstore', 'installed.json'), JSON.stringify({ modules: { x: { version: '1.0.0' } } }));
    const line = '[Shared] x is listed as installed, but the database holds none of its files; uninstall it from the App Store tab, then install it again';
    const named = () => rig.state.lines.filter(l => l === line).length;
    await rig.pass();
    await rig.pass();
    expect(named()).toBe(1);
    _resetModuleApply();
    await rig.pass();
    expect(named()).toBe(2);
  });

  it('rm3 reset runs: an apply still running in the process before does not hold the next apply of its module on the store mutex', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached = false;
    fakeLoader.duringLoad = async () => {
      reached = true;
      await held;
    };
    const first = rig.apply('m', u);
    await vi.waitFor(() => expect(reached).toBe(true), { timeout: 2000, interval: 5 });
    fakeLoader.duringLoad = null;
    _resetModuleApply();
    setModuleApplyClient({} as Client);
    const second = rig.apply('m', u);
    const answer = await Promise.race([second, new Promise(resolve => setTimeout(() => resolve('still waiting'), 1000))]);
    release();
    await first;
    await second;
    expect(answer).toMatchObject({ outcome: 'deferred', reason: 'starting' });
  });
});

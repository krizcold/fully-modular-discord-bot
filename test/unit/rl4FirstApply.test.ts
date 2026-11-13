import { afterEach, describe, expect, it, vi } from 'vitest';

// The first apply of a fresh bot process loads the module: only beginBootApplies makes an apply stop after its swap
// (NB6 decision 45 (3)). This file never calls _resetModuleApply before its apply, so the process's initial state is
// what the apply sees.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Client } from 'discord.js';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, setSharedModulePassStep } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setModuleDirs, modulePassStep, setModuleApplyClient } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

const rig = applyRig();

/** The rig's setup without its _resetModuleApply. */
function setupKeepingApplyState(): void {
  const state = rig.state;
  state.lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { state.lines.push(args.map(String).join(' ')); });
  }
  _resetRowQueue();
  _resetSharedMirror();
  setSharedModulePassStep(modulePassStep);
  _resetModuleCrashes();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  state.rows = sharedRows();
  state.pg = scriptedBackend(state.rows.answer);
  dm.setGuildDataBackend(state.pg.backend);
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl4first-'));
  state.source = path.join(state.root, 'appstore-modules');
  state.build = path.join(state.root, 'build', 'bot', 'modules');
  state.dist = path.join(state.root, 'dist', 'bot', 'modules');
  state.backups = dataPath('global', 'appstore', 'cache', 'backups');
  for (const dir of [state.source, state.build, state.dist]) fs.mkdirSync(dir, { recursive: true });
  _setModuleDirs({ source: state.source, build: state.build, dist: state.dist, backups: state.backups, buildFile: path.join(state.root, 'dist', '.build-complete') });
  fakeLoader.reset(state.source);
  setModuleApplyClient({} as Client);
}

afterEach(() => rig.teardown());

describe('the first apply of a process', () => {
  it('loads the module and finishes the apply', async () => {
    setupKeepingApplyState();
    const files = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
    const sha = await rig.publish('m', files);
    const result = await rig.apply('m', sha);
    expect(result).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true });
    expect(fakeLoader.loads).toEqual([{ module: 'm', sha }]);
    expect(rig.entry('m')).toMatchObject({ sha, applying: null });
  });
});

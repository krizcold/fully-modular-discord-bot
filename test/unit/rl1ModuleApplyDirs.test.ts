import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, moduleApply.ts: the folders the apply uses when no test names them (production's dirs()).

const trees = vi.hoisted(() => ({ value: null as null | { source: string; build: string; dist: string } }));

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    getModulesDir: () => trees.value?.dist ?? real.getModulesDir(),
    getSourceModulesDir: () => trees.value?.source ?? real.getSourceModulesDir(),
    getBuildModulesDir: () => trees.value?.build ?? real.getBuildModulesDir(),
  };
});

import fs from 'fs';
import path from 'path';
import { applyRig } from '../helpers/nb6ApplyRig';
import { _setModuleDirs, pruneBackups } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
beforeEach(async () => {
  await rig.setup();
  trees.value = { source: rig.state.source, build: rig.state.build, dist: rig.state.dist };
  _setModuleDirs(null);
});
afterEach(async () => {
  trees.value = null;
  await rig.teardown();
});

const DAY = 86_400_000;

describe('rl1 the default folders', () => {
  it('the prune deletes an old copy in the store cache backups folder under /data/global', () => {
    const now = Date.now();
    const old = path.join(rig.state.backups, `m-${now - 40 * DAY}-failed`);
    rig.writeTree(old, { 'module.json': '{"name":"m"}' });
    pruneBackups(now);
    expect(fs.existsSync(old)).toBe(false);
    expect(rig.state.lines).toContain(`[Shared] Deleted the module backup ${old}: it was older than 30 days and not the newest backup of m`);
  });

  it('an apply records the image build from .build-complete two folders above the dist modules folder', async () => {
    fs.writeFileSync(path.join(rig.state.root, 'dist', '.build-complete'), 'build-7');
    const sha = await rig.inPlace('m', { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' });
    expect(rig.entry('m')?.built).toEqual({ sha, buildId: 'build-7' });
  });
});

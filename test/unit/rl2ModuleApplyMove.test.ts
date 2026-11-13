import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const move = vi.hoisted(() => ({ fail: null as null | ((from: string) => unknown), dirRenames: 0 }));

vi.mock('fs', async orig => {
  const real = await orig<typeof import('fs')>();
  const renameSync = (from: import('fs').PathLike, to: import('fs').PathLike): void => {
    if (move.fail && real.existsSync(from) && real.statSync(from).isDirectory()) {
      move.dirRenames += 1;
      const thrown = move.fail(String(from));
      if (thrown !== undefined) throw thrown;
    }
    real.renameSync(from, to);
  };
  return { ...real, renameSync, default: { ...real, renameSync } };
});

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import { applyRig } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n', 'lib/util.js': 'u1' };
const U_FILES = { 'module.json': '{"name":"m","version":"2.0.0"}', 'index.js': 'exports.v = 2;\n', 'lib/util.js': 'u2' };

const exdev = () => Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });

beforeEach(async () => {
  move.fail = null;
  move.dirRenames = 0;
  await rig.setup();
});
afterEach(async () => {
  move.fail = null;
  await rig.teardown();
});

describe('a folder move across devices', () => {
  it('rl2 EXDEV: every folder rename refused as cross-device still installs and updates by copy, leaving no source behind', async () => {
    const s = await rig.publish('m', S_FILES);
    move.fail = () => exdev();
    expect((await rig.apply('m', s)).outcome).toBe('applied');
    expect(rig.live('m')).toEqual(S_FILES);
    move.fail = null;
    const u = await rig.publish('m', U_FILES, '2.0.0');
    move.fail = () => exdev();
    const result = await rig.apply('m', u);
    expect(result).toEqual({ outcome: 'applied', reason: null, error: null, loaded: true });
    expect(move.dirRenames).toBe(3);
    expect(rig.live('m')).toEqual(U_FILES);
    expect(rig.built('m')).toEqual(U_FILES);
    expect(fs.readdirSync(rig.state.source)).toEqual(['m']);
    expect(rig.backupsOf('m')).toEqual([]);
    expect(rig.entry('m')).toMatchObject({ sha: u });
  });

  it('rl2 non-error throw: a rename that throws a value with no code fails the apply with that same value', async () => {
    await rig.inPlace('m', S_FILES);
    const u = await rig.publish('m', U_FILES, '2.0.0');
    let once = true;
    move.fail = () => {
      if (!once) return undefined;
      once = false;
      return null;
    };
    let caught: unknown = 'nothing thrown';
    try {
      await rig.apply('m', u);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeNull();
    expect(rig.live('m')).toEqual(S_FILES);
  });
});

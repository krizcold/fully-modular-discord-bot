import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB45 on a JSON bot: the App Store's own uninstall and update (appStoreManager.ts) delete a module's dist folder with
// tsc's incremental record (tsconfigprod.json's ./dist/.tsbuildinfo), so the reload's compile writes its files again.

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const fsReal = await vi.importActual<any>('fs');
  const execSync = (cmd: string, opts: any = {}) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from(fsReal.readFileSync(path.join(opts.cwd, '.git', 'HEAD_HASH'), 'utf-8'));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
    if (cmd.startsWith('git clone')) {
      const target = cmd.match(/"([^"]+)"$/)![1];
      fsReal.mkdirSync(path.join(target, '.git'), { recursive: true });
      fsReal.writeFileSync(path.join(target, '.git', 'HEAD_HASH'), 'e'.repeat(40));
      return Buffer.from('');
    }
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  const root = process.env.DATA_DIR as string;
  return {
    ...real,
    getModulesDir: () => path.join(root, 'nb45-dist', 'bot', 'modules'),
    getSourceModulesDir: () => path.join(root, 'appstore-modules'),
    getBuildModulesDir: () => path.join(root, 'nb45-build', 'bot', 'modules'),
    getModulesDevDir: () => path.join(root, 'modulesDev'),
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';

const STORE = dataPath('global', 'appstore');
const INSTALLED = path.join(STORE, 'installed.json');
const CLONE = path.join(STORE, 'cache', 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('nb45-build', 'bot', 'modules');
const DIST = dataPath('nb45-dist', 'bot', 'modules');
const RECORD = dataPath('nb45-dist', '.tsbuildinfo');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}
const entry = (name: string) => ({ name, version: '1.0.0', installedFrom: 'official-modules', installedAt: '2026-11-24T00:00:00.000Z', commitHash: 'a'.repeat(40) });
const compiled = (name: string) => write(path.join(DIST, name, 'index.js'), 'exports.v = 1;\n');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  for (const dir of [STORE, SOURCE, dataPath('nb45-build'), dataPath('nb45-dist')]) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

function listed(name: string): AppStoreManager {
  new AppStoreManager();
  write(INSTALLED, JSON.stringify({ modules: { [name]: entry(name) } }));
  write(path.join(SOURCE, name, 'module.json'), JSON.stringify({ name, version: '1.0.0' }));
  write(path.join(BUILD, name, 'module.json'), JSON.stringify({ name, version: '1.0.0' }));
  return new AppStoreManager();
}

describe("a JSON bot's uninstall", () => {
  it("nb45 json uninstall: the module's dist folder goes with tsc's record", async () => {
    const m = listed('alpha');
    compiled('alpha');
    write(RECORD, '{}');
    expect(await m.uninstallModule('alpha')).toBe(true);
    expect(fs.existsSync(path.join(DIST, 'alpha'))).toBe(false);
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it('nb45 json uninstall uncompiled: a module with no dist folder leaves the record for the next incremental compile', async () => {
    const m = listed('alpha');
    write(RECORD, '{}');
    expect(await m.uninstallModule('alpha')).toBe(true);
    expect(fs.existsSync(RECORD)).toBe(true);
  });
});

describe("a JSON bot's update", () => {
  it("nb45 json update: the old dist folder goes with tsc's record", async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    compiled('alpha');
    write(RECORD, '{}');
    publish('alpha', '1.1.0');
    expect(await m.updateModule('alpha')).toMatchObject({ success: true, newVersion: '1.1.0' });
    expect(fs.existsSync(path.join(DIST, 'alpha'))).toBe(false);
    expect(fs.existsSync(RECORD)).toBe(false);
  });
});

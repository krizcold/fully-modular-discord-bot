import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB53 on the App Store's own uninstall and update (appStoreManager.ts dropRuntimeDir): a module's dist folder deleted
// while a hot reload's compile runs. The scripted tsc is held open until a row lets it write its record and answer.

const h = vi.hoisted(() => ({
  held: null as null | (() => void),
  started: null as null | (() => void),
  writeRecord: null as null | (() => void),
}));

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
  const exec = (command: string, _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    if (!/tsc(\.cmd)?" -p tsconfig\.json$/.test(command)) {
      callback(null, '', '');
      return;
    }
    h.held = () => {
      h.writeRecord?.();
      callback(null, '', '');
    };
    h.started?.();
  };
  return { ...real, execSync, exec, default: { ...real, execSync, exec } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  const root = process.env.DATA_DIR as string;
  return {
    ...real,
    getModulesDir: () => path.join(root, 'nb53-dist', 'bot', 'modules'),
    getSourceModulesDir: () => path.join(root, 'appstore-modules'),
    getBuildModulesDir: () => path.join(root, 'nb53-build', 'bot', 'modules'),
    getModulesDevDir: () => path.join(root, 'modulesDev'),
    getBuildRoot: () => 'Z:/nb53-no-build-root',
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { AppStoreManager } from '../../src/bot/internalSetup/utils/appStoreManager';
import { recompileTypeScript } from '../../src/bot/internalSetup/utils/moduleReloader';

const STORE = dataPath('global', 'appstore');
const INSTALLED = path.join(STORE, 'installed.json');
const CLONE = path.join(STORE, 'cache', 'official-modules');
const SOURCE = dataPath('appstore-modules');
const BUILD = dataPath('nb53-build', 'bot', 'modules');
const DIST = dataPath('nb53-dist', 'bot', 'modules');
const RECORD = dataPath('nb53-dist', '.tsbuildinfo');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function publish(name: string, version: string): void {
  write(path.join(CLONE, 'Modules', name, 'module.json'), JSON.stringify({ name, version }));
  write(path.join(CLONE, 'Modules', name, 'index.ts'), 'export {};');
  write(path.join(CLONE, '.git', 'HEAD_HASH'), 'a'.repeat(40));
}
const entry = (name: string) => ({ name, version: '1.0.0', installedFrom: 'official-modules', installedAt: '2026-11-27T00:00:00.000Z', commitHash: 'a'.repeat(40) });
const compiled = (name: string) => write(path.join(DIST, name, 'index.js'), 'exports.v = 1;\n');

function listed(name: string): AppStoreManager {
  new AppStoreManager();
  write(INSTALLED, JSON.stringify({ modules: { [name]: entry(name) } }));
  write(path.join(SOURCE, name, 'module.json'), JSON.stringify({ name, version: '1.0.0' }));
  write(path.join(BUILD, name, 'module.json'), JSON.stringify({ name, version: '1.0.0' }));
  return new AppStoreManager();
}

async function heldCompile(): Promise<{ result: Promise<unknown> }> {
  const started = new Promise<void>(resolve => { h.started = resolve; });
  const result = recompileTypeScript();
  await started;
  return { result };
}
async function endCompile(compile: { result: Promise<unknown> }): Promise<void> {
  h.held!();
  h.held = null;
  expect(await compile.result).toMatchObject({ success: true });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  for (const dir of [STORE, SOURCE, dataPath('nb53-build'), dataPath('nb53-dist')]) fs.rmSync(dir, { recursive: true, force: true });
  h.held = null;
  h.started = null;
  h.writeRecord = () => write(RECORD, JSON.stringify({ emitted: ['./dist/bot/modules/alpha/index.js'] }));
});
afterEach(() => {
  h.held?.();
  h.writeRecord = null;
  vi.restoreAllMocks();
});

describe("the App Store deletes a module's dist folder while a compile runs", () => {
  it('nb53 store uninstall during compile: the record the compile writes at its end is deleted', async () => {
    const m = listed('alpha');
    compiled('alpha');
    write(RECORD, '{"old":true}');
    const compile = await heldCompile();
    expect(await m.uninstallModule('alpha')).toBe(true);
    expect(fs.existsSync(path.join(DIST, 'alpha'))).toBe(false);
    await endCompile(compile);
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it('nb53 store update during compile: the record the compile writes at its end is deleted', async () => {
    publish('alpha', '1.0.0');
    const m = new AppStoreManager();
    await m.installModule('alpha', 'official-modules');
    compiled('alpha');
    write(RECORD, '{"old":true}');
    publish('alpha', '1.1.0');
    const compile = await heldCompile();
    expect(await m.updateModule('alpha')).toMatchObject({ success: true, newVersion: '1.1.0' });
    expect(fs.existsSync(path.join(DIST, 'alpha'))).toBe(false);
    await endCompile(compile);
    expect(fs.existsSync(RECORD)).toBe(false);
  });

  it('nb53 store uninstall uncompiled during compile: a module with no dist folder leaves the record the compile writes', async () => {
    const m = listed('alpha');
    const compile = await heldCompile();
    expect(await m.uninstallModule('alpha')).toBe(true);
    await endCompile(compile);
    expect(fs.readFileSync(RECORD, 'utf8')).toContain('alpha/index.js');
  });
});

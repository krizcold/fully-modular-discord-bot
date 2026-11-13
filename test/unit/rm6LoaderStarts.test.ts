import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ manifests: [] as string[] }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  return { ...real, findModuleManifests: () => h.manifests };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import {
  _resetModuleCrashes,
  bootStartOf,
  endStart,
  openStarts,
  startFailureOf,
  startModule,
  starting,
  type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';

let tmp: string;
const names: string[] = [];

function manifestOf(name: string): void {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'module.json');
  fs.writeFileSync(file, JSON.stringify({ name, version: '1.0.0', displayName: name, description: 'd', author: 'a', category: 'misc' }));
  h.manifests = [file];
  names.push(name);
}

function loaderWithStarts(made: ModuleStart[]): ModuleLoader {
  return new ModuleLoader({} as any, {
    onModuleCode: m => {
      const start = startModule(m.name, null, m.version, m.path);
      if (typeof start === 'string') throw new Error(`start refused: ${start}`);
      made.push(start);
      return start;
    },
  });
}

function loadsAs(hooks: { onLoad?: () => unknown; onReady?: () => unknown }): void {
  vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async (m: any, p: string) => ({
    manifest: m, path: p, commands: [], events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [], hooks,
  }) as any);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm6loader-'));
  h.manifests = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of names.splice(0)) getModuleRegistry().unregister(name);
  _resetModuleCrashes();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('rm6 the boot loop ends a start whose load threw no error', () => {
  it('rm6 a load that rejects with undefined ends its start failed with "the load did not finish"', async () => {
    manifestOf('rm6-undef');
    vi.spyOn(ModuleLoader.prototype, 'loadModule').mockImplementation(async () => { throw undefined; });
    const made: ModuleStart[] = [];

    const loaded = await loaderWithStarts(made).loadAllModules();

    expect(loaded).toEqual([]);
    expect(made).toHaveLength(1);
    expect(openStarts.has('rm6-undef')).toBe(false);
    expect(startFailureOf(made[0])).toBe('the load did not finish');
    expect(startFailureOf('rm6-undef')).toBe('the load did not finish');
  });
});

describe("rm6 onReady runs inside the window of the boot loop's start only while that start is open", () => {
  it('rm6 the start handed to the boot turn and still open has its window open during onReady, and closed after', async () => {
    manifestOf('rm6-open');
    const during: boolean[] = [];
    loadsAs({ onReady: () => { during.push(starting.has(bootStartOf('rm6-open')!)); } });
    const made: ModuleStart[] = [];

    await loaderWithStarts(made).loadAllModules();

    expect(bootStartOf('rm6-open')).toBe(made[0]);
    expect(openStarts.get('rm6-open')).toBe(made[0]);
    expect(during).toEqual([true]);
    expect(starting.size).toBe(0);
  });

  it('rm6 a handed start that ended before onReady opens no window', async () => {
    manifestOf('rm6-ended');
    const during: number[] = [];
    loadsAs({
      onLoad: async () => { await endStart(openStarts.get('rm6-ended')!, 'ok'); },
      onReady: () => { during.push(starting.size); },
    });
    const made: ModuleStart[] = [];

    await loaderWithStarts(made).loadAllModules();

    expect(bootStartOf('rm6-ended')).toBe(made[0]);
    expect(openStarts.has('rm6-ended')).toBe(false);
    expect(during).toEqual([0]);
  });
});

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

const h = vi.hoisted(() => ({
  failed: [] as any[],
  updateCalls: 0,
  nameCalls: 0,
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', () => ({
  getAppStoreManager: () => ({
    getInstalledModules: () => [{ name: 'm' }],
    checkAllModulesForUpdates: async () => ({ success: true, updatesAvailable: 1, updates: [{ moduleName: 'm', hasUpdate: true }] }),
    updateAllModules: async () => { h.updateCalls += 1; return { updated: [], failed: h.failed }; },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', () => ({
  reloadModules: async () => ({ success: true, reloaded: [], failed: [], totalDuration: 0 }),
}));
// gethostname can fail (a SystemError from os.hostname() when NODE_NAME is empty).
vi.mock('../../src/bot/internalSetup/fleet/nodeName', () => ({
  getNodeName: () => { h.nameCalls += 1; throw new Error('gethostname failed'); },
}));

import { dataPath } from '../../src/utils/dataRoot';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';

const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  h.updateCalls = 0;
  h.nameCalls = 0;
  const store = dataPath('global', 'appstore');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ autoUpdate: true }));
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  stopModuleAutoUpdater();
  vi.restoreAllMocks();
});

async function tick(): Promise<string[]> {
  let run: (() => void) | null = null;
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { run = fn; return 0; }) as never);
  try {
    startModuleAutoUpdater({} as Client);
  } finally {
    spy.mockRestore();
  }
  run!();
  await vi.waitFor(() => { if (h.updateCalls === 0) throw new Error('no update yet'); }, { timeout: 2000, interval: 2 });
  await new Promise(resolve => setImmediate(resolve));
  return lines.filter(l => l.startsWith('[ModuleAutoUpdater]') && !/Started|Stopped/.test(l));
}

describe('rl10 a change elsewhere that names no machine', () => {
  it('rl10 says another machine without reading the node name, even when the name cannot be read', async () => {
    h.failed = [
      { moduleName: 'm', error: 'changed', changedElsewhere: true },
      { moduleName: 'r', error: 'changed', changedElsewhere: true, elsewhere: { kind: 'removed', by: null } },
    ];
    expect(await tick()).toEqual([
      '[ModuleAutoUpdater] 1 module update(s) available, downloading...',
      '[ModuleAutoUpdater] m was updated on another machine meanwhile; applying that version',
      '[ModuleAutoUpdater] r was not updated: it was uninstalled on another machine meanwhile',
    ]);
    expect(h.nameCalls).toBe(0);
  });
});

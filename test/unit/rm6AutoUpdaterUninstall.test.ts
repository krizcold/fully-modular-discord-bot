import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

const h = vi.hoisted(() => ({
  failed: [] as any[],
  updateCalls: 0,
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
vi.mock('../../src/bot/internalSetup/fleet/nodeName', () => ({ getNodeName: () => 'NODE-ONE' }));

import { dataPath } from '../../src/utils/dataRoot';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';

const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  h.updateCalls = 0;
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

async function uninstallLines(): Promise<string[]> {
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
  return lines.filter(l => l.includes('uninstalled on'));
}

describe('rm6 the auto-updater names where an update was refused because of an uninstall', () => {
  it('rm6 an uninstall by this machine says "this machine", never its node name', async () => {
    h.failed = [{ moduleName: 'mine', error: 'changed', changedElsewhere: true, elsewhere: { kind: 'removed', by: 'NODE-ONE' } }];
    expect(await uninstallLines()).toEqual(['[ModuleAutoUpdater] mine was not updated: it was uninstalled on this machine meanwhile']);
  });

  it('rm6 an uninstall that names no machine says "another machine", never "null"', async () => {
    h.failed = [{ moduleName: 'nobody', error: 'changed', changedElsewhere: true, elsewhere: { kind: 'removed', by: null } }];
    expect(await uninstallLines()).toEqual(['[ModuleAutoUpdater] nobody was not updated: it was uninstalled on another machine meanwhile']);
  });

  it('rm6 an uninstall by another named machine names it', async () => {
    h.failed = [{ moduleName: 'theirs', error: 'changed', changedElsewhere: true, elsewhere: { kind: 'removed', by: 'NODE-TWO' } }];
    expect(await uninstallLines()).toEqual(['[ModuleAutoUpdater] theirs was not updated: it was uninstalled on NODE-TWO meanwhile']);
  });
});

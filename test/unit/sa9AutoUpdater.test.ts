import { afterEach, describe, expect, it, vi } from 'vitest';

// The module auto updater's check on a JSON bot: downloaded modules hot-reloaded, and the T9 line of each module whose
// installed list can't be confirmed as saved, and of no other.

const h = vi.hoisted(() => ({
  updated: [] as Array<{ moduleName: string; oldVersion: string; newVersion: string; listUnconfirmed?: string }>,
  reloads: [] as string[][],
}));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => ({
  ...(await orig<any>()),
  getAppStoreManager: () => ({
    getInstalledModules: () => h.updated.map(u => ({ name: u.moduleName })),
    checkAllModulesForUpdates: async () => ({
      success: true, checked: h.updated.length, updatesAvailable: h.updated.length, updates: h.updated.map(u => ({ moduleName: u.moduleName, hasUpdate: true })),
    }),
    updateAllModules: async () => ({ success: true, updated: h.updated, failed: [], checkErrors: [], skipped: [] }),
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => ({
  ...(await orig<any>()),
  reloadModules: async (_client: unknown, names: string[]) => {
    h.reloads.push(names);
    return { success: true, reloaded: names, failed: [], totalDuration: 5 };
  },
}));

import fs from 'fs';
import path from 'path';
import type { Client } from 'discord.js';
import { dataPath } from '../../src/utils/dataRoot';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';

const CHECK_MS = 30 * 60 * 1000;

afterEach(() => {
  stopModuleAutoUpdater();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the auto updater's check", () => {
  it('warns the T9 line of the module whose list is unconfirmed only, and counts only the confirmed reload', async () => {
    const config = dataPath('global', 'appstore', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ autoUpdate: true }));
    h.updated = [
      { moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '1.1.0' },
      { moduleName: 'beta', oldVersion: '1.0.0', newVersion: '2.0.0', listUnconfirmed: 'beta 2.0.0 is in place, but the list of installed modules is not confirmed saved' },
    ];
    const lines: string[] = [];
    const warns: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    startModuleAutoUpdater({} as Client);
    vi.advanceTimersByTime(CHECK_MS);
    await vi.waitFor(() => expect(lines).toContain('[ModuleAutoUpdater] Hot-reloaded 1 module(s) in 5ms'), { timeout: 5000, interval: 5 });
    expect(h.reloads).toEqual([['alpha', 'beta']]);
    expect(warns).toEqual(['[ModuleAutoUpdater] beta 2.0.0 is in place, but the list of installed modules is not confirmed saved']);
  });
});

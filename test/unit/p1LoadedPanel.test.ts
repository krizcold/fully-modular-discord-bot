import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 12, review7 Z1 and Z2: a module's panel loaded from its folder by the real ModuleLoader, with no
// `_moduleName` in the file, and registered as boot registers it (clientInitializer.ts: registerPanel for each of
// module.panels), meets the user gate and the server panel gate of its module's manifest.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { DEFAULT_MESSAGES, getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { PanelManager } from '../../src/bot/internalSetup/utils/panelManager';
import { gh, uh } from '../helpers/p1Holder';
import { p1World, SERVERS, USERS } from '../helpers/p1World';

const w = p1World();
const M1 = ':no_entry_sign: This is not available for your personal subscription tier.';
const WITH_TIER = USERS[0];
const BELOW = USERS[1];
const SERVER = SERVERS[0];
let root = '';

const PANEL_FILE = (id: string) => `const ran: string[] = ((globalThis as any).__p1LoadedRan ??= []);
export default {
  id: '${id}',
  name: '${id}',
  callback: async () => { ran.push('${id}:open'); return { content: 'View' }; },
  handleButton: async () => { ran.push('${id}:button'); return { content: 'Pressed' }; },
};
`;
const ran = (): string[] => ((globalThis as any).__p1LoadedRan ??= []);

async function loadAndRegister(name: string, tierRequirement?: Record<string, unknown>): Promise<PanelManager> {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'panels'), { recursive: true });
  const manifest = { name, displayName: name, version: '1.0.0', ...(tierRequirement ? { tierRequirement } : {}) };
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'panels', 'main.ts'), PANEL_FILE(`${name}_main`));
  const module = await new ModuleLoader({} as any).loadModule(manifest as any, dir);
  getModuleRegistry().register(module);
  const manager = new PanelManager({} as any);
  for (const panel of module.panels) manager.registerPanel(panel);
  return manager;
}

const ctx = (panelId: string, userId: string, guildId: string | null) => ({ panelId, userId, guildId, accessMethod: 'web_ui', client: {} } as any);

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-loaded-'));
  await w.setup();
  await w.addUserTiers();
  expect((await w.grant(uh(WITH_TIER), 'umid', 30)).ok).toBe(true);
  expect((await w.grant(uh(BELOW), 'ulow', 30)).ok).toBe(true);
  ran().length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of ['p1lu', 'p1ls', 'p1ln']) getModuleRegistry().unregister(name);
  fs.rmSync(root, { recursive: true, force: true });
  await w.teardown();
});

describe('P1 claim 12: the gates on a panel loaded from its module folder', () => {
  it('the user gate refuses a user below user.minPriority on open and on a button; a user with the tier runs both', async () => {
    const manager = await loadAndRegister('p1lu', { user: { minPriority: 2 } });
    const opened = JSON.stringify(await manager.handlePanelInteraction(ctx('p1lu_main', BELOW, null)));
    const pressed = JSON.stringify(await manager.handleButtonInteraction(ctx('p1lu_main', BELOW, null), 'b'));
    expect(ran()).toEqual([]);
    for (const text of [opened, pressed]) {
      expect(text).toContain('Tier Restricted');
      expect(text).toContain(M1);
    }
    await manager.handlePanelInteraction(ctx('p1lu_main', WITH_TIER, null));
    await manager.handleButtonInteraction(ctx('p1lu_main', WITH_TIER, null), 'b');
    expect(ran()).toEqual(['p1lu_main:open', 'p1lu_main:button']);
  });

  it('the server gate refuses on a server below minPriority with panelBlocked, and opens on a server with the tier', async () => {
    const manager = await loadAndRegister('p1ls', { minPriority: 2 });
    const text = JSON.stringify(await manager.handlePanelInteraction(ctx('p1ls_main', BELOW, SERVER)));
    expect(text).toContain('Tier Restricted');
    expect(text).toContain(JSON.stringify(DEFAULT_MESSAGES.panelBlocked).slice(1, -1));
    expect(ran()).toEqual([]);
    expect((await w.grant(gh(SERVER), 'mid', 30)).ok).toBe(true);
    expect(getPremiumManager().hasFeatureAccess(SERVER, 2)).toBe(true);
    expect(JSON.stringify(await manager.handlePanelInteraction(ctx('p1ls_main', BELOW, SERVER)))).not.toContain('Tier Restricted');
    expect(ran()).toEqual(['p1ls_main:open']);
  });

  it('a module with no tierRequirement still opens, on a server and with none', async () => {
    const manager = await loadAndRegister('p1ln');
    await manager.handlePanelInteraction(ctx('p1ln_main', BELOW, SERVER));
    await manager.handlePanelInteraction(ctx('p1ln_main', BELOW, null));
    expect(ran()).toEqual(['p1ln_main:open', 'p1ln_main:open']);
  });
});

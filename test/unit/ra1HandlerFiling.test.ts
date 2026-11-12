import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// clientInitializer.ts's runInitializers files under each module the handler ids its own initializers registered
// (fileNewHandlers): the ids that were not in the client's maps before its turn, each one's info named after the
// module; ids registered before the turn stay unfiled and unnamed.

const h = vi.hoisted(() => ({ modules: [] as any[] }));

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', async orig => {
  const { getModuleRegistry } = await import('../../src/bot/internalSetup/utils/moduleRegistry');
  return {
    ...(await orig<any>()),
    ModuleLoader: class {
      async loadAllModules() {
        for (const m of h.modules) getModuleRegistry().register(m);
        return h.modules;
      }
    },
  };
});

import type { Client } from 'discord.js';
import { _resetBootModules, loadModules, registerModuleComponents, runInitializers } from '../../src/bot/internalSetup/clientInitializer';
import { resetModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';

const KINDS = ['buttonHandlers', 'modalHandlers', 'dropdownHandlers', 'reactionHandlers', 'reactionRemoveHandlers'] as const;
type Kind = typeof KINDS[number];

function fakeModule(name: string, initialize: (client: any) => unknown) {
  return {
    manifest: { name, version: '1.0.0', displayName: name, description: 'a test module', author: 'a', category: 'misc' },
    path: `/modules/${name}`, events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
    commands: [{ name: `${name}-cmd`, initialize }],
  } as any;
}

const valueOf = (kind: Kind, label: string) => (kind === 'reactionRemoveHandlers' ? [{ label }, { label: `${label}-2` }] : { label });

async function boot(client: any, ...modules: any[]): Promise<void> {
  h.modules = modules;
  await loadModules(client as Client);
  registerModuleComponents(client as Client);
  await runInitializers(client as Client);
}

beforeEach(() => {
  resetModuleRegistry();
  _resetBootModules();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetModuleRegistry();
  _resetBootModules();
});

describe('the handler ids a module registered in its turn', () => {
  it('files only the new ids of every kind under the module and names their infos; older ids stay unnamed', async () => {
    const client: any = { options: { intents: 0 }, on: () => undefined };
    const old: Record<string, any> = {};
    for (const kind of KINDS) {
      old[kind] = valueOf(kind, `old-${kind}`);
      client[kind] = new Map([[`old-${kind}`, old[kind]]]);
    }
    const fresh: Record<string, any> = {};
    const mod = fakeModule('alpha', (c: any) => {
      for (const kind of KINDS) {
        fresh[kind] = valueOf(kind, `new-${kind}`);
        c[kind].set(`new-${kind}`, fresh[kind]);
      }
    });
    await boot(client, mod);

    expect(mod.registeredInteractionIds).toEqual({
      buttons: ['new-buttonHandlers'], modals: ['new-modalHandlers'], dropdowns: ['new-dropdownHandlers'],
    });
    expect(mod.registeredReactionIds).toEqual({ reactions: ['new-reactionHandlers'], reactionRemoves: ['new-reactionRemoveHandlers'] });
    for (const kind of ['buttonHandlers', 'modalHandlers', 'dropdownHandlers', 'reactionHandlers'] as const) {
      expect(fresh[kind]._moduleName, kind).toBe('alpha');
      expect(old[kind]._moduleName, kind).toBeUndefined();
    }
    expect(fresh.reactionRemoveHandlers.map((i: any) => i._moduleName)).toEqual(['alpha', 'alpha']);
    expect(old.reactionRemoveHandlers.map((i: any) => i._moduleName)).toEqual([undefined, undefined]);
  });

  it('a new id whose map holds no info is filed and the turn completes', async () => {
    const client: any = { options: { intents: 0 }, on: () => undefined };
    for (const kind of KINDS) client[kind] = new Map();
    const mod = fakeModule('beta', (c: any) => {
      for (const kind of KINDS) c[kind].set(`empty-${kind}`, undefined);
    });
    await expect(boot(client, mod)).resolves.toBeUndefined();
    expect(mod.registeredInteractionIds).toEqual({
      buttons: ['empty-buttonHandlers'], modals: ['empty-modalHandlers'], dropdowns: ['empty-dropdownHandlers'],
    });
    expect(mod.registeredReactionIds).toEqual({ reactions: ['empty-reactionHandlers'], reactionRemoves: ['empty-reactionRemoveHandlers'] });
  });

  for (const kind of KINDS) {
    it(`a ${kind} map the module's initializer creates files every id in it, whatever its name`, async () => {
      const client: any = { options: { intents: 0 }, on: () => undefined };
      const id = 'Stryker was here';
      const mod = fakeModule('gamma', (c: any) => { c[kind] = new Map([[id, valueOf(kind, id)]]); });
      await boot(client, mod);
      const filed = [
        ...mod.registeredInteractionIds.buttons, ...mod.registeredInteractionIds.modals, ...mod.registeredInteractionIds.dropdowns,
        ...mod.registeredReactionIds.reactions, ...mod.registeredReactionIds.reactionRemoves,
      ];
      expect(filed).toEqual([id]);
    });
  }
});

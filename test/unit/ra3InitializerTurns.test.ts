import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// clientInitializer.ts's runInitializers for a module the boot handed no start: a module with no initializer gets no
// turn and no filing, an initializer that throws is logged under its command's name, the handler ids its initializer
// registered are filed under it; and _resetBootModules empties what loadModules and registerModuleComponents collected.

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

function fakeModule(name: string, commands: any[]) {
  return {
    manifest: { name, version: '1.0.0', displayName: name, description: 'a test module', author: 'a', category: 'misc' },
    path: `/modules/${name}`, events: new Map(), panels: [], exports: new Map(), initialized: false, importedFiles: [],
    commands,
  } as any;
}

function fakeClient(): any {
  return {
    options: { intents: 0 }, on: () => undefined,
    buttonHandlers: new Map(), modalHandlers: new Map(), dropdownHandlers: new Map(), reactionHandlers: new Map(), reactionRemoveHandlers: new Map(),
  };
}

async function collect(client: any, ...modules: any[]): Promise<void> {
  h.modules = modules;
  await loadModules(client as Client);
  registerModuleComponents(client as Client);
}

let logs: string[];
let errors: unknown[][];
beforeEach(() => {
  resetModuleRegistry();
  _resetBootModules();
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetModuleRegistry();
  _resetBootModules();
});

describe('runInitializers for a module with no boot start', () => {
  it('a module with no initializer logs no error and files nothing under itself', async () => {
    const client = fakeClient();
    const quiet = fakeModule('quiet', [{ name: 'quiet-cmd' }]);
    await collect(client, quiet);
    await runInitializers(client as Client);
    expect(errors).toEqual([]);
    expect(quiet.registeredInteractionIds).toBeUndefined();
    expect(quiet.registeredReactionIds).toBeUndefined();
    expect(logs).toContain('[Initializer] Initialization complete.');
  });

  it('an initializer that throws is logged under its command name with the error, and the next one still runs', async () => {
    const client = fakeClient();
    const failure = new Error('the initializer broke');
    const ran: string[] = [];
    const mod = fakeModule('loud', [
      { name: 'first-cmd', initialize: () => { ran.push('first'); throw failure; } },
      { name: 'second-cmd', initialize: () => { ran.push('second'); } },
    ]);
    await collect(client, mod);
    await runInitializers(client as Client);
    expect(ran).toEqual(['first', 'second']);
    expect(errors).toEqual([['[Initializer] Error running initialize function for module: first-cmd', failure]]);
  });

  it("the button its initializer registered is filed under the module and named after it", async () => {
    const client = fakeClient();
    const info: any = { label: 'b' };
    const mod = fakeModule('filer', [{ name: 'filer-cmd', initialize: (c: any) => { c.buttonHandlers.set('filer-button', info); } }]);
    await collect(client, mod);
    await runInitializers(client as Client);
    expect(mod.registeredInteractionIds).toEqual({ buttons: ['filer-button'], modals: [], dropdowns: [] });
    expect(mod.registeredReactionIds).toEqual({ reactions: [], reactionRemoves: [] });
    expect(info._moduleName).toBe('filer');
  });
});

describe('_resetBootModules', () => {
  it('empties the collected initializers and the loaded modules', async () => {
    const client = fakeClient();
    const ran: string[] = [];
    const mod = fakeModule('reset', [{ name: 'reset-cmd', initialize: () => { ran.push('reset'); } }]);
    await collect(client, mod);
    _resetBootModules();
    logs.length = 0;
    registerModuleComponents(client as Client);
    await runInitializers(client as Client);
    expect(ran).toEqual([]);
    expect(logs.some(l => l.startsWith('[ModuleLoader] Registered reset:'))).toBe(false);
    expect(logs).toContain('[Initializer] Running initialization for 0 modules...');
  });
});

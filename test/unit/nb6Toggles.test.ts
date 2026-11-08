import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';

// NB6 test 53 (wip-redesign/sheets/NB6.md: decisions 55 and 62; rows 181, 182, 226 and 227; part 9): another machine's
// change to component-config.json, once the applier wrote it, attaches or detaches this machine's events and panels to
// match the set this process last applied; commands are not touched. The event and panel managers are fakes that
// record each call; the hook is reached through the applier's own registry (runSharedAppliedHooks).

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  attached: new Map<string, number>(),
  panels: new Map<string, { id: string }>(),
  commandCalls: [] as string[],
}));

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/moduleEventManager', () => ({
  getModuleEventManager: () => ({
    hasEventListeners: (m: string, e: string) => (fake.attached.get(`${m}:${e}`) ?? 0) > 0,
    registerListener: (m: string, e: string) => {
      fake.calls.push(`attach ${m}:${e}`);
      fake.attached.set(`${m}:${e}`, (fake.attached.get(`${m}:${e}`) ?? 0) + 1);
    },
    removeEventListeners: (m: string, e: string) => {
      const n = fake.attached.get(`${m}:${e}`) ?? 0;
      fake.calls.push(`detach ${m}:${e}`);
      fake.attached.delete(`${m}:${e}`);
      return n;
    },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({
    getModule: (name: string) => (name === 'm1'
      ? { manifest: { name: 'm1' }, events: new Map([['messageCreate', [() => undefined]]]), panels: [{ id: 'p1' }] }
      : undefined),
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({
    getPanel: (id: string) => fake.panels.get(id),
    registerPanel: (def: { id: string }) => {
      fake.calls.push(`register ${def.id}`);
      fake.panels.set(def.id, def);
    },
    unregisterPanel: (id: string) => {
      fake.calls.push(`unregister ${id}`);
      fake.panels.delete(id);
    },
  }),
}));

const CONFIG = dataPath('global', 'appstore', 'component-config.json');
const KEY = 'global/appstore/component-config.json';
const EVENT = 'm1:event:messageCreate';
const PANEL = 'm1:panel:p1';

type Toggles = typeof import('../../src/bot/internalSetup/utils/ipcToggleHandler');
type Dm = typeof import('../../src/bot/internalSetup/utils/dataManager');
let toggles: Toggles;
let dm: Dm;
let listener: ((message: unknown) => void) | null;
let logs: string[];

/** A client whose command manager records every use: commands are never touched by the hook. */
const client = {
  application: new Proxy({}, { get: (_t, prop) => { fake.commandCalls.push(String(prop)); return undefined; } }),
} as any;

function writeConfig(content: string | object): void {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(async () => {
  fake.calls = [];
  fake.commandCalls = [];
  fake.attached = new Map([['m1:messageCreate', 1]]);
  fake.panels = new Map([['p1', { id: 'p1' }]]);
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
  fs.rmSync(CONFIG, { force: true });
  vi.resetModules();
  toggles = await import('../../src/bot/internalSetup/utils/ipcToggleHandler');
  dm = await import('../../src/bot/internalSetup/utils/dataManager');
  listener = null;
  const realOn = process.on.bind(process);
  const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
    if (event === 'message') {
      listener = fn;
      return process;
    }
    return realOn(event as any, fn);
  }) as any);
  const original = process.send;
  if (!original) (process as any).send = () => true;
  toggles.setupToggleIPCHandlers(client);
  (process as any).send = original;
  spy.mockRestore();
});

afterEach(() => {
  fs.rmSync(CONFIG, { force: true });
  vi.restoreAllMocks();
});

/** The applier wrote the mirror from the row: its hooks run. */
async function applied(content: string | object): Promise<void> {
  writeConfig(content);
  dm.runSharedAppliedHooks(KEY);
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('row 181: another machine changed component-config.json', () => {
  it('detaches the events and panels it disables and attaches them again once enabled; commands are not touched', async () => {
    writeConfig({});
    toggles.applyAllDisabledStatesOnBoot();
    expect(fake.calls).toEqual([]);
    await applied({ [EVENT]: false, [PANEL]: false, 'm1:command:ping': false });
    expect(fake.calls).toEqual(['detach m1:messageCreate', 'unregister p1']);
    expect(fake.attached.has('m1:messageCreate')).toBe(false);
    expect(fake.panels.has('p1')).toBe(false);
    expect(logs).toContain('[Toggle] Detached 1 listener(s) for m1:messageCreate');
    expect(logs).toContain('[Toggle] Unregistered panel: p1');
    fake.calls = [];
    await applied({ 'm1:command:ping': false });
    expect(fake.calls).toEqual(['attach m1:messageCreate', 'register p1']);
    expect(fake.attached.get('m1:messageCreate')).toBe(1);
    expect(fake.panels.has('p1')).toBe(true);
    expect(fake.commandCalls).toEqual([]);
  });

  it('a hook with the set already applied changes nothing', async () => {
    writeConfig({ [EVENT]: false });
    toggles.applyAllDisabledStatesOnBoot();
    fake.calls = [];
    await applied({ [EVENT]: false });
    expect(fake.calls).toEqual([]);
  });

  it('before the boot applied a set, the hook does nothing', async () => {
    await applied({ [EVENT]: false });
    expect(fake.calls).toEqual([]);
  });
});

describe('row 182: the file cannot be read at the hook', () => {
  it('keeps the last applied set, with the existing log', async () => {
    writeConfig({ [EVENT]: false });
    toggles.applyAllDisabledStatesOnBoot();
    fake.calls = [];
    await applied('{ not json');
    expect(fake.calls).toEqual([]);
    expect(logs.some(l => l.startsWith('[Toggle] component-config.json cannot be read, keeping the last applied disabled set: '))).toBe(true);
  });
});

describe('row 226: a reload after the hook applied a set', () => {
  it('leaves the applied set as it was; the next hook compares with it', async () => {
    writeConfig({ [EVENT]: false });
    toggles.applyAllDisabledStatesOnBoot();
    await applied({});
    expect(fake.attached.get('m1:messageCreate')).toBe(1);
    // The file changes; a reload of the module reads it before the hook runs.
    writeConfig({ [EVENT]: false });
    await toggles.applyComponentToggleState(client, { manifest: { name: 'm1' } } as any);
    fake.calls = [];
    await applied({ [EVENT]: false });
    expect(fake.calls).toEqual(['detach m1:messageCreate']);
    fake.calls = [];
    await applied({});
    expect(fake.calls).toEqual(['attach m1:messageCreate']);
  });
});

describe('row 227: the hook and a local toggle of one key at once', () => {
  it("the hook's toggle runs after the local one, on the key's chain", async () => {
    writeConfig({ [EVENT]: false });
    toggles.applyAllDisabledStatesOnBoot();
    expect(fake.attached.has('m1:messageCreate')).toBe(false);
    expect(listener).not.toBeNull();
    fake.calls = [];
    const replies: unknown[] = [];
    const original = process.send;
    (process as any).send = (msg: any) => { replies.push(msg); return true; };
    try {
      // This machine's operator disables the event while another machine's enable is applied.
      listener!({ type: 'component:toggle', requestId: 'nb6t-1', data: { module: 'm1', componentType: 'event', name: 'messageCreate', enabled: false } });
      writeConfig({});
      dm.runSharedAppliedHooks(KEY);
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      (process as any).send = original;
    }
    expect(replies).toEqual([{ requestId: 'nb6t-1', data: { success: true } }]);
    expect(fake.calls).toEqual(['detach m1:messageCreate', 'attach m1:messageCreate']);
    expect(fake.attached.get('m1:messageCreate')).toBe(1);
  });
});

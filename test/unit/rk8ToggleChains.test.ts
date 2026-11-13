import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  attached: new Map<string, number>(),
  panels: new Map<string, { id: string }>(),
  creates: [] as { name: string; release: () => void }[],
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
      ? { manifest: { name: 'm1' }, events: new Map([['messageCreate', [() => undefined]]]), panels: [{ id: 'a:b' }] }
      : undefined),
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({
    getPanel: (id: string) => fake.panels.get(id),
    registerPanel: (def: { id: string }) => { fake.calls.push(`register ${def.id}`); fake.panels.set(def.id, def); },
    unregisterPanel: (id: string) => { fake.calls.push(`unregister ${id}`); fake.panels.delete(id); },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({
  default: () => [{ name: 'c1' }, { name: 'c2' }, { name: 'c3' }],
}));
vi.mock('../../src/bot/internalSetup/utils/commandUtils', () => ({
  buildCommandPayload: (def: any) => ({ name: def.name }),
}));
vi.mock('../../src/bot/internalSetup/utils/clientApplication', () => ({
  resolveClientApplication: async () => ({
    commands: {
      create: (payload: { name: string }) => new Promise<void>(resolve => {
        fake.calls.push(`create ${payload.name}`);
        fake.creates.push({ name: payload.name, release: resolve });
      }),
    },
  }),
}));

// NB6 decisions 55 and 62 and the toggle chains: a toggle of one `<module>:<type>:<name>` waits for the one before it on
// that key and no other; another machine's change to component-config.json, and only that file's, toggles events and
// panels to match.

const CONFIG = dataPath('global', 'appstore', 'component-config.json');
const KEY = 'global/appstore/component-config.json';

type Toggles = typeof import('../../src/bot/internalSetup/utils/ipcToggleHandler');
type Dm = typeof import('../../src/bot/internalSetup/utils/dataManager');
let toggles: Toggles;
let dm: Dm;
let listener: ((message: unknown) => void) | null;
let replies: any[];
let hadSend: typeof process.send;

function writeConfig(content: object): void {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(content));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

beforeEach(async () => {
  fake.calls = [];
  fake.creates = [];
  fake.attached = new Map([['m1:messageCreate', 1]]);
  fake.panels = new Map([['a:b', { id: 'a:b' }], ['ab', { id: 'ab' }]]);
  replies = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  fs.rmSync(CONFIG, { force: true });
  vi.resetModules();
  toggles = await import('../../src/bot/internalSetup/utils/ipcToggleHandler');
  dm = await import('../../src/bot/internalSetup/utils/dataManager');
  listener = null;
  const realOn = process.on.bind(process);
  const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
    if (event === 'message') { listener = fn; return process; }
    return realOn(event as any, fn);
  }) as any);
  hadSend = process.send;
  (process as any).send = (msg: any) => { replies.push(msg); return true; };
  toggles.setupToggleIPCHandlers({} as any);
  spy.mockRestore();
});

afterEach(() => {
  (process as any).send = hadSend;
  for (const c of fake.creates) c.release();
  fs.rmSync(CONFIG, { force: true });
  vi.restoreAllMocks();
});

function toggleCommand(requestId: string, name: string): void {
  listener!({ type: 'component:toggle', requestId, data: { module: 'm1', componentType: 'command', name, enabled: true } });
}

function release(name: string): void {
  const entry = fake.creates.find(c => c.name === name);
  expect(entry).toBeDefined();
  entry!.release();
}

describe('the toggle chain of one key', () => {
  it('a third toggle of a key waits for the second, after the first finished', async () => {
    toggleCommand('t1', 'c1');
    toggleCommand('t2', 'c1');
    await settle();
    expect(fake.creates.map(c => c.name)).toEqual(['c1']);
    fake.creates[0].release();
    await vi.waitFor(() => expect(fake.creates.length).toBe(2), { timeout: 1000, interval: 2 });
    expect(replies.map(r => r.requestId)).toEqual(['t1']);
    toggleCommand('t3', 'c1');
    await settle();
    expect(fake.creates.length).toBe(2);
    fake.creates[1].release();
    await vi.waitFor(() => expect(fake.creates.length).toBe(3), { timeout: 1000, interval: 2 });
    expect(replies.map(r => r.requestId)).toEqual(['t1', 't2']);
    fake.creates[2].release();
    await vi.waitFor(() => expect(replies.map(r => r.requestId)).toEqual(['t1', 't2', 't3']), { timeout: 1000, interval: 2 });
    expect(replies.every(r => r.data.success === true)).toBe(true);
  });

  it('toggles of different keys do not wait for each other', async () => {
    toggleCommand('k1', 'c1');
    toggleCommand('k2', 'c2');
    await vi.waitFor(() => expect(fake.creates.map(c => c.name).sort()).toEqual(['c1', 'c2']), { timeout: 1000, interval: 2 });
    release('c2');
    await vi.waitFor(() => expect(replies).toEqual([{ requestId: 'k2', data: { success: true } }]), { timeout: 1000, interval: 2 });
    release('c1');
    await vi.waitFor(() => expect(replies.map(r => r.requestId)).toEqual(['k2', 'k1']), { timeout: 1000, interval: 2 });
  });

  it('a toggle message without data is answered with a failure', async () => {
    listener!({ type: 'component:toggle', requestId: 'nodata' });
    await vi.waitFor(() => expect(replies.map(r => r.requestId)).toEqual(['nodata']), { timeout: 1000, interval: 2 });
    expect(replies[0].data.success).toBe(false);
    expect(typeof replies[0].data.error).toBe('string');
  });
});

describe('another machine changed component-config.json', () => {
  it('a panel name with a colon is unregistered and registered again under its full name', async () => {
    writeConfig({});
    toggles.applyAllDisabledStatesOnBoot();
    writeConfig({ 'm1:panel:a:b': false });
    dm.runSharedAppliedHooks(KEY);
    await vi.waitFor(() => expect(fake.calls).toEqual(['unregister a:b']), { timeout: 1000, interval: 2 });
    expect(fake.panels.has('ab')).toBe(true);
    fake.calls = [];
    writeConfig({});
    dm.runSharedAppliedHooks(KEY);
    await vi.waitFor(() => expect(fake.calls).toEqual(['register a:b']), { timeout: 1000, interval: 2 });
  });

  it('a key without a name is not an event and is left alone', async () => {
    writeConfig({});
    toggles.applyAllDisabledStatesOnBoot();
    writeConfig({ 'm1:event': false, 'm1:panel': false });
    dm.runSharedAppliedHooks(KEY);
    await settle();
    expect(fake.calls).toEqual([]);
    writeConfig({ 'm1:event:messageCreate': false });
    dm.runSharedAppliedHooks(KEY);
    await vi.waitFor(() => expect(fake.calls).toEqual(['detach m1:messageCreate']), { timeout: 1000, interval: 2 });
  });

  it('a change to another shared file toggles nothing', async () => {
    writeConfig({});
    toggles.applyAllDisabledStatesOnBoot();
    writeConfig({ 'm1:event:messageCreate': false });
    dm.runSharedAppliedHooks('global/appstore/other.json');
    dm.runSharedAppliedHooks('guild/123/m1/x.json');
    await settle();
    expect(fake.calls).toEqual([]);
    expect(fake.attached.get('m1:messageCreate')).toBe(1);
    dm.runSharedAppliedHooks(KEY);
    await vi.waitFor(() => expect(fake.calls).toEqual(['detach m1:messageCreate']), { timeout: 1000, interval: 2 });
  });
});

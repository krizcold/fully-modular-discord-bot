import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.GUILD_ID = 'g-test'; });

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', () => ({ resolveNodeRole: () => 'master' }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async (orig) => ({
  ...(await orig<any>()),
  loadGlobalData: () => ({ guildId: 'g-test' }),
  saveGlobalData: () => true,
}));
vi.mock('child_process', async (orig) => ({
  ...(await orig<any>()),
  exec: (_cmd: string, _opts: any, cb: (err: any) => void) => cb(Object.assign(new Error('tsc failed'), { stderr: 'tsc failed' })),
}));


import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import registerCommands from '../../src/bot/internalSetup/events/clientReady/registerCommands';
import { clearLoadFailures, recordLoadFailure } from '../../src/bot/internalSetup/utils/loadFailures';
import { findModuleManifests } from '../../src/bot/internalSetup/utils/pathHelpers';
import { reloadModules } from '../../src/bot/internalSetup/utils/moduleReloader';

function setAutoCleanup(on: boolean): void {
  const file = dataPath('global', 'appstore', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ autoCleanup: on }));
}

function setInstalled(names: string[] | string): void {
  const file = dataPath('global', 'appstore', 'installed.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = typeof names === 'string' ? names : JSON.stringify({ modules: Object.fromEntries(names.map(n => [n, { name: n }])) });
  fs.writeFileSync(file, body);
}

function fakeClient(globalNames: string[], onDelete?: () => void) {
  const deleted: string[] = [];
  const commands = {
    fetch: vi.fn(async (opts?: any) => {
      const m = new Map<string, any>();
      if (!opts?.guildId) for (const n of globalNames) m.set(n, { id: n, name: n, type: 1 });
      return m;
    }),
    create: vi.fn(async () => ({})),
    edit: vi.fn(async () => ({})),
    delete: vi.fn(async (id: string) => { deleted.push(id); onDelete?.(); }),
  };
  const client: any = { application: { commands }, guilds: { cache: new Map() } };
  return { client, deleted };
}

describe('Auto Cleanup deletes only commands of uninstalled modules (R7-J12)', () => {
  beforeEach(() => { clearLoadFailures(); setAutoCleanup(true); });

  it('skips the orphan sweep when a module failed to load at this boot', async () => {
    recordLoadFailure('broken-module');
    const { client, deleted } = fakeClient(['broken-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
    expect(result?.note).toMatch(/broken-module/);
  });

  it('sweeps orphans when every module loaded', async () => {
    const { client, deleted } = fakeClient(['gone-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual(['gone-cmd']);
    expect(result).toEqual({ sweep: 'done', deleted: 1, failed: 0 });
  });

  it('refuses to list modules when a manifest check fails for a reason other than absence', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    try {
      expect(() => findModuleManifests()).toThrow(/denied/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('the sweep re-reads the switch before each deletion (R24-J9)', () => {
  beforeEach(() => { clearLoadFailures(); setAutoCleanup(true); });

  it('stops after the deletion during which Auto Cleanup was turned off', async () => {
    const { client, deleted } = fakeClient(['a', 'b', 'c'], () => setAutoCleanup(false));
    const result = await registerCommands(client);
    expect(deleted).toEqual(['a']);
    expect(result?.sweep).toBe('stopped');
    expect(result?.note).toMatch(/stopped after 1 deletion/);
  });
});

describe('review fixes (C09-3)', () => {
  beforeEach(() => { clearLoadFailures(); setAutoCleanup(true); setInstalled([]); });

  it('skips the sweep when an installed module has no manifest at this boot', async () => {
    setInstalled(['half-updated']);
    const { client, deleted } = fakeClient(['its-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
    expect(result?.note).toMatch(/half-updated/);
  });

  it('skips the sweep when installed.json cannot be parsed', async () => {
    setInstalled('{"modules": {"half');
    const { client, deleted } = fakeClient(['its-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
  });

  it('reads installed.json fresh on each run', async () => {
    setInstalled(['gone-later']);
    const first = await registerCommands(fakeClient(['its-cmd']).client);
    expect(first?.sweep).toBe('skipped');
    setInstalled([]);
    const { client, deleted } = fakeClient(['its-cmd']);
    const second = await registerCommands(client);
    expect(second?.sweep).toBe('done');
    expect(deleted).toEqual(['its-cmd']);
  });

  it('says the sweep did not run when the switch is off at the sweep', async () => {
    setAutoCleanup(false);
    const { client, deleted } = fakeClient(['x']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.note).toMatch(/not run: Auto Cleanup was turned off/);
  });

  it('says the setting could not be read when config.json is torn mid-sweep', async () => {
    const file = dataPath('global', 'appstore', 'config.json');
    const { client, deleted } = fakeClient(['a', 'b'], () => fs.writeFileSync(file, '{"autoCl'));
    const result = await registerCommands(client);
    expect(deleted).toEqual(['a']);
    expect(result?.sweep).toBe('stopped');
    expect(result?.note).toMatch(/could not be read/);
  });

  it('records a module the bulk reload leaves unloaded', async () => {
    await reloadModules({} as any, ['bulk-mod']);
    const { client, deleted } = fakeClient(['its-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.sweep).toBe('skipped');
    expect(result?.note).toMatch(/bulk-mod/);
  });
});

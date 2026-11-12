import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// registerCommands' orphan sweep notes: the installed module list is read only when nothing failed to load and nothing
// is held back, and a note names each failed module apart.

const h = vi.hoisted(() => {
  process.env.GUILD_ID = 'g-test';
  return { listed: 0, unreadRepo: null as string | null };
});

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  loadGlobalData: () => ({ guildId: 'g-test' }),
  saveGlobalData: () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const loadFailures = await import('../../src/bot/internalSetup/utils/loadFailures');
  return {
    ...(await orig<any>()),
    findModuleManifests: () => {
      h.listed++;
      if (h.unreadRepo) loadFailures.recordLoadFailure(h.unreadRepo);
      return [];
    },
  };
});

import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import registerCommands from '../../src/bot/internalSetup/events/clientReady/registerCommands';
import { clearLoadFailures, recordHeldBack, recordLoadFailure } from '../../src/bot/internalSetup/utils/loadFailures';

const SKIP = '[Cleanup] Orphan command sweep skipped; their commands would be deleted. ';
let warns: string[];

function writeAppStore(name: string, value: unknown): void {
  const file = dataPath('global', 'appstore', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fakeClient(globalNames: string[]) {
  const deleted: string[] = [];
  const commands = {
    fetch: vi.fn(async (opts?: any) => {
      const m = new Map<string, any>();
      if (!opts?.guildId) for (const n of globalNames) m.set(n, { id: n, name: n, type: 1 });
      return m;
    }),
    create: vi.fn(async () => ({})),
    edit: vi.fn(async () => ({})),
    delete: vi.fn(async (id: string) => { deleted.push(id); }),
  };
  const client: any = { application: { commands }, guilds: { cache: new Map() } };
  return { client, deleted };
}

beforeEach(() => {
  h.listed = 0;
  h.unreadRepo = 'the modulesDev repo unread';
  warns = [];
  clearLoadFailures();
  writeAppStore('config.json', { autoCleanup: true });
  writeAppStore('installed.json', { modules: {} });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
});

afterEach(() => {
  clearLoadFailures();
  vi.restoreAllMocks();
});

describe('the sweep notes when it is already skipped', () => {
  it('held back only: the module list is not read and the note names only the held module', async () => {
    recordHeldBack('held-a');
    const { client, deleted } = fakeClient(['orphan-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(h.listed).toBe(0);
    expect(result).toEqual({
      sweep: 'skipped', deleted: 0, failed: 0,
      note: 'orphan sweep skipped: these modules are held back on this machine until they are updated, or uninstalled and installed again: held-a',
    });
    expect(warns).toEqual([`${SKIP}Held back on this machine until updated, or uninstalled and installed again: held-a`]);
  });

  it('a load failure only: the module list is not read and the note names only that module', async () => {
    recordLoadFailure('broken');
    const { client, deleted } = fakeClient(['orphan-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(h.listed).toBe(0);
    expect(result?.note).toBe('orphan sweep skipped until the bot restarts: these modules did not load, lack a dependency or could not be read: broken');
    expect(warns).toEqual([`${SKIP}Did not load, lack a dependency or could not be read: broken`]);
  });

  it('two load failures: the note and the log line separate them with a comma', async () => {
    h.unreadRepo = null;
    recordLoadFailure('broken-a');
    recordLoadFailure('broken-b');
    const { client, deleted } = fakeClient(['orphan-cmd']);
    const result = await registerCommands(client);
    expect(deleted).toEqual([]);
    expect(result?.note).toBe('orphan sweep skipped until the bot restarts: these modules did not load, lack a dependency or could not be read: broken-a, broken-b');
    expect(warns).toEqual([`${SKIP}Did not load, lack a dependency or could not be read: broken-a, broken-b`]);
  });

  it('nothing failed: the module list is read, and a repo it could not read skips the sweep', async () => {
    const { client, deleted } = fakeClient(['orphan-cmd']);
    const result = await registerCommands(client);
    expect(h.listed).toBe(1);
    expect(deleted).toEqual([]);
    expect(result?.note).toBe('orphan sweep skipped until the bot restarts: these modules did not load, lack a dependency or could not be read: the modulesDev repo unread');
  });
});

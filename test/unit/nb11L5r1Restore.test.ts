import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, RestoreOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { RESTORE_TEXTS, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { LEASED } from '../helpers/readinessRig';

// NB11 (wip-redesign/sheets/NB11.md): a restored batch whose reason the database gives as NULL, and the restore
// route's answer on Postgres when no working set exists or the guild's set is still loaded after the restore.

const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };
let guilds = 881_000_000_000_000_000n;
const freshGuild = () => String(++guilds);

class NoEntryStore extends FakeStore {
  override async restoreGuild(..._args: unknown[]): Promise<RestoreOutcome> {
    return { ok: false, reason: 'no-entry' };
  }
}

let drivers: DataReadinessDriver[] = [];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.stop();
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('restoreGuild on Postgres with a batch whose reason is NULL', () => {
  it('commits and answers the moved rows with an empty reason', async () => {
    const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
    const internals = backend as unknown as { state: string; provisioned: boolean };
    internals.state = 'ready';
    internals.provisioned = true;
    const sent: string[] = [];
    const client = {
      query: async (config: string | { text: string }) => {
        const sql = (typeof config === 'string' ? config : config.text).trim();
        sent.push(sql);
        if (/^INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) return { rows: [], rowCount: 1 };
        if (/max\(retired_at\)/.test(sql)) return { rows: [{ retired_at: '2000' }], rowCount: 1 };
        if (/AS present$/.test(sql)) return { rows: [{ present: false }], rowCount: 1 };
        if (/^WITH moved AS/.test(sql)) return { rows: [{ taken: '1', put: '1', reason: null }], rowCount: 1 };
        return { rows: [], rowCount: null };
      },
      release: () => {},
    };
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => client;
    const g = freshGuild();
    const outcome = await backend.restoreGuild(g, null, token, () => null, process.hrtime.bigint() + 40_000_000_000n);
    expect(outcome).toStrictEqual({ ok: true, moved: 1, retiredAt: 2000, reason: '' });
    expect(sent).toContain('COMMIT');
  });
});

describe('the restore route on Postgres', () => {
  it('with no working set built, answers that the data is not loaded', async () => {
    setBackendKind('postgres');
    setGuildDataBackend(new NoEntryStore());
    const reply = await applyOperatorDataWrite({ guildId: freshGuild(), module: '', filename: '', op: 'restore-graveyard' });
    expect(reply).toStrictEqual({ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.notLoaded });
  });

  it('a no-entry restore of a loaded guild waits for its readiness once and answers no entry', async () => {
    const store = new NoEntryStore();
    const ws = initWorkingSet(store);
    const driver = initDataReadiness(store, ws, { held: false });
    drivers.push(driver);
    driver.onLeaseChanged(LEASED);
    setGuildDataBackend(store);
    setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => 7 }));
    setBackendKind('postgres');
    const g = freshGuild();
    expect(await ws.hydrate(g, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
    const admit = vi.spyOn(driver, 'admitInteraction');
    const reply = await applyOperatorDataWrite({ guildId: g, module: '', filename: '', op: 'restore-graveyard' });
    expect(reply).toStrictEqual({ ok: false, code: 'invalid', error: 'no graveyard entry for this guild' });
    expect(ws.has(g)).toBe(true);
    expect(ws.stateOf(g)).toBe('ready');
    expect(admit).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  awaitGuildDataReady: async () => true,
}));

import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { DataBackendUnavailableError, initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';

const GUILD = '900000000000000014';
const TEXT = '[Data] The database did not answer or ended the connection (Connection terminated); nothing was restored; try again in a moment';

/** A ready set over a store whose restore did not get an answer from the database. */
async function unanswered(): Promise<void> {
  setBackendKind('postgres');
  const store = new FakeStore();
  store.restoreGuild = async () => ({ ok: false, reason: 'unavailable', detail: 'Connection terminated' });
  const ws = initWorkingSet(store);
  setGuildDataBackend(store);
  expect(await ws.hydrate(GUILD, { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
}

afterEach(() => {
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('a graveyard restore the database did not answer', () => {
  it('reads unreachable, says what happened and that nothing was restored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await unanswered();
    const error = await restoreGuildFromGraveyard(GUILD, 1000).catch(e => e);
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect(error.causeKey).toBe('database-unreachable');
    expect(error.message).toBe(TEXT);
  });

  it('tells the operator the backend was unavailable, not that the restore was done', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await unanswered();
    const reply: any = await applyOperatorDataWrite({ guildId: GUILD, module: '', filename: '', op: 'restore-graveyard', contentJson: '{"retiredAt":1000}' });
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: TEXT });
  });
});

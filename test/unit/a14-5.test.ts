import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  awaitGuildDataReady: async () => true,
}));

import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';

const GUILD = '900000000000000014';

function fakeBackend(): any {
  return { restoreGuild: async () => ({ ok: false, reason: 'unavailable' }) };
}

afterEach(() => {
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('a graveyard restore refused by the database', () => {
  it('reads unreachable when the database did not answer', async () => {
    setBackendKind('postgres');
    setGuildDataBackend(fakeBackend());
    const error = await restoreGuildFromGraveyard(GUILD, 1000).catch(e => e);
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect(error.causeKey).toBe('database-unreachable');
  });

  it('tells the operator the backend was unavailable, not that the restore was done', async () => {
    setBackendKind('postgres');
    setGuildDataBackend(fakeBackend());
    const reply: any = await applyOperatorDataWrite({ guildId: GUILD, module: '', filename: '', op: 'restore-graveyard', contentJson: '{"retiredAt":1000}' });
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('backend-unavailable');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  awaitGuildDataReady: async () => true,
}));

import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { clearRouteOverride, setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';

const GUILD = '900000000000000014';

function fakeBackend(readOnly: boolean): any {
  return {
    restoreGuild: async () => ({ ok: false, reason: 'unavailable' }),
    isReadOnly: () => readOnly,
  };
}

afterEach(() => {
  setGuildDataBackend(null);
  clearRouteOverride(GUILD);
});

describe('a graveyard restore refused by the database', () => {
  it('reads read-only, not unreachable, when the database refused it as read-only', async () => {
    setRouteOverride(GUILD, 'postgres');
    setGuildDataBackend(fakeBackend(true));
    const error = await restoreGuildFromGraveyard(GUILD, 1000).catch(e => e);
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect(error.causeKey).toBe('database-read-only');
  });

  it('still reads unreachable when the database did not answer', async () => {
    setRouteOverride(GUILD, 'postgres');
    setGuildDataBackend(fakeBackend(false));
    const error = await restoreGuildFromGraveyard(GUILD, 1000).catch(e => e);
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect(error.causeKey).toBe('database-unreachable');
  });

  it('tells the operator the guild was not restored, not that a write was not saved', async () => {
    setRouteOverride(GUILD, 'postgres');
    setGuildDataBackend(fakeBackend(true));
    const reply: any = await applyOperatorDataWrite({ guildId: GUILD, module: '', filename: '', op: 'restore-graveyard', contentJson: '{"retiredAt":1000}' });
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('backend-unavailable');
    expect(reply.error).toMatch(/read-only/);
    expect(reply.error).toMatch(/not restored/);
    expect(reply.error).not.toMatch(/write was not saved/);
  });
});

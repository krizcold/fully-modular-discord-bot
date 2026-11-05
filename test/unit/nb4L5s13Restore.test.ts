import { afterEach, describe, expect, it, vi } from 'vitest';

import { GuildFrozenError, restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';
import { storeGuild } from '../helpers/gateRig';

// NB4 decision 17: an operator restore of a guild whose set is frozen (its shard left, writes kept for the leave)
// is refused; a restore that lands drops the served set so the next access reads the restored rows.

afterEach(() => {
  vi.restoreAllMocks();
  setGuildDataBackend(null);
  setBackendKind(null);
});

function backendWith(restoreGuild: () => Promise<unknown>) {
  setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), { restoreGuild }));
}

describe('an operator restore', () => {
  it('of a frozen guild is refused and sends nothing', async () => {
    const { guildId } = await storeGuild();
    const ws = getWorkingSet()!;
    ws.freeze(guildId);
    const restoreGuild = vi.fn(async () => ({ ok: true, moved: 1 }));
    backendWith(restoreGuild);
    const error = await restoreGuildFromGraveyard(guildId, 5).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(GuildFrozenError);
    expect(restoreGuild).not.toHaveBeenCalled();
    expect(ws.stateOf(guildId)).toBe('frozen-retained');
  });

  it('that lands drops the served set, so the next access reads the restored rows', async () => {
    const { guildId } = await storeGuild();
    const ws = getWorkingSet()!;
    backendWith(async () => ({ ok: true, moved: 3 }));
    expect(await restoreGuildFromGraveyard(guildId, 5)).toEqual({ ok: true, moved: 3 });
    expect(ws.has(guildId)).toBe(false);
  });
});

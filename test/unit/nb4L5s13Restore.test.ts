import { afterEach, describe, expect, it, vi } from 'vitest';

import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
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
    const restoreGuild = vi.fn(async () => ({ ok: true, copied: 1 }));
    backendWith(restoreGuild);
    expect(await restoreGuildFromGraveyard(guildId, 5)).toEqual({ ok: false, code: 'frozen' });
    expect(restoreGuild).not.toHaveBeenCalled();
    expect(ws.stateOf(guildId)).toBe('frozen-retained');
  });

  it('that lands drops the served set, so the next access reads the restored rows', async () => {
    const { guildId } = await storeGuild();
    const ws = getWorkingSet()!;
    backendWith(async () => ({ ok: true, copied: 3, retiredAt: 5, reason: 'r', usedAt: 1000 }));
    expect(await restoreGuildFromGraveyard(guildId, 5)).toEqual({ ok: true, copied: 3, retiredAt: 5, reason: 'r', keptUntil: 1000 + 14 * 24 * 60 * 60 * 1000 });
    expect(ws.has(guildId)).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { admitGuildAction, gateCauseNow } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { drainForExit, isClosedForExit } from '../../src/bot/internalSetup/utils/dataManager';
import { freezeGuildWrites, unfreezeGuildWrites } from '../helpers/freezeGuild';
import { readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

// R1-J2's stopping row (notes/BT.md, "R1-J2 design sheet (L0): final, after the re-read"). Its own file: the exit
// drain closes writes for good in this process.

afterEach(() => {
  stopDrivers();
  vi.useRealTimers();
});

describe('the exit drain', () => {
  it('ends a hold under way with stopping, at its next reading, and every later reading is stopping', async () => {
    const r = readinessRig();
    const guildId = await r.ready();
    freezeGuildWrites(guildId);
    try {
      const hold = watch(admitGuildAction(guildId, performance.now() + 2000));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(hold.settled()).toBe(false);
      await drainForExit(200);
      expect(isClosedForExit()).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(hold.value()).toEqual({ cause: 'stopping', mark: null });
    } finally {
      unfreezeGuildWrites(guildId);
    }
    expect(gateCauseNow(guildId, performance.now())).toBe('stopping');
    expect(gateCauseNow(await r.ready(), performance.now())).toBe('stopping');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateEventDispatch } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { initDataReadiness } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';

// NB11 survivors, chunk 7 (wip-redesign/sheets/NB11.md): a JSON bot's guild events with a readiness driver left from
// a database backend.

afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
});

describe('a guild event on a JSON bot', () => {
  it('is dispatched at once even while a readiness driver with no leases is installed', async () => {
    const store = new FakeStore();
    const driver = initDataReadiness(store, new WorkingSetManager(store), { held: false });
    try {
      setBackendKind('file');
      const ran: number[] = [];
      expect(await gateEventDispatch('messageCreate', [{ guildId: freshGuild() }], () => { ran.push(1); })).toBe(true);
      expect(ran).toEqual([]);
    } finally {
      driver.stop();
    }
  });
});

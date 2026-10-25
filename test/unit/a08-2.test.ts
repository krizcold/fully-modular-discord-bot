import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  awaitGuildDataReady: async () => true,
}));

import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { clearRouteOverride, setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import { DataBackendUnavailableError } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { dataUnavailableMessage } from '../../src/bot/internalSetup/utils/dataBackends/boot';

const GUILD = '900000000000000082';

function staleBackend(): any {
  return {
    restoreGuild: async () => ({ ok: false, reason: 'read-only' }),
    isReadOnly: () => true,
    isStaleCopy: () => true,
  };
}

afterEach(() => {
  setGuildDataBackend(null);
  clearRouteOverride(GUILD);
});

describe('a write refused by a database fenced as an outdated copy', () => {
  it('names the stale copy as its cause, not read-only', async () => {
    setRouteOverride(GUILD, 'postgres');
    setGuildDataBackend(staleBackend());
    const error = await restoreGuildFromGraveyard(GUILD, 1000).catch(e => e);
    expect(error).toBeInstanceOf(DataBackendUnavailableError);
    expect(error.causeKey).toBe('database-stale-copy');
    expect(error.message).toMatch(/outdated copy/);
    expect(error.message).not.toMatch(/recovery/);
  });

  it('tells the member the copy is outdated and promises no short wait', () => {
    const text = dataUnavailableMessage('database-stale-copy' as any);
    expect(text).toMatch(/outdated copy/);
    expect(text).toMatch(/not saved/);
    expect(text).not.toMatch(/read-only|a few minutes|in a moment/);
  });
});

describe('the working set facing a database fenced as an outdated copy', () => {
  it('refuses a save as stale-copy, before read-only', async () => {
    const { WorkingSetManager } = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
    const backend: any = {
      hydrateGuild: async () => ({ ok: true, docs: [], appendKeys: [] }),
      isReadOnly: () => true,
      isStaleCopy: () => true,
      healthy: () => true,
    };
    const ws = new WorkingSetManager(backend);
    expect(await ws.hydrate(GUILD, { term: 1, epoch: 1 } as any)).toBe('ready');
    expect(ws.save(GUILD, 'm', 'f.json', '{}')).toBe('stale-copy');
  });
});

describe('a member write on a node fenced as an outdated copy', () => {
  it('refuses save, append and delete with the stale-copy cause', async () => {
    const { initWorkingSet } = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const backend: any = {
      hydrateGuild: async () => ({ ok: true, docs: [], appendKeys: [] }),
      isReadOnly: () => true,
      isStaleCopy: () => true,
      healthy: () => true,
    };
    const ws = initWorkingSet(backend);
    expect(await ws.hydrate(GUILD, { term: 1, epoch: 1 } as any)).toBe('ready');
    setRouteOverride(GUILD, 'postgres');
    const opts = { guildId: GUILD, category: 'm' };
    const calls = [
      () => dm.saveDataOutcome('f.json', opts, {}),
      () => dm.appendData('f.log', opts, 'x'),
      () => dm.deleteDataOutcome('f.json', opts),
    ];
    for (const call of calls) {
      let error: any = null;
      try { call(); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(DataBackendUnavailableError);
      expect(error.causeKey).toBe('database-stale-copy');
    }
  });
});

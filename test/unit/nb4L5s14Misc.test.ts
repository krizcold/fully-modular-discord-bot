import { afterEach, describe, expect, it, vi } from 'vitest';

// NB4 decision 6 and decisions 12 and 19: an operator delete of a frozen guild keeps its data, the panel recovery
// reads nothing once the process stopped serving, and the stop steps log what failed and always exit.

const h = vi.hoisted(() => ({ setState: null as string | null, deletes: 0, loads: [] as Array<string | undefined> }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<object>()),
  awaitGuildDataReady: async () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<object>()),
  getWorkingSet: () => (h.setState === null ? null : { stateOf: () => h.setState }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<object>()),
  deleteGuildNamespace: async () => { h.deletes += 1; return { ok: true }; },
}));
vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async orig => ({
  ...(await orig<object>()),
  loadPersistentPanels: async (guildId?: string) => { h.loads.push(guildId); return {}; },
}));

import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { recoverPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelRecovery';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { runStopSteps, type StopSteps } from '../../src/bot/internalSetup/utils/stopSteps';

afterEach(() => {
  h.setState = null;
  h.deletes = 0;
  h.loads.length = 0;
  setStoppedServingHook(null);
  vi.restoreAllMocks();
});

describe('an operator namespace delete of a frozen guild', () => {
  it('answers frozen and deletes nothing while the guild set is frozen-retained', async () => {
    setStoppedServingHook(() => false);
    h.setState = 'frozen-retained';
    expect(await applyOperatorDataWrite({ guildId: '123', module: '', filename: '', op: 'delete-namespace' })).toEqual({ ok: false, code: 'frozen' });
    expect(h.deletes).toBe(0);
    h.setState = 'ready';
    expect(await applyOperatorDataWrite({ guildId: '123', module: '', filename: '', op: 'delete-namespace' })).toEqual({ ok: true });
    expect(h.deletes).toBe(1);
  });
});

describe('the panel recovery after the process stopped serving', () => {
  it('reads no panel storage, global or guild', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setStoppedServingHook(() => true);
    const client = { guilds: { cache: new Map([['555', {}]]) } };
    await recoverPersistentPanels(client as never);
    expect(h.loads).toEqual([]);
    setStoppedServingHook(() => false);
    await recoverPersistentPanels(client as never);
    expect(h.loads).toEqual([undefined, '555']);
  });
});

describe('the stop steps', () => {
  const steps = (over: Partial<StopSteps> = {}) => {
    const exits: number[] = [];
    const s: StopSteps = {
      beginStop: () => undefined,
      stopSamplers: () => undefined,
      closeGateway: async () => undefined,
      flushTotals: () => undefined,
      drain: async () => undefined,
      finishStop: async () => undefined,
      exit: code => { exits.push(code); },
      ...over,
    };
    return { s, exits };
  };

  it('a gateway close that fails is logged with its error, and the drain and the exit still run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new Error('socket hang up');
    let drained = 0;
    const { s, exits } = steps({ closeGateway: async () => { throw failure; }, drain: async () => { drained += 1; } });
    await runStopSteps(s);
    expect(warn.mock.calls).toEqual([['[clientInitializer] Could not close the gateway on shutdown:', failure]]);
    expect(drained).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('a step that throws is logged with its error and the process exits with 0', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('drain broke');
    let finished = 0;
    const { s, exits } = steps({ drain: async () => { throw failure; }, finishStop: async () => { finished += 1; } });
    await runStopSteps(s);
    expect(error.mock.calls).toEqual([['[clientInitializer] A stop step failed; the bot process exits:', failure]]);
    expect(finished).toBe(0);
    expect(exits).toEqual([0]);
  });
});

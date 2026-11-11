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
import { stopSteps } from '../helpers/stopRig';
import { readSourceText } from '../helpers/sourceText';

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
  async function freshStop() {
    vi.resetModules();
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const order: string[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { order.push(`exit ${code}`); }) as unknown as typeof process.exit);
    return { dm, order, exit };
  }
  const stopStepSource = () => {
    const source = readSourceText(__dirname, '../../src/bot/internalSetup/clientInitializer.ts');
    return source.slice(source.indexOf('addStopStep(async () => {'), source.indexOf('addReleaseStep(() => stopMainWatch());'));
  };

  it("a gateway close that fails is logged with its error by clientInitializer's stop step", () => {
    expect(stopStepSource()).toContain(".catch(err => console.warn('[clientInitializer] Could not close the gateway on shutdown:', err))");
  });

  it('a step that throws is logged with its error and the process exits with 0', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { dm, exit } = await freshStop();
    const failure = new Error('step broke');
    let finished = 0;
    const stop = stopSteps(dm, { claims: () => ({ beginStop: () => undefined, finishStop: async () => { finished += 1; } }) });
    dm.addStopStep(() => { throw failure; });
    await stop();
    expect(error.mock.calls).toEqual([['[Data] A stop step failed:', failure]]);
    expect(finished).toBe(1);
    expect(exit.mock.calls).toEqual([[0]]);
  });
});

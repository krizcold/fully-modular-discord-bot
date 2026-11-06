import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pass: [] as any[],
  probed: [] as string[][],
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', async orig => ({
  ...(await orig<any>()),
  probePass: async (entries: Array<{ raw: string }>) => {
    h.probed.push(entries.map(e => e.raw));
    return h.pass;
  },
}));

import { decideBoot } from '../../src/bot/internalSetup/utils/maintenance';
import { MainChooser, tieText, type ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _startPostgresRuntime, getDataBootStatus } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';

// NB5 test 8: decideBoot runs one probe pass over every entry of the list and maps it by decision 7 (an accepted
// login is a normal boot, only refusals the maintenance boot), sends no Discord request, and a normal boot whose pass
// chose no main keeps the data layer 'starting' with decision 9's wait reason.

const A = 'postgres://bot@db1:5432/bot';
const B = 'postgres://bot@db2:5432/bot';
const LIST = `${A}, ${B}`;

const answered = (entry: string, over: Partial<Extract<ProbeAnswer, { kind: 'answered' }>> = {}): ProbeAnswer => ({
  kind: 'answered', address: parseAddressList(entry)[0].shown, entry, inRecovery: false, readOnly: false, generation: 1,
  machine: 'M', since: '2026-11-01', sysid: '1', started: entry, storeId: 'S', ...over,
});
const refused = (entry: string): ProbeAnswer => ({ kind: 'refused', address: parseAddressList(entry)[0].shown, entry });
const failed = (entry: string): ProbeAnswer => ({ kind: 'failed', address: parseAddressList(entry)[0].shown, entry, cause: 'unreachable' });

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.pass = [];
  h.probed = [];
  setBackendKind('postgres');
  vi.stubEnv('DATA_BACKEND_URL', LIST);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  setGuildDataBackend(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('test 8: decideBoot with a list', () => {
  it.each([
    ['a chosen pass', () => [answered(A, { generation: 2 }), answered(B, { inRecovery: true, generation: 2, started: A })]],
    ['a tie', () => [answered(A), answered(B)]],
    ['replaced', () => [answered(A, { generation: 1 }), answered(B, { generation: 2 })]],
    ['no-main', () => [answered(A, { inRecovery: true }), failed(B)]],
    ['mixed-stores', () => [answered(A, { storeId: 'S' }), answered(B, { storeId: 'T' })]],
    ['one refused and one answered', () => [refused(A), answered(B)]],
    ['only failures', () => [failed(A), failed(B)]],
  ] as Array<[string, () => ProbeAnswer[]]>)('%s boots normally, after one pass over both entries and no Discord request', async (_what, pass) => {
    h.pass = pass();
    expect(await decideBoot()).toEqual({ mode: 'normal' });
    expect(h.probed).toEqual([[A, B]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('every address refusing the login boots in maintenance', async () => {
    h.pass = [refused(A), refused(B)];
    expect(await decideBoot()).toMatchObject({ mode: 'maintenance', cause: 'login-refused' });
    expect(h.probed).toEqual([[A, B]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a probe whose statement failed after its login counts as accepted', async () => {
    h.pass = [{ ...failed(A), loggedIn: true }, refused(B)];
    expect(await decideBoot()).toEqual({ mode: 'normal' });
  });
});

describe('test 8: the data layer waits while the pass chose no main (B3)', () => {
  it('stays starting with the wait reason, and serves nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const waits: Array<string | null> = [];
    const chooser = new MainChooser({
      entries: () => parseAddressList(LIST),
      probe: async () => [answered(A), answered(B)],
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => 'S',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: reason => { waits.push(reason); },
    });
    const backend = _startPostgresRuntime(chooser);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(getDataBootStatus().state).toBe('starting');
    expect(backend.chosenEntry()).toBeNull();
    expect(waits.at(-1)).toBe(tieText(1, 'db1:5432/bot (M)', 'db2:5432/bot (M)'));
    expect(fetchSpy).not.toHaveBeenCalled();
    chooser.stop();
    await backend.stop?.();
  });
});

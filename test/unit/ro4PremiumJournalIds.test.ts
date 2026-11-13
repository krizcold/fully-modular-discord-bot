import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  premium: '',
  deletes: [] as Array<{ key: string; ids: string[] }>,
  journalRows: [] as Array<{ id: string; line: string }>,
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const { dataPath } = await import('../../src/utils/dataRoot');
  const premium = dataPath('global', 'premium-tiers.json');
  return {
    ...real,
    readRawStrict: (file: string) => (file === premium ? h.premium : real.readRawStrict(file)),
    saveDataTracked: () => ({ outcome: 'saved', ticket: { kind: 'row', key: 'global/premium-tiers.json', op: { state: 'landed', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 } }),
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return { ...real, rowBackend: () => ({ sharedSelect: async () => ({ rows: [] }) }) };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return { ...real, setSharedLinesPassStep: () => undefined, refreshShared: () => Promise.resolve({ ok: true }) };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  const ticket = (key: string) => ({ kind: 'row', key, op: { state: 'landed', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 });
  return {
    ...real,
    appendLine: (key: string) => ticket(key),
    deleteLines: (key: string, ids: string[]) => {
      h.deletes.push({ key, ids: [...ids] });
      return ticket(key);
    },
    carryLines: (key: string) => ticket(key),
    readJournal: async () => ({ ok: true, lines: h.journalRows.map(r => ({ ...r })) }),
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getNodeId } from '../../src/bot/internalSetup/fleet/nodeIdentity';
import { setBackendKind } from '../helpers/backendKind';
import { clearGlobal, paidSub, quiet, state, TIERS } from './nb10PremiumRig';

const JOURNAL_KEY = 'global/premium-tiers.events.jsonl';
const role = process.env.BOT_PROCESS_ROLE;

beforeEach(() => {
  quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  setBackendKind('postgres');
  resetPremiumManager();
  reg.current = null;
  h.deletes = [];
  h.journalRows = [];
  h.premium = JSON.stringify({
    tiers: TIERS,
    subscriptions: { g2: { active: paidSub('s2', 'e1', 'low'), paused: [] } },
    messages: {}, providerAccountLinks: {}, activatedProviders: {}, migrations: [], migrationSilencePolicy: 'cancel',
    eventsApplied: { 'p-old': 2 },
  }, null, 2);
  clearGlobal();
});
afterEach(() => {
  resetPremiumManager();
  reg.current = null;
  setBackendKind(null);
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a load that finds journal lines covered by the marks', () => {
  it('deletes the covered lines by their ids and sends no delete for a line with an empty id', async () => {
    const event = { type: 'subscription.expired', providerId: 'fake', providerSubId: 'e1', guildId: 'g2', state: state('expired') };
    const line = (n: number) => JSON.stringify({ writer: 'p-old', node: getNodeId(), nodeName: 'HERE', n, event });
    h.journalRows = [
      { id: '', line: line(1) },
      { id: 'j-old', line: line(2) },
    ];
    const pm = getPremiumManager();
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    pm.invalidate();
    pm.getAllTiers();
    expect(pm.cacheState()).not.toBe('replaying');
    expect(h.deletes).toEqual([{ key: JOURNAL_KEY, ids: ['j-old'] }]);
  });
});

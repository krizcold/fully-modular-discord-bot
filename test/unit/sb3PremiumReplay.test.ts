import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bot's pass over the journal key on a Postgres bot (NB10 decisions 40 and 54): it reloads the cache, and so starts
// the replay, when any replayable line is past eventsApplied, and keeps the loaded cache when none is. The journal read,
// the liveness query, this process's id and its node are scripted as rn3 scripts them; the manager is the real one.

const h = vi.hoisted(() => ({
  journal: { ok: true, lines: [] } as any,
  pool: null as null | { sharedSelect: (sql: string, params: unknown[], bound: number) => Promise<{ rows: any[] }> },
}));

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return { ...real, rowBackend: () => h.pool };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  const ticket = () => ({ kind: 'row', key: 'global/premium-tiers.events.jsonl', op: { state: 'landed', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 });
  return { ...real, readJournal: async () => h.journal, appendLine: ticket, carryLines: ticket, deleteLines: ticket };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return { ...real, setSharedLinesPassStep: () => undefined, refreshShared: async () => ({ ok: true }) };
});
vi.mock('../../src/bot/internalSetup/fleet/processId', () => ({ processId: () => 'me-proc' }));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/fleet/nodeIdentity')>();
  return { ...real, getNodeId: () => 'node-here' };
});
vi.mock('../../src/bot/internalSetup/fleet/nodeName', () => ({ getNodeName: () => 'Here' }));
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { setBackendKind } from '../helpers/backendKind';
import { clearGlobal, PREMIUM, quiet, tick, TIERS, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
let managers: PremiumManager[] = [];

const event = { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'e1', guildId: 'g1' };
const line = (id: string, n: number) => ({ id, line: JSON.stringify({ writer: 'w-other', node: 'node-here', n, event }) });

function bot(): PremiumManager {
  process.env.BOT_PROCESS_ROLE = 'bot';
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
}

/** premium-tiers.json renamed on disk after the load: a reload shows the new name, the loaded cache the old one. */
function renameOnDisk(): void {
  fs.writeFileSync(PREMIUM, JSON.stringify({ tiers: { ...TIERS, low: { ...TIERS.low, displayName: 'Renamed' } }, eventsApplied: { 'w-other': 1 } }, null, 2));
}

beforeEach(() => {
  quiet();
  setBackendKind('postgres');
  h.journal = { ok: true, lines: [] };
  h.pool = { sharedSelect: async () => ({ rows: [] }) };
  clearGlobal();
  writePremium({}, { eventsApplied: { 'w-other': 1 } });
});
afterEach(async () => {
  await tick(5);
  for (const pm of managers.splice(0)) pm.dispose();
  reg.current = null;
  setBackendKind(null);
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe("the bot's pass over a journal of an earlier process of this machine", () => {
  it('starts the replay when one line is past eventsApplied and another is covered', async () => {
    const pm = bot();
    expect(pm.getAllTiers().low.displayName).toBe('Low');
    renameOnDisk();
    h.journal = { ok: true, lines: [line('1', 1), line('2', 2)] };
    expect(await pm.readSharedJournal(true)).toEqual({ ok: true });
    expect(pm.cacheState()).toBe('replaying');
    expect(pm.getAllTiers().low.displayName).toBe('Renamed');
  });

  it('keeps the loaded cache when the journal holds no line', async () => {
    const pm = bot();
    expect(pm.getAllTiers().low.displayName).toBe('Low');
    renameOnDisk();
    expect(await pm.readSharedJournal(true)).toEqual({ ok: true });
    expect(pm.cacheState()).toBe('normal');
    expect(pm.getAllTiers().low.displayName).toBe('Low');
  });
});

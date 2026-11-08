import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { JOURNAL_KEY, PREMIUM_KEY, premiumRig, tier } from '../helpers/nb6PremiumRig';

// NB6 test 37 (wip-redesign/sheets/NB6.md decisions 40 and 54; rows 119, 120 and 180): the premium events journal is
// the journal key's lines. A pending line of another machine whose writer is live refuses a premium op with decision
// 40's text; the bot's pass replays the pending lines of a writer that is not live (NB4's test on shard_nodes, here
// the scripted rows) and deletes them once the save of its marks landed.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

const r = premiumRig();
const paused = (n: number, writer: string, node: string, nodeName: string) => JSON.stringify({
  writer, node, nodeName, n,
  event: { type: 'subscription.paused', providerId: 'nb6p', providerSubId: 'ps1', guildId: 'g1', resumesAt: '2027-01-01T00:00:00.000Z' },
});

/** A stored premium-tiers.json holding guild g1's paid sub ps1, as the facade stores it. */
async function storedWithSub(): Promise<void> {
  const pm = r.pm();
  pm.setTier('low', tier('Low', 1));
  await pm.grantManual('g1', 'low', 30);
  await r.settle();
  const config = r.row();
  config.subscriptions.g1.active = { ...config.subscriptions.g1.active, source: 'paid', providerId: 'nb6p', providerSubId: 'ps1' };
  r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
  await runSharedPass();
}

beforeEach(async () => {
  await r.setup();
});
afterEach(async () => {
  await r.teardown();
});

describe('row 119: another machine holds pending journal lines', () => {
  it('a premium op is not run and answers decision 40 text, code failed', async () => {
    await storedWithSub();
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', paused(1, 'p-bravo', 'node-bravo', 'BRAVO'));
    r.m.state.rows.nodes.set('p-bravo', { takeoverSeconds: 60, live: true });
    const before = r.row();
    const reply = await applySharedOp({ op: 'premium.setTier', args: { args: ['high', tier('High', 2)] } });
    expect(reply).toEqual({
      ok: false,
      code: 'failed',
      error: 'Premium holds provider events that BRAVO received while premium-tiers.json could not be read there; nothing was saved. The bot on BRAVO applies them once it runs normally (any bot does once that one has been stopped for 60 s); try again then.',
    });
    expect(r.row()).toEqual(before);
  });

  it('a line the marks cover refuses nothing (guard)', async () => {
    await storedWithSub();
    const config = r.row();
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify({ ...config, eventsApplied: { 'p-bravo': 1 } }, null, 2));
    await runSharedPass();
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', paused(1, 'p-bravo', 'node-bravo', 'BRAVO'));
    r.m.state.rows.nodes.set('p-bravo', { takeoverSeconds: 60, live: true });
    const reply = await applySharedOp({ op: 'premium.setTier', args: { args: ['high', tier('High', 2)] } });
    expect(reply).toMatchObject({ ok: true });
  });
});

describe('rows 120 and 180: the pass finds pending lines of a writer that is not live', () => {
  it('the cache is dropped and loaded, the replay applies the line, and the line is deleted once the marks landed', async () => {
    await storedWithSub();
    startPremiumTickers();
    r.pm().getAllTiers();
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', paused(1, 'p-dead', 'node-bravo', 'BRAVO'));
    await runSharedPass();
    await vi.waitFor(async () => {
      await r.settle();
      const row = r.row();
      expect(row.eventsApplied).toEqual({ 'p-dead': 1 });
      expect(row.subscriptions.g1.active.resumesAtHint).toBe('2027-01-01T00:00:00.000Z');
    }, { timeout: 5000 });
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.lines(JOURNAL_KEY)).toEqual([]);
    }, { timeout: 5000 });
  });

  it('a live writer of another machine is not replayed (guard)', async () => {
    await storedWithSub();
    startPremiumTickers();
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', paused(1, 'p-bravo', 'node-bravo', 'BRAVO'));
    r.m.state.rows.nodes.set('p-bravo', { takeoverSeconds: 60, live: true });
    await runSharedPass();
    await r.settle();
    expect(r.row().eventsApplied).toBeUndefined();
    expect(r.lines(JOURNAL_KEY)).toHaveLength(1);
  });
});

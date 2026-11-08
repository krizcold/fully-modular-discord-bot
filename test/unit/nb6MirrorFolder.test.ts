import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { mirrorRig } from '../helpers/nb6Mirror';
import { PREMIUM_KEY, settleRows, tier } from '../helpers/nb6PremiumRig';

// NB6 part 11b (out/NB6/part-rulings.md "Part 11"): the flush's mirror step creates the key's folders, as a JSON bot's
// file write does. A Postgres bot on a fresh data root with no global/ folder: premium's first save lands, its mirror
// holds the stored bytes, and a later save of the same key lands too (it is not refused 'changed-elsewhere').

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});

const m = mirrorRig('nb6folder');
const role = process.env.BOT_PROCESS_ROLE;

beforeEach(async () => {
  process.env.BOT_PROCESS_ROLE = 'bot';
  await m.setup();
  resetPremiumManager();
});
afterEach(async () => {
  resetPremiumManager();
  await m.teardown();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the mirror write on a data root with no global/ folder', () => {
  it('writes the mirror into a new folder; a later save of the key lands', async () => {
    expect(fs.existsSync(dataPath('global'))).toBe(false);
    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['low', tier('Low', 1)] } })).toMatchObject({ ok: true });
    await settleRows();
    const first = m.state.rows.docs.get(PREMIUM_KEY)!;
    expect(fs.readFileSync(dataPath('global', 'premium-tiers.json'))).toEqual(first.body);

    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['high', tier('High', 3)] } })).toMatchObject({ ok: true });
    await settleRows();
    const second = m.state.rows.docs.get(PREMIUM_KEY)!;
    expect(second.sha).not.toBe(first.sha);
    expect(Object.keys(JSON.parse(second.body.toString('utf8')).tiers).sort()).toEqual(['free', 'high', 'low']);
    expect(fs.readFileSync(dataPath('global', 'premium-tiers.json'))).toEqual(second.body);
    expect(m.state.lines.filter(l => l.includes('could not write'))).toEqual([]);
    expect(Object.keys(getPremiumManager().getAllTiers()).sort()).toEqual(['free', 'high', 'low']);
  });
});

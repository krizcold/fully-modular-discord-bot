# How premium-tiers.old.json was made

`premium-tiers.old.json` is the premium store in the shape the code at 6f2ac1d writes: its keys are bare server ids,
no paid subscription names a buyer, a provider account link is a bare server id, and a price-change decision has
`guildId`. `dummy-state.old.json` is the Dummy provider's own file from the same run (one record with `guildId` and no
buyer). Both were written on 2026-11-20 by the real PremiumManager and the real DummyProvider on the unchanged src of
6f2ac1d, over the mirror rig (test/helpers/nb6PremiumRig.ts, nb6DummyRig.ts); the bytes are the stored rows' bodies.
No field was edited by hand.

What the store holds:

- server 111111111111111111: an active Dummy purchase of gold (monthly), and a manual grant of silver paused in its
  queue;
- server 222222222222222222: an active manual grant of silver with no end, and the notices channel
  333333333333333333;
- the Patreon link `patreon-account-1` to server 222222222222222222;
- one pending price change (gold monthly to yearly) with one pending decision, for server 111111111111111111;
- `eventsApplied: { "p-old": 1 }`, the mark the replay saved for one journaled event of a stopped writer;
- the tiers gold and silver sold through the Dummy, the default messages, the Dummy's activation, the policy 'cancel'.

The dates are those of the run. To make the files again, check out 6f2ac1d, save the code below as
test/unit/p1MakeOldFixture.test.ts, run `node run.cjs --project fast unit/p1MakeOldFixture.test.ts` from test/ and
delete the test file. It cannot run on a later tree: it calls the manager with bare server ids.

```ts
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { JOURNAL_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, MONTHLY, YEARLY, dummyRig } from '../helpers/nb6DummyRig';

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
const d = dummyRig(r);
const A = '111111111111111111';
const B = '222222222222222222';

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await d.setup();
});
afterEach(async () => {
  await d.teardown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('writes the old-shape fixture', async () => {
  const pm = r.pm();
  void getPaymentRegistry();
  const bought = await d.buy(A, 'gold', 'o1', MONTHLY);
  expect(bought).toMatchObject({ state: { status: 'active' } });
  expect(await pm.grantManual(A, 'silver', 30)).toBe(true);
  await d.settle();
  expect(await pm.grantManual(B, 'silver', null)).toBe(true);
  await d.settle();
  expect(pm.setNotificationsChannelId(B, '333333333333333333')).toBe(true);
  await d.settle();
  expect(pm.linkAccount('patreon', 'patreon-account-1', B)).toBe(true);
  await d.settle();
  await pm.scheduleMigration({
    providerId: 'dummy', sourceTierId: 'gold', sourceOfferingId: 'o1', sourceVariantId: MONTHLY,
    targetTierId: 'gold', targetOfferingId: 'o1', targetVariantId: YEARLY,
    effectiveDate: new Date(Date.now() + 20 * DAY_MS).toISOString(), message: 'The monthly plan becomes yearly.',
  });
  await d.settle();
  startPremiumTickers();
  pm.getAllTiers();
  r.m.state.rows.putLine(JOURNAL_KEY, 'j1', JSON.stringify({
    writer: 'p-old', node: 'node-alfa', nodeName: 'ALFA', n: 1,
    event: { type: 'subscription.renewal-failed', providerId: 'dummy', providerSubId: 'dummy_unknown', guildId: '999999999999999999', reason: 'card' },
  }));
  await runSharedPass();
  await vi.waitFor(async () => {
    await r.settle();
    expect(r.row().eventsApplied).toEqual({ 'p-old': 1 });
  }, { timeout: 5000 });
  expect(r.lines(JOURNAL_KEY)).toEqual([]);
  const row = r.row();
  expect(Object.keys(row.subscriptions).sort()).toEqual([A, B]);
  expect(row.subscriptions[A].active).toMatchObject({ source: 'paid', providerId: 'dummy', tierId: 'gold' });
  expect(row.subscriptions[A].paused).toHaveLength(1);
  expect(row.subscriptions[B]).toMatchObject({ active: { source: 'manual' }, notificationsChannelId: '333333333333333333' });
  expect(row.providerAccountLinks).toEqual({ patreon: { 'patreon-account-1': B } });
  expect(row.migrations).toHaveLength(1);
  expect(row.migrations[0].decisions.map((x: any) => [x.guildId, x.decision])).toEqual([[A, 'pending']]);
  const out = path.resolve(__dirname, '..', 'fixtures', 'p1');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'premium-tiers.old.json'), r.m.state.rows.docs.get('global/premium-tiers.json')!.body);
  fs.writeFileSync(path.join(out, 'dummy-state.old.json'), r.m.state.rows.docs.get('global/payment-providers/dummy/state.json')!.body);
}, 30_000);
```

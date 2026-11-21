# How dummy-state.p1.json was made

`dummy-state.p1.json` is the Dummy provider's state.json in the shape P1 leaves it: three subscription records keyed
`dummy_1` to `dummy_3`, each with `guildId` and `buyerId` and no `holder` (`dummy_1` paused, the other two
active), the seeded variants, products and coupons, and `nextId` 4. `premium-tiers.p1.json` is premium's file from the
same run.

Both files were written on 2026-11-21 by one run of the real PremiumManager and the real DummyProvider on the unchanged
src of P1's head (sw-P1 d3be1dd, "Let premium belong to a server or a user"), over the mirror rig
(test/helpers/nb6PremiumRig.ts and nb6DummyRig.ts, the bot role); the bytes are the stored rows' bodies. No field was
edited by hand. The run, through premium's purchase with the buyer 80000000000000001:

- server 111111111111111111 buys silver (priority 1), then gold (priority 2): gold is active, silver is paused in its
  queue and paused at the Dummy with no resume date;
- server 222222222222222222 buys silver.

To make the files again, check out d3be1dd, save the code below as test/unit/p2MakeP1Fixture.test.ts, run
`node run.cjs --project fast unit/p2MakeP1Fixture.test.ts` from test/ (TEMP and TMP on D:) and delete the test file.
It writes both files; the dates are those of the run. After P2's part 1 the Dummy no longer writes `guildId`, so the
code does not run on a later tree.

```ts
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { premiumRig } from '../helpers/nb6PremiumRig';
import { dummyRig } from '../helpers/nb6DummyRig';
import { gh } from '../helpers/p1Holder';

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

it('writes the fixtures of the shape P1 leaves', async () => {
  expect(await d.buy(A, 'silver')).toMatchObject({ state: { status: 'active' } });
  expect(await d.buy(A, 'gold')).toMatchObject({ state: { status: 'active' } });
  expect(await d.buy(B, 'silver')).toMatchObject({ state: { status: 'active' } });
  await d.settle();
  const row = r.row();
  expect(Object.keys(row.subscriptions).sort()).toEqual([gh(A), gh(B)]);
  expect(row.subscriptions[gh(A)].active).toMatchObject({ source: 'paid', providerId: 'dummy', tierId: 'gold', providerSubId: 'dummy_2' });
  expect(row.subscriptions[gh(A)].paused.map((p: any) => [p.tierId, p.providerSubId, p.status])).toEqual([['silver', 'dummy_1', 'paused']]);
  expect(row.subscriptions[gh(B)].active).toMatchObject({ source: 'paid', providerId: 'dummy', tierId: 'silver', providerSubId: 'dummy_3' });
  const state = d.stored();
  expect(Object.values<any>(state.subscriptions).map(s => [s.providerSubId, s.guildId, s.buyerId, s.status])).toEqual([
    ['dummy_1', A, '80000000000000001', 'paused'],
    ['dummy_2', A, '80000000000000001', 'active'],
    ['dummy_3', B, '80000000000000001', 'active'],
  ]);
  expect(state.nextId).toBe(4);
  const out = path.resolve(__dirname, '..', 'fixtures', 'p2');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'premium-tiers.p1.json'), r.m.state.rows.docs.get('global/premium-tiers.json')!.body);
  fs.writeFileSync(path.join(out, 'dummy-state.p1.json'), r.m.state.rows.docs.get('global/payment-providers/dummy/state.json')!.body);
}, 30_000);
```

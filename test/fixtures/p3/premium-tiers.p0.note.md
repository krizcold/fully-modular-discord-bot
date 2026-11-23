# How premium-tiers.p0.json and stripe-objects.p0.json were made

`premium-tiers.p0.json` is premium-tiers.json after one Stripe subscription was installed by the code before P3: the
server tier `gold` with its offering `o-gold` linking `price_gold_month` and `price_gold_once`, Stripe's activation,
and under `guild:81000000000000001` the active paid subscription `sub_p3000003` bought by `81000000000000002`.
`stripe-objects.p0.json` is the fake's state from the same run (`FakeStripe.dump()` of test/helpers/p3Stripe.ts; `load`
takes it back): the prices, the Customer `cus_p3000002` that the checkout made, the Checkout Session
`cs_test_p3000001` with the parameters the code sent, and the subscription `sub_p3000003`, whose metadata holds
`guildId` and `userId` and no `holder` (sheet P3, claim 15).

Both files were written on 2026-11-22 by one run on the unchanged src of bot-int 139b993 ("Let the Dummy provider sell
to a server or a user") with P3's part 0 helpers, on the JSON files (test/helpers/p3World.ts, the bot role). No field
was edited by hand. The run: the member route's purchase of the monthly price for server 81000000000000001 by the
signed-in user 81000000000000002; the fake completes the session, paid; the three queued events
(`customer.subscription.created`, `invoice.paid`, `checkout.session.completed`) are delivered through payment.webhook,
oldest first, and the last installs the subscription.

To make the files again, on a tree whose Stripe provider still writes `guildId` (before P3's part 3), save the code
below as test/unit/p3MakeP0Fixture.test.ts, run `node run.cjs --project fast unit/p3MakeP0Fixture.test.ts` from test/
(TEMP and TMP on D:) and delete the test file. The dates are those of the run.

```ts
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { heldStripe, IDS, p3World } from '../helpers/p3World';

const w = p3World('json');
const SERVER = IDS[0];
const BUYER = IDS[1];

beforeEach(async () => {
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  await w.setup();
});
afterEach(async () => {
  await w.teardown();
  vi.restoreAllMocks();
});

it('writes the fixture of a Stripe subscription installed by the code before P3', async () => {
  const bought = await w.buyMember(`guild:${SERVER}`, BUYER);
  expect(bought.status).toBe(200);
  const session = w.fake.complete(bought.sessionId!, { paid: true });
  const delivered = await w.drain();
  expect(delivered.map(d => [d.event.type, d.status])).toEqual([
    ['customer.subscription.created', 200], ['invoice.paid', 200], ['checkout.session.completed', 200],
  ]);
  const sub = w.fake.subscriptions.get(session.subscription)!;
  expect(sub.metadata).toEqual({ guildId: SERVER, tierId: 'gold', offeringId: 'o-gold', variantId: 'price_gold_month', couponCode: '', userId: BUYER });
  expect(heldStripe(w.stored()).map(h => [h.holder, h.sub.providerSubId, h.sub.buyerId, h.sub.status])).toEqual([[`guild:${SERVER}`, sub.id, BUYER, 'active']]);
  expect(w.fake.unexpected).toEqual([]);
  const out = path.resolve(__dirname, '..', 'fixtures', 'p3');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'premium-tiers.p0.json'), w.storedText()!);
  fs.writeFileSync(path.join(out, 'stripe-objects.p0.json'), `${JSON.stringify(w.fake.dump(), null, 2)}\n`);
}, 60_000);
```

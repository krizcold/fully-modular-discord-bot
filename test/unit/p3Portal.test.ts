import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claim 14's op rows (sheet P3, section 7; part 3): the read-only op payment.billingPortal answers { portalUrl },
// writes nothing (its ledger holds no ticket and no refusal, the doc's and premium-tiers.json's bytes unchanged), turns a
// provider's throw into code 'invalid' with the provider's own text, and applySharedOp tags only refreshBeforeOp's
// refusal with refreshFailed. Lemon Squeezy's two-parameter method answers through the op as before. The route rows of
// claim 14 are part 5's.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { dataPath } from '../../src/utils/dataRoot';
import { carriedWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { LemonSqueezyProvider } from '../../src/bot/internalSetup/utils/payment/lemonsqueezyProvider';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { sharedOpFailure } from '../../src/webui/routes/hopFailure';
import { CUSTOMERS_KEY, customersPath, HOST, IDS, p3World, type P3World } from '../helpers/p3World';

const A = IDS[0];
const G = '73000000000000001';
const RETURN = `${HOST}/guild/${G}/subscription`;

/** A server subscription bought by A on the member route, completed at the fake and installed by its events. */
async function installed(w: P3World): Promise<string> {
  const bought = await w.buyMember(`guild:${G}`, A);
  const sub = w.fake.complete(bought.sessionId!).subscription as string;
  await w.drain();
  if (w.stored().subscriptions?.[`guild:${G}`]?.active?.providerSubId !== sub) throw new Error('the subscription was not installed');
  return sub;
}

const portal = (w: P3World, args: Record<string, unknown>) => w.sharedOp('payment.billingPortal', args);

describe('payment.billingPortal on the JSON files', () => {
  const w = p3World('json');
  beforeEach(async () => {
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    await w.setup();
  });
  afterEach(async () => {
    getPaymentRegistry().unregister('lemonsqueezy');
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('answers { portalUrl } and writes nothing: no ticket, no refusal, the bytes unchanged', async () => {
    const sub = await installed(w);
    const docBefore = w.customersText();
    const premiumBefore = w.storedText();
    const reply = await portal(w, { providerId: 'stripe', providerSubId: sub, returnUrl: RETURN, buyerId: A });
    expect(reply).toEqual({ ok: true, result: { portalUrl: expect.stringMatching(/^https:\/\/billing\.stripe\.example\//) } });
    expect(carriedWrites(reply)).toMatchObject({ tickets: [], refused: false, unknowable: false });
    expect(w.customersText()).toBe(docBefore);
    expect(w.storedText()).toBe(premiumBefore);
    expect(w.fake.portalSessions).toHaveLength(1);
  });

  it("a provider's throw answers code 'invalid' with the provider's text and no provider sentence", async () => {
    await installed(w);
    const reply = await portal(w, { providerId: 'stripe', providerSubId: 'sub_missing', returnUrl: RETURN, buyerId: A });
    expect(reply).toMatchObject({ ok: false, code: 'invalid' });
    expect(reply.error).toContain('sub_missing');
    expect(reply.error).not.toContain(PROVIDER_SENTENCE);
    expect((reply as any).refreshFailed).toBeUndefined();
  });

  it('a refusal that is not refreshBeforeOp\'s carries no refreshFailed: premium-tiers.json unreadable, an unknown op', async () => {
    const sub = await installed(w);
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), '{ not json');
    await w.reload();
    const unreadable = await portal(w, { providerId: 'stripe', providerSubId: sub, returnUrl: RETURN, buyerId: A });
    const unknown = await w.sharedOp('payment.nope', {});
    expect([unreadable.ok, unknown.ok]).toEqual([false, false]);
    expect([(unreadable as any).refreshFailed, (unknown as any).refreshFailed]).toEqual([undefined, undefined]);
  });

  it("Lemon Squeezy's method, called through the op with the buyer, answers its portal URL as before", async () => {
    vi.stubEnv('LEMONSQUEEZY_API_KEY', 'ls_key');
    getPaymentRegistry().register(new LemonSqueezyProvider());
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: { id: '9', attributes: { urls: { customer_portal: 'https://ls.example/portal/9' } } } }), { status: 200 });
    }));
    const reply = await portal(w, { providerId: 'lemonsqueezy', providerSubId: '9', returnUrl: RETURN, buyerId: A });
    expect(reply).toEqual({ ok: true, result: { portalUrl: 'https://ls.example/portal/9' } });
    expect(seen).toEqual(['https://api.lemonsqueezy.com/v1/subscriptions/9']);
    vi.unstubAllEnvs();
  });
});

describe('payment.billingPortal on the mirror rig', () => {
  const w = p3World('rig');
  beforeEach(async () => {
    await w.setup();
  });
  afterEach(async () => {
    w.rig!.m.state.rows.fault = undefined;
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("refreshBeforeOp's refusal carries refreshFailed: true; the op's own refusal does not", async () => {
    const sub = await installed(w);
    const own = await portal(w, { providerId: 'stripe', providerSubId: 'sub_missing', returnUrl: RETURN, buyerId: A });
    w.rig!.m.state.rows.fault = () => new Error('Connection terminated unexpectedly');
    const refused = await portal(w, { providerId: 'stripe', providerSubId: sub, returnUrl: RETURN, buyerId: A });
    w.rig!.m.state.rows.fault = undefined;
    expect(refused).toMatchObject({ ok: false, code: 'failed', refreshFailed: true });
    expect(own).toMatchObject({ ok: false, code: 'invalid' });
    expect((own as any).refreshFailed).toBeUndefined();
    expect(w.fake.portalSessions).toHaveLength(0);
  }, 30_000);
});

// Claim 14's route rows (part 5): gsub's POST /:guildId/paid/billing-portal over the world's runSharedOp.
const B = IDS[1];
const G2 = '73000000000000002';
const SP1 = 'Only the member who pays for this subscription can open its billing portal.';
const SP2 = "Stripe's record of this subscription does not name you as its payer, so no billing portal was opened.";
const SP4 = "This subscription is not on the Stripe billing account the bot records for you (it may have been started from the bot's dev page), so no billing portal was opened.";
const SP5_LEAD = 'The billing portal did not open: the bot could not read its record of your Stripe billing account (';
const SP6 = 'The billing portal did not open: the bot did not answer in time. Try again.';

function portalRoute(w: P3World, guildId: string, userId: string, body: Record<string, unknown> = {}, runSharedOp?: (name: string, args: unknown) => Promise<any>) {
  const bm = runSharedOp ? { ...w.botManager, runSharedOp } : w.botManager;
  return w.callRoute(createGuildSubscriptionRoutes(bm), 'post', '/:guildId/paid/billing-portal', { params: { guildId }, body, user: { id: userId } });
}

function writeDoc(w: P3World, text: string): void {
  if (w.rig) w.rig.m.state.rows.put(CUSTOMERS_KEY, text);
  else fs.writeFileSync(customersPath(), text);
}

for (const backend of ['json', 'rig'] as const) {
  describe(`the portal route on ${backend === 'json' ? 'the JSON files' : 'the mirror rig'}`, () => {
    const w = p3World(backend);
    beforeEach(async () => {
      for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
      await w.setup();
    });
    afterEach(async () => {
      if (w.rig) w.rig.m.state.rows.fault = undefined;
      await w.teardown();
      vi.restoreAllMocks();
    });

    it("the buyer gets the portal on the subscription's Customer with the route's own return address; the doc's bytes unchanged", async () => {
      const sub = await installed(w);
      const docBefore = w.customersText();
      const reply = await portalRoute(w, G, A, { returnUrl: 'https://evil.example/' });
      const customer = w.fake.subscriptions.get(sub)!.customer;
      expect(reply).toEqual({ status: 200, body: { success: true, portalUrl: `https://billing.stripe.example/p/${customer}` } });
      expect(w.fake.portalSessions.map(p => [p.customer, p.return_url])).toEqual([[customer, RETURN]]);
      expect(w.customersText()).toBe(docBefore);
    }, 30_000);

    it('a signed-in admin who is not the buyer: 403 SP1 and no call to Stripe', async () => {
      await installed(w);
      w.fake.fail('GET', /subscriptions/, { drop: 'before' });
      const reply = await portalRoute(w, G, B);
      expect(reply).toEqual({ status: 403, body: { success: false, error: SP1 } });
      expect(w.fake.portalSessions).toHaveLength(0);
      // The armed fault is still unused: the route made no Stripe call for B.
      const after = await portalRoute(w, G, A);
      expect(after.status).toBe(400);
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    it("Stripe's metadata names another buyer: SP2, no portal session", async () => {
      const sub = await installed(w);
      w.fake.subscriptions.get(sub)!.metadata.buyerId = B;
      const reply = await portalRoute(w, G, A);
      expect(reply).toEqual({ status: 400, body: { success: false, error: SP2 } });
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    it('a read of the subscription that fails: SP3, no portal session', async () => {
      await installed(w);
      w.fake.fail('GET', /subscriptions/, { drop: 'before' });
      const reply = await portalRoute(w, G, A);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toMatch(/^Stripe did not answer \(.+\), so no billing portal was opened\. Try again\.$/);
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    const answers: Array<[string, 'GET' | 'POST', any, string]> = [
      ['the read answers 404 resource_missing', 'GET', { status: 404, code: 'resource_missing', message: "No such subscription: 'sub_x'" }, "Stripe has no record of this subscription (No such subscription: 'sub_x'), so no billing portal was opened."],
      ['the read answers 401', 'GET', { status: 401, message: 'Invalid API Key provided.' }, 'Stripe refused to read this subscription: Invalid API Key provided. No billing portal was opened.'],
      ['the read answers 503', 'GET', { status: 503 }, 'Stripe answered 503, so no billing portal was opened. Try again.'],
      ['the portal POST answers 400', 'POST', { status: 400, message: 'No configuration provided and your test mode default configuration has not been created.' }, 'Stripe did not open the billing portal: No configuration provided and your test mode default configuration has not been created.'],
      ['the portal POST answers 500', 'POST', { status: 500 }, 'Stripe answered 500, so no billing portal was opened. Try again.'],
    ];
    for (const [name, method, fault, text] of answers) {
      it(`${name}: its own text, no portal session`, async () => {
        await installed(w);
        w.fake.fail(method, method === 'GET' ? /subscriptions/ : /^[/]v1[/]billing_portal[/]sessions$/, fault);
        const reply = await portalRoute(w, G, A);
        expect(reply).toEqual({ status: 400, body: { success: false, error: text } });
        expect(w.fake.portalSessions).toHaveLength(0);
      }, 30_000);
    }

    it("no STRIPE_SECRET_KEY: the bot's own cause, not 'Stripe did not answer', no portal session", async () => {
      await installed(w);
      const saved = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;
      let reply: any;
      try {
        reply = await portalRoute(w, G, A);
      } finally {
        process.env.STRIPE_SECRET_KEY = saved;
      }
      expect(reply).toEqual({ status: 400, body: { success: false, error: 'The bot did not ask Stripe (STRIPE_SECRET_KEY is not set), so no billing portal was opened.' } });
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    it('a dev-route subscription naming member B as buyer: B gets SP4 and no portal session', async () => {
      const bought = await w.buyDev(`guild:${G2}`, B);
      w.fake.complete(bought.sessionId!);
      await w.drain();
      expect(w.stored().subscriptions?.[`guild:${G2}`]?.active?.buyerId).toBe(B);
      const reply = await portalRoute(w, G2, B);
      expect(reply).toEqual({ status: 400, body: { success: false, error: SP4 } });
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    it("the buyer's doc entry missing (the row writes { customers: {} }): SP4, no portal session", async () => {
      await installed(w);
      writeDoc(w, JSON.stringify({ customers: {} }, null, 2));
      const reply = await portalRoute(w, G, A);
      expect(reply).toEqual({ status: 400, body: { success: false, error: SP4 } });
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    it("the buyer's doc entry names another Customer (the row edits the doc): SP4, no portal session", async () => {
      await installed(w);
      writeDoc(w, JSON.stringify({ customers: { [A]: { customerId: 'cus_other0001', createdAt: new Date().toISOString() } } }, null, 2));
      const reply = await portalRoute(w, G, A);
      expect(reply).toEqual({ status: 400, body: { success: false, error: SP4 } });
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    it('the doc not readable: SP5, no portal session', async () => {
      await installed(w);
      writeDoc(w, '{ not json');
      const reply = await portalRoute(w, G, A);
      expect(reply.status).toBe(400);
      expect(reply.body.error.startsWith(SP5_LEAD)).toBe(true);
      expect(w.fake.portalSessions).toHaveLength(0);
    }, 30_000);

    it('the bot starting: the starting text with its status, not SP5', async () => {
      await installed(w);
      const text = 'The bot is starting and is bringing the shared files up to date from the database. Try again in a moment.';
      const reply = await portalRoute(w, G, A, {}, async () => ({ ok: false, code: 'starting', error: text }));
      expect(reply).toEqual({ status: 503, body: { success: false, error: text } });
    }, 30_000);

    it('a reply with noAnswer: 503 SP6', async () => {
      await installed(w);
      const reply = await portalRoute(w, G, A, {}, async () => ({ ok: false, code: 'no-answer', noAnswer: 'timeout', error: 'IPC timeout' }));
      expect(reply).toEqual({ status: 503, body: { success: false, error: SP6 } });
    }, 30_000);
  });
}

describe('the portal route on the JSON files: premium-tiers.json unreadable', () => {
  const w = p3World('json');
  beforeEach(async () => {
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    await w.setup();
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("answers the op's own text, not SP5", async () => {
    await installed(w);
    const replies: any[] = [];
    const reply = await portalRoute(w, G, A, {}, async (name, args) => {
      fs.writeFileSync(dataPath('global', 'premium-tiers.json'), '{ not json');
      await w.reload();
      const r = await w.sharedOp(name, args);
      replies.push(r);
      return r;
    });
    expect(replies[0]).toMatchObject({ ok: false });
    expect(replies[0].refreshFailed).toBeUndefined();
    expect(reply.body).toEqual({ success: false, error: replies[0].error });
    expect(reply.body.error.startsWith(SP5_LEAD)).toBe(false);
    expect(reply.status).toBe(sharedOpFailure(replies[0])!.status);
    expect(w.fake.portalSessions).toHaveLength(0);
  }, 30_000);
});

describe('the portal route on the mirror rig: the doc refreshed inside the op', () => {
  const w = p3World('rig');
  beforeEach(async () => {
    await w.setup();
  });
  afterEach(async () => {
    w.rig!.m.state.rows.fault = undefined;
    await w.teardown();
    vi.restoreAllMocks();
  });

  /** Another machine moved A's entry to a new Customer in the row; this machine's mirror has not seen it. */
  async function movedElsewhere(): Promise<string | null> {
    const sub = await installed(w);
    w.fake.customers.set('cus_moved0001', { id: 'cus_moved0001', object: 'customer' });
    w.fake.subscriptions.get(sub)!.customer = 'cus_moved0001';
    const mirrorBefore = fs.existsSync(customersPath()) ? fs.readFileSync(customersPath(), 'utf8') : null;
    w.rig!.m.state.rows.put(CUSTOMERS_KEY, JSON.stringify({ customers: { [A]: { customerId: 'cus_moved0001', createdAt: new Date().toISOString() } } }, null, 2));
    return mirrorBefore;
  }

  it("the route's op brings the mirror up first and opens the portal on the Customer the row names", async () => {
    await movedElsewhere();
    const reply = await portalRoute(w, G, A);
    expect(reply).toEqual({ status: 200, body: { success: true, portalUrl: 'https://billing.stripe.example/p/cus_moved0001' } });
    expect(w.fake.portalSessions.map(p => p.customer)).toEqual(['cus_moved0001']);
  }, 30_000);

  it('with no bot child (the local chain applies the op through applySharedOp): the portal opens the same way', async () => {
    await movedElsewhere();
    const reply = await portalRoute(w, G, A, {}, async (name, args) => w.sharedOp(name, args));
    expect(reply.status).toBe(200);
    expect(w.fake.portalSessions.map(p => p.customer)).toEqual(['cus_moved0001']);
  }, 30_000);

  it('refreshBeforeOp made to fail: 503 SP5 carrying its text, no portal session, the mirror file not written', async () => {
    const mirrorBefore = await movedElsewhere();
    const replies: any[] = [];
    const reply = await portalRoute(w, G, A, {}, async (name, args) => {
      w.rig!.m.state.rows.fault = () => new Error('Connection terminated unexpectedly');
      const r = await w.sharedOp(name, args);
      w.rig!.m.state.rows.fault = undefined;
      replies.push(r);
      return r;
    });
    expect(replies[0]).toMatchObject({ ok: false, refreshFailed: true });
    expect(reply).toEqual({ status: 503, body: { success: false, error: `${SP5_LEAD}${String(replies[0].error).trim().replace(/\.+$/, '')}).` } });
    expect(w.fake.portalSessions).toHaveLength(0);
    const mirrorAfter = fs.existsSync(customersPath()) ? fs.readFileSync(customersPath(), 'utf8') : null;
    expect(mirrorAfter).toBe(mirrorBefore);
  }, 30_000);
});

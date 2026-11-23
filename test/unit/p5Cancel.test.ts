import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P5 claim 11, ppr's rows (sheet P5, Revision 9, Z7 and Z9): premium's cancel and "Cancel & remove now" through
// PayPal. A soft cancel returns Z5's state at once; a 4xx is followed by a read; a 5xx or no answer is "can't confirm";
// a call never sent says so and changes nothing.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { loadGuildPanel, panelFlush, panelText, type Node } from '../helpers/p1PanelRig';
import { z5End } from '../helpers/p5Model';
import { heldPayPal, IDS, p5World, type OpReply } from '../helpers/p5World';
import { onceKit } from '../helpers/p5pOnce';

const HOLDER = `guild:${IDS[0]}`;
const CANCEL = /\/cancel$/;
const SUB_READ = /^\/v1\/billing\/subscriptions\/I-[^/?]+$/;

const w = p5World('json');

beforeEach(async () => { await w.setup({ clock: Date.UTC(2027, 0, 31, 12) }); });
afterEach(async () => {
  await w.teardown();
  vi.restoreAllMocks();
});

async function owned(): Promise<string> {
  const reply = await w.buyMember(HOLDER, IDS[0]);
  w.fake.approve(reply.subscriptionId!);
  await w.drain();
  return reply.subscriptionId!;
}
const heldOf = (id: string) => heldPayPal(w.stored()).find(h => h.sub.providerSubId === id) ?? null;
const cancels = (id: string) => w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`)).length;
const errorOf = (reply: OpReply): string => String(reply.error ?? '');
/** A new PayPalProvider, so no token is cached. */
const freshProvider = (): void => {
  getPaymentRegistry().unregister('paypal');
  getPaymentRegistry().register(new PayPalProvider());
};

const MODES: Array<[string, 'cancelPaidSubscription' | 'cancelPaidSubscriptionImmediately']> = [
  ['the cancel', 'cancelPaidSubscription'],
  ['"Cancel & remove now"', 'cancelPaidSubscriptionImmediately'],
];

describe('P5 claim 11: the soft cancel', () => {
  it('returns the state (auto-renew off, the end of Z5) and premium shows it at once', async () => {
    const id = await owned();
    const reply = await w.op('cancelPaidSubscription', HOLDER);
    expect(reply.ok).toBe(true);
    expect(w.fake.subscriptions.get(id)!.status).toBe('CANCELLED');
    const held = heldOf(id)!.sub;
    expect([held.status, held.autoRenew, held.providerMeta.paypalStatus, Date.parse(held.endDate)]).toEqual(['active', false, 'CANCELLED', z5End(w.fake, id).end]);
    expect(w.fake.queue.map(e => e.event_type)).toEqual(['BILLING.SUBSCRIPTION.CANCELLED']);
  });

  it('with the read after it failing, returns nothing; the record changes at the CANCELLED event', async () => {
    const id = await owned();
    w.fake.fail('GET', SUB_READ, { status: 500 });
    const reply = await w.op('cancelPaidSubscription', HOLDER);
    expect(reply.ok).toBe(true);
    expect(heldOf(id)!.sub.autoRenew).toBe(true);
    await w.drain();
    expect(heldOf(id)!.sub).toMatchObject({ autoRenew: false, providerMeta: { paypalStatus: 'CANCELLED' } });
  });
});

describe('P5 review 2 (B8): the soft cancel while premium cannot read its copy', () => {
  it("premium-tiers.json turning unreadable during the read after the cancel: the cancel fails with the can't-confirm text and writes nothing; readable again, the CANCELLED delivery turns auto-renew off", async () => {
    const id = await owned();
    const file = dataPath('global', 'premium-tiers.json');
    const good = w.storedText()!;
    const held = w.fake.hold('GET', SUB_READ);
    const pending = w.op('cancelPaidSubscription', HOLDER);
    await held.reached;
    fs.writeFileSync(file, '{ not json');
    getPremiumManager().invalidate();
    held.release();
    const reply = await pending;
    expect(reply.ok).toBe(false);
    expect(errorOf(reply)).toContain(`PayPal cancelled subscription ${id}, and the bot can't confirm the end it keeps for it (premium cannot read its subscriptions now). Reload in a minute; the page shows the change once PayPal reports it.`);
    expect([w.storedText(), w.fake.subscriptions.get(id)!.status]).toEqual(['{ not json', 'CANCELLED']);
    fs.writeFileSync(file, good);
    getPremiumManager().invalidate();
    await w.drain();
    expect(heldOf(id)!.sub).toMatchObject({ autoRenew: false, providerMeta: { paypalStatus: 'CANCELLED' } });
  });
});

describe.each(MODES)('P5 claim 11: PayPal\'s answers to %s', (_name, op) => {
  it('a 422 with the subscription already cancelled counts as done', async () => {
    const id = await owned();
    w.fake.buyerCancel(id);
    const reply = await w.op(op, HOLDER);
    expect(reply.ok).toBe(true);
    if (op === 'cancelPaidSubscriptionImmediately') expect(heldOf(id)).toBeNull();
    else expect(heldOf(id)!.sub.autoRenew).toBe(false);
  });

  it('a 422 with it still active: PC1, premium unchanged', async () => {
    const id = await owned();
    const before = w.storedText();
    w.fake.fail('POST', CANCEL, { status: 422, message: 'Invalid subscription status for cancel action.' });
    const reply = await w.op(op, HOLDER);
    expect(reply.ok).toBe(false);
    expect(errorOf(reply)).toContain(`PayPal refused to cancel subscription ${id}: Invalid subscription status for cancel action. Its status at PayPal is ACTIVE.`);
    expect(w.storedText()).toBe(before);
  });

  it('a 422 with it suspended at PayPal: PC1 names SUSPENDED, premium unchanged', async () => {
    const id = await owned();
    w.fake.suspendNoFailure(id);
    await w.drain();
    const before = w.storedText();
    w.fake.fail('POST', CANCEL, { status: 422, message: 'Invalid subscription status for cancel action.' });
    const reply = await w.op(op, HOLDER);
    expect(reply.ok).toBe(false);
    expect(errorOf(reply)).toContain(`PayPal refused to cancel subscription ${id}: Invalid subscription status for cancel action. Its status at PayPal is SUSPENDED.`);
    expect(w.storedText()).toBe(before);
  });

  it('a 422 and a read answering 204 with no subscription: PC2, premium unchanged', async () => {
    const id = await owned();
    const before = w.storedText();
    w.fake.fail('POST', CANCEL, { status: 422, message: 'Invalid subscription status for cancel action.' });
    w.fake.fail('GET', SUB_READ, { status: 204 });
    const reply = await w.op(op, HOLDER);
    expect(reply.ok).toBe(false);
    expect(errorOf(reply)).toContain(`Can't confirm whether PayPal cancelled subscription ${id} (PayPal answered 422: Invalid subscription status for cancel action; its read showed no status). Reload in a minute; the page shows the change once PayPal reports it.`);
    expect(w.storedText()).toBe(before);
  });

  it('a 404 and a read answering 404: the cancel says PayPal has no such subscription and keeps it; "Cancel & remove now" removes it with that line logged', async () => {
    const id = await owned();
    const before = w.storedText();
    w.fake.fail('POST', CANCEL, { status: 404 });
    w.fake.fail('GET', SUB_READ, { status: 404 });
    const reply = await w.op(op, HOLDER);
    const text = `PayPal has no subscription ${id} for this bot's PayPal keys (PAYPAL_ENV sandbox); nothing was cancelled there. If it was made with other PayPal keys, it may still bill there.`;
    if (op === 'cancelPaidSubscription') {
      expect([reply.ok, errorOf(reply).includes(text), w.storedText() === before]).toEqual([false, true, true]);
    } else {
      expect([reply.ok, heldOf(id), w.logged(`[PayPalProvider] ${text}`)]).toEqual([true, null, [`[PayPalProvider] ${text}`]]);
    }
  });

  it.each([['503', { status: 503 }], ['no answer', { drop: 'before' as const }]])('%s: PC2, premium unchanged', async (_answer, fault) => {
    const id = await owned();
    const before = w.storedText();
    w.fake.fail('POST', CANCEL, fault as any);
    const reply = await w.op(op, HOLDER);
    expect(reply.ok).toBe(false);
    expect(errorOf(reply)).toMatch(new RegExp(`Can't confirm whether PayPal cancelled subscription ${id} \\(PayPal (answered 503: .+|did not answer: fetch failed)\\)\\. Reload in a minute; the page shows the change once PayPal reports it\\.`));
    expect(w.storedText()).toBe(before);
  });

  it('a key not set and a refused sign-in: PC3, no cancel call, premium unchanged', async () => {
    const id = await owned();
    const before = w.storedText();
    freshProvider();
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_CLIENT_SECRET;
    const missing = await w.op(op, HOLDER);
    process.env.PAYPAL_CLIENT_SECRET = secret;
    freshProvider();
    w.fake.fail('POST', /^\/v1\/oauth2\/token/, { status: 401 });
    const refused = await w.op(op, HOLDER);
    expect([missing.ok, refused.ok]).toEqual([false, false]);
    expect(errorOf(missing)).toContain(`The bot did not ask PayPal to cancel subscription ${id} (PAYPAL_CLIENT_SECRET is not set). Nothing changed.`);
    expect(errorOf(refused)).toContain(`The bot did not ask PayPal to cancel subscription ${id} (the bot could not sign in to PayPal: PayPal answered 401). Nothing changed.`);
    expect(cancels(id)).toBe(0);
    expect(w.storedText()).toBe(before);
  });

  it('a 2xx: done', async () => {
    const id = await owned();
    const reply = await w.op(op, HOLDER);
    expect(reply.ok).toBe(true);
    expect(cancels(id)).toBe(1);
    if (op === 'cancelPaidSubscriptionImmediately') expect(heldOf(id)).toBeNull();
  });
});

const PANEL_PROVIDERS = [StripeProvider, DummyProvider, DiscordProvider, PatreonProvider, ServerBoostingProvider];
const listed = (): any[] => [...PANEL_PROVIDERS.map(P => new (P as any)()), getPaymentRegistry().get('paypal')!]
  .map(p => ({ id: p.id, displayName: p.displayName, capabilities: p.capabilities }));

type Button = { label: string; title: string; onClick: () => unknown };
function buttonsOf(tree: unknown, out: Button[] = []): Button[] {
  if (Array.isArray(tree)) { tree.forEach(t => buttonsOf(t, out)); return out; }
  if (!tree || typeof tree !== 'object') return out;
  const node = tree as Node;
  if (node.type === 'button') out.push({ label: panelText(node).trim(), title: String(node.props?.title ?? ''), onClick: node.props?.onClick as () => unknown });
  (node.children || []).forEach(c => buttonsOf(c, out));
  return out;
}

async function showPanel(paid: any, providers: any[] = listed()) {
  const confirms: string[] = [];
  const panel = loadGuildPanel({
    listOrphans: async () => ({ success: true, orphans: [] }),
    listPendingMigrations: async () => ({ success: true, migrations: [] }),
    listGuildChannels: async () => ({ success: true, channels: [] }),
    cancelPaidSubscription: async () => ({ success: true }),
  }, text => { confirms.push(text); return false; });
  const props = { guild: { id: IDS[0] }, subData: { subscriptions: { active: paid, paused: [] }, tiers: w.tiers('guild'), providers }, onRefresh: async () => {} };
  panel.render(props);
  await panelFlush();
  const tree = panel.render(props);
  const buttons = buttonsOf(tree);
  const labels = buttons.map(b => b.label);
  return {
    text: panelText(tree),
    labels,
    has: (label: string) => labels.some(l => l.startsWith(label)),
    button: (label: string) => buttons.find(b => b.label === label)!,
    confirms,
  };
}

const ENDS = '2027-03-03T12:00:00.000Z';
const paidCard = (providerId: string, autoRenew: boolean) => ({
  source: 'paid', status: 'active', tierId: 'gold', providerId, providerSubId: 'sub-1', autoRenew, endDate: ENDS,
});
const dateOf = (iso: string): string => new Date(iso).toLocaleDateString();
const ENDS_TEXT = 'Cancel your paid subscription? PayPal stops billing it now. You keep access until the current period ends; it cannot be restarted, so to continue after that you buy again.';
const TODAY_TEXT = 'Cancel your paid subscription? You keep access until the current period ends and can reactivate any time before then.';
const TODAY_TITLE = 'Stop auto-renewing. You keep access until the current period ends.';

describe('P5 claim 11: the panel', () => {
  it.each([
    ['stripe', true, true], ['dummy', true, false], ['paypal', false, false],
    ['discord', false, false], ['patreon', false, false], ['boost', false, false],
  ])('%s: Reactivate %s, "Manage at provider" %s; Cancel and "Cancel & remove now" shown', async (providerId, reactivate, portal) => {
    const off = await showPanel(paidCard(providerId, false));
    const on = await showPanel(paidCard(providerId, true));
    expect([off.has('Reactivate'), off.has('Manage at provider'), off.labels.includes('Cancel & remove now')]).toEqual([reactivate, portal, true]);
    expect([on.labels.includes('Cancel'), on.has('Manage at provider'), on.labels.includes('Cancel & remove now')]).toEqual([true, portal, true]);
  });

  it("a provider not in providers keeps today's buttons", async () => {
    const off = await showPanel(paidCard('gone', false));
    const on = await showPanel(paidCard('gone', true));
    expect([off.has('Reactivate'), off.has('Manage at provider'), off.labels.includes('Cancel & remove now')]).toEqual([true, true, true]);
    expect([on.labels.includes('Cancel'), on.has('Manage at provider')]).toEqual([true, true]);
  });

  it.each([['paypal', ENDS_TEXT, ENDS_TEXT], ['stripe', TODAY_TEXT, TODAY_TITLE], ['discord', TODAY_TEXT, TODAY_TITLE]])('%s: the cancel confirm text and the Cancel title', async (providerId, text, title) => {
    const shown = await showPanel(paidCard(providerId, true));
    const cancel = shown.button('Cancel');
    await cancel.onClick();
    expect([shown.confirms, cancel.title]).toEqual([[text], title]);
  });

  it('a failed renewal shows the failing tag beside Cancel; after a retry that succeeds, (auto-renewing)', async () => {
    const id = await owned();
    w.fake.failPayment(id, { count: 0 });
    await w.drain();
    let sub = heldOf(id)!.sub;
    expect(sub.providerMeta.paymentFailing).toBe(true);
    let shown = await showPanel(sub);
    expect(shown.text).toContain(`(PayPal has not collected the latest payment; access ends ${dateOf(sub.endDate)} unless it does)`);
    expect([shown.text.includes('(auto-renewing)'), shown.labels.includes('Cancel')]).toEqual([false, true]);
    w.fake.retrySucceeds(id);
    await w.drain();
    sub = heldOf(id)!.sub;
    shown = await showPanel(sub);
    expect([shown.text.includes('(auto-renewing)'), shown.text.includes('has not collected')]).toEqual([true, false]);
  });

  it.each([[0], [1]])('a held-active SUSPENDED with %s failed payments shows the suspended tag, no failing tag', async failures => {
    const id = await owned();
    if (failures) w.fake.failPayment(id, { count: 1 });
    w.fake.suspendForFailures(id);
    await w.drain();
    const held = heldOf(id)!;
    expect([held.location, held.sub.providerMeta.paypalStatus, held.sub.autoRenew]).toEqual(['active', 'SUSPENDED', true]);
    const shown = await showPanel(held.sub);
    expect(shown.text).toContain(`(suspended at PayPal; access ends ${dateOf(held.sub.endDate)})`);
    expect([shown.text.includes('has not collected'), shown.text.includes('(auto-renewing)')]).toEqual([false, false]);
  });

  it('a resumed entry whose activate the fake refused shows the suspended tag', async () => {
    const low = await owned();
    const high = await w.buyMember(HOLDER, IDS[0], { tierId: 'platinum' });
    w.fake.approve(high.subscriptionId!);
    await w.drain();
    w.fake.fail('POST', /\/activate$/, { status: 422, issue: 'SUBSCRIPTION_STATUS_INVALID' });
    w.later(5 * 86_400_000);
    w.fake.expire(high.subscriptionId!);
    await w.drain();
    const resumed = heldOf(low)!;
    expect([resumed.location, resumed.sub.providerMeta.paypalStatus]).toEqual(['active', 'SUSPENDED']);
    const shown = await showPanel(resumed.sub);
    expect(shown.text).toContain(`(suspended at PayPal; access ends ${dateOf(resumed.sub.endDate)})`);
  });

  it('(auto-renewing) for a held one, and for a balance above 0 with count 0', async () => {
    const id = await owned();
    expect((await showPanel(heldOf(id)!.sub)).text).toContain('(auto-renewing)');
    w.fake.failPayment(id, { count: 0, moveNext: true });
    w.fake.renew(id, { at: Date.parse(w.fake.subscriptions.get(id)!.billing_info.last_failed_payment.time) + 86_400_000 });
    await w.drain();
    expect(Number(w.fake.subscriptions.get(id)!.billing_info.outstanding_balance.value)).toBeGreaterThan(0);
    const shown = await showPanel(heldOf(id)!.sub);
    expect([shown.text.includes('(auto-renewing)'), shown.text.includes('has not collected')]).toEqual([true, false]);
  });
});

describe('P5P Q13: cancelling a pay-once subscription', () => {
  const o = onceKit(w);
  /** A pay-once subscription premium holds while PayPal keeps it ACTIVE: its first cancel answered 503. */
  async function heldActive(): Promise<string> {
    const id = await o.buy('guild');
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`), { status: 503 });
    expect((await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id))).status).toBe(400);
    w.fake.queue.length = 0;
    return id;
  }

  it.each([['EXPIRED', 'expire-at-payment'], ['CANCELLED by the second rule', 'stays-active']] as const)('"Cancel & remove now" on one %s: one cancel call answered 422, one read, the entry removed, no error', async (_label, final) => {
    const id = await o.owned('guild', { settings: { finalCycle: final } });
    const [calls, reads] = [o.cancels(id), o.reads(id)];
    const reply = await w.op('cancelPaidSubscriptionImmediately', HOLDER);
    expect([reply.ok, reply.error]).toEqual([true, undefined]);
    expect([o.cancels(id) - calls, o.reads(id) - reads, heldOf(id)]).toEqual([1, 1, null]);
  });

  it('"Cancel & remove now" on one ACTIVE: one cancel, the entry removed', async () => {
    const id = await heldActive();
    const calls = o.cancels(id);
    const reply = await w.op('cancelPaidSubscriptionImmediately', HOLDER);
    expect(reply.ok).toBe(true);
    expect([o.cancels(id) - calls, heldOf(id), w.fake.subscriptions.get(id)!.status]).toEqual([1, null, 'CANCELLED']);
  });

  it("premium's soft cancel (the op) on it: one cancel call, the entry unchanged (active, its end, auto-renew off)", async () => {
    const id = await heldActive();
    const before = heldOf(id)!.sub;
    const calls = o.cancels(id);
    const reply = await w.op('cancelPaidSubscription', HOLDER);
    expect(reply.ok).toBe(true);
    expect(o.cancels(id) - calls).toBe(1);
    expect(heldOf(id)!.sub).toMatchObject({ status: 'active', endDate: before.endDate, autoRenew: false, providerMeta: before.providerMeta });
  });

  it('the provider answers nothing to premium for a soft cancel of a pay-once subscription', async () => {
    const id = await heldActive();
    const answer = await getPaymentRegistry().get('paypal')!.cancelSubscription!(id, false);
    expect(answer).toBeUndefined();
    expect(w.fake.subscriptions.get(id)!.status).toBe('CANCELLED');
  });
});

describe('P5P Q16: the panel for a pay-once subscription', () => {
  const o = onceKit(w);

  it('a pay-once card: the paid-in-full tag, no Cancel, no Reactivate, "Cancel & remove now" shown', async () => {
    const id = await o.owned('guild', { settings: { finalCycle: 'stays-active' } });
    const sub = heldOf(id)!.sub;
    expect([sub.autoRenew, sub.providerMeta.payOnce]).toEqual([false, true]);
    const shown = await showPanel(sub);
    expect(shown.text).toContain('(paid in full, will not renew)');
    expect(shown.text.includes('(cancelled, will not renew)')).toBe(false);
    expect([shown.labels.includes('Cancel'), shown.has('Reactivate'), shown.labels.includes('Cancel & remove now')]).toEqual([false, false, true]);
  });

  it('a cancelled renewing PayPal card keeps (cancelled, will not renew)', async () => {
    const id = await owned();
    expect((await w.op('cancelPaidSubscription', HOLDER)).ok).toBe(true);
    const sub = heldOf(id)!.sub;
    expect(sub.autoRenew).toBe(false);
    const shown = await showPanel(sub);
    expect([shown.text.includes('(cancelled, will not renew)'), shown.text.includes('paid in full')]).toEqual([true, false]);
  });

  it("Stripe's card is unchanged", async () => {
    const shown = await showPanel(paidCard('stripe', false));
    expect([shown.text.includes('(cancelled, will not renew)'), shown.text.includes('paid in full'), shown.has('Reactivate'), shown.labels.includes('Cancel & remove now')]).toEqual([true, false, true, true]);
  });
});

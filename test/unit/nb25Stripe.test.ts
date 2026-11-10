import { afterEach, describe, expect, it, vi } from 'vitest';

import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';

// NB25 (wip-redesign/sheets/NB25.md decisions 1 and 5, section 8 item 3): Stripe records the days left of a bot pause
// in metadata[pausedDaysLeft], clears them at a resume, reads them back on a listed subscription, marks a subscription
// Stripe paused itself as not resumable, and refuses a resume answer Stripe still holds paused (T4).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const sub = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_start: 1762000000, current_period_end: 1764000000,
  start_date: 1762000000, pause_collection: null, metadata: { guildId: 'g1', tierId: 't', offeringId: 'o' }, ...over,
});

function stub(answer: (url: string) => unknown) {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_nb25');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(answer(url)), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const formOf = (fetch: ReturnType<typeof stub>, n = 0): URLSearchParams => {
  const [, init] = fetch.mock.calls[n] as unknown as [string, RequestInit];
  return new URLSearchParams(String(init.body));
};

describe('the pause and resume POSTs', () => {
  it('the resume POST clears pause_collection, sets trial_end and sends metadata[pausedDaysLeft] empty', async () => {
    const fetch = stub(() => sub());
    const end = new Date(Date.now() + 12 * 86_400_000).toISOString();
    await new StripeProvider().resumeSubscription('sub_1', end);
    const form = formOf(fetch);
    expect(form.get('pause_collection')).toBe('');
    expect(form.get('trial_end')).toBe(String(Math.floor(Date.parse(end) / 1000)));
    expect(form.has('metadata[pausedDaysLeft]')).toBe(true);
    expect(form.get('metadata[pausedDaysLeft]')).toBe('');
  });

  it('the pause POST with days 20 records them with the pause time; with null it removes the key; with no days it sends no key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T00:00:00.000Z'));
    const fetch = stub(() => sub({ pause_collection: { behavior: 'void' } }));
    const stripe = new StripeProvider();
    await stripe.pauseSubscription('sub_1', null, 20);
    expect(formOf(fetch, 0).get('metadata[pausedDaysLeft]')).toBe(`20@${Math.floor(Date.parse('2026-11-10T00:00:00.000Z') / 1000)}`);
    await stripe.pauseSubscription('sub_1', null, null);
    expect(formOf(fetch, 1).has('metadata[pausedDaysLeft]')).toBe(true);
    expect(formOf(fetch, 1).get('metadata[pausedDaysLeft]')).toBe('');
    await stripe.pauseSubscription('sub_1', null);
    expect(formOf(fetch, 2).has('metadata[pausedDaysLeft]')).toBe(false);
  });
});

describe('a listed subscription', () => {
  const listed = async (s: Record<string, unknown>) => {
    stub(url => (url.includes('/search') ? { data: [s], has_more: false } : { data: [] }));
    const refs = await new StripeProvider().listSubscriptionsForGuild('g1');
    expect(refs).toHaveLength(1);
    return refs[0];
  };

  it("'20@1762732800' gives pausedDaysLeft 20 and pausedAt that time", async () => {
    const ref = await listed(sub({ pause_collection: { behavior: 'void' }, metadata: { guildId: 'g1', tierId: 't', offeringId: 'o', pausedDaysLeft: '20@1762732800' } }));
    expect(ref.metadata.pausedDaysLeft).toBe(20);
    expect(ref.metadata.pausedAt).toBe(new Date(1762732800 * 1000).toISOString());
  });

  it.each(['20', 'x@1', '-1@1', 'x', ''])("'%s' gives neither field", async value => {
    const ref = await listed(sub({ metadata: { guildId: 'g1', tierId: 't', offeringId: 'o', pausedDaysLeft: value } }));
    expect(ref.metadata.pausedDaysLeft).toBeUndefined();
    expect(ref.metadata.pausedAt).toBeUndefined();
  });

  it("Stripe's own status 'paused' is not resumable, with or without pause_collection", async () => {
    expect((await listed(sub({ status: 'paused' }))).state.resumable).toBe(false);
    expect((await listed(sub({ status: 'paused', pause_collection: { behavior: 'void' } }))).state.resumable).toBe(false);
  });

  it("status 'active' with pause_collection set has no resumable field", async () => {
    const ref = await listed(sub({ pause_collection: { behavior: 'void' } }));
    expect(ref.state.status).toBe('paused');
    expect('resumable' in ref.state).toBe(false);
  });
});

describe('the resume answer', () => {
  it("pause_collection null with status 'paused' throws T4", async () => {
    stub(() => sub({ status: 'paused' }));
    await expect(new StripeProvider().resumeSubscription('sub_1', null)).rejects.toThrow(
      "Stripe subscription 'sub_1' is still paused by Stripe itself; resume or cancel it in the Stripe dashboard.",
    );
  });

  it("status 'active' resolves", async () => {
    stub(() => sub());
    await expect(new StripeProvider().resumeSubscription('sub_1', null)).resolves.toBeUndefined();
  });
});

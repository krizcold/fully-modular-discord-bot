import path from 'path';
import { describe, it, expect } from 'vitest';
import { mount, settle } from '../helpers/jsxRig';

// P2 claim 14: the "Test purchase" block of the Dummy Provider Settings.

const FILE = path.join(__dirname, '../../src/webui/public/components/AppStorePanel.jsx');
const USER = '323456789012345678';
const SERVER = '423456789012345678';
const BUYER = '523456789012345678';

const dummyOffering = (id: string, enabled = true) => ({
  id, label: id,
  providerLinks: [{
    providerId: 'dummy', enabled, mode: 'price',
    priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] },
    cache: { syncedAt: '2026-01-01T00:00:00.000Z', variants: [{ variantId: 'dummy_monthly_999', label: 'Monthly' }, { variantId: 'dummy_yearly_9999', label: 'Yearly' }] },
  }],
});
const otherOffering = (id: string) => ({ id, label: id, providerLinks: [{ providerId: 'stripe', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'price_1' }] } }] });

const TIERS = {
  free: { displayName: 'Free', priority: 0, overrides: {}, offerings: [] },
  gold: { displayName: 'Gold', priority: 2, overrides: {}, offerings: [dummyOffering('o-gold')] },
  off: { displayName: 'Off', priority: 1, overrides: {}, offerings: [dummyOffering('o-off', false)] },
  striped: { displayName: 'Striped', priority: 3, overrides: {}, offerings: [otherOffering('o-striped')] },
};
const USER_TIERS = {
  vgold: { displayName: 'VGold', priority: 2, overrides: {}, offerings: [otherOffering('o-x'), dummyOffering('o-vgold')], kind: 'user' },
  voff: { displayName: 'VOff', priority: 1, overrides: {}, offerings: [dummyOffering('o-voff', false)], kind: 'user' },
  vsilver: { displayName: 'VSilver', priority: 1, overrides: {}, offerings: [dummyOffering('o-vsilver')], kind: 'user' },
};

interface Call { method: string; url: string; body?: any }

function autoApi(answers: (call: Call) => any) {
  const calls: Call[] = [];
  const make = (method: string) => async (url: string, body?: any) => {
    const call = { method, url, body };
    calls.push(call);
    return answers(call);
  };
  return { calls, api: { get: make('GET'), post: make('POST'), put: make('PUT'), delete: make('DELETE') } };
}

const tiersAnswer = (userTiers: object = USER_TIERS) => ({ success: true, tiers: TIERS, userTiers });

async function open(answers: (call: Call) => any, activated = true, confirmed = true) {
  const { calls, api } = autoApi(answers);
  const successes: string[] = [];
  const prompts: string[] = [];
  const confirm = (prompt: string) => { prompts.push(prompt); return confirmed; };
  const m = mount(FILE, 'DummyTestPurchase', { activated, showSuccess: (t: string) => successes.push(t), setError: () => {} }, { api, confirm });
  await settle();
  const field = (name: string) => m.all(el => el.props.name === name)[0];
  const set = async (name: string, value: string) => { field(name).props.onChange({ target: { value } }); await settle(); };
  const button = (label: RegExp, nth = 0) => m.all(el => el.type === 'button' && label.test(m.text(el)))[nth];
  const click = async (label: RegExp, nth = 0) => { button(label, nth).props.onClick(); await settle(); };
  const options = (name: string) => (field(name)?.children || []).filter((c: any) => typeof c === 'object').map((c: any) => c.props.value).filter((v: string) => v !== '');
  const text = () => (m.tree ? m.text(m.tree) : '');
  return { m, calls, successes, prompts, field, set, button, click, options, text };
}

const base = (extra: (call: Call) => any = () => undefined) => (call: Call) => {
  const own = extra(call);
  if (own !== undefined) return own;
  if (call.url === '/appstore/premium/tiers') return tiersAnswer();
  return { success: true };
};

describe('P2 claim 14: the Test purchase block', () => {
  it('is absent while the Dummy is not activated', async () => {
    const b = await open(base(), false);
    expect(b.m.tree).toBeNull();
    expect(b.calls).toEqual([]);
  });

  it('lists only tiers of the chosen kind with an enabled Dummy link', async () => {
    const b = await open(base());
    expect(b.options('tier')).toEqual(['gold']);
    await b.set('kind', 'user');
    expect(b.options('tier')).toEqual(['vgold', 'vsilver']);
    await b.set('tier', 'vgold');
    expect(b.options('variant')).toEqual(['dummy_monthly_999', 'dummy_yearly_9999']);
  });

  it('says no personal tier exists when userTiers has none', async () => {
    const b = await open(base(call => (call.url === '/appstore/premium/tiers' ? tiersAnswer({}) : undefined)));
    await b.set('kind', 'user');
    expect(b.options('tier')).toEqual([]);
    expect(b.text()).toContain('No personal tier is sold through the Dummy provider yet');
  });

  it('"Buy for" User sends the user route with providerId dummy and no buyerId', async () => {
    const b = await open(base());
    await b.set('kind', 'user');
    await b.set('holderId', USER);
    await b.set('tier', 'vgold');
    await b.set('variant', 'dummy_yearly_9999');
    await b.set('coupon', 'SAVE');
    await b.click(/^Buy$/);
    const buy = b.calls.filter(c => c.method === 'POST');
    expect(buy).toEqual([{ method: 'POST', url: `/appstore/premium/users/${USER}/paid`, body: { tierId: 'vgold', offeringId: 'o-vgold', providerId: 'dummy', variantId: 'dummy_yearly_9999', couponCode: 'SAVE' } }]);
    expect('buyerId' in buy[0].body).toBe(false);
    expect(b.successes.length).toBe(1);
  });

  it('Server sends the server route with buyerId', async () => {
    const b = await open(base());
    await b.set('holderId', SERVER);
    await b.set('buyerId', BUYER);
    await b.set('tier', 'gold');
    await b.click(/^Buy$/);
    const buy = b.calls.filter(c => c.method === 'POST');
    expect(buy).toEqual([{ method: 'POST', url: `/appstore/premium/subscriptions/${SERVER}/paid`, body: { tierId: 'gold', offeringId: 'o-gold', providerId: 'dummy', variantId: 'dummy_monthly_999', buyerId: BUYER } }]);
  });

  it('an answer that is not ok shows its error and no success text', async () => {
    const b = await open(base(call => (call.method === 'POST' ? { success: false, error: 'Can\'t confirm the purchase.' } : undefined)));
    await b.set('kind', 'user');
    await b.set('holderId', USER);
    await b.set('tier', 'vgold');
    await b.click(/^Buy$/);
    expect(b.text()).toContain('Can\'t confirm the purchase.');
    expect(b.successes).toEqual([]);
  });

  const lookedUp = async (extra: (call: Call) => any = () => undefined, confirmed = true) => {
    const b = await open(base(call => {
      const own = extra(call);
      if (own !== undefined) return own;
      if (call.method === 'GET' && call.url === `/appstore/premium/users/${USER}`) {
        return {
          success: true, effective: null,
          subscriptions: {
            active: { id: 'act-1', tierId: 'vgold', source: 'paid', providerId: 'dummy', status: 'active', autoRenew: true, startDate: '2026-11-01T00:00:00.000Z', endDate: null },
            paused: [
              { id: 'q-1', tierId: 'vsilver', source: 'paid', providerId: 'dummy', status: 'paused', autoRenew: true, startDate: '2026-11-01T00:00:00.000Z', endDate: null },
              { id: 'q-2', tierId: 'voff', source: 'manual', status: 'paused', autoRenew: false, startDate: '2026-11-01T00:00:00.000Z', endDate: null },
            ],
          },
        };
      }
      if (call.method === 'GET' && call.url === `/appstore/premium/users/${USER}/orphans`) {
        return {
          success: true,
          orphans: [
            { providerId: 'stripe', ref: { providerSubId: 'sub_stripe_1' }, plan: { kind: 'install', line: 'Stripe line.' } },
            { providerId: 'dummy', ref: { providerSubId: 'dsub_9' }, plan: { kind: 'resume', days: 12, from: 'period', autoRenew: true, call: true, line: 'Resumes with 12 days left.' } },
          ],
        };
      }
      return undefined;
    }), true, confirmed);
    await b.set('kind', 'user');
    await b.set('holderId', USER);
    await b.click(/^Look up$/);
    return b;
  };

  it('the lookup names the active and queued tiers by their display name, and a tier the block does not list by its id', async () => {
    const b = await lookedUp();
    expect(b.m.all(el => el.type === 'span' && /^(Active|Queued): /.test(b.m.text(el))).map(el => b.m.text(el))).toEqual(['Active: VGold (paid, active)', 'Queued: VSilver (paid)', 'Queued: voff (manual)']);
  });

  it('"Adopt" sends the plan the list showed', async () => {
    const b = await lookedUp();
    expect(b.text()).toContain('Found at the Dummy provider, not in the bot');
    expect(b.text()).toContain('Resumes with 12 days left.');
    await b.click(/^Adopt$/);
    const adopt = b.calls.filter(c => c.method === 'POST');
    expect(adopt).toEqual([{ method: 'POST', url: `/appstore/premium/users/${USER}/orphans/dummy/dsub_9/adopt`, body: { plan: { kind: 'resume', days: 12, from: 'period', autoRenew: true, call: true, line: 'Resumes with 12 days left.' } } }]);
  });

  it('"Cancel at the provider" sends the orphan cancel route', async () => {
    const b = await lookedUp();
    await b.click(/^Cancel at the provider$/);
    expect(b.calls.filter(c => c.method === 'DELETE')).toEqual([{ method: 'DELETE', url: `/appstore/premium/users/${USER}/orphans/dummy/dsub_9`, body: undefined }]);
  });

  it("a queued entry's \"Cancel & remove\" asks a confirm that its days are lost, then sends the queued-cancel route", async () => {
    const b = await lookedUp();
    expect(b.m.all(el => el.type === 'button' && /^Cancel/.test(b.m.text(el))).map(el => b.m.text(el))).toEqual(['Cancel', 'Cancel & remove', 'Cancel & remove', 'Cancel at the provider']);
    await b.click(/^Cancel & remove$/);
    expect(b.prompts).toEqual(["End the queued 'VSilver' subscription now? It is cancelled at the provider, and its days are lost."]);
    expect(b.calls.filter(c => c.method === 'DELETE')).toEqual([{ method: 'DELETE', url: `/appstore/premium/users/${USER}/paused/q-1`, body: undefined }]);
  });

  it("a queued manual grant's \"Cancel & remove\" asks a confirm that names the tier by its id when the block does not list it, then sends the queued-cancel route", async () => {
    const b = await lookedUp();
    await b.click(/^Cancel & remove$/, 1);
    expect(b.prompts).toEqual(["Remove the queued 'voff' grant now? Its days are lost."]);
    expect(b.calls.filter(c => c.method === 'DELETE')).toEqual([{ method: 'DELETE', url: `/appstore/premium/users/${USER}/paused/q-2`, body: undefined }]);
  });

  it('"End now", "Cancel & remove" and "Cancel at the provider" send nothing when the confirm is declined', async () => {
    const b = await lookedUp(undefined, false);
    await b.click(/^End now$/);
    await b.click(/^Cancel & remove$/);
    await b.click(/^Cancel at the provider$/);
    expect(b.prompts).toHaveLength(3);
    expect(b.calls.filter(c => c.method !== 'GET')).toEqual([]);
    expect(b.successes).toEqual([]);
  });

  it('lists only the Dummy provider\'s records under its heading', async () => {
    const b = await lookedUp();
    expect(b.text()).toContain('dsub_9');
    expect(b.text()).not.toContain('sub_stripe_1');
    expect(b.m.all(el => el.type === 'button' && /^Adopt$/.test(b.m.text(el)))).toHaveLength(1);
  });

  it.each([
    ['Buy', 'POST', async (b: Awaited<ReturnType<typeof open>>) => { await b.set('kind', 'user'); await b.set('holderId', USER); await b.set('tier', 'vgold'); await b.click(/^Buy$/); }],
    ['End now', 'POST', async (b: Awaited<ReturnType<typeof open>>) => { await b.click(/^End now$/); }],
    ['Cancel', 'DELETE', async (b: Awaited<ReturnType<typeof open>>) => { await b.click(/^Cancel$/); }],
  ])('%s: a request that fails shows its error text and no success text', async (_label, method, act) => {
    const fail = (call: Call) => { if (call.method === method) throw new Error('Request failed: 503 premium-tiers.json was not saved'); return undefined; };
    const b = _label === 'Buy' ? await open(base(fail)) : await lookedUp(fail);
    await act(b);
    expect(b.calls.filter(c => c.method === method)).toHaveLength(1);
    expect(b.text()).toContain('Request failed: 503 premium-tiers.json was not saved');
    expect(b.successes).toEqual([]);
  });

  it.each([['Cancel', 'DELETE', /^Cancel$/], ['Renew again', 'POST', /^Renew again$/]] as const)('%s answered 200 with success false says nothing was changed and why', async (_label, method, label) => {
    const b = await lookedUp(call => (call.method === method ? { success: false } : undefined));
    await b.click(label);
    expect(b.text()).toContain('Nothing was changed: this user has no active paid subscription that can be cancelled or renewed again.');
    expect(b.successes).toEqual([]);
  });

  it('"Buy" is disabled until a Discord id is typed, and for a server until "Paid by" is typed too', async () => {
    const b = await open(base());
    await b.set('tier', 'gold');
    expect(b.button(/^Buy$/).props.disabled).toBe(true);
    await b.set('holderId', SERVER);
    expect(b.button(/^Buy$/).props.disabled).toBe(true);
    await b.set('buyerId', BUYER);
    expect(b.button(/^Buy$/).props.disabled).toBe(false);
    await b.set('kind', 'user');
    await b.set('holderId', '  ');
    expect(b.button(/^Buy$/).props.disabled).toBe(true);
    await b.set('holderId', USER);
    expect(b.button(/^Buy$/).props.disabled).toBe(false);
  });

  it("the active paid one's Cancel, Renew again and End now send their routes", async () => {
    const b = await lookedUp();
    await b.click(/^Cancel$/, 0);
    await b.click(/^Renew again$/);
    await b.click(/^End now$/);
    expect(b.calls.filter(c => c.method !== 'GET')).toEqual([
      { method: 'DELETE', url: `/appstore/premium/users/${USER}/paid`, body: undefined },
      { method: 'POST', url: `/appstore/premium/users/${USER}/paid/reactivate`, body: undefined },
      { method: 'POST', url: `/appstore/premium/users/${USER}/paid/expire-now`, body: undefined },
    ]);
  });
});

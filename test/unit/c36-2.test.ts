import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const babel = require('@babel/core');

const SRC = path.join(__dirname, '../../src/webui/public/assets/components/guild/GuildSubscriptionPanel.jsx');

type Node = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
type Api = Record<string, ReturnType<typeof vi.fn>>;

function load(api: Api, runEffects: boolean) {
  const code = babel.transformSync(fs.readFileSync(SRC, 'utf8'), {
    presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic' }]],
    babelrc: false,
    configFile: false,
  }).code;
  const state: unknown[] = [];
  const deps: Record<number, unknown[] | undefined> = {};
  const pending: Array<() => void> = [];
  let slot = 0;
  const React = {
    Fragment: 'Fragment',
    useRef(init: unknown) {
      const i = slot++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useState(init: unknown) {
      const i = slot++;
      if (!(i in state)) state[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [state[i], (v: unknown) => { state[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(state[i]) : v; }];
    },
    useEffect(fn: () => unknown, d?: unknown[]) {
      const i = slot++;
      const prev = deps[i];
      const changed = !prev || !d || d.length !== prev.length || d.some((x, k) => x !== prev[k]);
      if (i in deps && !changed) return;
      deps[i] = d;
      if (runEffects) pending.push(() => { fn(); });
    },
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props, children }),
  };
  const ctx: Record<string, unknown> = {
    React, guildApi: api, confirm: () => true, alert: () => {}, disabledButtonStyle: () => ({}),
    RefetchOverlay: 'RefetchOverlay', FirstLoadPlaceholder: 'FirstLoadPlaceholder',
    window: { location: { search: '', pathname: '/', hash: '', origin: 'http://x', href: '' }, history: { replaceState() {} } },
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const render = (name: string, props: unknown): Node => {
    slot = 0;
    const tree = (ctx[name] as (p: unknown) => Node)(props);
    while (pending.length) pending.shift()!();
    return tree;
  };
  return { render };
}

function all(tree: unknown, out: Node[] = []): Node[] {
  if (!tree || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { for (const t of tree) all(t, out); return out; }
  const n = tree as Node;
  out.push(n);
  for (const c of n.children || []) all(c, out);
  return out;
}

function text(tree: unknown): string {
  if (tree === null || tree === undefined || tree === false || tree === true) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return ((tree as Node).children || []).map(text).join('');
}

const flush = () => new Promise(r => setTimeout(r, 0));

const variant = (id: string) => ({ variantId: id, active: true, amount: 1, currency: 'usd', durationDays: 30, recurring: true, label: id });
const providers = [
  { id: 'p1', displayName: 'P1', capabilities: { supportsCoupons: true } },
  { id: 'p2', displayName: 'P2', capabilities: { supportsCoupons: false } },
];
const tier = {
  displayName: 'Gold',
  offerings: [{
    id: 'o1', label: 'Plan',
    providerLinks: [
      { providerId: 'p1', enabled: true, mode: 'price', cache: { variants: [variant('a'), variant('b')] } },
      { providerId: 'p2', enabled: true, mode: 'price', cache: { variants: [variant('c')] } },
    ],
  }],
};

function modal(api: Api) {
  const h = load(api, true);
  const props = { guildId: 'g', tierId: 't', tier, providers, willBePaused: false, activeTierName: '', onClose() {}, onSuccess() {} };
  const r = () => h.render('SubscribeModal', props);
  const click = (key: string) => { (all(r()).find(n => n.props?.key === key)!.props!.onClick as () => void)(); };
  const input = () => all(r()).find(n => n.type === 'input' && n.props?.onBlur)!;
  const type = (v: string) => { (input().props!.onChange as (e: unknown) => void)({ target: { value: v } }); };
  const blur = async () => { await (input().props!.onBlur as () => Promise<void>)(); await flush(); };
  const submit = async () => {
    const b = all(r()).find(n => n.type === 'button' && typeof n.props?.onClick === 'function' && (n.props.onClick as { name: string }).name === 'handleSubmit');
    await (b!.props!.onClick as () => Promise<void>)();
  };
  return { r, click, type, blur, submit, input };
}

describe('C36-2 subscribe modal coupon preview', () => {
  it('a failed coupon check is not shown as a refused coupon', async () => {
    const api = { previewCoupon: vi.fn(async () => ({ success: false, error: 'provider down' })) };
    const m = modal(api);
    m.click('o1'); m.click('a'); m.type('SAVE'); await m.blur();
    const t = text(m.r());
    expect(t).toContain('Could not check the coupon: provider down');
    expect(t).not.toContain('Coupon not accepted');
  });

  it('a thrown coupon check is not shown as a refused coupon', async () => {
    const api = { previewCoupon: vi.fn(async () => { throw new Error('network'); }) };
    const m = modal(api);
    m.click('o1'); m.click('a'); m.type('SAVE'); await m.blur();
    expect(text(m.r())).toContain('Could not check the coupon: network');
  });

  it('a real refusal still reads as a refusal', async () => {
    const api = { previewCoupon: vi.fn(async () => ({ success: true, valid: false, reason: 'Expired' })) };
    const m = modal(api);
    m.click('o1'); m.click('a'); m.type('SAVE'); await m.blur();
    const t = text(m.r());
    expect(t).toContain('Expired');
    expect(t).not.toContain('Could not check');
  });

  it('a preview checked for one variant is dropped and re-run when the variant changes', async () => {
    const api = { previewCoupon: vi.fn(async (_g: string, _p: string, _c: string, v: string) => (
      v === 'a' ? { success: true, valid: true, effectText: '50% off' } : { success: true, valid: false, reason: 'Not for this variant' }
    )) };
    const m = modal(api);
    m.click('o1'); m.click('a'); m.type('SAVE'); await m.blur();
    expect(text(m.r())).toContain('50% off');
    m.click('b'); m.r(); await flush();
    const t = text(m.r());
    expect(t).not.toContain('50% off');
    expect(t).toContain('Not for this variant');
    expect(api.previewCoupon).toHaveBeenLastCalledWith('g', 'p1', 'SAVE', 'b');
  });

  it('a late answer for an earlier variant is never shown for the current one', async () => {
    let release: (v: unknown) => void = () => {};
    const api = { previewCoupon: vi.fn((_g: string, _p: string, _c: string, v: string) => (
      v === 'a' ? new Promise(r => { release = r; }) : new Promise(() => {})
    )) };
    const m = modal(api);
    m.click('o1'); m.click('a'); m.type('SAVE');
    const first = m.blur();
    m.click('b'); m.r();
    release({ success: true, valid: true, effectText: '50% off' });
    await first; await flush();
    expect(text(m.r())).not.toContain('50% off');
  });

  it('a coupon typed for a coupon provider is not submitted with a provider that hides the field', async () => {
    const api = {
      previewCoupon: vi.fn(async () => ({ success: true, valid: true, effectText: 'x' })),
      subscribePaid: vi.fn(async () => ({ success: false, error: 'stop' })),
    };
    const m = modal(api);
    m.click('o1'); m.click('a'); m.type('SAVE'); await m.blur();
    m.click('c'); m.r(); await flush();
    await m.submit();
    expect(api.subscribePaid).toHaveBeenCalledTimes(1);
    expect((api.subscribePaid.mock.calls[0] as unknown[])[5]).toBeUndefined();
  });
});

describe('C36-2 cancel and reactivate show the provider answer', () => {
  const sub = (autoRenew: boolean) => ({
    subscriptions: { active: { source: 'paid', tierId: 't', providerId: 'p1', autoRenew, status: 'active', endDate: new Date(Date.now() + 86400000 * 5).toISOString() } },
    tiers: { t: { displayName: 'Gold', priority: 1, offerings: [] } },
    providers: [],
  });
  for (const [label, method, handler, autoRenew] of [
    ['cancel', 'cancelPaidSubscription', 'handleCancel', true],
    ['reactivate', 'reactivatePaidSubscription', 'handleReactivate', false],
  ] as const) {
    it(`${label}: the provider error is shown and the subscription is re-read`, async () => {
      const api = { [method]: vi.fn(async () => ({ success: false, error: 'Provider said no' })) };
      const h = load(api, false);
      const onRefresh = vi.fn(async () => {});
      const props = { guild: { id: 'g' }, subData: sub(autoRenew), onRefresh };
      const b = all(h.render('GuildSubscriptionPanel', props)).find(n => (n.props?.onClick as { name?: string } | undefined)?.name === handler);
      await (b!.props!.onClick as () => Promise<void>)();
      expect(text(h.render('GuildSubscriptionPanel', props))).toContain('Provider said no');
      expect(onRefresh).toHaveBeenCalled();
    });
  }
});

describe('C36-2 review rows', () => {
  it('a check left pending by an offering change does not leave Checking shown', async () => {
    let resolve: (v: unknown) => void = () => {};
    const api = { previewCoupon: vi.fn(() => new Promise(r => { resolve = r; })) };
    const m = modal(api);
    m.click('o1'); m.click('a'); m.type('SAVE');
    void (m.input().props!.onBlur as () => Promise<void>)();
    m.click('o1'); m.click('a');
    resolve({ success: true, valid: true });
    await flush();
    expect(text(m.r())).not.toContain('Checking');
  });

  it('a Stripe lookup failure is thrown, not answered as a refusal', async () => {
    vi.resetModules();
    vi.doMock('@/utils/envLoader', () => ({ loadCredentials: () => ({ STRIPE_SECRET_KEY: 'k' }) }));
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { StripeProvider } = await import('@/bot/internalSetup/utils/payment/stripeProvider');
      await expect(new StripeProvider().validateCoupon('SAVE')).rejects.toThrow('network down');
    } finally { vi.unstubAllGlobals(); vi.doUnmock('@/utils/envLoader'); }
  });

  it('an unconfigured Lemon Squeezy coupon check is thrown, not answered as a refusal', async () => {
    vi.resetModules();
    vi.doMock('@/utils/envLoader', () => ({ loadCredentials: () => ({}) }));
    try {
      const { LemonSqueezyProvider } = await import('@/bot/internalSetup/utils/payment/lemonsqueezyProvider');
      await expect(new LemonSqueezyProvider().validateCoupon('SAVE')).rejects.toThrow('not configured');
    } finally { vi.doUnmock('@/utils/envLoader'); }
  });
});

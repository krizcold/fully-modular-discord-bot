import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

// NB25 (wip-redesign/sheets/NB25.md decision 8, section 8 item 4): the subscription page shows each orphan's plan and
// computes none; the automatic adoption takes only an orphan whose plan is 'install' and sends that plan; Adopt sends
// the card's plan; a 'refuse' plan has no Adopt button. The render rig of c36-2.test.ts.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const babel = require('@babel/core');

const SRC = path.join(__dirname, '../../src/webui/public/assets/components/guild/GuildSubscriptionPanel.jsx');

type Node = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

function load(api: Record<string, unknown>, confirm: (text: string) => boolean = () => true) {
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
      pending.push(() => { fn(); });
    },
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props, children }),
  };
  const ctx: Record<string, unknown> = {
    React, guildApi: api, confirm, alert: () => {}, disabledButtonStyle: () => ({}),
    RefetchOverlay: 'RefetchOverlay', FirstLoadPlaceholder: 'FirstLoadPlaceholder',
    window: { location: { search: '', pathname: '/', hash: '', origin: 'http://x', href: '' }, history: { replaceState() {} } },
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const render = (props: unknown): Node => {
    slot = 0;
    const tree = (ctx.GuildSubscriptionPanel as (p: unknown) => Node)(props);
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

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

const T5 = 'Adopting resumes this paused subscription at Stripe; its next charge is in 12 days. The days are the ones the bot recorded when it paused it on 2026-11-01.';
const T5Q = 'Adopting queues this paused subscription behind Gold; it stays paused at Stripe until its turn in the queue, then resumes with 12 days left.';
const RESUME = { kind: 'resume', days: 12, from: 'recorded', at: '2026-11-01T00:00:00.000Z', autoRenew: true, call: true, line: T5 };
const QUEUE = { kind: 'queue', days: 12, from: 'recorded', at: '2026-11-01T00:00:00.000Z', activeTierId: 'gold', activeTier: 'Gold', line: T5Q };
const INSTALL = { kind: 'install', line: 'It is active at Stripe, and adopting adds it as it is.' };

const tiers = { gold: { displayName: 'Gold', priority: 2, offerings: [] }, silver: { displayName: 'Silver', priority: 1, offerings: [] } };
const orphan = (id: string, status: string, plan: unknown, tierId = 'silver') => ({
  providerId: 'stripe',
  ref: { providerSubId: id, metadata: { tierId, offeringId: 'o1' }, state: { status }, display: { amountLabel: '5.00 USD', periodLabel: 'every month', statusLabel: status } },
  ...(plan ? { plan } : {}),
});
const empty = { subscriptions: { paused: [] }, tiers, providers: [] };
const withPaid = { subscriptions: { active: { id: 's1', source: 'paid', tierId: 'gold', providerId: 'stripe', status: 'active', autoRenew: true, endDate: new Date(Date.now() + 86_400_000 * 20).toISOString() }, paused: [] }, tiers, providers: [] };

function apiWith(listings: unknown[][], adoptAnswer: unknown = { success: true }) {
  let n = 0;
  return {
    listOrphans: vi.fn(async () => ({ success: true, orphans: JSON.parse(JSON.stringify(listings[Math.min(n++, listings.length - 1)])) })),
    adoptOrphan: vi.fn(async () => adoptAnswer),
    listPendingMigrations: vi.fn(async () => ({ success: true, migrations: [] })),
    listGuildChannels: vi.fn(async () => ({ success: true, channels: [] })),
  };
}

async function shown(api: ReturnType<typeof apiWith>, subData: unknown = empty, confirm?: (t: string) => boolean) {
  const h = load(api, confirm);
  const props = { guild: { id: 'g' }, subData, onRefresh: vi.fn(async () => {}) };
  h.render(props);
  await flush();
  return { h, props, tree: () => h.render(props) };
}

describe('the automatic adoption', () => {
  it('a paused orphan with no local paid sub is not adopted; its card is listed with its line', async () => {
    const api = apiWith([[orphan('sub_p', 'paused', RESUME)]]);
    const { tree } = await shown(api);
    expect(api.adoptOrphan).not.toHaveBeenCalled();
    expect(text(tree())).toContain('sub_p');
    expect(text(tree())).toContain(T5);
  });

  it("an active orphan is adopted with its plan { kind: 'install' }", async () => {
    const api = apiWith([[orphan('sub_a', 'active', INSTALL)], []]);
    await shown(api);
    expect(api.adoptOrphan).toHaveBeenCalledTimes(1);
    expect(api.adoptOrphan.mock.calls[0]).toEqual(['g', 'stripe', 'sub_a', INSTALL]);
  });

  it("an active orphan's card shows no plan line", async () => {
    const api = apiWith([[orphan('sub_a', 'active', INSTALL)]]);
    const { tree } = await shown(api, withPaid);
    expect(text(tree())).toContain('sub_a');
    expect(text(tree())).not.toContain(INSTALL.line);
  });

  it('after it adopts, the remaining cards show the plans of a new listing', async () => {
    const api = apiWith([[orphan('sub_a', 'active', INSTALL, 'gold'), orphan('sub_p', 'paused', RESUME)], [orphan('sub_p', 'paused', QUEUE)]]);
    const h = load(api);
    let props: any;
    const onRefresh = vi.fn(async () => { props = { ...props, subData: withPaid }; });
    props = { guild: { id: 'g' }, subData: empty, onRefresh };
    h.render(props);
    await flush();
    h.render(props);
    await flush();
    const tree = h.render(props);
    expect(api.adoptOrphan).toHaveBeenCalledTimes(1);
    expect(api.listOrphans).toHaveBeenCalledTimes(2);
    expect(text(tree)).toContain(T5Q);
    expect(text(tree)).not.toContain(T5);
  });
});

describe('the card and Adopt', () => {
  it("Adopt on a 'resume' card sends the card's plan unchanged, after a dialog that shows its line", async () => {
    const asked: string[] = [];
    const api = apiWith([[orphan('sub_p', 'paused', RESUME)]]);
    const { tree } = await shown(api, withPaid, t => { asked.push(t); return true; });
    const button = all(tree()).find(n => n.type === 'button' && text(n) === 'Adopt');
    expect(button).toBeDefined();
    await (button!.props!.onClick as () => Promise<void>)();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(T5);
    expect(api.adoptOrphan.mock.calls.at(-1)).toEqual(['g', 'stripe', 'sub_p', RESUME]);
  });

  it("a 'queue' card shows its line, and the dialog too", async () => {
    const asked: string[] = [];
    const api = apiWith([[orphan('sub_p', 'paused', QUEUE)]]);
    const { tree } = await shown(api, withPaid, t => { asked.push(t); return false; });
    expect(text(tree())).toContain(T5Q);
    const button = all(tree()).find(n => n.type === 'button' && text(n) === 'Adopt');
    await (button!.props!.onClick as () => Promise<void>)();
    expect(asked[0]).toContain(T5Q);
    expect(api.adoptOrphan).not.toHaveBeenCalled();
  });

  it("a 'refuse' plan shows its line and no Adopt button; a deleted tier renders", async () => {
    const refuse = { kind: 'refuse', reason: "tier 'bronze' does not exist", line: "It cannot be adopted: tier 'bronze' does not exist." };
    const api = apiWith([[orphan('sub_p', 'paused', refuse, 'bronze')]]);
    const { tree } = await shown(api, withPaid);
    expect(text(tree())).toContain(refuse.line);
    expect(all(tree()).filter(n => n.type === 'button' && text(n) === 'Adopt')).toEqual([]);
  });
});

describe('guildApi.adoptOrphan', () => {
  it('posts the plan as a JSON body to the adopt route', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/webui/public/assets/utils/guildApi.js'), 'utf8');
    const calls: Array<[string, any]> = [];
    const fetch = async (url: string, init: any) => {
      calls.push([url, init]);
      return { status: 200, json: async () => ({ success: true }) };
    };
    const api = new Function('fetch', 'window', `${source}\nreturn guildApi;`)(fetch, { location: { href: '' } });
    const plan = { kind: 'resume', tierId: 'silver', offeringId: 'o2', days: 12 };
    expect(await api.adoptOrphan('g', 'stripe', 'sub_1', plan)).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url.endsWith('/subscriptions/g/orphans/stripe/sub_1/adopt')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ plan });
  });
});

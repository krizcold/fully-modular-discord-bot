import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 3 (parts 3 and 4a): a file in the old shape is read as the sheet's section 3 says (entries that do not fit are not
// loaded, L1 says how many, the bytes stay until the next save), and the new shape survives a reload. The old-shape
// document is test/fixtures/p1/premium-tiers.old.json, written by the manager at 6f2ac1d: no writer of this tree can
// make it, so each row writes it before the first load.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { DEFAULT_MESSAGES, getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { dataPath } from '../../src/utils/dataRoot';
import { allowDropLines } from '../helpers/p1Guard';
import { gh, uh } from '../helpers/p1Holder';
import { BUYER, p1World, PREMIUM, SELLER_ID, SELLER_VARIANT, SERVERS, USERS } from '../helpers/p1World';

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'p1', 'premium-tiers.old.json'), 'utf8');
const OLD = JSON.parse(FIXTURE);
const L1 = '[PremiumManager] premium-tiers.json holds entries this version does not read: 2 subscription record(s) not keyed by a holder, '
  + '0 paid subscription(s) with no buyer, 1 provider account link(s), 1 price-change decision(s). They are not loaded, and the next '
  + 'premium save writes the file without them.';
const L1_START = '[PremiumManager] premium-tiers.json holds entries this version does not read:';

function shownByGetters(): Record<string, unknown> {
  const mgr: any = getPremiumManager();
  const config = mgr.getFullConfig();
  return {
    subscriptions: mgr.getAllSubscriptions(),
    links: config.providerAccountLinks,
    link: mgr.getAccountLink('patreon', 'patreon-account-1') ?? null,
    decisions: mgr.listMigrations().map((m: any) => m.decisions),
    migrations: mgr.listMigrations().map((m: any) => ({ ...m, decisions: undefined })),
    tiers: config.tiers,
    messages: config.messages,
    activatedProviders: config.activatedProviders,
    migrationSilencePolicy: config.migrationSilencePolicy,
    eventsApplied: config.eventsApplied,
  };
}

const expectedFromFixture = {
  subscriptions: {},
  links: {},
  link: null,
  decisions: OLD.migrations.map(() => []),
  migrations: OLD.migrations.map((m: any) => ({ ...m, decisions: undefined })),
  tiers: OLD.tiers,
  messages: { userBlocked: DEFAULT_MESSAGES.userBlocked, ...OLD.messages },
  activatedProviders: OLD.activatedProviders,
  migrationSilencePolicy: OLD.migrationSilencePolicy,
  eventsApplied: OLD.eventsApplied,
};

describe('the fixture is the old shape', () => {
  it('holds two bare server keys, a link that is a bare id and a decision with guildId', () => {
    expect(Object.keys(OLD.subscriptions)).toEqual(['111111111111111111', '222222222222222222']);
    expect(OLD.providerAccountLinks).toEqual({ patreon: { 'patreon-account-1': '222222222222222222' } });
    expect(OLD.migrations).toHaveLength(1);
    expect(OLD.migrations[0].decisions.map((d: any) => [d.guildId, d.holder])).toEqual([['111111111111111111', undefined]]);
    expect(OLD.eventsApplied).toEqual({ 'p-old': 1 });
  });
});

describe.each([['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]])('P1 claim 3 in the bot role on %s', (_name, backend) => {
  const w = p1World(backend);
  let lines: string[] = [];
  const logged = (text: string): string[] => (backend === 'rig' ? w.logged(text) : lines.filter(l => l.includes(text)));
  beforeEach(() => {
    lines = [];
    if (backend === 'json') {
      for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    }
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('from the fixture the getters show no subscription, link or decision, and the rest equals the fixture', async () => {
    allowDropLines('L1');
    await w.setup({ seed: FIXTURE });

    expect(shownByGetters()).toEqual(expectedFromFixture);
    expect(getPremiumManager().resolveActiveTier('111111111111111111').tierId).toBe('free');
    expect(getPremiumManager().resolveActiveTier('222222222222222222').tierId).toBe('free');
  });

  it('L1 is logged once with the counts, not again on a second load of the same bytes, and the bytes stay until a save', async () => {
    allowDropLines('L1');
    await w.setup({ seed: FIXTURE });
    getPremiumManager().getAllTiers();

    expect(logged(L1_START)).toEqual([L1]);
    getPremiumManager().load();
    getPremiumManager().getAllSubscriptions();
    await w.settle();
    expect(logged(L1_START)).toEqual([L1]);
    expect(w.storedText()).toBe(FIXTURE);
  });

  it('after one setMessages the stored document has none of the entries left out and still has the tiers', async () => {
    allowDropLines('L1');
    await w.setup({ seed: FIXTURE });

    const reply = await w.op('setMessages', { moduleBlocked: 'not on this tier' });

    expect(reply).toMatchObject({ ok: true });
    const doc = w.stored();
    expect(doc.subscriptions).toEqual({});
    expect(doc.providerAccountLinks).toEqual({});
    expect(doc.migrations.map((m: any) => [m.id, m.status, m.decisions])).toEqual(OLD.migrations.map((m: any) => [m.id, m.status, []]));
    expect(doc.tiers).toEqual(OLD.tiers);
    expect(doc.activatedProviders).toEqual(OLD.activatedProviders);
    expect(doc.eventsApplied).toEqual(OLD.eventsApplied);
    expect(doc.messages).toEqual({ userBlocked: DEFAULT_MESSAGES.userBlocked, ...OLD.messages, moduleBlocked: 'not on this tier' });
    expect(w.storedText()).not.toContain('111111111111111111');
    expect(w.storedText()).not.toContain('patreon-account-1');
  });

  it('a document that holds every new field is deep-equal after a reload and one unrelated save, with no L1', async () => {
    await w.setup();
    await w.addUserTiers();
    const [a, b] = SERVERS;
    const u = USERS[0];
    expect(await w.grant(gh(a), 'low', 30)).toMatchObject({ ok: true });
    expect(await w.purchase(gh(a), 'high')).toMatchObject({ ok: true });
    expect(await w.grant(uh(u), 'ulow', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh(u), 'uhigh', null)).toMatchObject({ ok: true });
    expect(await w.purchase(gh(b), 'low')).toMatchObject({ ok: true });
    expect(await w.setNoticesChannel(gh(b), '70000000000000777')).toMatchObject({ ok: true });
    expect(await w.op('linkAccount', SELLER_ID, 'acct-1', gh(b), BUYER)).toMatchObject({ ok: true, result: true });
    expect(await w.op('scheduleMigration', {
      providerId: SELLER_ID, sourceTierId: 'low', sourceOfferingId: 'o-low', sourceVariantId: SELLER_VARIANT,
      targetTierId: 'mid', targetOfferingId: 'o-mid', targetVariantId: SELLER_VARIANT,
      effectiveDate: new Date(Date.now() + 3_600_000).toISOString(), message: 'the price changes',
    })).toMatchObject({ ok: true });
    expect(await w.op('setMessages', { userBlocked: 'an edited personal message' })).toMatchObject({ ok: true });
    await w.settle();
    const before = w.stored();
    expect(before.messages.userBlocked).toBe('an edited personal message');
    expect(before.tiers.ulow.kind).toBe('user');
    expect(before.subscriptions[gh(a)].paused).toHaveLength(1);
    expect(before.subscriptions[uh(u)].paused).toHaveLength(1);
    expect(before.subscriptions[gh(a)].active.buyerId).toBe(BUYER);
    expect(before.subscriptions[gh(b)].notificationsChannelId).toBe('70000000000000777');
    expect(before.providerAccountLinks).toEqual({ [SELLER_ID]: { 'acct-1': { holder: gh(b), buyerId: BUYER } } });
    // Both paid subscriptions are on the seller's one variant, whatever their tier.
    expect(before.migrations[0].decisions.map((d: any) => d.holder)).toEqual([gh(a), gh(b)]);

    await w.reload();
    expect(await w.op('setMessages', { panelBlocked: 'an unrelated change' })).toMatchObject({ ok: true });

    expect(w.stored()).toEqual({ ...before, messages: { ...before.messages, panelBlocked: 'an unrelated change' } });
    expect(getPremiumManager().getMessages().userBlocked).toBe('an edited personal message');
    expect(logged(L1_START)).toEqual([]);
  });

  it('rule 2: a paid subscription without a buyer, or a user\'s paid by someone else, is not loaded and L1 counts each; the grant queued behind it stays queued and never takes the slot (an accepted limit)', async () => {
    await w.setup();
    await w.addSoldUserTiers();
    const [a, b] = SERVERS;
    const [u, v] = USERS;
    expect(await w.grant(gh(a), 'low', 30)).toMatchObject({ ok: true });
    expect(await w.purchase(gh(a), 'high')).toMatchObject({ ok: true });
    expect(await w.purchase(gh(b), 'mid')).toMatchObject({ ok: true });
    expect(await w.purchase(uh(u), 'vlow')).toMatchObject({ ok: true });
    expect(await w.purchase(uh(v), 'vmid')).toMatchObject({ ok: true });
    await w.settle();
    // No writer of this tree stores a paid subscription without its buyer, or a user's with another buyer: the
    // document is edited by hand and written before the first load.
    const doc = w.stored();
    const grant = JSON.parse(JSON.stringify(doc.subscriptions[gh(a)].paused[0]));
    const kept = JSON.parse(JSON.stringify({ [gh(b)]: doc.subscriptions[gh(b)], [uh(v)]: doc.subscriptions[uh(v)] }));
    expect(grant.source).toBe('manual');
    delete doc.subscriptions[gh(a)].active.buyerId;
    doc.subscriptions[uh(u)].active.buyerId = BUYER;
    const seed = JSON.stringify(doc, null, 2);
    await w.teardown();
    allowDropLines('L1');
    await w.setup({ seed });

    const shown: any = getPremiumManager().getAllSubscriptions();

    expect(Object.keys(shown).sort()).toEqual([gh(a), gh(b), uh(v)].sort());
    expect(shown[gh(a)]).toEqual({ paused: [grant] });
    expect({ [gh(b)]: shown[gh(b)], [uh(v)]: shown[uh(v)] }).toEqual(kept);
    expect(logged(L1_START)).toEqual([
      '[PremiumManager] premium-tiers.json holds entries this version does not read: 0 subscription record(s) not keyed by a holder, '
      + '2 paid subscription(s) with no buyer, 0 provider account link(s), 0 price-change decision(s). They are not loaded, and the next '
      + 'premium save writes the file without them.',
    ]);
    expect(w.storedText()).toBe(seed);

    expect(await w.op('setMessages', { panelBlocked: 'a save' })).toMatchObject({ ok: true });
    const after = w.stored();
    expect(Object.keys(after.subscriptions).sort()).toEqual([gh(a), gh(b), uh(v)].sort());
    expect(after.subscriptions[gh(a)]).toEqual({ paused: [grant] });
    expect(after.subscriptions[gh(b)].active.buyerId).toBe(BUYER);
    expect(after.subscriptions[uh(v)].active.buyerId).toBe(v);
    expect(logged(L1_START)).toHaveLength(1);
  });

  it('rule 2 in setFullConfig: a paid subscription without a buyer is left out and counted, one with its buyer is stored', async () => {
    allowDropLines('L1');
    await w.setup();
    expect(await w.purchase(gh(SERVERS[0]), 'high')).toMatchObject({ ok: true });
    expect(await w.purchase(gh(SERVERS[1]), 'mid')).toMatchObject({ ok: true });
    const config = w.stored();
    delete config.subscriptions[gh(SERVERS[0])].active.buyerId;

    expect((getPremiumManager() as any).setFullConfig(config)).toBe(true);
    await w.settle();

    expect(Object.keys(w.stored().subscriptions)).toEqual([gh(SERVERS[1])]);
    expect(w.stored().subscriptions[gh(SERVERS[1])].active.buyerId).toBe(BUYER);
    expect(logged('holds entries this version does not read')).toEqual([
      '[PremiumManager] The configuration given to setFullConfig holds entries this version does not read: 0 subscription record(s) not keyed by a holder, '
      + '1 paid subscription(s) with no buyer, 0 provider account link(s), 0 price-change decision(s). They are left out of what is saved.',
    ]);
  });

  it('setFullConfig given bare keys and a user tier stores no bare key, keeps the kind and logs what it left out', async () => {
    allowDropLines('L1');
    await w.setup();
    const config = w.stored();
    const sub = (id: string) => ({ id, tierId: 'low', source: 'manual', startDate: new Date().toISOString(), endDate: null, autoRenew: false, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const saved = (getPremiumManager() as any).setFullConfig({
      ...config,
      tiers: { ...config.tiers, vip: { displayName: 'VIP', priority: 2, overrides: {}, offerings: [], kind: 'user' } },
      subscriptions: { [SERVERS[0]]: { active: sub('bare'), paused: [] }, [gh(SERVERS[1])]: { active: sub('keyed'), paused: [] } },
      providerAccountLinks: { [SELLER_ID]: { old: SERVERS[0], kept: { holder: gh(SERVERS[1]), buyerId: BUYER } } },
    });
    await w.settle();

    expect(saved).toBe(true);
    const doc = w.stored();
    expect(Object.keys(doc.subscriptions)).toEqual([gh(SERVERS[1])]);
    expect(doc.subscriptions[gh(SERVERS[1])].active.id).toBe('keyed');
    expect(doc.tiers.vip).toStrictEqual({ displayName: 'VIP', priority: 2, overrides: {}, offerings: [], kind: 'user' });
    expect(doc.providerAccountLinks).toEqual({ [SELLER_ID]: { kept: { holder: gh(SERVERS[1]), buyerId: BUYER } } });
    expect(logged(L1_START)).toEqual([]);
    expect(logged('holds entries this version does not read')).toEqual([
      '[PremiumManager] The configuration given to setFullConfig holds entries this version does not read: 1 subscription record(s) not keyed by a holder, '
      + '0 paid subscription(s) with no buyer, 1 provider account link(s), 0 price-change decision(s). They are left out of what is saved.',
    ]);
  });

  it('setFullConfig given only holder keys logs no such line', async () => {
    await w.setup();
    expect(await w.grant(SERVERS[0], 'low', 30)).toMatchObject({ ok: true });
    const config = w.stored();

    expect((getPremiumManager() as any).setFullConfig(config)).toBe(true);
    await w.settle();

    expect(logged('holds entries this version does not read')).toEqual([]);
    expect(w.stored().subscriptions[gh(SERVERS[0])].active.tierId).toBe('low');
  });

  it("a provider's link map that is no object is counted as one link left out", async () => {
    allowDropLines('L1');
    await w.setup({ seed: JSON.stringify({ ...OLD, subscriptions: {}, migrations: [], providerAccountLinks: { patreon: 'not a map' } }) });
    getPremiumManager().getAllTiers();

    expect(logged(L1_START)).toEqual([
      '[PremiumManager] premium-tiers.json holds entries this version does not read: 0 subscription record(s) not keyed by a holder, '
      + '0 paid subscription(s) with no buyer, 1 provider account link(s), 0 price-change decision(s). They are not loaded, and the next '
      + 'premium save writes the file without them.',
    ]);
    expect((getPremiumManager() as any).getFullConfig().providerAccountLinks).toEqual({});
  });

  it("a user's record that holds only a notices channel is not loaded and no line says so: L1 has no count it fits", async () => {
    await w.setup({ seed: JSON.stringify({ ...OLD, subscriptions: { 'user:5': { notificationsChannelId: 'c1' }, 'guild:5': { notificationsChannelId: 'c2' } }, migrations: [], providerAccountLinks: {} }) });

    expect(getPremiumManager().getAllSubscriptions()).toEqual({ 'guild:5': { paused: [], notificationsChannelId: 'c2' } });
    expect(logged(L1_START)).toEqual([]);
    expect(await w.op('setMessages', { panelBlocked: 'a save' })).toMatchObject({ ok: true });
    expect(Object.keys(w.stored().subscriptions)).toEqual(['guild:5']);
    expect(logged(L1_START)).toEqual([]);
  });
});

describe('P1 claim 3 in the web UI role on the JSON files', () => {
  const role = process.env.BOT_PROCESS_ROLE;
  let lines: string[] = [];
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await flushAll();
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  };
  beforeEach(async () => {
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    await settle();
    resetPremiumManager();
    delete process.env.BOT_PROCESS_ROLE;
    fs.rmSync(dataPath('global'), { recursive: true, force: true });
    fs.mkdirSync(dataPath('global'), { recursive: true });
    fs.writeFileSync(PREMIUM, FIXTURE);
  });
  afterEach(async () => {
    await settle();
    resetPremiumManager();
    if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
    else process.env.BOT_PROCESS_ROLE = role;
    vi.restoreAllMocks();
  });

  it('the getters show no subscription, link or decision; L1 is logged once; the bytes stay until a save', async () => {
    allowDropLines('L1');

    expect(shownByGetters()).toEqual(expectedFromFixture);
    expect(lines.filter(l => l.includes(L1_START))).toEqual([L1]);

    // The web UI drops its cache at each writer lock take; the next read loads the same bytes again.
    const mgr: any = getPremiumManager();
    const loads = vi.spyOn(mgr, 'load');
    mgr.invalidate();
    expect(shownByGetters()).toEqual(expectedFromFixture);
    mgr.invalidate();
    mgr.getAllSubscriptions();
    await settle();

    expect(loads.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(lines.filter(l => l.includes(L1_START))).toEqual([L1]);
    expect(fs.readFileSync(PREMIUM, 'utf8')).toBe(FIXTURE);
  });

  it('after one setMessages the stored document has none of the entries left out and still has the tiers', async () => {
    allowDropLines('L1');

    const saved = getPremiumManager().setMessages({ moduleBlocked: 'not on this tier' });
    await settle();

    expect(saved).toBe(true);
    const doc = JSON.parse(fs.readFileSync(PREMIUM, 'utf8'));
    expect(doc.subscriptions).toEqual({});
    expect(doc.providerAccountLinks).toEqual({});
    expect(doc.migrations.map((m: any) => m.decisions)).toEqual([[]]);
    expect(doc.tiers).toEqual(OLD.tiers);
    expect(doc.messages.moduleBlocked).toBe('not on this tier');
    expect(lines.filter(l => l.includes(L1_START))).toEqual([L1]);
  });
});

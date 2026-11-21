import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 11 (part 5): the user helpers read a user's own tier and nothing of a server's or of the Free baseline,
// and the server helpers answer as they did before the user tier existed. The real manager over the JSON files; the
// subscriptions are granted through the op. A state no writer makes (a user record holding a server tier, a record
// whose tier is gone, one past its end, a lone paused entry) is written into the file and read by a reload.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/settings/settingsDiscovery', () => ({
  getSettingsSchema: (name: string) => (name === 'p1mod' ? {
    settings: {
      count: { type: 'number', label: 'Count', default: 5 },
      name: { type: 'string', label: 'Name', default: 'x' },
      level: { type: 'number', label: 'Level', default: 1 },
    },
  } : null),
}));

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { loadModuleSettings } from '../../src/bot/internalSetup/utils/settings/settingsStorage';
import { uh } from '../helpers/p1Holder';
import { PREMIUM, p1World, SERVERS, tierDef, TWIN_USER, userTierDef } from '../helpers/p1World';

const w = p1World();
const MOD = 'p1mod';
const ID = SERVERS[0];
const USER = uh(TWIN_USER);
const USER_OVERRIDES = { level: 9, name: 'mine' };
const pm = (): any => getPremiumManager();

const serverView = () => ({
  overrides: pm().getTierOverrides(ID, MOD),
  delta: pm().getPaidTierDelta(ID, MOD),
  limits: pm().getTierHardLimits(ID, MOD),
  access: [0, 1, 2, 3, 4].map(p => pm().hasFeatureAccess(ID, p)),
  active: pm().resolveActiveTier(ID),
  settings: loadModuleSettings(MOD, ID),
});

async function editStored(edit: (doc: any) => void): Promise<void> {
  await w.settle();
  const doc = JSON.parse(fs.readFileSync(PREMIUM, 'utf8'));
  edit(doc);
  fs.writeFileSync(PREMIUM, JSON.stringify(doc, null, 2));
  await w.reload();
}

beforeEach(async () => {
  await w.setup();
  expect(await w.setGlobal(MOD, { values: { count: 7 }, hardLimits: { count: { max: 50 } } } as any)).toBe(true);
  expect((await w.op('setTier', 'mid', { ...tierDef('mid'), overrides: { [MOD]: { count: 20, _hardLimits: { count: { max: 80 } } } } })).ok).toBe(true);
  expect((await w.grant(ID, 'mid', 30)).ok).toBe(true);
  await w.addUserTiers();
  expect((await w.op('setTier', 'uhigh', { ...userTierDef('uhigh'), overrides: { [MOD]: USER_OVERRIDES } })).ok).toBe(true);
});
afterEach(async () => { await w.teardown(); });

describe('P1 claim 11: the user helpers', () => {
  it('a user tier on the same digits leaves every server helper as it was', async () => {
    const before = serverView();
    expect(before.active.tierId).toBe('mid');
    expect((await w.grant(USER, 'uhigh', 30)).ok).toBe(true);
    expect(pm().resolveActiveUserTier(TWIN_USER)?.tierId).toBe('uhigh');
    expect(serverView()).toStrictEqual(before);
  });

  it("getUserTierOverrides answers the user tier's map only, and a copy of it", async () => {
    expect((await w.grant(USER, 'uhigh', 30)).ok).toBe(true);
    const got = pm().getUserTierOverrides(TWIN_USER, MOD);
    expect(got).toStrictEqual(USER_OVERRIDES);
    got.level = 1;
    expect(pm().getUserTierOverrides(TWIN_USER, MOD)).toStrictEqual(USER_OVERRIDES);
    expect(pm().resolveActiveUserTier(TWIN_USER)).toMatchObject({ tierId: 'uhigh', source: 'manual', tier: { priority: 3, kind: 'user' } });
    expect(pm().hasUserFeatureAccess(TWIN_USER, 3)).toBe(true);
    expect(pm().hasUserFeatureAccess(TWIN_USER, 4)).toBe(false);
  });

  it('a user with no subscription, or a module the tier does not name, gets {} and null', async () => {
    expect(pm().getUserTierOverrides(TWIN_USER, MOD)).toStrictEqual({});
    expect(pm().resolveActiveUserTier(TWIN_USER)).toBeNull();
    expect((await w.grant(USER, 'uhigh', 30)).ok).toBe(true);
    expect(pm().getUserTierOverrides(TWIN_USER, 'nomod')).toStrictEqual({});
  });

  it('a queued tier is not the active one', async () => {
    expect((await w.grant(USER, 'uhigh', 30)).ok).toBe(true);
    expect((await w.grant(USER, 'ulow', 30)).ok).toBe(true);
    expect(w.recordOf(USER).paused.map((s: any) => s.tierId)).toEqual(['ulow']);
    expect(pm().resolveActiveUserTier(TWIN_USER)?.tierId).toBe('uhigh');
  });

  it.each([
    ['a paused active entry', (r: any) => { r.active.status = 'paused'; }],
    ['one past its end', (r: any) => { r.active.endDate = new Date(Date.now() - 60_000).toISOString(); }],
    ['a deleted tier', (r: any, doc: any) => { delete doc.tiers.uhigh; }],
    ['a server tier under a user key', (r: any) => { r.active.tierId = 'high'; }],
  ])('%s gives null, {} and priority 0', async (_what, edit) => {
    expect((await w.grant(USER, 'uhigh', 30)).ok).toBe(true);
    await editStored(doc => edit(doc.subscriptions[USER], doc));
    expect(pm().resolveActiveUserTier(TWIN_USER)).toBeNull();
    expect(pm().getUserTierOverrides(TWIN_USER, MOD)).toStrictEqual({});
    expect(pm().hasUserFeatureAccess(TWIN_USER, 1)).toBe(false);
  });

  it('a user tier under a server key gives the server Free', async () => {
    await editStored(doc => { doc.subscriptions[`guild:${ID}`].active.tierId = 'uhigh'; });
    expect(pm().resolveActiveTier(ID)).toMatchObject({ tierId: 'free', source: null });
    expect(pm().hasFeatureAccess(ID, 1)).toBe(false);
    expect(pm().getPaidTierDelta(ID, MOD)).toStrictEqual({});
  });

  it('hasUserFeatureAccess(u, 0) is true for anyone, any text included', () => {
    for (const who of [TWIN_USER, '81000000000000009', 'web-ui-owner', '', 'g1']) expect(pm().hasUserFeatureAccess(who, 0)).toBe(true);
  });

  it('ids that are not Discord ids answer Free, false and {} without throwing', () => {
    expect(pm().resolveActiveTier('g1')).toMatchObject({ tierId: 'free', source: null });
    expect(pm().hasFeatureAccess('g1', 1)).toBe(false);
    expect(pm().getUserTierOverrides('web-ui-owner', MOD)).toStrictEqual({});
    expect(pm().resolveActiveUserTier('web-ui-owner')).toBeNull();
    expect(pm().hasUserFeatureAccess('web-ui-owner', 1)).toBe(false);
    expect(pm().hasUserFeature('web-ui-owner', MOD, 'x')).toBe(true);
  });
});

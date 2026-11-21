import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 4: a tier is a server tier unless it says `kind: 'user'`, and its kind never changes. Every tier is made
// through the premium.setTier op on the real manager over the JSON files.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { AUDIT, PREMIUM, p1World } from '../helpers/p1World';

const w = p1World();
const MOD = 'p1mod';
const tier = (displayName: string, priority: number, more: Record<string, unknown> = {}) => ({ displayName, priority, overrides: {}, offerings: [], ...more });
const bytes = () => ({ premium: fs.readFileSync(PREMIUM, 'utf8'), audit: fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8') : '' });

beforeEach(async () => { await w.setup(); });
afterEach(async () => { await w.teardown(); });

describe('P1 claim 4: tier kind', () => {
  it('a tier saved without a kind, or as a server tier, stores the four fields and no kind', async () => {
    const plain = await w.op('setTier', 'plain', tier('Plain', 4));
    const named = await w.op('setTier', 'named', tier('Named', 5, { kind: 'guild' }));
    expect([plain.ok, named.ok]).toEqual([true, true]);
    expect(w.stored().tiers.plain).toStrictEqual({ displayName: 'Plain', priority: 4, overrides: {}, offerings: [] });
    expect(w.stored().tiers.named).toStrictEqual({ displayName: 'Named', priority: 5, overrides: {}, offerings: [] });
  });

  it("kind 'user' is stored, and is still there after a reload and after a second save of the tier", async () => {
    const first = await w.op('setTier', 'vip', tier('VIP', 2, { kind: 'user' }));
    expect(first.ok).toBe(true);
    expect(w.stored().tiers.vip).toStrictEqual({ displayName: 'VIP', priority: 2, overrides: {}, offerings: [], kind: 'user' });

    await w.reload();
    expect(w.tiers().vip.kind).toBe('user');
    const second = await w.op('setTier', 'vip', tier('VIP two', 2, { kind: 'user' }));
    expect(second.ok).toBe(true);
    expect(w.stored().tiers.vip).toStrictEqual({ displayName: 'VIP two', priority: 2, overrides: {}, offerings: [], kind: 'user' });

    // A save of something else rewrites the whole document from what the reload kept.
    await w.reload();
    expect((await w.op('setTier', 'other', tier('Other', 7))).ok).toBe(true);
    expect(w.stored().tiers.vip.kind).toBe('user');
    expect(w.stored().tiers.other.kind).toBeUndefined();
  });

  it("a tier's kind cannot be changed in either direction: X6, and nothing is stored", async () => {
    expect((await w.op('setTier', 'vip', tier('VIP', 2, { kind: 'user' }))).ok).toBe(true);
    expect((await w.op('setTier', 'plain', tier('Plain', 4))).ok).toBe(true);
    const before = bytes();

    const toServer = await w.op('setTier', 'vip', tier('VIP renamed', 2));
    const toServerNamed = await w.op('setTier', 'vip', tier('VIP renamed', 2, { kind: 'guild' }));
    const toUser = await w.op('setTier', 'plain', tier('Plain renamed', 4, { kind: 'user' }));

    expect(toServer.ok).toBe(false);
    expect(toServer.error).toContain("A tier's kind cannot be changed: 'VIP' is a user tier. Make a new tier.");
    expect(toServerNamed.ok).toBe(false);
    expect(toServerNamed.error).toContain("A tier's kind cannot be changed: 'VIP' is a user tier. Make a new tier.");
    expect(toUser.ok).toBe(false);
    expect(toUser.error).toContain("A tier's kind cannot be changed: 'Plain' is a server tier. Make a new tier.");
    expect(bytes()).toEqual(before);
    await w.reload();
    expect(w.tiers().vip).toMatchObject({ displayName: 'VIP', kind: 'user' });
    expect(w.tiers().plain.displayName).toBe('Plain');
  });

  it("'free' with kind 'user' is refused and stays a server tier", async () => {
    const before = bytes();
    const reply = await w.op('setTier', 'free', tier('Free', 0, { kind: 'user' }));
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("Cannot edit the 'free' tier");
    expect(bytes()).toEqual(before);
    expect(w.tiers('user').free).toBeUndefined();
    expect(w.tiers('guild').free).toBeTruthy();
  });

  it.each([
    ['_moduleEnabled', false],
    ['_disabledCommands', ['ping']],
    ['_hardLimits', { a: { max: 5 } }],
  ])('a user tier that sets %s is refused with X7 and nothing is stored', async (key, value) => {
    expect((await w.op('setTier', 'vip', tier('VIP', 2, { kind: 'user', overrides: { [MOD]: { a: 1 } } }))).ok).toBe(true);
    const before = bytes();

    const made = await w.op('setTier', 'vip2', tier('VIP 2', 3, { kind: 'user', overrides: { [MOD]: { a: 1, [key]: value } } }));
    const edited = await w.op('setTier', 'vip', tier('VIP', 2, { kind: 'user', overrides: { [MOD]: { [key]: value } } }));

    const x7 = `A user tier cannot set ${key} for ${MOD}: module switches, command switches and limits belong to server tiers.`;
    expect(made.ok).toBe(false);
    expect(made.error).toContain(x7);
    expect(edited.ok).toBe(false);
    expect(edited.error).toContain(x7);
    expect(bytes()).toEqual(before);
  });

  it("a user tier keeps a value equal to the Free baseline's and an empty map; a server tier's are pruned", async () => {
    expect(await w.setGlobal(MOD, { values: { a: 1 } })).toBe(true);

    expect((await w.op('setTier', 'vip', tier('VIP', 2, { kind: 'user', overrides: { [MOD]: { a: 1 }, empty: {} } }))).ok).toBe(true);
    expect((await w.op('setTier', 'plain', tier('Plain', 4, { overrides: { [MOD]: { a: 1 }, empty: {} } }))).ok).toBe(true);

    expect(w.stored().tiers.vip.overrides).toStrictEqual({ [MOD]: { a: 1 }, empty: {} });
    expect(w.stored().tiers.plain.overrides).toStrictEqual({});
  });

  it("a change of the Free baseline leaves a user tier's overrides byte-equal and cleans a server tier's", async () => {
    expect(await w.setGlobal(MOD, { moduleEnabled: false, disabledCommands: ['ping'] })).toBe(true);
    expect((await w.op('setTier', 'vip', tier('VIP', 2, { kind: 'user', overrides: { [MOD]: { a: 1 } } }))).ok).toBe(true);
    expect((await w.op('setTier', 'vipEmpty', tier('VIP empty', 3, { kind: 'user', overrides: { [MOD]: {} } }))).ok).toBe(true);
    expect((await w.op('setTier', 'plain', tier('Plain', 4, { overrides: { [MOD]: { _disabledCommands: ['ping'] } } }))).ok).toBe(true);
    const before = w.stored().tiers;
    expect(before.plain.overrides).toStrictEqual({ [MOD]: { _disabledCommands: ['ping'] } });
    expect(before.vipEmpty.overrides).toStrictEqual({ [MOD]: {} });

    expect(await w.setGlobal(MOD, { moduleEnabled: true, disabledCommands: [] })).toBe(true);

    const after = w.stored().tiers;
    expect(after.plain.overrides).toStrictEqual({});
    expect(JSON.stringify(after.vip)).toBe(JSON.stringify(before.vip));
    expect(JSON.stringify(after.vipEmpty)).toBe(JSON.stringify(before.vipEmpty));
  });

  it("getAllTiers('guild') and ('user') split the set, and without a kind it answers every tier", async () => {
    expect((await w.op('setTier', 'vip', tier('VIP', 2, { kind: 'user' }))).ok).toBe(true);
    expect((await w.op('setTier', 'plain', tier('Plain', 4))).ok).toBe(true);

    expect(Object.keys(w.tiers('user'))).toEqual(['vip']);
    expect(Object.keys(w.tiers('guild')).sort()).toEqual(['alt', 'free', 'high', 'low', 'mid', 'plain']);
    expect(Object.keys(w.tiers()).sort()).toEqual(['alt', 'free', 'high', 'low', 'mid', 'plain', 'vip']);
  });
});

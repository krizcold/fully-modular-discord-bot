import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 10 (parts 3 and 4a): a failed write never reports success, for a user as for a server. The manual methods
// for a user, a server purchase, and the paid methods for a user that save the document with the seller (a purchase,
// a cancel now, the cancel of a queued one), each through its shared op. On the JSON files the disk refuses the save (as
// nb10PremiumRefused.test.ts makes one): the op answers not ok, the stored bytes stay, and the bot's retry stores the
// change with its audit line once. On the mirror rig another machine changes the row the save was built on: the op
// answers changed-elsewhere and the next read shows the other machine's record.
// P2 claim 12 (parts 0 and 2): the paid methods for a server and for a user run through the P1 seller and the real Dummy
// provider, with the refusal on premium-tiers.json only (the Dummy's state.json is another file and stores its
// change): a purchase or an adoption leaves the seller's record live and listed for the holder.

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = (await import('../helpers/longConfirm')).longConfirm(await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>());
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const guard = (filename: string, options: any) => {
    const cause = inject.refuse.get(filename);
    if (!cause) return;
    ledger.recordRefusal(cause as any, `global:${options.category ?? ''}/${filename}`);
    throw new real.DataBackendUnavailableError(cause as any);
  };
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => { guard(f, o); return real.saveDataTracked(f, o, d); },
    appendDataTracked: (f: string, o: any, l: string) => { guard(f, o); return real.appendDataTracked(f, o, l); },
  };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { PREMIUM_KEY } from '../helpers/nb6PremiumRig';
import { gh, uh } from '../helpers/p1Holder';
import { BUYER, SERVERS, USERS, eachSeller, p1World, type OpReply } from '../helpers/p1World';

type World = ReturnType<typeof p1World>;
const USER = uh(USERS[0]);
const SERVER = gh(SERVERS[0]);

interface Case {
  name: string;
  /** The state the real writer leaves before the call. */
  prepare: (w: World) => Promise<void>;
  call: (w: World) => Promise<OpReply>;
  holder: string;
  /** The audit action the change writes, and what the stored record shows once it is stored. */
  action: string;
  stored: (record: any) => unknown;
  expected: unknown;
  /** The seller's record the call sells or adopts, which stays live at the seller when premium's save is refused. */
  sold?: (w: World, idsBefore: string[]) => string;
}

const manualCases: Case[] = [
  {
    name: 'grantManual for a user', holder: USER, action: 'subscription.grant.manual',
    prepare: async () => undefined,
    call: w => w.grant(USER, 'ulow', 30),
    stored: record => record?.active?.tierId ?? null, expected: 'ulow',
  },
  {
    name: 'extendManual for a user', holder: USER, action: 'subscription.extend.manual',
    prepare: async w => { expect((await w.grant(USER, 'ulow', 1)).ok).toBe(true); },
    call: w => w.extend(USER, 50),
    stored: record => Date.parse(record?.active?.endDate ?? '') > Date.now() + 40 * 86_400_000, expected: true,
  },
  {
    name: 'revokeManual for a user', holder: USER, action: 'subscription.revoke.manual',
    prepare: async w => { expect((await w.grant(USER, 'ulow', 30)).ok).toBe(true); },
    call: w => w.revoke(USER),
    stored: record => record, expected: null,
  },
];

/** The paid methods for a user, run through each seller. */
const userPaidCases: Case[] = [
  {
    name: 'a user purchase', holder: USER, action: 'subscription.install.paid',
    prepare: async () => undefined,
    call: w => w.purchase(USER, 'vlow'),
    stored: record => [record?.active?.tierId ?? null, record?.active?.buyerId ?? null], expected: ['vlow', USERS[0]],
    sold: (w, idsBefore) => {
      const made = w.ids().filter(id => !idsBefore.includes(id));
      expect(made).toHaveLength(1);
      return made[0];
    },
  },
  {
    name: 'cancelPaidSubscriptionImmediately for a user', holder: USER, action: 'subscription.cancel.paid',
    prepare: async w => { expect((await w.purchase(USER, 'vlow')).ok).toBe(true); },
    call: w => w.cancelNow(USER),
    stored: record => record, expected: null,
  },
  {
    name: 'cancelAndRemovePausedSubscription for a user', holder: USER, action: 'subscription.cancel.paid',
    prepare: async w => {
      expect((await w.purchase(USER, 'vhigh')).ok).toBe(true);
      expect((await w.purchase(USER, 'vlow')).ok).toBe(true);
    },
    call: async w => (await w.cancelQueued(USER, 0))!,
    stored: record => [record?.active?.tierId ?? null, record?.paused?.length ?? null], expected: ['vhigh', 0],
  },
  {
    name: 'cancelPaidSubscription for a user', holder: USER, action: 'subscription.cancel.paid',
    prepare: async w => {
      expect((await w.purchase(USER, 'vlow')).ok).toBe(true);
    },
    call: w => w.op('cancelPaidSubscription', USER),
    stored: record => [record?.active?.tierId ?? null, record?.active?.autoRenew ?? null], expected: ['vlow', false],
  },
  {
    name: 'reactivatePaidSubscription for a user', holder: USER, action: 'subscription.reactivate.paid',
    prepare: async w => {
      expect((await w.purchase(USER, 'vlow')).ok).toBe(true);
      expect(await w.op('cancelPaidSubscription', USER)).toMatchObject({ ok: true, result: true });
      expect(w.recordOf(USER).active.autoRenew).toBe(false);
    },
    call: w => w.op('reactivatePaidSubscription', USER),
    stored: record => [record?.active?.tierId ?? null, record?.active?.autoRenew ?? null], expected: ['vlow', true],
  },
  {
    name: 'adoptOrphan for a user', holder: USER, action: 'subscription.install.paid',
    prepare: async w => {
      const providerSubId = await w.unheld(USER, 'vlow');
      const listed = await w.orphans(USER);
      expect(listed.map(o => [o.ref.providerSubId, o.plan.kind])).toEqual([[providerSubId, 'install']]);
      adoption = { providerSubId, plan: listed[0].plan };
    },
    call: w => w.adopt(USER, adoption.providerSubId, adoption.plan),
    stored: record => [record?.active?.providerSubId === adoption.providerSubId, record?.active?.buyerId ?? null], expected: [true, USERS[0]],
    sold: () => adoption.providerSubId,
  },
];

let adoption: { providerSubId: string; plan: unknown } = { providerSubId: '', plan: null };

/** The paid methods for a server, run through each seller. */
const serverCases: Case[] = [
  {
    name: 'a server purchase', holder: SERVER, action: 'subscription.install.paid',
    prepare: async () => undefined,
    call: w => w.purchase(SERVER, 'mid'),
    stored: record => record?.active?.tierId ?? null, expected: 'mid',
    sold: (w, idsBefore) => {
      const made = w.ids().filter(id => !idsBefore.includes(id));
      expect(made).toHaveLength(1);
      return made[0];
    },
  },
  {
    name: 'cancelPaidSubscriptionImmediately for a server', holder: SERVER, action: 'subscription.cancel.paid',
    prepare: async w => { expect((await w.purchase(SERVER, 'low')).ok).toBe(true); },
    call: w => w.cancelNow(SERVER),
    stored: record => record, expected: null,
  },
  {
    name: 'cancelAndRemovePausedSubscription for a server', holder: SERVER, action: 'subscription.cancel.paid',
    prepare: async w => {
      expect((await w.purchase(SERVER, 'high')).ok).toBe(true);
      expect((await w.purchase(SERVER, 'low')).ok).toBe(true);
    },
    call: async w => (await w.cancelQueued(SERVER, 0))!,
    stored: record => [record?.active?.tierId ?? null, record?.paused?.length ?? null], expected: ['high', 0],
  },
  {
    name: 'cancelPaidSubscription for a server', holder: SERVER, action: 'subscription.cancel.paid',
    prepare: async w => { expect((await w.purchase(SERVER, 'low')).ok).toBe(true); },
    call: w => w.op('cancelPaidSubscription', SERVER),
    stored: record => [record?.active?.tierId ?? null, record?.active?.autoRenew ?? null], expected: ['low', false],
  },
  {
    name: 'reactivatePaidSubscription for a server', holder: SERVER, action: 'subscription.reactivate.paid',
    prepare: async w => {
      expect((await w.purchase(SERVER, 'low')).ok).toBe(true);
      expect(await w.op('cancelPaidSubscription', SERVER)).toMatchObject({ ok: true, result: true });
      expect(w.recordOf(SERVER).active.autoRenew).toBe(false);
    },
    call: w => w.op('reactivatePaidSubscription', SERVER),
    stored: record => [record?.active?.tierId ?? null, record?.active?.autoRenew ?? null], expected: ['low', true],
  },
  {
    name: 'adoptOrphan for a server', holder: SERVER, action: 'subscription.install.paid',
    prepare: async w => {
      const providerSubId = await w.unheld(SERVER, 'low');
      const listed = await w.orphans(SERVER);
      expect(listed.map(o => [o.ref.providerSubId, o.plan.kind])).toEqual([[providerSubId, 'install']]);
      adoption = { providerSubId, plan: listed[0].plan };
    },
    call: w => w.adopt(SERVER, adoption.providerSubId, adoption.plan),
    stored: record => [record?.active?.providerSubId === adoption.providerSubId, record?.active?.buyerId ?? null], expected: [true, BUYER],
    sold: () => adoption.providerSubId,
  },
];

describe('P1 claim 10 on the JSON files: a save the disk refuses', () => {
  for (const [sellers, table] of [[['p1seller'], manualCases], [['p1seller', 'dummy'], [...userPaidCases, ...serverCases]]] as const) eachSeller([...sellers], make => {
  const w = p1World('json', make());
  beforeEach(async () => {
    inject.refuse.clear();
    await w.setup();
    await w.addUserTiers();
    await w.addSoldUserTiers();
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    inject.refuse.clear();
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each(table)('$name answers not ok, leaves the stored bytes, and the retry stores it with its audit line once', async c => {
    await c.prepare(w);
    const before = { premium: w.storedText(), audit: w.auditText() };
    const linesBefore = w.auditLines().filter(l => l.action === c.action).length;
    const idsBefore = w.ids();
    inject.refuse.set('premium-tiers.json', 'storage-failing');
    inject.refuse.set('premium-tiers.audit.jsonl', 'storage-failing');

    const reply = await c.call(w);

    expect(reply.ok).toBe(false);
    expect((reply as any).answer).toBe('held');
    expect({ premium: w.storedText(), audit: w.auditText() }).toEqual(before);
    if (c.sold) {
      const id = c.sold(w, idsBefore);
      expect(w.view(id)).toMatchObject({ status: 'active' });
      const listed = await getPaymentRegistry().get(w.driver.id)!.listSubscriptionsFor!(c.holder as any);
      expect(listed.map(r => r.providerSubId)).toContain(id);
    }

    inject.refuse.clear();
    await vi.waitFor(() => expect(c.stored(w.recordOf(c.holder))).toEqual(c.expected), { timeout: 8000, interval: 50 });
    await vi.waitFor(() => expect(w.auditLines().filter(l => l.action === c.action)).toHaveLength(linesBefore + 1), { timeout: 8000, interval: 50 });
    await w.settle();
    const lines = w.auditLines().filter(l => l.action === c.action);
    expect(lines).toHaveLength(linesBefore + 1);
    expect(lines[lines.length - 1].holder).toBe(c.holder);
  }, 30_000);
  });
});

describe('P1 claim 10 on the mirror rig: a save built on a row another machine changed', () => {
  for (const [sellers, table] of [[['p1seller'], manualCases], [['p1seller', 'dummy'], [...userPaidCases, ...serverCases]]] as const) eachSeller([...sellers], make => {
  const w = p1World('rig', make());
  beforeEach(async () => {
    inject.refuse.clear();
    await w.setup();
    await w.addUserTiers();
    await w.addSoldUserTiers();
  });
  afterEach(async () => { await w.teardown(); });

  it.each(table)("$name answers changed-elsewhere, and the next read shows the other machine's record", async c => {
    await c.prepare(w);
    const rows = w.rig!.m.state.rows;
    // The other machine's version: this one's document with a grant to a third holder, and without this change.
    const theirs = w.stored();
    const now = new Date().toISOString();
    theirs.subscriptions['user:9'] = { active: { id: 'theirs-1', tierId: 'uhigh', source: 'manual', startDate: now, endDate: null, autoRenew: false, status: 'active', createdAt: now, updatedAt: now }, paused: [] };
    const theirText = JSON.stringify(theirs, null, 2);
    const mineBefore = JSON.parse(JSON.stringify(theirs.subscriptions[c.holder] ?? null));
    rows.fault = sql => {
      if (sql.startsWith('SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs')) {
        rows.fault = undefined;
        rows.put(PREMIUM_KEY, theirText);
      }
      return undefined;
    };

    const reply = await c.call(w);

    expect(reply.ok).toBe(false);
    expect((reply as any).answer).toBe('changed-elsewhere');
    expect(w.storedText()).toBe(theirText);
    await w.settle();
    await runSharedPass();
    const read: any = getPremiumManager().getAllSubscriptions();
    expect(read['user:9'].active.id).toBe('theirs-1');
    expect(read[c.holder] ?? null).toEqual(mineBefore);
  }, 30_000);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 7(b) (part 4a): stacking per holder is the server's of today. One scenario table runs twice, for a server
// and for a user, with the seller: the higher priority takes the slot, a manual grant wins a tie, a paid one at a tie
// is refused, the lower priority queues paused, the queue resumes when the slot frees. The clock is the real one; the
// one entry that "ran out in the queue" comes from a created event whose paid period had ended when it arrived.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { gh, uh } from '../helpers/p1Holder';
import { brokenHolders, brokenStacking, DAY_MS, p1World, SELLER_LIST_CALL, SERVERS, USERS } from '../helpers/p1World';

const w = p1World();

const kinds = [
  { name: 'a server', who: gh(SERVERS[0]), other: uh(SERVERS[0]), low: 'low', mid: 'mid', alt: 'alt', high: 'high' },
  { name: 'a user', who: uh(USERS[0]), other: gh(USERS[0]), low: 'vlow', mid: 'vmid', alt: 'valt', high: 'vhigh' },
];
const shape = (record: any) => record === null ? null : {
  active: record.active ? `${record.active.tierId}/${record.active.source}/${record.active.status}` : null,
  paused: record.paused.map((p: any) => `${p.tierId}/${p.source}/${p.status}`),
};
const methods = () => w.seller.calls.map(c => c.method);
const callsOf = (method: string) => w.seller.calls.filter(c => c.method === method);
const near = (iso: string | null, ms: number): boolean => iso !== null && Math.abs(Date.parse(iso) - ms) < 120_000;

beforeEach(async () => {
  await w.setup();
  await w.addSoldUserTiers();
  for (const level of ['log', 'warn'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await w.teardown();
});

describe.each(kinds)('P1 claim 7(b): the stacking of $name', k => {
  const sound = () => {
    expect(brokenStacking(w.stored())).toEqual([]);
    expect(brokenHolders(w.stored())).toEqual([]);
    expect(w.recordOf(k.other)).toBeNull();
  };

  it('a higher priority takes the slot, and the old one is paused at the seller with its days left', async () => {
    expect(await w.purchase(k.who, k.low)).toMatchObject({ ok: true });
    const lowSub = w.recordOf(k.who).active.providerSubId;
    expect(await w.purchase(k.who, k.high)).toMatchObject({ ok: true });

    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.high}/paid/active`, paused: [`${k.low}/paid/paused`] });
    expect(w.recordOf(k.who).paused[0]).toMatchObject({ providerSubId: lowSub, remainingDaysAtPause: 30 });
    expect(methods()).toEqual([SELLER_LIST_CALL, 'initiatePurchase', SELLER_LIST_CALL, 'initiatePurchase', 'pauseSubscription']);
    expect(callsOf('pauseSubscription')[0].args).toEqual([lowSub, null, 30]);
    expect(w.seller.records.get(lowSub)).toMatchObject({ status: 'paused', pausedDaysLeft: 30 });
    sound();
  });

  it('a manual grant wins a tie: it takes the slot and the paid one is paused', async () => {
    expect(await w.purchase(k.who, k.mid)).toMatchObject({ ok: true });
    const midSub = w.recordOf(k.who).active.providerSubId;
    expect(await w.grant(k.who, k.alt, 10)).toMatchObject({ ok: true });

    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.alt}/manual/active`, paused: [`${k.mid}/paid/paused`] });
    expect(callsOf('pauseSubscription').map(c => c.args)).toEqual([[midSub, null, 30]]);
    sound();
  });

  it("a paid one at a tie is refused with today's text, and nothing is bought or stored", async () => {
    expect(await w.purchase(k.who, k.mid)).toMatchObject({ ok: true });
    const before = { premium: w.storedText(), audit: w.auditText() };

    const tie = await w.purchase(k.who, k.alt);
    const same = await w.purchase(k.who, k.mid);

    expect(tie.ok).toBe(false);
    expect(tie.error).toContain(`You already have a '${k.mid.toUpperCase()}' subscription at the same priority as '${k.alt.toUpperCase()}'. Stacking requires distinct priorities: cancel or let the existing one expire first.`);
    expect(same.ok).toBe(false);
    expect(same.error).toContain(`You already have a '${k.mid.toUpperCase()}' subscription. Cancel or let the existing one expire first.`);
    expect({ premium: w.storedText(), audit: w.auditText() }).toEqual(before);
    expect(callsOf('initiatePurchase')).toHaveLength(1);
    expect(w.seller.records.size).toBe(1);
  });

  it('a lower priority queues paused: a purchase starts paused at the seller, and a checkout that ended there is paused by a call', async () => {
    expect(await w.purchase(k.who, k.high)).toMatchObject({ ok: true });
    const highEnd = w.recordOf(k.who).active.endDate;

    expect(await w.purchase(k.who, k.low)).toMatchObject({ ok: true });
    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.high}/paid/active`, paused: [`${k.low}/paid/paused`] });
    const lowSub = w.recordOf(k.who).paused[0].providerSubId;
    expect(callsOf('initiatePurchase')[1].args[0]).toMatchObject({ tierId: k.low, startPausedUntil: highEnd });
    expect(w.seller.records.get(lowSub)!.status).toBe('paused');
    expect(callsOf('pauseSubscription')).toEqual([]);

    expect(await w.created(k.who, k.mid)).toMatchObject({ ok: true });
    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.high}/paid/active`, paused: [`${k.mid}/paid/paused`, `${k.low}/paid/paused`] });
    const midSub = w.recordOf(k.who).paused[0].providerSubId;
    expect(callsOf('pauseSubscription').map(c => c.args)).toEqual([[midSub, highEnd, 30]]);
    expect(w.seller.records.get(midSub)!.status).toBe('paused');
    sound();
  });

  it("an expiry resumes the queue's first with fresh dates and one resume call", async () => {
    expect(await w.purchase(k.who, k.low)).toMatchObject({ ok: true });
    const lowSub = w.recordOf(k.who).active.providerSubId;
    expect(await w.purchase(k.who, k.high)).toMatchObject({ ok: true });
    const pausedStart = w.recordOf(k.who).paused[0].startDate;
    await new Promise(resolve => setTimeout(resolve, 15));

    expect(await w.expired(k.who)).toMatchObject({ ok: true });

    const record = w.recordOf(k.who);
    expect(shape(record)).toEqual({ active: `${k.low}/paid/active`, paused: [] });
    expect(record.active.providerSubId).toBe(lowSub);
    expect(Date.parse(record.active.startDate)).toBeGreaterThan(Date.parse(pausedStart));
    expect(near(record.active.endDate, Date.now() + 30 * DAY_MS)).toBe(true);
    expect(record.active.remainingDaysAtPause).toBeUndefined();
    expect(callsOf('resumeSubscription').map(c => c.args)).toEqual([[lowSub, record.active.endDate]]);
    sound();
  });

  it("an entry that ran out in the queue is skipped with its 'expired-while-queued' line", async () => {
    expect(await w.purchase(k.who, k.high)).toMatchObject({ ok: true });
    // The seller's checkout of the lower tier ended its paid period before its event arrived.
    const late = w.orphan(k.who, k.low);
    late.endDate = new Date(Date.now() - 60_000).toISOString();
    expect(await w.deliver(w.createdEvent(late))).toMatchObject({ ok: true });
    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.high}/paid/active`, paused: [`${k.low}/paid/paused`] });
    const queuedId = w.recordOf(k.who).paused[0].id;
    expect(w.recordOf(k.who).paused[0].remainingDaysAtPause).toBe(0);

    expect(await w.cancelNow(k.who)).toMatchObject({ ok: true });

    expect(w.recordOf(k.who)).toBeNull();
    const lines = w.auditLines().filter(l => l.metadata?.reason === 'expired-while-queued');
    expect(lines.map(l => [l.action, l.holder, l.subscriptionId])).toEqual([['subscription.expire.paid', k.who, queuedId]]);
    expect(callsOf('resumeSubscription')).toEqual([]);
  });

  it('cancel now drops the active one and resumes the next', async () => {
    expect(await w.purchase(k.who, k.low)).toMatchObject({ ok: true });
    const lowSub = w.recordOf(k.who).active.providerSubId;
    expect(await w.purchase(k.who, k.high)).toMatchObject({ ok: true });
    const highSub = w.recordOf(k.who).active.providerSubId;

    expect(await w.cancelNow(k.who)).toMatchObject({ ok: true });

    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.low}/paid/active`, paused: [] });
    expect(callsOf('cancelSubscription').map(c => c.args)).toEqual([[highSub, true]]);
    expect(callsOf('resumeSubscription').map(c => c.args[0])).toEqual([lowSub]);
    expect(w.seller.records.get(highSub)!.status).toBe('expired');
    expect(w.seller.records.get(lowSub)!.status).toBe('active');
    sound();
  });

  it('the revoke of a queued manual grant removes it and leaves the active paid one', async () => {
    expect(await w.grant(k.who, k.low, 30)).toMatchObject({ ok: true });
    expect(await w.purchase(k.who, k.high)).toMatchObject({ ok: true });
    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.high}/paid/active`, paused: [`${k.low}/manual/paused`] });
    const activeBefore = JSON.stringify(w.recordOf(k.who).active);

    expect(await w.revoke(k.who)).toMatchObject({ ok: true, result: true });

    expect(shape(w.recordOf(k.who))).toEqual({ active: `${k.high}/paid/active`, paused: [] });
    expect(JSON.stringify(w.recordOf(k.who).active)).toBe(activeBefore);
    expect(callsOf('cancelSubscription')).toEqual([]);
    sound();
  });
});

describe('P1 claim 7(b): deleteTier', () => {
  it('empties both kinds: the subscriptions of a deleted server tier and of a deleted user tier are gone, the others stay', async () => {
    const [server, user] = [gh(SERVERS[0]), uh(USERS[0])];
    expect(await w.purchase(server, 'low')).toMatchObject({ ok: true });
    expect(await w.purchase(server, 'high')).toMatchObject({ ok: true });
    expect(await w.purchase(user, 'vlow')).toMatchObject({ ok: true });
    expect(await w.grant(user, 'vhigh', 30)).toMatchObject({ ok: true });
    expect(await w.grant(uh(USERS[1]), 'vlow', null)).toMatchObject({ ok: true });

    expect(await w.deleteTier('low')).toMatchObject({ ok: true });
    expect(await w.deleteTier('vlow')).toMatchObject({ ok: true });

    expect(shape(w.recordOf(server))).toEqual({ active: 'high/paid/active', paused: [] });
    expect(shape(w.recordOf(user))).toEqual({ active: 'vhigh/manual/active', paused: [] });
    expect(w.recordOf(uh(USERS[1]))).toBeNull();
    expect(Object.keys(w.stored().subscriptions).sort()).toEqual([server, user].sort());
    expect(brokenStacking(w.stored())).toEqual([]);
  });
});

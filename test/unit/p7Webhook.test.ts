import { afterEach, describe, expect, it, vi } from 'vitest';

// P7 claim 4 (sheet P7, section 10; 4.6 and THE RE-READ RULE): a delivery is a doorbell. Its signature (HMAC-MD5 of
// the raw body with the webhook secret) is checked first; then the bot reads each member it names from Patreon and
// applies the read, never the body, within the op's 5 s budget, arms a round for the members that did not fit, and
// arms each member's re-read W later. The real PatreonProvider and PremiumManager (helpers/p7World.ts), deliveries
// posted the way the web UI's webhook route posts them, and the fake of helpers/p7Patreon.ts as Patreon.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { setOrderRefusal } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { currentLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { CREATOR_TOKEN, PATREON_USERS, PTIER, type FakeMember, type Posted } from '../helpers/p7Patreon';
import { p7World, type P7World } from '../helpers/p7World';
import { busiestMinute, callsTo, held, holderOf, link, LOG, memberReads, MIN, PT13, PT14, SEC, tiersAt, W } from '../helpers/p7Rows';

const PU = PATREON_USERS[0];
const H = holderOf(0);

/** A Discord user id and a Patreon user id for the n-th extra member of a row. */
const discordOf = (n: number) => `8670000000${String(100000 + n).padStart(7, '0')}`;
const patreonOf = (n: number) => String(73_000_000 + n);

async function linkExtra(w: P7World, n: number): Promise<void> {
  const ok = (getPremiumManager() as any).linkAccount('patreon', patreonOf(n), `user:${discordOf(n)}`, discordOf(n));
  if (!ok) throw new Error(`link ${n} was not saved`);
}

/** A delivery of Patreon's own body for the members, as one request (`data` an array for several). */
function bodyOf(w: P7World, members: FakeMember[]): string {
  return JSON.stringify(w.fake.deliveryBody(members));
}

async function post(w: P7World, body: string, trigger: 'members:update' | 'members:pledge:delete' = 'members:update'): Promise<Posted[]> {
  const d = w.fake.signed(trigger, body);
  const out = await w.pump(w.fake.postOwn(d));
  await w.settle();
  return [out];
}

describe('P7 claim 4: webhooks', () => {
  const w = p7World('json');
  afterEach(async () => {
    await w.teardown();
    setOrderRefusal(false);
    vi.restoreAllMocks();
  });

  it('W1: a valid signature applies; a wrong one, a missing header, or a body changed by one byte answers 400 with PT14 and calls Patreon not at all', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 } });
    await link(w, 0);
    w.fake.pledge(PU, PTIER.A);
    const valid = w.fake.queue[0];
    w.fake.queue.length = 0;
    const calls = w.fake.calls.length;
    const statuses = [
      await w.postWebhook(valid.body, { ...valid.headers, 'x-patreon-signature': valid.headers['x-patreon-signature'].replace(/^./, c => (c === '0' ? '1' : '0')) }),
      await w.postWebhook(valid.body, { 'content-type': 'application/json', 'x-patreon-event': valid.trigger }),
      await w.postWebhook(valid.body.replace('"member"', '"membeR"'), valid.headers),
    ];
    const reply = await w.sharedOp('payment.webhook', { providerId: 'patreon', body: Buffer.from(valid.body.replace('"member"', '"membeR"')).toString('base64'), signature: '', headers: valid.headers });
    expect(statuses).toEqual([400, 400, 400]);
    expect([reply.ok, reply.error]).toEqual([false, PT14]);
    expect(w.fake.calls.length).toBe(calls);
    expect(held(w)).toEqual([]);
    expect(await w.postWebhook(valid.body, valid.headers)).toBe(200);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it('W2: with no webhook secret saved a delivery answers 400 with PT13 and nothing is read', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 }, webhook: false });
    await link(w, 0);
    const m = w.fake.pledge(PU, PTIER.A);
    const d = w.fake.signed('members:update', bodyOf(w, [m]));
    const calls = w.fake.calls.length;
    expect(await w.postWebhook(d.body, d.headers)).toBe(400);
    const reply = await w.sharedOp('payment.webhook', { providerId: 'patreon', body: Buffer.from(d.body).toString('base64'), signature: '', headers: d.headers });
    expect([reply.ok, reply.error]).toEqual([false, PT13]);
    expect([w.fake.calls.length, held(w)]).toEqual([calls, []]);
  });

  it('W3: a signed body claiming tier B for a member Patreon holds on A installs A (fails on a build that applies the body)', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false } });
    await link(w, 0);
    const m = w.fake.pledge(PU, PTIER.A);
    w.fake.queue.length = 0;
    const body = w.fake.deliveryBody([m]);
    body.data.relationships.currently_entitled_tiers.data = [{ type: 'tier', id: PTIER.B }];
    body.included = body.included.map((o: any) => (o.type === 'tier' ? { ...o, id: PTIER.B, attributes: { amount_cents: 1000, title: 'Patreon B' } } : o));
    expect((await post(w, JSON.stringify(body))).map(p => p.status)).toEqual([200]);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it('W4: a replayed old members:pledge:delete while the pledge lives changes nothing', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 } });
    await link(w, 0);
    const m = w.fake.pledge(PU, PTIER.A);
    await w.deliverAll();
    const before = w.storedText();
    const old = w.fake.deliveryBody([m]);
    old.data.attributes.patron_status = 'former_patron';
    old.data.relationships.currently_entitled_tiers.data = [];
    old.included = old.included.filter((o: any) => o.type !== 'tier');
    expect((await post(w, JSON.stringify(old), 'members:pledge:delete')).map(p => p.status)).toEqual([200]);
    expect(w.storedText()).toBe(before);
    await w.advance(W + MIN);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it('W5 (R3): reordered deliveries end at Patreon\'s state', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false, reorder: true } });
    await link(w, 0);
    const m = w.fake.pledge(PU, PTIER.A);
    w.fake.changeTier(m, PTIER.B);
    w.fake.reorderQueue(w.fake.queue.length - 1, 0);
    await w.deliverAll();
    await w.advance(W + MIN);
    expect(tiersAt(w, H)).toEqual([`${PTIER.B}:active`]);
  });

  it.each([[false], [true]])('W6 (R1, retryNon2xx %s): a read failing in the op answers 200 with PT25, and the re-read W later applies', async retryNon2xx => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, retryNon2xx } });
    await link(w, 0);
    w.fake.pledge(PU, PTIER.A);
    w.fake.fail('member', { status: 500 }, 2);
    const posted = await w.deliverAll();
    expect(posted.every(p => p.status === 200)).toBe(true);
    expect(w.logs.filter(l => l.startsWith(LOG.PT8) && l.includes(LOG.PT25_DELIVERY) && l.includes('the bot reads it again within 10 minutes')).length).toBeGreaterThan(0);
    expect(held(w)).toEqual([]);
    await w.advance(W + 10 * SEC);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it('W7 (R2): a body naming several members applies each; a body that is not JSON answers 200 and arms a round 30 s later', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 } });
    await w.advance(31 * SEC);
    await link(w, 0);
    await link(w, 1);
    const m0 = w.fake.pledge(PU, PTIER.A);
    const m1 = w.fake.pledge(PATREON_USERS[1], PTIER.B);
    w.fake.queue.length = 0;
    expect((await post(w, bodyOf(w, [m0, m1]))).map(p => p.status)).toEqual([200]);
    expect([tiersAt(w, H), tiersAt(w, holderOf(1))]).toEqual([[`${PTIER.A}:active`], [`${PTIER.B}:active`]]);
    const rounds = callsTo(w, 'campaigns').length;
    expect((await post(w, 'not json at all')).map(p => p.status)).toEqual([200]);
    await w.advance(29 * SEC);
    expect(callsTo(w, 'campaigns').length).toBe(rounds);
    await w.advance(2 * SEC);
    expect(callsTo(w, 'campaigns').length).toBe(rounds + 1);
  });

  it('W8: a delivery during a save order answers 503, and the first round after the order applies the change', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 } });
    await link(w, 0);
    w.fake.pledge(PU, PTIER.A);
    setOrderRefusal(true);
    const posted = await w.deliverAll();
    expect(posted.map(p => p.status)).toEqual(posted.map(() => 503));
    await w.advance(2 * MIN);
    expect(held(w)).toEqual([]);
    setOrderRefusal(false);
    await w.advance(5 * MIN);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it.each([[3], [10], [60]])('W9 (D18, R15, deliveryTimeout %s): 30 members in one body, each read taking 2 s, under staleReads 40: 200 within the 5 s budget, and every change applied by its re-read W later (fails on a build that arms re-reads only for reads that ran in the op)', async deliveryTimeout => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 40, deliveryTimeout } });
    await w.advance(31 * SEC);
    const members: FakeMember[] = [];
    for (let n = 0; n < 30; n++) {
      await linkExtra(w, n);
      members.push(w.fake.pledge(patreonOf(n), PTIER.A));
    }
    await w.settle();
    w.fake.queue.length = 0;
    w.fake.slow('member', 2000, 30);
    const [answer] = await post(w, bodyOf(w, members));
    expect(answer.status).toBe(200);
    expect(answer.ms).toBeLessThanOrEqual(5 * SEC + 500);
    expect(answer.failed).toBe(deliveryTimeout === 3);
    expect(held(w)).toEqual([]);
    await w.advance(W + 2 * MIN);
    expect(held(w).map(h => h.holder).sort()).toEqual(members.map((_, n) => `user:${discordOf(n)}`).sort());
  }, 120_000);

  it('W10 (THE RE-READ RULE): a new pledge whose delivery\'s read is stale changes nothing, and the re-read W later installs it', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 40 } });
    await w.advance(31 * SEC);
    await link(w, 0);
    const m = w.fake.pledge(PU, PTIER.A);
    const t0 = Date.now();
    await w.deliverAll();
    expect(memberReads(w, m).length).toBeGreaterThan(0);
    expect(held(w)).toEqual([]);
    await w.advance(t0 + W - SEC - Date.now());
    expect(held(w)).toEqual([]);
    await w.advance(2 * SEC);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it('W11 (E3): a charge day of 2500 members, 300 linked: no read and no re-read for the others, a masked or absent user always read, at most 80 creator-token calls a minute, the re-reads due together behind one step 0, and an answered 429 runs again W later', async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, perMinute: 100 } });
    await w.advance(31 * SEC);
    const members: FakeMember[] = [];
    for (let n = 0; n < 2500; n++) {
      if (n < 300) await linkExtra(w, n);
      members.push(w.fake.pledge(patreonOf(n), PTIER.A));
    }
    await w.settle();
    w.fake.queue.length = 0;
    const masked = [members[2400], members[2401]];
    for (const m of masked) m.masked = true;
    const t0 = Date.now();
    const from = w.fake.calls.length;
    for (let i = 0; i < members.length; i += 50) {
      const body = w.fake.deliveryBody(members.slice(i, i + 50));
      if (i === 2450) for (const d of body.data) if (d.id === members[2460].id) delete d.relationships.user;
      const out = await post(w, JSON.stringify(body));
      expect(out.map(p => p.status)).toEqual([200]);
    }
    const readIds = new Set(w.fake.calls.slice(from).filter(c => c.route === 'member').map(c => c.path.split('?')[0].slice('/members/'.length)));
    const allowed = new Set([...members.slice(0, 300), ...masked, members[2460]].map(m => m.id));
    expect([...readIds].filter(id => !allowed.has(id))).toEqual([]);
    await w.advance(t0 + W - 30 * SEC - Date.now());
    const before = w.fake.calls.length;
    w.fake.fail('member', { status: 429, retryAfter: 5 }, 1);
    await w.advance(10 * MIN);
    const batch = w.fake.calls.slice(before);
    const steps0 = batch.filter(c => c.route === 'campaigns').length;
    const rereadIds = new Set(batch.filter(c => c.route === 'member').map(c => c.path.split('?')[0].slice('/members/'.length)));
    expect([...rereadIds].filter(id => !allowed.has(id))).toEqual([]);
    expect(steps0).toBeLessThanOrEqual(6);
    for (const m of [...masked, members[2460]]) expect(memberReads(w, m, from).length).toBeGreaterThan(0);
    const limited = batch.find(c => c.route === 'member' && c.status === 429);
    expect(limited).toBeDefined();
    const limitedId = limited!.path.split('?')[0].slice('/members/'.length);
    await w.advance(W + MIN);
    expect(memberReads(w, limitedId).filter(c => c.at >= limited!.at + W - 5 * SEC).length).toBeGreaterThan(0);
    expect(busiestMinute(w, CREATOR_TOKEN)).toBeLessThanOrEqual(80);
    expect(held(w).length).toBe(300);
    expect(w.fake.unexpected).toEqual([]);
  }, 600_000);

  it("W12 (section 2 item 3): the re-read timer a delivery arms inside its op is created outside the op's ledger, while the op's own read runs inside it (fails on a build that arms the re-read timer without outsideLedgers)", async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 } });
    await w.advance(31 * SEC);
    await link(w, 0);
    // Node's timers keep the AsyncLocalStorage context of the setTimeout call, and the faked timers do not, so the row
    // looks at the ledger in scope where each timer is created.
    const inner = globalThis.fetch;
    const reads: boolean[] = [];
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/members/')) reads.push(currentLedger() !== undefined);
      return inner(url, init);
    });
    const realTimeout = globalThis.setTimeout;
    const armed: boolean[] = [];
    vi.stubGlobal('setTimeout', ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (ms === W) armed.push(currentLedger() !== undefined);
      return realTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);
    w.fake.pledge(PU, PTIER.A);
    await w.deliverAll();
    vi.stubGlobal('setTimeout', realTimeout);
    expect([reads.length > 0, reads.every(Boolean), armed.length > 0, armed.some(Boolean)]).toEqual([true, true, true, false]);
    await w.advance(W + MIN);
    expect(tiersAt(w, H)).toEqual([`${PTIER.A}:active`]);
  });

  it("W13 (PT25, THE RE-READ RULE): a delivery whose read fails in a process where start() did not run logs that the hourly check reads the member, and arms no re-read (fails on a build whose log promises a re-read within 10 minutes there)", async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0 } });
    await w.advance(31 * SEC);
    await link(w, 0);
    w.provider.stop();
    const m = w.fake.pledge(PU, PTIER.A);
    w.fake.fail('member', { status: 500 }, 1);
    await w.deliverAll();
    const reads = memberReads(w, m).length;
    await w.advance(W + MIN);
    expect([reads > 0, memberReads(w, m).length - reads]).toEqual([true, 0]);
    expect(w.logs.filter(l => l.startsWith(`${LOG.PT8} ${m.id} ${LOG.PT25_DELIVERY}`))).toEqual([
      `${LOG.PT8} ${m.id} ${LOG.PT25_DELIVERY} (Patreon answered 500); the bot's next hourly check reads it.`,
    ]);
  });
});

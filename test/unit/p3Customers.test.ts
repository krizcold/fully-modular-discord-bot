import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claims 8 to 11 (sheet P3, section 7) and the unit row of `recordedCustomer` (section 8, part 3): one Stripe
// Customer per member, kept in payment-providers/stripe/customers.json and used only on the member route; the race of
// two purchases; the crash and failure states K1 to K4 with their texts ST1 to ST8; the doc's load rule. The real
// PremiumManager in the bot role over the JSON files and over the mirror rig, the real StripeProvider, the fake of
// helpers/p3Stripe.ts. A purchase on the member route is gsub's handler (w.buyMember) or, in a row that holds a write
// open, the op gsub runs called directly (gsub's own settle would wait on the held write).

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});
const h = vi.hoisted(() => ({ confirm: null as null | ((ticket: { path: string }, ms: number, real: (t: any, ms: number) => Promise<string>) => Promise<string>) }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<any>();
  return { ...real, confirmFile: (ticket: any, ms: number) => (h.confirm ? h.confirm(ticket, ms, real.confirmFile) : real.confirmFile(ticket, ms)) };
});

import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { enqueueWrite } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flushAll, readRaw } from '../../src/bot/internalSetup/utils/dataManager';
import { recordedCustomer } from '../../src/bot/internalSetup/utils/payment/stripeCustomers';
import { dataPath } from '../../src/utils/dataRoot';
import { CUSTOMERS_KEY, customersPath, IDS, PRICES, p3World, type P3World } from '../helpers/p3World';

const ST1 = (cause: string) => `Stripe checkout did not start: payment-providers/stripe/customers.json cannot be read (${cause}). Nothing was charged.`;
const ST2 = (words: string) => `Stripe checkout did not start: the bot did not save your Stripe billing account (${words}). Nothing was charged.`;
const ST3 = (reason: string) => `Can't confirm that the bot saved your Stripe billing account (${reason}), so no checkout was started. Nothing was charged; try again in a moment.`;
const ST4 = (message: string) => `Stripe did not create your billing account: ${message}. Nothing was charged.`;
const ST5 = (reason: string) => `Can't confirm whether Stripe created your billing account (${reason}). Nothing was charged; try again in a moment.`;
const ST6 = (message: string) => `Stripe did not start the checkout: ${message}. Nothing was charged.`;
const ST7 = (reason: string) => `Can't confirm whether Stripe started a checkout (${reason}). Nothing is charged until a checkout is paid; try again.`;
const ST8 = 'The Stripe billing account the bot recorded for you no longer exists at Stripe; the bot is removing its record. Try again in a moment to start a new one. Nothing was charged.';
const ELSEWHERE = 'another machine changed your entry in payment-providers/stripe/customers.json at the same time';
const HELD = 'the disk refused the write; the bot keeps trying it';
const LOST = "the database's answer was lost";
const BOUND_DB = 'the database did not confirm it within 8 s';
const BOUND_DISK = 'the disk did not confirm the write within 8 s';
const SL2 = (n: number) => `[StripeProvider] payment-providers/stripe/customers.json holds ${n} ${n === 1 ? 'entry' : 'entries'} this version does not read. They are not used, and the next save of the file writes it without them.`;

const A = IDS[0];
const B = IDS[1];
const C = '81000000000000003';
/** A server per purchase, so no purchase stacks on another. */
let serverSeq = 0;
const server = (): string => `guild:7100000000000${String(++serverSeq).padStart(4, '0')}`;
const LOCK_READ = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs';

const creates = (w: P3World) => w.fake.callsOf('POST', /^\/v1\/customers$/);
const sessionCalls = (w: P3World) => w.fake.callsOf('POST', /^\/v1\/checkout\/sessions$/);
const keyOf = (call: { headers: Record<string, string> }): string | undefined => call.headers['idempotency-key'];
const docOf = (w: P3World): any => {
  const text = w.customersText();
  return text === null ? null : JSON.parse(text);
};

/** The member route's op, called as gsub calls it (premium.initiatePaidSubscription with buyerSignedIn), without gsub's settle. */
async function memberOp(holder: string, buyerId: string, variantId: string = PRICES.gold.monthly): Promise<{ ok: boolean; error?: string; result?: any }> {
  return applySharedOp({
    op: 'premium.initiatePaidSubscription',
    args: { args: [holder, 'gold', 'o-gold', { providerId: 'stripe', variantId, buyerId, autoRenewOptOut: false, buyerSignedIn: true }] },
  }) as any;
}

/** The customer each Checkout Session made since `from` names, in order. */
const sessionCustomers = (w: P3World, from = 0): Array<string | undefined> => sessionCalls(w).slice(from).map(c => c.params.customer);

let logs: string[];
function quiet(): void {
  logs = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
}

/** Rejects every mkdir of the doc's folder with ENOSPC, so a whole write of the doc fails before its temp file. */
function failDocFolder() {
  const dir = path.dirname(customersPath());
  const real = fs.promises.mkdir.bind(fs.promises);
  return vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (d: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
    if (path.resolve(String(d)) === path.resolve(dir)) throw Object.assign(new Error('ENOSPC: stubbed mkdir'), { code: 'ENOSPC' });
    return real(d, o);
  }) as typeof fs.promises.mkdir);
}

const isDoc = (ticket: { path: string }) => path.resolve(ticket.path) === path.resolve(customersPath());

for (const backend of ['json', 'rig'] as const) {
  describe(`on ${backend === 'json' ? 'the JSON files' : 'the mirror rig'}`, () => {
    const w = p3World(backend);
    beforeEach(async () => {
      quiet();
      h.confirm = null;
      await w.setup();
    });
    afterEach(async () => {
      h.confirm = null;
      if (w.rig) w.rig.m.state.rows.fault = undefined;
      await w.teardown();
      vi.restoreAllMocks();
    });

    describe('claim 8: one Customer per member, and none for a dev route', () => {
      it("a member's first purchase sends one create with metadata[discordUserId] and an Idempotency-Key, stores the Customer and names it in the session", async () => {
        const bought = await w.buyMember(server(), A);
        expect(bought.body.success).toBe(true);
        const made = creates(w);
        expect(made).toHaveLength(1);
        expect(made[0].params).toEqual({ 'metadata[discordUserId]': A });
        expect(keyOf(made[0])).toMatch(new RegExp(`^smdb-customer-${A}-[0-9a-f]{16}$`));
        const customerId = [...w.fake.customers.keys()][0];
        expect(docOf(w).customers[A]).toEqual({ customerId, createdAt: expect.any(String) });
        expect(Number.isFinite(Date.parse(docOf(w).customers[A].createdAt))).toBe(true);
        expect(w.fake.sessionParams.get(bought.sessionId!)!.customer).toBe(customerId);
        expect(w.fake.unexpected).toEqual([]);
      });

      it("the same member's purchases for two servers send one create and name one Customer; another member gets another", async () => {
        const first = await w.buyMember(server(), A);
        const second = await w.buyMember(server(), A);
        const other = await w.buyMember(server(), B);
        expect([first.body.success, second.body.success, other.body.success]).toEqual([true, true, true]);
        expect(creates(w).map(c => c.params['metadata[discordUserId]'])).toEqual([A, B]);
        const doc = docOf(w).customers;
        expect(sessionCustomers(w)).toEqual([doc[A].customerId, doc[A].customerId, doc[B].customerId]);
        expect(doc[A].customerId).not.toBe(doc[B].customerId);
      });

      it("a dev route's purchase naming the member as buyer sends no customer and no create, and keeps the doc's bytes", async () => {
        await w.buyMember(server(), A);
        const before = w.customersText();
        const createsBefore = creates(w).length;
        const devServer = await w.buyDev(server(), A);
        const devUser = await w.buyDev(`user:${A}`, A);
        expect([devServer.body.success, devUser.body.success]).toEqual([true, true]);
        expect(creates(w)).toHaveLength(createsBefore);
        expect(w.fake.sessionParams.get(devServer.sessionId!)!.customer).toBeUndefined();
        expect(w.fake.sessionParams.get(devUser.sessionId!)!.customer).toBeUndefined();
        expect(w.customersText()).toBe(before);
      });
    });

    describe('claim 9: the race', () => {
      it('two purchases by one member at once send one create, and both sessions name that Customer', async () => {
        const replies = await Promise.all([memberOp(server(), A), memberOp(server(), A)]);
        await w.settle();
        expect(replies.map(r => r.ok)).toEqual([true, true]);
        expect(creates(w)).toHaveLength(1);
        expect(w.fake.customers.size).toBe(1);
        const id = [...w.fake.customers.keys()][0];
        expect(sessionCustomers(w)).toEqual([id, id]);
        expect(docOf(w).customers[A].customerId).toBe(id);
      });

      it('two members at once send two creates, and the doc holds both entries', async () => {
        const replies = await Promise.all([memberOp(server(), A), memberOp(server(), B)]);
        await w.settle();
        expect(replies.map(r => r.ok)).toEqual([true, true]);
        expect(creates(w)).toHaveLength(2);
        const doc = docOf(w).customers;
        expect(Object.keys(doc).sort()).toEqual([A, B].sort());
        expect(new Set([doc[A].customerId, doc[B].customerId])).toEqual(new Set(w.fake.customers.keys()));
      });
    });

    describe('claim 10: the crash and failure states', () => {
      it('K1: the create never reached Stripe: ST5; the next purchase sends the same key and one Customer exists', async () => {
        w.fake.fail('POST', /^\/v1\/customers$/, { drop: 'before' });
        const first = await w.buyMember(server(), A);
        expect(first.body.error).toContain(ST5('fetch failed'));
        expect(first.sessionId).toBeNull();
        const pending = docOf(w).customers[A];
        expect(pending).toEqual({ pendingKey: expect.stringMatching(new RegExp(`^smdb-customer-${A}-[0-9a-f]{16}$`)), startedAt: expect.any(String) });
        const second = await w.buyMember(server(), A);
        expect(second.body.success).toBe(true);
        expect(creates(w).map(keyOf)).toEqual([pending.pendingKey]);
        expect(w.fake.customers.size).toBe(1);
        expect(docOf(w).customers[A].customerId).toBe([...w.fake.customers.keys()][0]);
      });

      it("K2: Stripe made the Customer and its answer was lost: ST5; the next purchase sends the same key and gets the same id", async () => {
        w.fake.fail('POST', /^\/v1\/customers$/, { drop: 'after' });
        const first = await w.buyMember(server(), A);
        expect(first.body.error).toContain(ST5('fetch failed'));
        expect(w.fake.customers.size).toBe(1);
        const made = [...w.fake.customers.keys()][0];
        const second = await w.buyMember(server(), A);
        expect(second.body.success).toBe(true);
        const keys = creates(w).map(keyOf);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
        expect(w.fake.customers.size).toBe(1);
        expect(docOf(w).customers[A].customerId).toBe(made);
        expect(w.fake.sessionParams.get(second.sessionId!)!.customer).toBe(made);
      });

      it('K4: the Customer stored and the session answered a 4xx: ST6; the next purchase sends no create and names the stored Customer', async () => {
        await w.buyMember(server(), A);
        const stored = docOf(w).customers[A].customerId;
        w.fake.fail('POST', /^\/v1\/checkout\/sessions$/, { status: 400, message: 'Invalid line item.' });
        const refused = await w.buyMember(server(), A);
        expect(refused.body.error).toContain(ST6('Invalid line item'));
        const again = await w.buyMember(server(), A);
        expect(again.body.success).toBe(true);
        expect(creates(w)).toHaveLength(1);
        expect(w.fake.sessionParams.get(again.sessionId!)!.customer).toBe(stored);
      });

      it('the session answered a 5xx, and the session got no answer: ST7 each', async () => {
        w.fake.fail('POST', /^\/v1\/checkout\/sessions$/, { status: 503 });
        const five = await w.buyMember(server(), A);
        w.fake.fail('POST', /^\/v1\/checkout\/sessions$/, { drop: 'before' });
        const none = await w.buyMember(server(), A);
        expect([five.body.error, none.body.error]).toEqual([
          expect.stringContaining(ST7('Stripe answered 503')),
          expect.stringContaining(ST7('fetch failed')),
        ]);
      });

      it('the create answered a 5xx: ST5, the pending entry gone, and the next purchase sends a new key', async () => {
        w.fake.fail('POST', /^\/v1\/customers$/, { status: 500 });
        const first = await w.buyMember(server(), A);
        expect(first.body.error).toContain(ST5('Stripe answered 500'));
        expect(docOf(w).customers[A]).toBeUndefined();
        const second = await w.buyMember(server(), A);
        expect(second.body.success).toBe(true);
        const keys = creates(w).map(keyOf);
        expect(keys).toHaveLength(2);
        expect(keys[1]).not.toBe(keys[0]);
      });

      it('the create answered a 4xx: ST4 with Stripe\'s message; the entry and its key stay for the next purchase', async () => {
        w.fake.fail('POST', /^\/v1\/customers$/, { status: 400, message: 'Invalid metadata.' });
        const first = await w.buyMember(server(), A);
        expect(first.body.error).toContain(ST4('Invalid metadata'));
        const pending = docOf(w).customers[A];
        expect(pending.pendingKey).toBe(keyOf(creates(w)[0]));
        const second = await w.buyMember(server(), A);
        expect(second.body.success).toBe(true);
        expect(creates(w).map(keyOf)).toEqual([pending.pendingKey, pending.pendingKey]);
      });

      it('claim 10: the create answered 409 idempotency_key_in_use: ST5 (an earlier request may still make it); the entry and its key stay', async () => {
        w.fake.fail('POST', /^[/]v1[/]customers$/, { status: 409, code: 'idempotency_key_in_use', message: 'There is currently another in-progress request using this Idempotent Key.' });
        const first = await w.buyMember(server(), A);
        expect(first.body.error).toContain(ST5('Stripe is still answering an earlier request for your billing account: There is currently another in-progress request using this Idempotent Key'));
        const pending = docOf(w).customers[A];
        expect(pending.pendingKey).toBe(keyOf(creates(w)[0]));
        const second = await w.buyMember(server(), A);
        expect(second.body.success).toBe(true);
        expect(creates(w).map(keyOf)).toEqual([pending.pendingKey, pending.pendingKey]);
        expect(w.fake.customers.size).toBe(1);
      });

      it('no STRIPE_SECRET_KEY when the create is due: ST4 with that cause (nothing was sent) and no session', async () => {
        // The operator clears the key while the purchase reads its price, after the provider's configured check.
        const saved = process.env.STRIPE_SECRET_KEY;
        const price = w.fake.hold('GET', /^[/]v1[/]prices[/]/);
        void price.reached.then(() => { delete process.env.STRIPE_SECRET_KEY; price.release(); });
        let reply: Awaited<ReturnType<typeof w.buyMember>>;
        try {
          reply = await w.buyMember(server(), A);
        } finally {
          process.env.STRIPE_SECRET_KEY = saved;
        }
        expect(reply.body.error).toContain(ST4('STRIPE_SECRET_KEY is not set'));
        expect(creates(w)).toEqual([]);
        expect(w.fake.sessionParams.size).toBe(0);
      });

      it('no STRIPE_SECRET_KEY when the session is due, the Customer stored: ST6 with that cause and no session', async () => {
        await w.buyMember(server(), A);
        const sessionsBefore = w.fake.sessionParams.size;
        // The operator clears the key while the purchase reads its price, after the provider's configured check.
        const saved = process.env.STRIPE_SECRET_KEY;
        const price = w.fake.hold('GET', /^[/]v1[/]prices[/]/);
        void price.reached.then(() => { delete process.env.STRIPE_SECRET_KEY; price.release(); });
        let reply: Awaited<ReturnType<typeof w.buyMember>>;
        try {
          reply = await w.buyMember(server(), A);
        } finally {
          process.env.STRIPE_SECRET_KEY = saved;
        }
        expect(reply.body.error).toContain(ST6('STRIPE_SECRET_KEY is not set'));
        expect(w.fake.sessionParams.size).toBe(sessionsBefore);
      });

      it('a pending entry 23 hours and one minute old is replaced by a new key', async () => {
        w.fake.fail('POST', /^\/v1\/customers$/, { drop: 'before' });
        await w.buyMember(server(), A);
        const pending = docOf(w).customers[A];
        // The row moves the stored entry's startedAt back to 23 h 1 min ago.
        const aged = JSON.stringify({ customers: { [A]: { ...pending, startedAt: new Date(Date.now() - (23 * 60 + 1) * 60_000).toISOString() } } }, null, 2);
        if (w.rig) w.rig.m.state.rows.put(CUSTOMERS_KEY, aged);
        else fs.writeFileSync(customersPath(), aged);
        const second = await w.buyMember(server(), A);
        expect(second.body.success).toBe(true);
        const keys = creates(w).map(keyOf);
        expect(keys).toHaveLength(1);
        expect(keys[0]).not.toBe(pending.pendingKey);
      });

      it("a session refused with resource_missing on customer: ST8, the entry removed, and the next purchase makes a new Customer", async () => {
        await w.buyMember(server(), A);
        const old = docOf(w).customers[A].customerId;
        w.fake.deleteObject('customer', old);
        const refused = await w.buyMember(server(), A);
        expect(refused.body.error).toContain(ST8);
        expect(docOf(w).customers[A]).toBeUndefined();
        const again = await w.buyMember(server(), A);
        expect(again.body.success).toBe(true);
        const fresh = docOf(w).customers[A].customerId;
        expect(fresh).not.toBe(old);
        expect(creates(w)).toHaveLength(2);
        expect(w.fake.sessionParams.get(again.sessionId!)!.customer).toBe(fresh);
      });
    });

    describe("claim 11: the doc's load rule", () => {
      it('a purchase of another member keeps the valid entries, leaves out the three bad ones and logs SL2 once per content', async () => {
        await w.buyMember(server(), A);
        const written = docOf(w);
        // The row edits the doc the real writer left: an entry under 'abc', one whose customerId is 'x', one with both
        // shapes' fields missing, and an unknown field on A's valid entry.
        const edited = JSON.stringify({
          customers: {
            ...written.customers,
            [A]: { ...written.customers[A], note: 'kept' },
            abc: { customerId: 'cus_abc', createdAt: written.customers[A].createdAt },
            '81000000000000007': { customerId: 'x', createdAt: written.customers[A].createdAt },
            '81000000000000008': { createdAt: written.customers[A].createdAt },
          },
        }, null, 2);
        const put = () => {
          if (w.rig) w.rig.m.state.rows.put(CUSTOMERS_KEY, edited);
          else fs.writeFileSync(customersPath(), edited);
        };
        put();
        const bought = await w.buyMember(server(), B);
        expect(bought.body.success).toBe(true);
        const after = docOf(w).customers;
        expect(Object.keys(after).sort()).toEqual([A, B].sort());
        expect(after[A]).toEqual({ ...written.customers[A], note: 'kept' });
        expect((w.rig ? w.rig.m.state.lines : logs).filter(l => l === SL2(3))).toHaveLength(1);
        put();
        const third = await w.buyMember(server(), C);
        expect(third.body.success).toBe(true);
        expect((w.rig ? w.rig.m.state.lines : logs).filter(l => l.startsWith('[StripeProvider] payment-providers/stripe/customers.json holds'))).toEqual([SL2(3)]);
      });

      for (const [what, text, cause] of [
        ['not JSON', '{ "customers": ', 'it is not valid JSON'],
        ['an array under customers', JSON.stringify({ customers: [] }), 'its customers field is not an object'],
      ] as const) {
        it(`a doc that is ${what}: ST1, no create and no session, the bytes unchanged`, async () => {
          if (w.rig) w.rig.m.state.rows.put(CUSTOMERS_KEY, text);
          else {
            fs.mkdirSync(path.dirname(customersPath()), { recursive: true });
            fs.writeFileSync(customersPath(), text);
          }
          const refused = await w.buyMember(server(), A);
          expect(refused.body.error).toContain(ST1(cause));
          expect(w.fake.callsOf('POST', /./)).toEqual([]);
          expect(w.customersText()).toBe(text);
        });
      }
    });
  });
}

describe('on the JSON files only', () => {
  const w = p3World('json');
  beforeEach(async () => {
    quiet();
    h.confirm = null;
    await w.setup();
  });
  afterEach(async () => {
    h.confirm = null;
    vi.restoreAllMocks();
    await w.teardown();
  });

  it("recordedCustomer: the stored id, null for no entry and for a pending one, a throw for a doc that cannot be read", async () => {
    await w.buyMember(server(), A);
    w.fake.fail('POST', /^\/v1\/customers$/, { drop: 'before' });
    await w.buyMember(server(), B);
    const answers = [recordedCustomer(A), recordedCustomer(B), recordedCustomer(C)];
    expect(answers).toEqual([docOf(w).customers[A].customerId, null, null]);
    fs.writeFileSync(customersPath(), 'not json');
    let thrown: unknown = null;
    try {
      recordedCustomer(A);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('it is not valid JSON');
  });

  it('the create is not sent while the pending entry\'s write is not confirmed', async () => {
    const seen: number[] = [];
    h.confirm = async (ticket, ms, real) => {
      if (isDoc(ticket)) seen.push(creates(w).length);
      return real(ticket, ms);
    };
    const bought = await w.buyMember(server(), A);
    expect(bought.body.success).toBe(true);
    expect(seen[0]).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("ST3 by the bound: confirmFile answers 'pending' for the pending entry: ST3 and no create", async () => {
    h.confirm = async (ticket, ms, real) => (isDoc(ticket) ? 'pending' : real(ticket, ms));
    const reply = await memberOp(server(), A);
    expect(reply.error).toContain(ST3(BOUND_DISK));
    expect(creates(w)).toEqual([]);
    expect(sessionCalls(w)).toEqual([]);
  });

  it('ST2 at the accept: file writes refused while storage is failing: ST2 and no create', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024);
    for (let i = 0; i < 8; i++) enqueueWrite(dataPath('global', 'p3big', `${i}.json`), big);
    const reply = await memberOp(server(), A);
    expect(reply.error).toContain(ST2('the bot cannot write to its disk right now'));
    expect(creates(w)).toEqual([]);
    await flushAll();
    fs.rmSync(dataPath('global', 'p3big'), { recursive: true, force: true });
  });

  it("K3: the Customer's write held by a disk that refuses it: ST3 and no session; a retry confirms the queued entry, answers ST3 again and makes no session; once the disk takes writes the next purchase stores the same id", async () => {
    const held = w.fake.hold('POST', /^\/v1\/customers$/);
    const state: { fail?: ReturnType<typeof failDocFolder> } = {};
    void held.reached.then(() => { state.fail = failDocFolder(); held.release(); });
    const first = await memberOp(server(), A);
    expect(first.error).toContain(ST3(HELD));
    expect(sessionCalls(w)).toEqual([]);
    const made = [...w.fake.customers.keys()][0];
    const seen: number[] = [];
    h.confirm = async (ticket, ms, real) => {
      if (isDoc(ticket)) seen.push(sessionCalls(w).length + creates(w).length);
      return real(ticket, ms);
    };
    const retry = await memberOp(server(), A);
    expect(retry.error).toContain(ST3(HELD));
    expect(seen).toEqual([1]);
    expect(sessionCalls(w)).toEqual([]);
    expect(creates(w)).toHaveLength(1);
    state.fail!.mockRestore();
    const after = await memberOp(server(), A);
    await w.settle();
    expect(after.ok).toBe(true);
    expect(creates(w)).toHaveLength(1);
    expect(sessionCustomers(w)).toEqual([made]);
    expect(JSON.parse(fs.readFileSync(customersPath(), 'utf8')).customers[A].customerId).toBe(made);
  });

  it("E3: a retry after ST3 reuses the queued pending key and sends no create until that write is confirmed", async () => {
    const fail = failDocFolder();
    const first = await memberOp(server(), A);
    expect(first.error).toContain(ST3(HELD));
    expect(creates(w)).toEqual([]);
    const seen: number[] = [];
    h.confirm = async (ticket, ms, real) => {
      if (isDoc(ticket)) seen.push(w.fake.callsOf('POST', /./).length);
      return real(ticket, ms);
    };
    const retry = await memberOp(server(), A);
    expect(retry.error).toContain(ST3(HELD));
    expect(seen).toEqual([0]);
    expect(creates(w)).toEqual([]);
    const queuedKey = JSON.parse(readRaw(customersPath())!).customers[A].pendingKey;
    fail.mockRestore();
    h.confirm = null;
    const after = await memberOp(server(), A);
    await w.settle();
    expect(after.ok).toBe(true);
    const stored = JSON.parse(fs.readFileSync(customersPath(), 'utf8')).customers[A];
    expect(creates(w)).toHaveLength(1);
    expect(stored.customerId).toBe([...w.fake.customers.keys()][0]);
    expect(creates(w).map(keyOf)).toEqual([queuedKey]);
  });
});

describe('on the mirror rig only', () => {
  const w = p3World('rig');
  beforeEach(async () => {
    quiet();
    await w.setup();
  });
  /** The gates of holdNextBegin, opened after each row so a failed row does not leave a flush waiting. */
  const gates: Array<() => void> = [];
  afterEach(async () => {
    w.rig!.m.state.rows.fault = undefined;
    for (const open of gates.splice(0)) open();
    await w.teardown();
    vi.restoreAllMocks();
  });

  /** Runs fn once, at the first lock read of the doc's key (its op's transaction holds the key's lock then). */
  function atLockRead(fn: () => void): void {
    let done = false;
    w.rig!.m.state.rows.fault = async (sql, params) => {
      if (!done && sql.startsWith(LOCK_READ) && params?.[0] === CUSTOMERS_KEY) {
        done = true;
        fn();
      }
      return undefined;
    };
  }

  /** Holds the next transaction at its BEGIN until released. */
  function holdNextBegin(): () => void {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    gates.push(() => release());
    let taken = false;
    w.rig!.m.state.rows.fault = sql => {
      if (!taken && sql.startsWith('BEGIN')) {
        taken = true;
        return gate.then(() => undefined);
      }
      return undefined;
    };
    return () => {
      w.rig!.m.state.rows.fault = undefined;
      release();
    };
  }

  it("claim 9: another machine stores a pending entry for the same member before this purchase's flush: ST2 and no create or session", async () => {
    atLockRead(() => {
      w.rig!.m.state.rows.put(CUSTOMERS_KEY, JSON.stringify({ customers: { [A]: { pendingKey: `smdb-customer-${A}-0123456789abcdef`, startedAt: new Date().toISOString() } } }, null, 2));
    });
    const reply = await memberOp(server(), A);
    expect(reply.error).toContain(ST2(ELSEWHERE));
    expect(creates(w)).toEqual([]);
    expect(sessionCalls(w)).toEqual([]);
  });

  it("claim 9: another machine stores another member's entry in that window: both purchases succeed and the doc holds both", async () => {
    const other = { id: 'cus_bravo1', object: 'customer', created: 1, metadata: { discordUserId: B } };
    w.fake.customers.set(other.id, other);
    atLockRead(() => {
      w.rig!.m.state.rows.put(CUSTOMERS_KEY, JSON.stringify({ customers: { [B]: { customerId: other.id, createdAt: new Date().toISOString() } } }, null, 2));
    });
    const mine = await w.buyMember(server(), A);
    expect(mine.body.success).toBe(true);
    const theirs = await w.buyMember(server(), B);
    expect(theirs.body.success).toBe(true);
    const doc = docOf(w).customers;
    expect(Object.keys(doc).sort()).toEqual([A, B].sort());
    expect(doc[B].customerId).toBe(other.id);
    expect(creates(w)).toHaveLength(1);
    expect(sessionCustomers(w)).toEqual([doc[A].customerId, other.id]);
  });

  it("K3: the Customer's row op refused: ST2 with no session; the next purchase replays the key and stores the same id", async () => {
    const held = w.fake.hold('POST', /^\/v1\/customers$/);
    void held.reached.then(() => {
      atLockRead(() => {
        const stored = JSON.parse(w.rig!.m.state.rows.docs.get(CUSTOMERS_KEY)!.body.toString('utf8'));
        stored.customers[A] = { ...stored.customers[A], note: 'from BRAVO' };
        w.rig!.m.state.rows.put(CUSTOMERS_KEY, JSON.stringify(stored, null, 2));
      });
      held.release();
    });
    const first = await memberOp(server(), A);
    expect(first.error).toContain(ST2(ELSEWHERE));
    expect(sessionCalls(w)).toEqual([]);
    w.rig!.m.state.rows.fault = undefined;
    await w.settle();
    const made = [...w.fake.customers.keys()][0];
    const second = await w.buyMember(server(), A);
    expect(second.body.success).toBe(true);
    const keys = creates(w).map(keyOf);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(w.fake.customers.size).toBe(1);
    expect(docOf(w).customers[A]).toMatchObject({ customerId: made });
    expect(sessionCustomers(w)).toEqual([made]);
  });

  it("K3: the Customer's row op held open: ST3 after 8 s and no session; once it lands the next purchase sends no create", async () => {
    const held = w.fake.hold('POST', /^\/v1\/customers$/);
    const state: { release?: () => void } = {};
    void held.reached.then(() => { state.release = holdNextBegin(); held.release(); });
    const started = performance.now();
    const first = await memberOp(server(), A);
    expect(performance.now() - started).toBeGreaterThanOrEqual(7900);
    expect(first.error).toContain(ST3(BOUND_DB));
    expect(sessionCalls(w)).toEqual([]);
    state.release!();
    await w.settle();
    const made = [...w.fake.customers.keys()][0];
    const second = await w.buyMember(server(), A);
    expect(second.body.success).toBe(true);
    expect(creates(w)).toHaveLength(1);
    expect(sessionCustomers(w)).toEqual([made]);
  }, 30_000);

  it("ST3 by the bound: the pending entry's row op held open past 8 s: ST3 and no create", async () => {
    const release = holdNextBegin();
    const started = performance.now();
    const reply = await memberOp(server(), A);
    expect(performance.now() - started).toBeGreaterThanOrEqual(7900);
    expect(reply.error).toContain(ST3(BOUND_DB));
    expect(creates(w)).toEqual([]);
    release();
  }, 30_000);

  it("ST3 when the database's answer was lost: the pending entry's commit answer lost: ST3 and no create", async () => {
    let done = false;
    w.rig!.m.state.rows.fault = sql => {
      if (!done && sql === 'COMMIT') {
        done = true;
        return 'lose';
      }
      return undefined;
    };
    const { unconfirmUnansweredRows } = await import('../../src/bot/internalSetup/utils/sharedStore');
    const replying = memberOp(server(), A);
    await vi.waitFor(() => expect(w.rig!.m.state.rows.docs.has(CUSTOMERS_KEY)).toBe(true));
    unconfirmUnansweredRows('the test ended it');
    const reply = await replying;
    expect(reply.error).toContain(ST3(LOST));
    expect(creates(w)).toEqual([]);
  });

  it('E3: a retry after ST3 reuses the held key and sends no create until its op is confirmed; once it lands the same key goes out', async () => {
    const release = holdNextBegin();
    const first = await memberOp(server(), A);
    expect(first.error).toContain(ST3(BOUND_DB));
    const retry = await memberOp(server(), A);
    expect(retry.error).toContain(ST3(BOUND_DB));
    expect(creates(w)).toEqual([]);
    release();
    await w.settle();
    const stored = docOf(w).customers[A];
    const after = await w.buyMember(server(), A);
    expect(after.body.success).toBe(true);
    expect(creates(w).map(keyOf)).toEqual([stored.pendingKey]);
  }, 40_000);
});

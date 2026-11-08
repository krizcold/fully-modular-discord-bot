import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { unconfirmUnansweredRows } from '../../src/bot/internalSetup/utils/sharedStore';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';
import { AUDIT_KEY, JOURNAL_KEY, PREMIUM_KEY, premiumRig, tier } from '../helpers/nb6PremiumRig';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { openItemsOf } from '../../src/bot/internalSetup/utils/premiumItems';
import { startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';

// NB6 test 56 (wip-redesign/sheets/NB6.md decisions 47, 48, 63, 64, 73 and 75; rows 86 to 88, 183, 186 to 189, 192,
// 193, 195, 196, 228, 232, 237 and 238; part 11, without the Dummy provider's clauses, which are part 12's): premium's
// audit lines, notices and events ride the op of the save that stores their change. The real PremiumManager in the bot
// process role, the real row flush over the scripted shared tables.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as string[], unreachable: new Set<string>() }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    if (notices.unreachable.has(guildId)) return { delivered: false, cause: 'guild not reachable' };
    notices.sent.push(`${kind}:${guildId}`);
    return { delivered: true, via: 'dm' };
  },
}));
const inject = vi.hoisted(() => ({ refuse: null as null | { cause: string; thrown: boolean } }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      if (f === 'premium-tiers.json' && inject.refuse) {
        if (inject.refuse.thrown) throw new real.DataBackendUnavailableError(inject.refuse.cause as any);
        return { outcome: 'refused', cause: inject.refuse.cause };
      }
      return real.saveDataTracked(f, o, d);
    },
  };
});

const r = premiumRig();
const T16a = (kind: string, guild: string, words: string) => `[PremiumManager] The ${kind} notice for guild ${guild} was not sent: the change it announces was not saved (${words})`;
const ELSEWHERE = 'another machine changed premium-tiers.json (or the Dummy state) at the same time';

/** Holds every transaction at its BEGIN until released. */
function hold(): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  r.m.state.rows.fault = sql => (sql.startsWith('BEGIN') ? gate.then(() => undefined) : undefined);
  return () => {
    r.m.state.rows.fault = undefined;
    release();
  };
}

/** The SQL of the transaction that sent a statement matching `match`, from its BEGIN to its COMMIT. */
function txWith(match: (sql: string, params: unknown[] | undefined) => boolean): string[] {
  const sent = r.m.state.pg.sent;
  const at = sent.findIndex(s => match(s.sql, s.params));
  expect(at).toBeGreaterThanOrEqual(0);
  const client = sent[at].client;
  let begin = at;
  while (begin > 0 && !(sent[begin].client === client && sent[begin].sql.startsWith('BEGIN'))) begin--;
  let end = at;
  while (end < sent.length - 1 && !(sent[end].client === client && sent[end].sql === 'COMMIT')) end++;
  return sent.slice(begin, end + 1).filter(s => s.client === client).map(s => s.sql);
}

const isLineOf = (action: string) => (sql: string, params: unknown[] | undefined) =>
  sql.startsWith('INSERT INTO smdb_data.shared_lines') && String(params?.[0]) === AUDIT_KEY && JSON.parse(Buffer.from(params![2] as Buffer).toString('utf8')).action === action;

beforeEach(async () => {
  await r.setup();
  notices.sent.length = 0;
  notices.unreachable.clear();
  inject.refuse = null;
});
afterEach(async () => {
  inject.refuse = null;
  await r.teardown();
});

describe('the op of the save carries the items (183, 186, 228)', () => {
  it('the audit line is inserted in the transaction of the save that stores its change; the notice goes out once it landed', async () => {
    const pm = r.pm();
    expect(pm.setTier('low', tier('Low', 1))).toBe(true);
    await r.settle();
    const release = hold();
    expect(await pm.grantManual('g1', 'low', 30)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(notices.sent).toEqual([]);
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create']);
    release();
    await r.settle();
    await vi.waitFor(() => expect(notices.sent).toEqual(['manual.grant.added:g1']));
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']);
    const tx = txWith(isLineOf('subscription.grant.manual'));
    expect(tx.some(sql => sql.startsWith('INSERT INTO smdb_data.shared_docs'))).toBe(true);
    expect(tx[tx.length - 1]).toBe('COMMIT');
    expect(r.row().subscriptions.g1.active.tierId).toBe('low');
  });
});

describe('a refused carrier (87, 187)', () => {
  it('another machine changed the row: the notice is dropped with T16 (a), the line is stored marked, the cache dropped', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    const release = hold();
    await pm.grantManual('g1', 'low', 30);
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify({ tiers: { other: tier('Other', 2) } }, null, 2));
    release();
    await r.settle();
    await vi.waitFor(() => expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']));
    await r.settle();
    const marked = r.lines(AUDIT_KEY)[1];
    expect(marked.metadata.notSaved.cause).toBe('changed-elsewhere');
    expect(typeof marked.metadata.notSaved.at).toBe('string');
    expect(notices.sent).toEqual([]);
    expect(r.logged(T16a('manual.grant.added', 'g1', ELSEWHERE))).toHaveLength(1);
    // Decision 13: the next use loads the stored version.
    // The pass takes the stored version (decision 6: this machine now holds that version).
    await runSharedPass();
    expect(Object.keys(pm.getAllTiers()).sort()).toEqual(['free', 'other']);
  });
});

describe("an 'unconfirmed' carrier (188)", () => {
  it('the notice is dropped with T16 (b); the marked copy keeps the line once, as the original landed', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    r.m.state.rows.fault = sql => (sql === 'COMMIT' ? 'lose' : undefined);
    await pm.grantManual('g1', 'low', 30);
    await vi.waitFor(() => expect(r.lines(AUDIT_KEY)).toHaveLength(2));
    r.m.state.rows.fault = undefined;
    unconfirmUnansweredRows('the test ended it');
    await r.settle();
    await vi.waitFor(() => expect(r.logged("was not sent: can't confirm that the change it announces was saved (the database's answer was lost)")).toHaveLength(1));
    await r.settle();
    const lines = r.lines(AUDIT_KEY);
    expect(lines.map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']);
    expect(lines[1].metadata?.notSaved).toBeUndefined();
    expect(notices.sent).toEqual([]);
  });
});

describe('a no-change write (189)', () => {
  it('writes no doc row and sends no notification; its line and op id are stored', async () => {
    const pm = r.pm();
    pm.setMessages({});
    await r.settle();
    const docsBefore = r.m.state.rows.history.length;
    r.m.state.rows.notices.length = 0;
    const opsBefore = r.m.state.rows.ops.size;
    expect(pm.setMessages({})).toBe(true);
    await r.settle();
    expect(r.m.state.rows.history.length).toBe(docsBefore);
    expect(r.m.state.rows.notices).toEqual([]);
    expect(r.m.state.rows.ops.size).toBe(opsBefore + 1);
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['message.update', 'message.update']);
  });
});

describe('a save refused at the accept', () => {
  it('192, 233: a cause the retry takes again: the items wait; the retried save carries them', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    inject.refuse = { cause: 'database-backlog', thrown: true };
    expect(await pm.grantManual('g1', 'low', 30)).toBe(true);
    await r.settle();
    expect(notices.sent).toEqual([]);
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create']);
    inject.refuse = null;
    (pm as any).retryPass();
    await r.settle();
    await vi.waitFor(() => expect(notices.sent).toEqual(['manual.grant.added:g1']));
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']);
    expect(r.row().subscriptions.g1.active.tierId).toBe('low');
  });

  it('193: a cause never retried: save() answers null, the notice is dropped with T16 (a), the line is stored marked', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    inject.refuse = { cause: 'unstorable', thrown: false };
    await pm.grantManual('g1', 'low', 30);
    await r.settle();
    await vi.waitFor(() => expect(r.lines(AUDIT_KEY)).toHaveLength(2));
    expect(r.lines(AUDIT_KEY)[1].metadata.notSaved.cause).toBe('unstorable');
    expect(r.logged(T16a('manual.grant.added', 'g1', 'unstorable'))).toHaveLength(1);
    expect(notices.sent).toEqual([]);
  });
});

describe('standalone items (232)', () => {
  it('a renewal failure changes nothing stored: its notice goes out at once, with no save', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await pm.grantManual('g1', 'low', 30);
    await r.settle();
    const sub = r.row().subscriptions.g1.active;
    const config = r.row();
    config.subscriptions.g1.active = { ...sub, source: 'paid', providerId: 'nb6p', providerSubId: 'ps1' };
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    await runSharedPass();
    const historyBefore = r.m.state.rows.history.length;
    notices.sent.length = 0;
    await runSealed('console', null, null, async () => {
      getPaymentRegistry().emitEvent({ type: 'subscription.renewal-failed', providerId: 'nb6p', providerSubId: 'ps1', guildId: 'g1', reason: 'card declined' } as any);
    });
    await vi.waitFor(() => expect(notices.sent).toEqual(['paid.sub.renewal-failed:g1']));
    await r.settle();
    expect(r.m.state.rows.history.length).toBe(historyBefore);
  });
});

describe('the stop (237, 238, 196)', () => {
  it('237: the op lands in the drain after the stop: the line is stored, the notice is not sent', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    const release = hold();
    await pm.grantManual('g1', 'low', 30);
    pm.markStopped('stopping');
    release();
    await r.settle();
    await vi.waitFor(() => expect(r.logged('The manual.grant.added notice for guild g1 was not sent: the bot is stopping')).toHaveLength(1));
    expect(notices.sent).toEqual([]);
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']);
  });

  it('238: the op is refused after the stop: no marked line; the line is logged as lost, the notice with T16 (a)', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    const release = hold();
    await pm.grantManual('g1', 'low', 30);
    pm.markStopped('stopping');
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify({ tiers: {} }, null, 2));
    release();
    await r.settle();
    await vi.waitFor(() => expect(r.logged(T16a('manual.grant.added', 'g1', ELSEWHERE))).toHaveLength(1));
    await r.settle();
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create']);
    expect(r.logged('The audit line subscription.grant.manual (guild g1, ')).toHaveLength(1);
    expect(r.logged('was not written: the bot is stopping; it is lost')).toHaveLength(1);
  });

  it('196: items whose op is still open at the exit are logged as lost', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    const release = hold();
    await pm.grantManual('g1', 'low', 30);
    pm.logLossesAtExit();
    expect(r.logged('The manual.grant.added notice for guild g1 was not sent: the bot is stopping')).toHaveLength(1);
    expect(r.logged('was not written: the bot is stopping; it is lost')).toHaveLength(1);
    release();
    await r.settle();
  });
});

describe('a JSON bot (195, 246)', () => {
  beforeEach(() => {
    setBackendKind('file');
  });

  it('195: the links change only the timing: the line is appended and the notice sent at the save', async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await pm.grantManual('g1', 'low', 30);
    await r.settle();
    await vi.waitFor(() => expect(notices.sent).toEqual(['manual.grant.added:g1']));
    const audit = fs.readFileSync(dataPath('global', 'premium-tiers.audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).action);
    expect(audit).toEqual(['tier.create', 'subscription.grant.manual']);
  });

  it("246: a refused save drops each item with decision 27's line text and T16 (a)", async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    inject.refuse = { cause: 'unstorable', thrown: false };
    await pm.grantManual('g1', 'low', 30);
    await r.settle();
    expect(r.logged('The audit line subscription.grant.manual (guild g1, ')).toHaveLength(1);
    expect(r.logged('was not written: the change it records was not saved (unstorable)')).toHaveLength(1);
    expect(r.logged(T16a('manual.grant.added', 'g1', 'unstorable'))).toHaveLength(1);
    expect(notices.sent).toEqual([]);
  });
});

// Part 11b: rows 88, 235, 241, 284 and 285, and the property.

const LOCK_READ = 'SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs';

/** A stored premium-tiers.json holding guild g1's paid sub ps1 of provider nb6p, taken by this machine's pass. */
async function paidSubStored(): Promise<void> {
  const pm = r.pm();
  pm.setTier('low', tier('Low', 1));
  await pm.grantManual('g1', 'low', 30);
  await r.settle();
  const config = r.row();
  config.subscriptions.g1.active = { ...config.subscriptions.g1.active, source: 'paid', providerId: 'nb6p', providerSubId: 'ps1' };
  r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
  await runSharedPass();
  notices.sent.length = 0;
}

/** Another machine's version of premium-tiers.json, stored as each of the next `times` saves reads the row under its lock. */
function otherMachineWrites(times: number): () => number {
  let left = times;
  r.m.state.rows.fault = sql => {
    if (left > 0 && sql.startsWith(LOCK_READ)) {
      left -= 1;
      const config = r.row();
      config.messages = { ...(config.messages ?? {}), moduleBlocked: `from BRAVO ${times - left}` };
      r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    }
    return undefined;
  };
  return () => times - left;
}

const pausedEvent = () => ({ type: 'subscription.paused', providerId: 'nb6p', providerSubId: 'ps1', guildId: 'g1', resumesAt: '2027-01-01T00:00:00.000Z' });

describe('row 88: a gateway event whose save another machine refused is handed again', () => {
  it('refused once: the stored version is read, the event handed again, and its change lands on that version', async () => {
    await paidSubStored();
    const writes = otherMachineWrites(1);
    getPaymentRegistry().emitEvent(pausedEvent() as any);
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.row().subscriptions.g1.active.resumesAtHint).toBe('2027-01-01T00:00:00.000Z');
    }, { timeout: 5000 });
    expect(writes()).toBe(1);
    expect(r.row().messages.moduleBlocked).toBe('from BRAVO 1');
    expect(r.logged('could not be applied')).toEqual([]);
  });

  it("refused three times: no fourth hand; decision 27's lost line", async () => {
    await paidSubStored();
    const writes = otherMachineWrites(10);
    getPaymentRegistry().emitEvent(pausedEvent() as any);
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.logged('[PremiumManager] A subscription.paused event from nb6p (subscription ps1, guild g1) could not be applied: premium-tiers.json kept changing on other machines (3 tries); it is lost: {')).toHaveLength(1);
    }, { timeout: 5000 });
    await r.settle();
    expect(writes()).toBe(3);
    expect(r.row().subscriptions.g1.active.resumesAtHint).toBeUndefined();
  });
});

describe('row 235: an item still open after 8 s in the bot', () => {
  it("the op answers that it can't confirm; the notice goes out later, once its op landed", async () => {
    const pm = r.pm();
    pm.setTier('low', tier('Low', 1));
    await r.settle();
    const release = hold();
    const started = Date.now();
    const reply: any = await applySharedOp({ op: 'premium.grantManual', args: { args: ['g1', 'low', 30] } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'pending' });
    expect(reply.error).toContain(truthText('pending', false));
    expect(notices.sent).toEqual([]);
    release();
    await r.settle();
    await vi.waitFor(() => expect(notices.sent).toEqual(['manual.grant.added:g1']));
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']);
    expect(openItemsOf(pm)).toEqual([]);
  }, 30_000);
});

describe('row 241: a dropped notice marks nothing', () => {
  async function migrationReady(): Promise<void> {
    const link = (variantId: string) => ({
      providerId: 'nb6m', enabled: true, mode: 'price',
      cache: { syncedAt: '2026-01-01T00:00:00Z', variants: [{ variantId, label: variantId }] },
    });
    getPaymentRegistry().register({
      id: 'nb6m', displayName: 'NB6M', capabilities: { supportsPriceMigration: true }, isConfigured: () => true,
      migrateSubscriptionPrice: async () => undefined,
    } as any);
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify({
      tiers: {
        a: { displayName: 'A', priority: 1, overrides: {}, offerings: [{ id: 'o1', providerLinks: [link('v1')] }] },
        b: { displayName: 'B', priority: 2, overrides: {}, offerings: [{ id: 'o2', providerLinks: [link('v2')] }] },
      },
      subscriptions: { g1: { active: { id: 's1', source: 'paid', providerId: 'nb6m', providerSubId: 'ms1', variantId: 'v1', tierId: 'a', offeringId: 'o1', status: 'active', startDate: new Date().toISOString(), endDate: null, autoRenew: true }, paused: [] } },
      migrations: [],
      migrationSilencePolicy: 'continue',
    }, null, 2));
    await runSharedPass();
  }
  const schedule = () => r.pm().scheduleMigration({
    providerId: 'nb6m', sourceTierId: 'a', sourceOfferingId: 'o1', sourceVariantId: 'v1',
    targetTierId: 'b', targetOfferingId: 'o2', targetVariantId: 'v2',
    effectiveDate: new Date(Date.now() + 86_400_000).toISOString(), message: '',
  });

  it('the op landed and the DM was not delivered: the outcome names the cause; the decision stays unmarked', async () => {
    await migrationReady();
    notices.unreachable.add('g1');
    await schedule();
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.logged('request not delivered to guild g1: guild not reachable')).toHaveLength(1);
    }, { timeout: 5000 });
    await r.settle();
    expect(r.row().migrations[0].decisions[0].notifiedAt).toBeUndefined();
    expect(r.pm().getFullConfig().migrations[0].decisions[0].notifiedAt).toBeUndefined();
  });

  it('the op was refused: the outcome names the refusal; nothing is marked', async () => {
    await migrationReady();
    otherMachineWrites(1);
    await schedule();
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.logged(`request not delivered to guild g1: the change it announces was not saved (${ELSEWHERE})`)).toHaveLength(1);
    }, { timeout: 5000 });
    await r.settle();
    expect(notices.sent).toEqual([]);
    expect(r.row().migrations ?? []).toEqual([]);
  });

  it('the op landed and the DM went out: the decision is marked notified (guard)', async () => {
    await migrationReady();
    await schedule();
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.row().migrations[0].decisions[0].notifiedAt).toEqual(expect.any(String));
    }, { timeout: 5000 });
  });
});

const expiredLine = (writer: string, n: number) => JSON.stringify({
  writer, node: 'node-alfa', nodeName: 'ALFA', n,
  event: { type: 'subscription.expired', providerId: 'nb6p', providerSubId: 'ps1', guildId: 'g1', state: { status: 'expired', startDate: '2026-01-01T00:00:00.000Z', endDate: new Date(Date.now() - 1000).toISOString(), autoRenew: false } },
});

describe('rows 284 and 285: the replay of a stopped writer', () => {
  it("284: a replayed event's line rides the replay's marks save; its notice goes out once that op landed", async () => {
    await paidSubStored();
    startPremiumTickers();
    r.pm().getAllTiers();
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', expiredLine('p-dead', 1));
    await runSharedPass();
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.row().eventsApplied).toEqual({ 'p-dead': 1 });
    }, { timeout: 5000 });
    await vi.waitFor(() => expect(notices.sent).toEqual(['paid.sub.expired:g1']));
    expect(r.row().subscriptions.g1?.active).toBeUndefined();
    const tx = txWith(isLineOf('subscription.expire.paid'));
    expect(tx.some(sql => sql.startsWith('INSERT INTO smdb_data.shared_docs'))).toBe(true);
    expect(tx[tx.length - 1]).toBe('COMMIT');
    expect(r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.expire.paid')).toHaveLength(1);
  });

  it('285: a replay the stop ends drops its items with no log; the journal keeps the line; the exit line says so', async () => {
    await paidSubStored();
    startPremiumTickers();
    const pm = r.pm();
    pm.getAllTiers();
    let calls = 0;
    const real = pm.settled.bind(pm);
    vi.spyOn(pm, 'settled').mockImplementation(async (ledger: any) => {
      calls += 1;
      if (calls === 1) pm.markStopped('stopping');
      return real(ledger);
    });
    r.m.state.rows.putLine(JOURNAL_KEY, 'j1', expiredLine('p-dead', 1));
    await runSharedPass();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    await r.settle();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(r.logged('was not written')).toEqual([]);
    expect(r.logged('notice for guild g1 was not sent')).toEqual([]);
    expect(notices.sent).toEqual([]);
    expect(r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.expire.paid')).toEqual([]);
    expect(r.lines(JOURNAL_KEY)).toHaveLength(1);
    expect(r.row().eventsApplied).toBeUndefined();
    pm.logLossesAtExit();
    expect(r.logged('[PremiumManager] The stop came before the kept provider events were saved; they stay in premium-tiers.events.jsonl, and the next normal start of the bot applies them')).toHaveLength(1);
    expect(openItemsOf(pm)).toEqual([]);
  });
});

/**
 * Test 56's property (sheet 2881 as 3459 amends it; the Dummy clause is part 12's): for any sequence of saves landed,
 * held, refused at the accept, refused at the flush by another machine's write, or 'unconfirmed', with a stop at any
 * point, every notice goes out exactly when the op that stores its change landed before the stop; every audit line is
 * stored once, plain when that op stored it and marked when it did not, with no marked line written after the stop;
 * and no item stays open.
 */
describe("test 56's property", () => {
  type Fate = 'landed' | 'held' | 'refused-accept' | 'refused-flush' | 'unconfirmed';
  const FATES: Fate[] = ['landed', 'held', 'refused-accept', 'refused-flush', 'unconfirmed'];
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** One grant with its fate; `stop` stops the manager while its op is on the wire (fates landed and refused-flush). */
  async function grant(guild: string, fate: Fate, stop: boolean): Promise<void> {
    const pm = r.pm();
    let gate: Promise<void> | null = null;
    let open!: () => void;
    if (stop) gate = new Promise<void>(resolve => { open = resolve; });
    let pending = fate === 'unconfirmed' || fate === 'refused-flush';
    r.m.state.rows.fault = sql => {
      if (gate && sql.startsWith('BEGIN')) return gate.then(() => undefined);
      if (pending && fate === 'unconfirmed' && sql === 'COMMIT') {
        pending = false;
        return 'lose';
      }
      if (pending && fate === 'refused-flush' && sql.startsWith(LOCK_READ)) {
        pending = false;
        const config = r.row();
        r.m.state.rows.put(PREMIUM_KEY, JSON.stringify({ ...config, messages: { moduleBlocked: `BRAVO before ${guild}` } }, null, 2));
      }
      return undefined;
    };
    if (fate === 'refused-accept') inject.refuse = { cause: 'unstorable', thrown: false };
    if (fate === 'held') inject.refuse = { cause: 'database-backlog', thrown: true };
    await pm.grantManual(guild, 'low', 30);
    inject.refuse = null;
    if (stop) {
      pm.markStopped('stopping');
      gate = null;
      open();
    }
    if (fate === 'unconfirmed') {
      // The COMMIT's answer is lost; the op ends 'unconfirmed' before the landing check runs (as row 188).
      await vi.waitFor(() => expect(r.lines(AUDIT_KEY).some(l => l.guildId === guild)).toBe(true));
      unconfirmUnansweredRows('the test ended it');
    }
    await r.settle();
    if (fate === 'held') {
      (pm as any).retryPass();
      await r.settle();
    }
    r.m.state.rows.fault = undefined;
    await new Promise(resolve => setTimeout(resolve, 10));
    await r.settle();
    if (fate === 'refused-flush') await runSharedPass();
  }

  it('holds for 12 seeded sequences of up to 4 grants', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const next = rng(seed);
      const count = 1 + Math.floor(next() * 4);
      const plan = Array.from({ length: count }, (_, i) => ({ guild: `g${i + 1}`, fate: FATES[Math.floor(next() * FATES.length)] }));
      const stopAt = next() < 0.5 ? Math.floor(next() * count) : -1;
      if (stopAt >= 0 && plan[stopAt].fate !== 'landed' && plan[stopAt].fate !== 'refused-flush') plan[stopAt].fate = next() < 0.5 ? 'landed' : 'refused-flush';
      const label = `seed ${seed}: ${plan.map(p => p.fate).join(', ')}; stop at ${stopAt}`;
      if (seed > 1) {
        await r.teardown();
        await r.setup();
        notices.sent.length = 0;
      }
      const pm = r.pm();
      pm.setTier('low', tier('Low', 1));
      await r.settle();
      let stoppedAt: string | null = null;
      for (let i = 0; i < count; i++) {
        if (stopAt >= 0 && i > stopAt) break;
        await grant(plan[i].guild, plan[i].fate, i === stopAt);
        if (i === stopAt) stoppedAt = new Date().toISOString();
      }
      await r.settle();
      const lines = r.lines(AUDIT_KEY).filter(l => l.action === 'subscription.grant.manual');
      for (let i = 0; i < count; i++) {
        const { guild, fate } = plan[i];
        const mine = lines.filter(l => l.guildId === guild);
        const sent = notices.sent.filter(n => n === `manual.grant.added:${guild}`);
        if (stopAt >= 0 && i > stopAt) {
          expect(mine, label).toEqual([]);
          expect(sent, label).toEqual([]);
          continue;
        }
        if (i === stopAt) {
          expect(sent, label).toEqual([]);
          expect(mine.map(l => l.metadata?.notSaved ?? 'plain'), label).toEqual(fate === 'landed' ? ['plain'] : []);
          continue;
        }
        const plain = fate === 'landed' || fate === 'held' || fate === 'unconfirmed';
        expect(mine, label).toHaveLength(1);
        expect(mine[0].metadata?.notSaved?.cause, label).toBe(plain ? undefined : fate === 'refused-accept' ? 'unstorable' : 'changed-elsewhere');
        expect(sent, label).toEqual(fate === 'landed' || fate === 'held' ? [`manual.grant.added:${guild}`] : []);
      }
      if (stoppedAt) expect(lines.filter(l => l.metadata?.notSaved && l.metadata.notSaved.at > stoppedAt!), label).toEqual([]);
      expect(openItemsOf(pm), label).toEqual([]);
    }
  }, 60_000);
});

/**
 * Test 56's property, the Dummy clause (sheet 3459; part 12): for seeded sequences of premium's cancels and
 * reactivations through the Dummy provider whose ops land, are refused at the flush by another machine's write or end
 * 'unconfirmed', each Dummy method resolves only after its op landed, and premium makes no item for its change before.
 */
describe("test 56's property, the Dummy clause", () => {
  type Fate = 'landed' | 'refused-flush' | 'unconfirmed';
  const FATES: Fate[] = ['landed', 'refused-flush', 'unconfirmed'];
  const rng = (seed: number) => () => {
    seed = (seed + 0x9e3779b9) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const DUMMY_KEY = 'global/payment-providers/dummy/state.json';
  const gold = {
    displayName: 'Gold', priority: 2, overrides: {},
    offerings: [{ id: 'o1', label: 'Gold', providerLinks: [{ providerId: 'dummy', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] }, cache: { syncedAt: '2026-01-01T00:00:00.000Z', variants: [{ variantId: 'dummy_monthly_999', label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true }] } }] }],
  };
  const stored = () => JSON.parse(r.m.state.rows.docs.get(DUMMY_KEY)!.body.toString('utf8')).subscriptions.dummy_1;

  it('holds for 8 seeded sequences of up to 4 calls', async () => {
    const { DummyProvider } = await import('../../src/bot/internalSetup/utils/payment/dummyProvider');
    for (let seed = 1; seed <= 8; seed++) {
      if (seed > 1) {
        await r.teardown();
        await r.setup();
        notices.sent.length = 0;
      }
      const dummy = new DummyProvider();
      getPaymentRegistry().register(dummy);
      try {
        const pm = r.pm();
        pm.setTier('gold', gold as any);
        pm.setProviderActivation('dummy', true);
        await pm.initiatePaidSubscription('g1', 'gold', 'o1', { providerId: 'dummy', variantId: 'dummy_monthly_999' });
        await r.settle();
        const next = rng(seed);
        const count = 1 + Math.floor(next() * 4);
        for (let i = 0; i < count; i++) {
          const fate = FATES[Math.floor(next() * FATES.length)];
          await r.settle();
          const cancel = pm.getSubscriptions('g1').active!.autoRenew;
          const action = cancel ? 'subscription.cancel.paid' : 'subscription.reactivate.paid';
          const label = `seed ${seed}, call ${i}: ${action} ${fate}`;
          const linesBefore = r.lines(AUDIT_KEY).filter(l => l.action === action).length;
          let dummyClient: number | null = null;
          let atCommit: { items: number; lines: number } | null = null;
          let landedAt: number | null = null;
          r.m.state.rows.fault = (sql, params, client) => {
            if (sql.startsWith(LOCK_READ) && params?.[0] === DUMMY_KEY && dummyClient === null) {
              dummyClient = client;
              if (fate === 'refused-flush') {
                const state = JSON.parse(r.m.state.rows.docs.get(DUMMY_KEY)!.body.toString('utf8'));
                state.nextId += 1;
                r.m.state.rows.put(DUMMY_KEY, JSON.stringify(state, null, 2));
              }
            }
            if (client === dummyClient && sql === 'COMMIT') {
              atCommit = { items: openItemsOf(pm).length, lines: r.lines(AUDIT_KEY).filter(l => l.action === action).length };
              dummyClient = -1;
              if (fate === 'unconfirmed') return 'lose';
              landedAt = Date.now();
            }
            return undefined;
          };
          const call = (cancel ? pm.cancelPaidSubscription('g1') : pm.reactivatePaidSubscription('g1')).then(
            ok => ({ ok, at: Date.now(), autoRenew: stored().autoRenew }),
            error => ({ error, at: Date.now() }),
          );
          if (fate === 'unconfirmed') {
            await vi.waitFor(() => expect(atCommit, label).not.toBeNull());
            unconfirmUnansweredRows('the test ended it');
          }
          const outcome: any = await call;
          r.m.state.rows.fault = undefined;
          await r.settle();
          if (fate !== 'refused-flush') expect(atCommit, label).toEqual({ items: 0, lines: linesBefore });
          const lines = r.lines(AUDIT_KEY).filter(l => l.action === action).length;
          if (fate === 'landed') {
            expect(outcome.ok, label).toBe(true);
            expect(outcome.at, label).toBeGreaterThanOrEqual(landedAt!);
            expect(outcome.autoRenew, label).toBe(!cancel);
            expect(lines, label).toBe(linesBefore + 1);
          } else {
            expect(outcome.error?.message, label).toContain(fate === 'unconfirmed' ? "Can't confirm that the Dummy provider saved this change" : 'The Dummy provider did not save this change');
            expect(lines, label).toBe(linesBefore);
            if (fate === 'refused-flush') await runSharedPass();
            if (fate === 'unconfirmed') {
              // The commit landed at the provider; premium's copy stays as it was until the tick writes the record back.
              const state = JSON.parse(r.m.state.rows.docs.get(DUMMY_KEY)!.body.toString('utf8'));
              state.subscriptions.dummy_1.autoRenew = cancel;
              r.m.state.rows.put(DUMMY_KEY, JSON.stringify(state, null, 2));
              await runSharedPass();
            }
          }
          expect(openItemsOf(pm), label).toEqual([]);
        }
      } finally {
        dummy.dispose();
        getPaymentRegistry().unregister('dummy');
      }
    }
  }, 60_000);
});

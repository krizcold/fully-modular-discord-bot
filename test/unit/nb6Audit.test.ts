import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { markPaymentLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { lost } from '../helpers/sharedRows';
import { AUDIT_KEY, PREMIUM_KEY, premiumRig, tier } from '../helpers/nb6PremiumRig';

// NB6 test 14 (wip-redesign/sheets/NB6.md decisions 8, 41 and 48; rows 121 and 194): on a Postgres bot premium's
// audit log is the audit key's lines. readAuditEntries reads them in seq order with today's filters (marked lines
// shown as they are); fillInstallLines reads them for a webhook's redelivery and skips marked lines; a JSON bot reads
// the file as today.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

const r = premiumRig();
const LINES = 'SELECT id, line FROM smdb_data.shared_lines WHERE key = $1 ORDER BY seq';
const entry = (i: number, action: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: `2026-11-07T10:00:0${i}.000Z`, actor: 'admin', action, guildId: `g${i}`, ...extra });

beforeEach(async () => {
  await r.setup();
});
afterEach(async () => {
  await r.teardown();
});

describe('readAuditEntries on a Postgres bot', () => {
  it('reads the lines in seq order, newest first, with the filters on the lines', async () => {
    r.m.state.rows.putLine(AUDIT_KEY, 'a', entry(1, 'tier.create'));
    r.m.state.rows.putLine(AUDIT_KEY, 'b', entry(2, 'tier.update'));
    r.m.state.rows.putLine(AUDIT_KEY, 'c', entry(3, 'tier.update', { metadata: { notSaved: { cause: 'changed-elsewhere', at: '2026-11-07T10:00:04.000Z' } } }));
    r.m.state.rows.putLine('global/other.jsonl', 'd', entry(4, 'tier.update'));
    const all = await r.pm().readAuditEntries();
    expect(all.entries.map(e => e.guildId)).toEqual(['g3', 'g2', 'g1']);
    expect(all.total).toBe(3);
    expect((all.entries[0].metadata as any).notSaved.cause).toBe('changed-elsewhere');
    const some = await r.pm().readAuditEntries({ action: 'tier.update', limit: 1 });
    expect(some).toEqual({ entries: [JSON.parse(entry(3, 'tier.update', { metadata: { notSaved: { cause: 'changed-elsewhere', at: '2026-11-07T10:00:04.000Z' } } }))], total: 3, truncated: true });
    expect(r.m.sql()).toContain(LINES);
  });

  it('a read the database does not answer throws its cause', async () => {
    r.m.state.rows.fault = sql => (sql === LINES ? lost() : undefined);
    await expect(r.pm().readAuditEntries()).rejects.toThrow('Connection terminated unexpectedly');
  });

  it('a line appended twice with one id (a retry after a lost answer) is stored once', async () => {
    r.pm().setTier('low', tier('Low', 1));
    let lose = true;
    r.m.state.rows.fault = sql => (sql === 'COMMIT' && lose ? (lose = false, 'lose') : undefined);
    await vi.waitFor(() => expect(r.m.state.rows.lines.size).toBe(1));
    await vi.waitFor(async () => {
      await r.settle();
      expect(r.m.state.rows.lineLog.filter(l => l.key === AUDIT_KEY)).toHaveLength(1);
      expect(rowQueue.keys()).toEqual([]);
    }, { timeout: 5000 });
    expect((await r.pm().readAuditEntries()).entries.map(e => e.action)).toEqual(['tier.create']);
  });
});

describe('readAuditEntries on a JSON bot', () => {
  it('reads the file as today', async () => {
    setBackendKind('file');
    fs.mkdirSync(dataPath('global'), { recursive: true });
    fs.writeFileSync(dataPath('global', 'premium-tiers.audit.jsonl'), `${entry(1, 'tier.create')}\nnot json\n${entry(2, 'tier.update')}\n`);
    const res = await r.pm().readAuditEntries();
    expect(res.entries.map(e => e.guildId)).toEqual(['g2', 'g1']);
    expect(r.m.sql()).toEqual([]);
  });
});

describe('the redelivery of a webhook (121, 194)', () => {
  const created = (providerSubId: string) => ({
    type: 'subscription.created', providerId: 'nb6p', providerSubId, guildId: 'g1', tierId: 'low', offeringId: 'o1', variantId: 'v1',
    state: { status: 'active', startDate: '2026-11-07T10:00:00.000Z', endDate: '2026-12-07T10:00:00.000Z', autoRenew: true, meta: {} },
  });
  async function deliver(providerSubId: string): Promise<void> {
    await runSealed('console', null, null, async ledger => {
      markPaymentLedger(ledger, 'payment.webhook');
      getPaymentRegistry().emitEvent(created(providerSubId) as any);
      await r.pm().settled(ledger);
    });
    await r.settle();
  }
  async function installed(): Promise<string> {
    const pm = r.pm();
    pm.setTier('low', { ...tier('Low', 1), offerings: [{ id: 'o1', label: 'One', providerLinks: [] }] } as any);
    await deliver('ps1');
    await vi.waitFor(() => expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.install.paid']));
    return r.row().subscriptions.g1.active.id;
  }

  it('121: after the cache was dropped, a redelivery finds the install line in the database and writes no second line', async () => {
    await installed();
    r.pm().invalidate();
    await deliver('ps1');
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.install.paid']);
    expect(r.m.sql()).toContain(LINES);
  });

  it('a marked install line is skipped: the redelivery writes the install line', async () => {
    const id = await installed();
    const config = r.row();
    const marked = r.lines(AUDIT_KEY)[1];
    r.m.state.rows.lines.clear();
    r.m.state.rows.putLine(AUDIT_KEY, 'm1', JSON.stringify({ ...marked, metadata: { ...marked.metadata, notSaved: { cause: 'io', at: '2026-11-07T10:00:05.000Z' } } }));
    r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
    r.pm().invalidate();
    await deliver('ps1');
    await vi.waitFor(() => expect(r.lines(AUDIT_KEY)).toHaveLength(2));
    const second = r.lines(AUDIT_KEY)[1];
    expect(second).toMatchObject({ action: 'subscription.install.paid', subscriptionId: id, metadata: { redelivered: true } });
  });

  it('194: the install line is held as queued with its op until that op lands; a redelivery meanwhile writes no second line', async () => {
    const pm = r.pm();
    pm.setTier('low', { ...tier('Low', 1), offerings: [{ id: 'o1', label: 'One', providerLinks: [] }] } as any);
    await r.settle();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    r.m.state.rows.fault = sql => (sql.startsWith('BEGIN') ? gate.then(() => undefined) : undefined);
    const first = runSealed('console', null, null, async ledger => {
      markPaymentLedger(ledger, 'payment.webhook');
      getPaymentRegistry().emitEvent(created('ps1') as any);
      await r.pm().settled(ledger);
    });
    const second = runSealed('console', null, null, async ledger => {
      markPaymentLedger(ledger, 'payment.webhook');
      getPaymentRegistry().emitEvent(created('ps1') as any);
      await r.pm().settled(ledger);
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    r.m.state.rows.fault = undefined;
    release();
    await Promise.all([first, second]);
    await r.settle();
    expect(r.lines(AUDIT_KEY).map(l => l.action)).toEqual(['tier.create', 'subscription.install.paid']);
  });

  it('a read of the lines that fails is an io refusal: the delivery is answered 503 and logged', async () => {
    await installed();
    r.pm().invalidate();
    r.m.state.rows.fault = sql => (sql === LINES ? lost() : undefined);
    await deliver('ps1');
    expect(r.logged('[PremiumManager] Cannot read premium-tiers.audit.jsonl (Connection terminated unexpectedly); the delivery is answered 503 and the next one reads it again')).toHaveLength(1);
  });
});

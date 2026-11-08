import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import { mirrorRig } from '../helpers/nb6Mirror';
import { settleRows } from '../helpers/nb6PremiumRig';
import { lost } from '../helpers/sharedRows';

// NB6 test 13 (wip-redesign/sheets/NB6.md section 5, decisions 13 and 40). Part 9: row 55, a premium, Dummy or payment
// op whose refresh of the shared files (refreshShared, with the journal read) fails is not run and answers decision 13's
// text. Part 11: row 54, a save built on a cache older than the row is refused and drops the cache; row 56, another
// machine's change applied by the pass drops the cache.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
// The registry's lazy require of the Dummy provider does not load under vitest: the registry starts empty here.
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});

const m = mirrorRig('nb6premium');
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const LINES = 'SELECT id, line FROM smdb_data.shared_lines WHERE key = $1 ORDER BY seq';
const text = (cause: string) => `Can't reach the database to read the current premium settings (${cause}); nothing was saved. Try again in a moment.`;

beforeEach(async () => {
  await m.setup();
  fs.mkdirSync(dataPath('global'), { recursive: true });
  resetPremiumManager();
});
afterEach(async () => {
  resetPremiumManager();
  await m.teardown();
});

describe('row 55: the refresh before the op fails', () => {
  it.each([
    ['premium.setTier', { args: ['low', { name: 'Low' }] }],
    ['dummy.adminSetVariant', { args: [] }],
    ['payment.webhook', { providerId: 'dummy', body: '' }],
  ])('%s: the rows cannot be listed; the op is not run', async (op, args) => {
    const setTier = vi.spyOn(getPremiumManager(), 'setTier');
    m.state.rows.fault = sql => (sql === LIST_KEYS ? lost() : undefined);
    expect(await applySharedOp({ op, args })).toEqual({ ok: false, code: 'failed', error: text('Connection terminated unexpectedly') });
    expect(setTier).not.toHaveBeenCalled();
    expect(rowQueue.keys()).toEqual([]);
  });

  it('the journal lines cannot be read (decision 40): the same answer, and the op is not run', async () => {
    const setTier = vi.spyOn(getPremiumManager(), 'setTier');
    m.state.rows.fault = sql => (sql === LINES ? lost() : undefined);
    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['low', { name: 'Low' }] } })).toEqual({ ok: false, code: 'failed', error: text('Connection terminated unexpectedly') });
    expect(setTier).not.toHaveBeenCalled();
    expect(m.sql()).toContain(LIST_KEYS);
  });

  it("R4-B2: this machine's record write fails ENOSPC: the local answer, and the op is not run", async () => {
    const setTier = vi.spyOn(getPremiumManager(), 'setTier');
    const body = JSON.stringify({ tiers: {} }, null, 2);
    // The mirror holds the row and the record has no entry for it (a crash between the mirror write and the record's).
    m.state.rows.put('global/premium-tiers.json', body);
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), body);
    const record = dataPath('.shared-mirror.json');
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).startsWith(`${record}.`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.openSync);
    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['low', { name: 'Low' }] } })).toEqual({
      ok: false, code: 'failed',
      error: "This machine could not write its copy of the current premium settings (ENOSPC: no space left on device), so nothing was saved. Check this machine's disk, then try again.",
    });
    expect(setTier).not.toHaveBeenCalled();
    expect(rowQueue.keys()).toEqual([]);
  });

  it('an op of another kind reads nothing first (guard)', async () => {
    m.state.rows.fault = sql => (sql === LIST_KEYS || sql === LINES ? lost() : undefined);
    const reply = await applySharedOp({ op: 'nb6.no-such-op' });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'unknown op nb6.no-such-op' });
    expect(m.sql()).toEqual([]);
  });
});

describe('row 54: the save meets another machine change', () => {
  it('the op carries the cache base, is refused changed-elsewhere and not retried; the cache is dropped', async () => {
    const pm = getPremiumManager();
    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['low', { displayName: 'Low', priority: 1, overrides: {}, offerings: [] }] } })).toMatchObject({ ok: true });
    const stored = m.state.rows.docs.get('global/premium-tiers.json')!;
    const other = JSON.stringify({ tiers: { other: { displayName: 'Other', priority: 2, overrides: {}, offerings: [] } } }, null, 2);
    m.state.rows.fault = sql => {
      if (sql.startsWith('SELECT body, sha, updated_by, updated_at FROM smdb_data.shared_docs')) {
        m.state.rows.fault = undefined;
        m.state.rows.put('global/premium-tiers.json', other);
      }
      return undefined;
    };
    const reply = await applySharedOp({ op: 'premium.setTier', args: { args: ['high', { displayName: 'High', priority: 3, overrides: {}, offerings: [] }] } });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'changed-elsewhere' });
    expect((reply as { error: string }).error).toMatch(/^This data was changed on BRAVO at .* after your change read it, so your change was not saved\. Reload to see the current values, then try again\. A payment provider call this change made may already have taken effect; check the provider's dashboard\.$/);
    expect(m.state.rows.history.filter(h => h.key === 'global/premium-tiers.json').map(h => h.before)).toEqual(['absent']);
    expect(m.state.rows.docs.get('global/premium-tiers.json')!.body.toString('utf8')).toBe(other);
    expect(stored.sha).not.toBe(m.state.rows.docs.get('global/premium-tiers.json')!.sha);
    // The pass takes the stored version (decision 6: this machine now holds that version).
    await settleRows();
    await runSharedPass();
    expect(Object.keys(pm.getAllTiers()).sort()).toEqual(['free', 'other']);
  });
});

describe('row 56: another machine change applied in the bot', () => {
  it('drops the cache; the next use loads it', async () => {
    const pm = getPremiumManager();
    expect(Object.keys(pm.getAllTiers())).toEqual(['free']);
    m.state.rows.put('global/premium-tiers.json', JSON.stringify({ tiers: { other: { displayName: 'Other', priority: 2, overrides: {}, offerings: [] } } }, null, 2));
    await runSharedPass();
    expect(Object.keys(pm.getAllTiers()).sort()).toEqual(['free', 'other']);
  });
});

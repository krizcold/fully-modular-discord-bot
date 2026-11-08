import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { carryLines } from '../../src/bot/internalSetup/utils/sharedLines';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { _resetPremiumItems } from '../../src/bot/internalSetup/utils/premiumItems';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { sha } from '../helpers/sharedRows';

// NB6 test 54 [pg] (wip-redesign/sheets/NB6.md decisions 47 and 48; rows 186, 188 and 189): premium's audit lines on
// real Postgres. A carrier's lines commit with it; a refused carrier stores none plain, only the marked copy; a marked
// copy with the id of a line that landed stores nothing; a no-change write stores its lines and its op id and no doc row.

// The registry's lazy require of the Dummy provider does not load under vitest: the registry starts empty here.
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

const PREMIUM_KEY = 'global/premium-tiers.json';
const AUDIT_KEY = 'global/premium-tiers.audit.jsonl';
const tier = (name: string, priority: number) => ({ displayName: name, priority, overrides: {}, offerings: [] });
const role = process.env.BOT_PROCESS_ROLE;

let rig: ClaimRig;

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

afterAll(async () => {
  await rig?.stop();
});

beforeEach(async () => {
  process.env.BOT_PROCESS_ROLE = 'bot';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
  dm.setGuildDataBackend(rig.backend);
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.mkdirSync(dataPath('global'), { recursive: true });
  await rig.direct.query('DELETE FROM smdb_data.shared_docs');
  await rig.direct.query('DELETE FROM smdb_data.shared_lines');
  await rig.direct.query('DELETE FROM smdb_data.shared_ops');
  resetPremiumManager();
  _resetPremiumItems();
});

afterEach(() => {
  resetPremiumManager();
  _resetPremiumItems();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.restoreAllMocks();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 100 && rowQueue.keys().length > 0; i++) {
    await dm.flushAll();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const lines = async () => (await rig.direct.query('SELECT id, convert_from(line, \'UTF8\') AS line FROM smdb_data.shared_lines WHERE key = $1 ORDER BY seq', [AUDIT_KEY])).rows
  .map((r: any) => ({ id: String(r.id), ...JSON.parse(r.line) }));
const premiumRow = async () => (await rig.direct.query('SELECT rev::text AS rev, sha FROM smdb_data.shared_docs WHERE key = $1', [PREMIUM_KEY])).rows[0];
const opsCount = async () => Number((await rig.direct.query('SELECT count(*)::int AS n FROM smdb_data.shared_ops')).rows[0].n);

describe('row 186: a carrier lands', () => {
  it('its audit line is committed with the premium row', async () => {
    const pm = getPremiumManager();
    pm.setTier('low', tier('Low', 1));
    await pm.grantManual('g1', 'low', 30);
    await settle();
    expect((await lines()).map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']);
    expect(await premiumRow()).toBeDefined();
  });
});

describe('row 188: a refused carrier, and the marked copy', () => {
  it('a carrier refused by another session write stores its line only marked', async () => {
    const pm = getPremiumManager();
    pm.setTier('low', tier('Low', 1));
    await settle();
    const other = JSON.stringify({ tiers: {} }, null, 2);
    await rig.direct.query(
      `UPDATE smdb_data.shared_docs SET body = $2, sha = $3, rev = nextval('smdb_data.shared_rev_seq'), updated_by = 'BRAVO/p-bravo' WHERE key = $1`,
      [PREMIUM_KEY, Buffer.from(other), sha(other)],
    );
    await pm.grantManual('g1', 'low', 30);
    await settle();
    const stored = await lines();
    expect(stored.map(l => l.action)).toEqual(['tier.create', 'subscription.grant.manual']);
    expect(stored[1].metadata.notSaved.cause).toBe('changed-elsewhere');
  });

  it('a marked copy with the id of a line that landed stores nothing', async () => {
    const pm = getPremiumManager();
    pm.setTier('low', tier('Low', 1));
    await settle();
    const [line] = await lines();
    const { id, ...entry } = line;
    carryLines(AUDIT_KEY, [{ id, line: JSON.stringify({ ...entry, metadata: { notSaved: { cause: 'not-landed', at: '2026-11-07T10:00:00.000Z' } } }) }], { lockKey: PREMIUM_KEY });
    await settle();
    const after = await lines();
    expect(after).toHaveLength(1);
    expect(after[0].metadata?.notSaved).toBeUndefined();
  });
});

describe('row 189: a no-change write', () => {
  it('writes no doc row; its line and its op id are stored', async () => {
    const pm = getPremiumManager();
    pm.setMessages({});
    await settle();
    const before = await premiumRow();
    const ops = await opsCount();
    pm.setMessages({});
    await settle();
    expect(await premiumRow()).toEqual(before);
    expect(await opsCount()).toBe(ops + 1);
    expect((await lines()).map(l => l.action)).toEqual(['message.update', 'message.update']);
  });
});

// Part 16: rows 266, 311 and 312, the module status upsert of decision 83 (MODULE_STATUS_SQL, sent by the apply) on real
// Postgres: within one process the higher seq wins whatever the order of commits and the clocks; a new process always
// replaces the row.
describe('the module status upsert (rows 266, 311, 312)', () => {
  const row = (state: string, seq: number, at: string, processId = 'p-alpha') =>
    ['m', 'node-a', 'ALPHA', 'f'.repeat(64), state, state === 'failed' ? 'it failed' : null, at, processId, seq];
  const stored = async () => (await rig.direct.query("SELECT state, seq::int AS seq, process_id FROM smdb_data.shared_module_status WHERE module = 'm'")).rows;

  beforeEach(async () => {
    await rig.direct.query('DELETE FROM smdb_data.shared_module_status');
  });

  it('266: an older failed upsert that commits after a newer applied one leaves the newer row', async () => {
    const { MODULE_STATUS_SQL } = await import('../../src/bot/internalSetup/utils/moduleApply');
    await rig.direct.query(MODULE_STATUS_SQL, row('applied', 2, '2026-11-07T10:00:02.000Z'));
    await rig.direct.query(MODULE_STATUS_SQL, row('failed', 1, '2026-11-07T10:00:01.000Z'));
    expect(await stored()).toEqual([{ state: 'applied', seq: 2, process_id: 'p-alpha' }]);
  });

  it('311: a clock stepped back: the later status, with the higher seq and the older at, replaces the row', async () => {
    const { MODULE_STATUS_SQL } = await import('../../src/bot/internalSetup/utils/moduleApply');
    await rig.direct.query(MODULE_STATUS_SQL, row('failed', 1, '2026-11-07T12:00:00.000Z'));
    await rig.direct.query(MODULE_STATUS_SQL, row('applied', 2, '2026-11-07T11:00:00.000Z'));
    expect(await stored()).toEqual([{ state: 'applied', seq: 2, process_id: 'p-alpha' }]);
  });

  it('312: statusSeq went back (a restored /data): a lower seq from another process replaces the row', async () => {
    const { MODULE_STATUS_SQL } = await import('../../src/bot/internalSetup/utils/moduleApply');
    await rig.direct.query(MODULE_STATUS_SQL, row('applied', 9, '2026-11-07T10:00:00.000Z'));
    await rig.direct.query(MODULE_STATUS_SQL, row('failed', 1, '2026-11-07T10:05:00.000Z', 'p-restarted'));
    expect(await stored()).toEqual([{ state: 'failed', seq: 1, process_id: 'p-restarted' }]);
  });
});

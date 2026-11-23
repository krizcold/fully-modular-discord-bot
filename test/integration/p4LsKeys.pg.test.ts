import fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// P4 (sheet P4, section R3, p4LsKeys.pg) on a real Postgres: with the Lemon Squeezy provider removed, its keys still
// cross both migration directions, and a premium-tiers.json holding Lemon Squeezy subscriptions crosses them byte for
// byte. Setup as integration/nb6fMigrationKeys.pg.test.ts. Values are made up and compared, never printed.

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = { stripe: provider('stripe', ['STRIPE_SECRET_KEY']) };
  return { get: (id: string) => providers[id], on: () => undefined, off: () => undefined };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({ getPaymentRegistry: () => registry }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import * as dotenv from 'dotenv';
import { dataPath } from '../../src/utils/dataRoot';
import { loadCredentials } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { backendOn } from '../helpers/nb6Pg';
import { freshWriterLock } from '../helpers/nb10Rig';
import { jsonBot, realService, resetDatabase, sessionsGone, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, useDatabaseUrl, why, wipeRoot } from '../helpers/migrationRig';
import { sharedOpts } from '../helpers/nb6MigrateRig';

const K = 'LEMONSQUEEZY_API_KEY';
const ENV = dataPath('.env');
const PREMIUM = dataPath('global', 'premium-tiers.json');
const DOC_KEY = 'global/payment-providers/credentials.json';
const PREMIUM_KEY = 'global/premium-tiers.json';
const A = 'ls_a_madeup_0001';
const B = 'ls_b_madeup_0002';

let rig: PgRig;

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  fs.writeFileSync(ENV, '');
  loadCredentials();
  fs.rmSync(ENV, { force: true });
  for (const key of Object.keys(process.env)) if (key.startsWith('LEMONSQUEEZY_')) delete process.env[key];
  await resetDatabase(rig);
  await sessionsGone(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  setBackendKind(null);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function migrate(jobId: string, to: 'postgres' | 'file') {
  const service = realService(new FakeHost(), sharedOpts);
  await service.post({ jobId, to });
  await service.idle();
  await sessionsGone(rig);
  return service.status().body.job;
}

/** Work on the Postgres bot: a started backend, the mirror pass first, the row queue flushed after. */
async function onDatabase<T>(work: () => Promise<T>): Promise<T> {
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  freshWriterLock('bot');
  const backend = await backendOn(rig.url);
  dm.setGuildDataBackend(backend);
  try {
    await runSharedPass({ rehash: true });
    const out = await work();
    for (let i = 0; i < 100 && rowQueue.keys().length > 0; i++) {
      await dm.flushAll();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return out;
  } finally {
    dm.setGuildDataBackend(null);
    _resetRowQueue();
    _resetSharedMirror();
    await backend.stop();
    setBackendKind(null);
  }
}

async function rowBody(key: string): Promise<Buffer | null> {
  const row = await rig.admin.query('SELECT body FROM smdb_data.shared_docs WHERE key = $1', [key]);
  return row.rows.length === 0 ? null : Buffer.from(row.rows[0].body);
}

const envValue = (): string | undefined => dotenv.parse(fs.readFileSync(ENV))[K];

/**
 * A JSON bot's premium-tiers.json as premium writes it: a gold grant queued behind a higher plat grant, both then made
 * server subscriptions sold through Lemon Squeezy.
 */
async function lemonPremium(): Promise<Buffer> {
  const role = process.env.BOT_PROCESS_ROLE;
  process.env.BOT_PROCESS_ROLE = 'bot';
  try {
    resetPremiumManager();
    const pm = getPremiumManager();
    expect(pm.setTier('gold', { displayName: 'Gold', priority: 1, overrides: {}, offerings: [] })).toBe(true);
    expect(pm.setTier('plat', { displayName: 'Platinum', priority: 2, overrides: {}, offerings: [] })).toBe(true);
    expect(await pm.grantManual('guild:74000000000000001', 'gold', 30)).toBe(true);
    expect(await pm.grantManual('guild:74000000000000001', 'plat', 30)).toBe(true);
    await dm.flushAll();
  } finally {
    resetPremiumManager();
    if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
    else process.env.BOT_PROCESS_ROLE = role;
  }
  const doc = JSON.parse(fs.readFileSync(PREMIUM, 'utf8'));
  const subs = doc.subscriptions['guild:74000000000000001'];
  const paid = (sub: any, providerSubId: string) => ({ ...sub, source: 'paid', buyerId: '81000000000000001', providerId: 'lemonsqueezy', providerSubId, autoRenew: true });
  subs.active = paid(subs.active, '9');
  subs.paused = subs.paused.map((p: any) => paid(p, '10'));
  expect([subs.active.providerId, subs.paused.length]).toEqual(['lemonsqueezy', 1]);
  fs.writeFileSync(PREMIUM, JSON.stringify(doc, null, 2));
  return fs.readFileSync(PREMIUM);
}

describe('Lemon Squeezy keys and subscriptions across the migrations', () => {
  it('(a) a key in /data/.env reaches the doc on Postgres, stays in /data/.env, and is there back on JSON', async () => {
    jsonBot();
    fs.writeFileSync(ENV, `${K}=${A}\n`);
    expect(await migrate('job-p4ls-a-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    const body = await rowBody(DOC_KEY);
    expect(body).not.toBeNull();
    expect(JSON.parse(body!.toString('utf8')).lemonsqueezy?.[K] === A).toBe(true);
    expect(envValue() === A).toBe(true);
    const job = await migrate('job-p4ls-a-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(envValue() === A).toBe(true);
  });

  it('(b) a key set in the doc on Postgres reaches /data/.env on the move to JSON', async () => {
    jsonBot();
    expect(await migrate('job-p4ls-b-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    await onDatabase(async () => {
      const reply = await applySharedOp({ op: 'provider.saveCredentials', args: { providerId: 'lemonsqueezy', changes: { [K]: B } } });
      expect(reply.ok, why(reply)).toBe(true);
    });
    const body = await rowBody(DOC_KEY);
    expect(JSON.parse(body!.toString('utf8')).lemonsqueezy?.[K] === B).toBe(true);
    const job = await migrate('job-p4ls-b-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(envValue() === B).toBe(true);
  });

  it('(c) premium-tiers.json with an active and a queued Lemon Squeezy entry crosses both ways byte for byte', async () => {
    jsonBot();
    const bytes = await lemonPremium();
    expect(await migrate('job-p4ls-c-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    const row = await rowBody(PREMIUM_KEY);
    expect(row !== null && row.equals(bytes)).toBe(true);
    const job = await migrate('job-p4ls-c-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(fs.readFileSync(PREMIUM).equals(bytes)).toBe(true);
  });
});

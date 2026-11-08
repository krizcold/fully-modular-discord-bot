import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6F P1 to P3 [pg] (out/NB6F/design.md section 5): the built-in payment providers' keys across round trips on a
// real Postgres. JSON-side keys are set through the premium tab's route on a JSON bot; Postgres-side writes run
// provider.saveCredentials (the op the route runs) on a started backend whose row queue flushes to the database, and
// Postgres-side reads run the mirror pass, then providerCredentials. Values are made up and compared, never printed.

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

import * as dotenv from 'dotenv';
import { dataPath } from '../../src/utils/dataRoot';
import { loadCredentials, providerCredentials, providerCredentialsPath } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { backendOn } from '../helpers/nb6Pg';
import { freshWriterLock } from '../helpers/nb10Rig';
import { jsonBot, realService, resetDatabase, schemas, sessionsGone, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, useDatabaseUrl, why, wipeRoot } from '../helpers/migrationRig';
import { sharedOpts } from '../helpers/nb6MigrateRig';

const K = 'STRIPE_SECRET_KEY';
const ENV = dataPath('.env');
const MIRROR = providerCredentialsPath();
const A = 'pg_a_madeup_0001';
const B = 'pg_b_madeup_0002';
const C = 'pg_c_madeup_0003';

let rig: PgRig;

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  fs.writeFileSync(ENV, '');
  loadCredentials();
  fs.rmSync(ENV, { force: true });
  delete process.env[K];
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

async function jsonRoute(body: object): Promise<void> {
  const router = createAppStoreRoutes({ migrationRunning: () => null } as any) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === '/premium/providers/:providerId/credentials' && l.route.methods.put);
  let status = 200;
  const res = { status(code: number) { status = code; return res; }, json() { return res; } };
  setBackendKind('file');
  try {
    await layer!.route!.stack[0].handle({ params: { providerId: 'stripe' }, body }, res);
  } finally {
    setBackendKind(null);
  }
  expect(status).toBe(200);
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

async function opSaves(changes: Record<string, string | null>): Promise<void> {
  const reply = await applySharedOp({ op: 'provider.saveCredentials', args: { providerId: 'stripe', changes } });
  expect(reply.ok, why(reply)).toBe(true);
}

const postgresReads = () => onDatabase(async () => providerCredentials('stripe')[K]);
const jsonReads = () => {
  setBackendKind(null);
  return providerCredentials('stripe')[K];
};

describe('P1 to P3: the keys across a round trip', () => {
  it('P1: JSON to Postgres to JSON carries a key set on Postgres', async () => {
    jsonBot();
    await jsonRoute({ values: { [K]: A } });
    expect(await migrate('job-nb6fp-1-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    expect((await postgresReads()) === A).toBe(true);
    await onDatabase(() => opSaves({ [K]: B }));
    const job = await migrate('job-nb6fp-1-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(jsonReads() === B).toBe(true);
    expect(dotenv.parse(fs.readFileSync(ENV))[K] === B).toBe(true);
    expect(fs.existsSync(MIRROR)).toBe(false);
    const retired = (await schemas(rig)).filter(s => s.startsWith('smdb_superseded_'));
    expect(retired).toHaveLength(1);
    const kept = await rig.admin.query(`SELECT count(*)::int AS n FROM "${retired[0]}".shared_docs WHERE key = $1`, ['global/payment-providers/credentials.json']);
    expect(kept.rows[0].n).toBe(1);
  });

  it('P2: back to Postgres after a key set on JSON: the row holds it, not the earlier doc', async () => {
    jsonBot();
    await jsonRoute({ values: { [K]: A } });
    expect(await migrate('job-nb6fp-2-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    await onDatabase(() => opSaves({ [K]: B }));
    expect(await migrate('job-nb6fp-2-02', 'file'), 'to JSON').toMatchObject({ state: 'done' });
    await jsonRoute({ values: { [K]: C } });
    const job = await migrate('job-nb6fp-2-03', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const row = await rig.admin.query('SELECT body FROM smdb_data.shared_docs WHERE key = $1', ['global/payment-providers/credentials.json']);
    expect(JSON.parse(Buffer.from(row.rows[0].body).toString('utf8')).stripe[K] === C).toBe(true);
    expect((await postgresReads()) === C).toBe(true);
  });

  it('P3: a key cleared on Postgres leaves no line on JSON', async () => {
    jsonBot();
    await jsonRoute({ values: { [K]: A } });
    expect(await migrate('job-nb6fp-3-01', 'postgres'), 'to Postgres').toMatchObject({ state: 'done' });
    await onDatabase(() => opSaves({ [K]: null }));
    const job = await migrate('job-nb6fp-3-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(K in dotenv.parse(fs.readFileSync(ENV))).toBe(false);
    expect(jsonReads()).toBeUndefined();
    expect(fs.existsSync(path.dirname(MIRROR)) && fs.readdirSync(path.dirname(MIRROR)).includes('credentials.json')).toBe(false);
  });
});

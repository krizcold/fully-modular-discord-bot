import fs from 'fs';
import path from 'path';
import { format } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = {
    stripe: provider('stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'WEBUI_BASE_URL']),
    paypal: provider('paypal', ['PAYPAL_CLIENT_ID']),
  };
  return { get: (id: string) => providers[id], on: () => undefined, off: () => undefined };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({ getPaymentRegistry: () => registry }));

import { loadCredentials, providerCredentialsPath } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import type { ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G1 = '880000000000000047';
const ENV = dataPath('.env');
const DOC_KEY = 'global/payment-providers/credentials.json';
const MIRROR = providerCredentialsPath();
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const K = 'STRIPE_SECRET_KEY';
const K2 = 'STRIPE_WEBHOOK_SECRET';
const PK = 'PAYPAL_CLIENT_ID';
const OLD = 'sk_old_madeup_4701';
const NEW = 'sk_new_madeup_4702';
const opDoc = (doc: unknown) => JSON.stringify(doc, null, 2);
let lines: string[];

function clearProviderEnv(): void {
  for (const key of Object.keys(process.env)) if (/^(STRIPE_|PAYPAL_|PATREON_|LEMONSQUEEZY_)|^WEBUI_BASE_URL$|^DATA_BACKEND$/.test(key)) delete process.env[key];
}

function forgetEnvFile(): void {
  fs.writeFileSync(ENV, '');
  loadCredentials();
  fs.rmSync(ENV, { force: true });
}

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  forgetEnvFile();
  clearProviderEnv();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  loadCredentials();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(format(...a)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
  _resetRowQueue();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  clearProviderEnv();
});

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file') {
  const extra: ServiceOptions = { rootConfigPath: CFG, sourceModulesDir: MODS };
  const service = serviceFor(db, new FakeHost(), extra);
  await service.post({ jobId, to });
  await service.idle();
  return service.status().body.job;
}

async function jsonRoute(providerId: string, body: object): Promise<void> {
  const router = createAppStoreRoutes({ migrationRunning: () => null } as any) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] };
  const layer = router.stack.find(l => l.route?.path === '/premium/providers/:providerId/credentials' && l.route.methods.put);
  let status = 200;
  const res = { status(code: number) { status = code; return res; }, json() { return res; } };
  setBackendKind('file');
  try {
    await layer!.route!.stack[0].handle({ params: { providerId }, body }, res);
  } finally {
    setBackendKind(null);
  }
  expect(status).toBe(200);
}

function pgDoc(db: FakeDb, body: string): void {
  const store = db.schemas.get('smdb_data')!;
  store.docs = (store.docs ?? []).filter(d => d.key !== DOC_KEY);
  store.docs.push({ key: DOC_KEY, body: Buffer.from(body), sha: shaOf(Buffer.from(body)), rev: 900, updated_by: 'webui' });
  fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
  fs.writeFileSync(MIRROR, body);
}

async function onPostgres(keys: Array<[string, Record<string, string>]>, jobId: string): Promise<FakeDb> {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
  for (const [id, values] of keys) await jsonRoute(id, { values });
  const db = new FakeDb();
  const job = await run(db, jobId, 'postgres');
  expect(job, why(job)).toMatchObject({ state: 'done' });
  return db;
}

function supersededOf(jobId: string): string {
  const names = fs.readdirSync(path.join(root, '_superseded')).filter(n => n.endsWith(`-${jobId}`));
  expect(names).toHaveLength(1);
  return path.join(root, '_superseded', names[0]);
}

describe('ra47: the log line of what the move to JSON changed in /data/.env', () => {
  it('lists the set keys, then the keys of a provider whose entry cannot be read, and where the old file is kept', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD, [K2]: OLD }], ['paypal', { [PK]: OLD }]], 'job-ra47-src-01');
    pgDoc(db, opDoc({ stripe: 'x', paypal: { [PK]: NEW } }));
    const job = await run(db, 'job-ra47-keys-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const kept = path.join(supersededOf('job-ra47-keys-01'), '.env');
    const changed = lines.filter(l => l.startsWith('[Migration] Changed the payment provider key lines'));
    expect(changed).toEqual([
      `[Migration] Changed the payment provider key lines of ${ENV} (set: ${PK}; removed, since the database's keys of stripe cannot be read: ${K}, ${K2}); the file as it was is kept at ${kept}`,
    ]);
  });

  it('says there was no /data/.env when the bot had none', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD }]], 'job-ra47-src-02');
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    forgetEnvFile();
    clearProviderEnv();
    const job = await run(db, 'job-ra47-keys-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const changed = lines.filter(l => l.startsWith('[Migration] Changed the payment provider key lines'));
    expect(changed).toEqual([`[Migration] Changed the payment provider key lines of ${ENV} (set: ${K}); there was no ${ENV} before`]);
  });
});

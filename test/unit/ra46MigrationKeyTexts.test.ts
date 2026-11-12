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
import { FakeHost, MARKER, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G1 = '880000000000000001';
const ENV = dataPath('.env');
const DOC_KEY = 'global/payment-providers/credentials.json';
const MIRROR = providerCredentialsPath();
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const K = 'STRIPE_SECRET_KEY';
const K2 = 'STRIPE_WEBHOOK_SECRET';
const PK = 'PAYPAL_CLIENT_ID';
const OLD = 'sk_old_madeup_0001';
const NEW = 'sk_new_madeup_0002';
const opDoc = (doc: unknown) => JSON.stringify(doc, null, 2);
const RETRY = 'restart the container, and run the migration again';

const opts = (extra: ServiceOptions = {}): ServiceOptions => ({ rootConfigPath: CFG, sourceModulesDir: MODS, ...extra });
let lines: string[];

function clearProviderEnv(): void {
  for (const key of Object.keys(process.env)) if (/^(STRIPE_|PAYPAL_|PATREON_|LEMONSQUEEZY_)|^WEBUI_BASE_URL$|^DATA_BACKEND$/.test(key)) delete process.env[key];
}

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  fs.writeFileSync(ENV, '');
  loadCredentials();
  fs.rmSync(ENV, { force: true });
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
  const service = serviceFor(db, new FakeHost(), opts());
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
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

async function onPostgres(keys: Array<[string, Record<string, string>]>): Promise<FakeDb> {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
  for (const [id, values] of keys) await jsonRoute(id, { values });
  const db = new FakeDb();
  const { job } = await run(db, 'job-ra46-src-01', 'postgres');
  expect(job, why(job)).toMatchObject({ state: 'done' });
  return db;
}

function supersededEnv(jobId: string): string {
  const names = fs.readdirSync(path.join(root, '_superseded')).filter(n => n.endsWith(`-${jobId}`));
  expect(names).toHaveLength(1);
  return path.join(root, '_superseded', names[0], '.env');
}

const changedLine = (parts: string, jobId: string) =>
  `[Migration] Changed the payment provider key lines of ${ENV} (${parts}); the file as it was is kept at ${supersededEnv(jobId)}`;
const changedLines = () => lines.filter(l => l.startsWith('[Migration] Changed the payment provider key lines'));

function pinInContainer(...keys: string[]): void {
  for (const key of keys) process.env[key] = NEW;
  loadCredentials();
}

async function refusedAtReading(db: FakeDb, jobId: string, error: string): Promise<void> {
  const envBefore = fs.readFileSync(ENV);
  const markerBefore = fs.readFileSync(MARKER);
  const { job } = await run(db, jobId, 'file');
  expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading', error });
  expect(fs.readFileSync(ENV).equals(envBefore)).toBe(true);
  expect(fs.readFileSync(MARKER).equals(markerBefore)).toBe(true);
  expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
}

describe('to JSON, keys the container pins while their provider\'s entry cannot be read', () => {
  it('one pinned key of an unread entry fails at reading naming that key and provider', async () => {
    const db = await onPostgres([]);
    pgDoc(db, opDoc({ stripe: 'x' }));
    pinInContainer(K);
    await refusedAtReading(db, 'job-ra46-e1-01',
      `${K} is set by the container environment, and the database's keys of stripe cannot be read, so after the move the bot would read ${K} from the container while on Postgres it reads none of stripe's keys; remove it from the container environment, ${RETRY}`);
  });

  it('two pinned keys of one unread entry are named together', async () => {
    const db = await onPostgres([]);
    pgDoc(db, opDoc({ stripe: 'x' }));
    pinInContainer(K, K2);
    await refusedAtReading(db, 'job-ra46-e2-01',
      `${K}, ${K2} are set by the container environment, and the database's keys of stripe cannot be read, so after the move the bot would read them from the container while on Postgres it reads none of stripe's keys; remove them from the container environment, ${RETRY}`);
  });

  it('pins of two unread entries name only the first provider and its key', async () => {
    const db = await onPostgres([]);
    pgDoc(db, opDoc({ stripe: 'x', paypal: 'y' }));
    pinInContainer(K, PK);
    await refusedAtReading(db, 'job-ra46-e3-01',
      `${K} is set by the container environment, and the database's keys of stripe cannot be read, so after the move the bot would read ${K} from the container while on Postgres it reads none of stripe's keys; remove it from the container environment, ${RETRY}`);
  });
});

describe('to JSON on a managed bot, the /data/.env write is judged before anything moves', () => {
  it('a /data/.env that is not valid UTF-8 with a key to change fails at reading, bytes kept', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'made-up-token';
    const db = await onPostgres([]);
    fs.writeFileSync(ENV, Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${K}=${OLD}\n`)]));
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    await refusedAtReading(db, 'job-ra46-u8-01',
      `${ENV} is not valid UTF-8, so the payment provider keys cannot be written to it without changing other bytes; save it as UTF-8, then run the migration again`);
  });

  it('a key whose line would change another key fails at reading with the writer\'s text, bytes kept', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'made-up-token';
    const db = await onPostgres([]);
    fs.writeFileSync(ENV, 'A=1\nOTHER:');
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    await refusedAtReading(db, 'job-ra46-wr-01',
      `Writing ${K} would change the value of OTHER in ${ENV}; edit that line of ${ENV}, then run the migration again`);
  });
});

describe('to JSON, the log line of what changed in /data/.env', () => {
  it('one key set and one cleared', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD, [K2]: OLD }]]);
    pgDoc(db, opDoc({ stripe: { [K]: NEW, [K2]: null } }));
    const { job } = await run(db, 'job-ra46-l1-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(changedLines()).toEqual([changedLine(`set: ${K}; removed: ${K2}`, 'job-ra46-l1-01')]);
  });

  it('two keys cleared and none set', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD, [K2]: OLD }]]);
    pgDoc(db, opDoc({ stripe: { [K]: null, [K2]: null } }));
    const { job } = await run(db, 'job-ra46-l2-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(changedLines()).toEqual([changedLine(`removed: ${K}, ${K2}`, 'job-ra46-l2-01')]);
  });

  it('two keys set and none cleared', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD, [K2]: OLD }]]);
    pgDoc(db, opDoc({ stripe: { [K]: NEW, [K2]: NEW } }));
    const { job } = await run(db, 'job-ra46-l3-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(changedLines()).toEqual([changedLine(`set: ${K}, ${K2}`, 'job-ra46-l3-01')]);
  });

  it('a key removed because its entry cannot be read is named with its provider', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD }], ['paypal', { [PK]: OLD }]]);
    pgDoc(db, opDoc({ stripe: 'x', paypal: { [PK]: NEW } }));
    const { job } = await run(db, 'job-ra46-l4-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(changedLines()).toEqual([changedLine(`set: ${PK}; removed, since the database's keys of stripe cannot be read: ${K}`, 'job-ra46-l4-01')]);
  });
});

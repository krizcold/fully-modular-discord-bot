import fs from 'fs';
import path from 'path';
import { format } from 'util';
import * as dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6F (design.md section 5 as review1.md to review8.md rule it): the built-in payment providers' keys across NB3's
// job, against FakeDb and temp folders. JSON-side keys are set through the premium tab's route on a JSON bot, which
// writes /data/.env with saveCredentials; Postgres-side keys are the doc bytes the route's op stores
// (JSON.stringify(doc, null, 2), sharedOps.ts saveProviderCredentials), put in shared_docs and in the mirror. Values
// are made up and compared, never printed.

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

import { loadCredentials, providerCredentials, providerCredentialsPath } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import type { ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

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
const T4 = (key: string) => `${key} is set by the container environment, which a JSON bot reads before /data/.env, so after the move the bot would not read that payment provider key as the database holds it; remove it from the container environment, restart the container, and run the migration again`;
const T5b = (keys: string, other: string) => `Writing ${keys} would change the value of ${other} in ${ENV}; edit that line of ${ENV}, then run the migration again`;
const T11b = `${ENV} is not valid UTF-8, so the migration cannot write DATA_BACKEND to it without changing other bytes; save it as UTF-8, then run the migration again`;
const T3 = `The source read a second time differs from the source in the payment provider keys of ${ENV}`;

const opts = (extra: ServiceOptions = {}): ServiceOptions => ({ rootConfigPath: CFG, sourceModulesDir: MODS, ...extra });
let lines: string[];

function clearProviderEnv(): void {
  for (const key of Object.keys(process.env)) if (/^(STRIPE_|PAYPAL_|PATREON_|LEMONSQUEEZY_)|^WEBUI_BASE_URL$|^DATA_BACKEND$/.test(key)) delete process.env[key];
}

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  // An empty file makes loadCredentials forget the keys an earlier row's file seeded.
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

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file', extra: ServiceOptions = {}) {
  const service = serviceFor(db, new FakeHost(), opts(extra));
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

/** The premium tab's credentials route on a JSON bot: saveCredentials writes /data/.env. */
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

/** The doc row the route's op stores on Postgres, and the mirror the mirror pass writes of it; null removes both. */
function pgDoc(db: FakeDb, body: string | null): void {
  const store = db.schemas.get('smdb_data')!;
  store.docs = (store.docs ?? []).filter(d => d.key !== DOC_KEY);
  fs.rmSync(MIRROR, { force: true });
  if (body === null) return;
  store.docs.push({ key: DOC_KEY, body: Buffer.from(body), sha: shaOf(Buffer.from(body)), rev: 900, updated_by: 'webui' });
  fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
  fs.writeFileSync(MIRROR, body);
}

function jsonBot(): void {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
}

/** A JSON bot whose route set the given keys, moved to Postgres by a real job. */
async function onPostgres(keys: Array<[string, Record<string, string>]>, jobId = 'job-nb6f-src-01'): Promise<FakeDb> {
  jsonBot();
  for (const [id, values] of keys) await jsonRoute(id, { values });
  const db = new FakeDb();
  const { job } = await run(db, jobId, 'postgres');
  expect(job, why(job)).toMatchObject({ state: 'done' });
  return db;
}

function supersededOf(jobId: string): string {
  const names = fs.readdirSync(path.join(root, '_superseded')).filter(n => n.endsWith(`-${jobId}`));
  expect(names).toHaveLength(1);
  return path.join(root, '_superseded', names[0]);
}

const envRead = () => dotenv.parse(fs.readFileSync(ENV));
const jsonReads = (providerId: string, key: string) => {
  setBackendKind(null);
  return providerCredentials(providerId)[key];
};
const postgresReads = (providerId: string, key: string) => {
  setBackendKind('postgres');
  try {
    return providerCredentials(providerId)[key];
  } finally {
    setBackendKind(null);
  }
};
const rowOf = (db: FakeDb) => db.schemas.get('smdb_data')!.docs?.find(d => d.key === DOC_KEY);
const doneLine = (jobId: string) => lines.find(l => l.startsWith(`[Migration] Migration ${jobId} (--to `) && l.includes(' is done: '));

describe('rows 1 and 2: to JSON, the database\'s keys reach /data/.env', () => {
  it('row 1: the doc\'s key is applied, the old file is kept, nothing is placed, T7 and T8 are logged', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD, WEBUI_BASE_URL: 'https://panel.example' }]]);
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    const before = fs.readFileSync(ENV);
    const { job } = await run(db, 'job-nb6f-01-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(jsonReads('stripe', K) === NEW).toBe(true);
    expect(fs.existsSync(MIRROR)).toBe(false);
    const sup = supersededOf('job-nb6f-01-01');
    expect(fs.readFileSync(path.join(sup, '.env')).equals(before)).toBe(true);
    const keep = before.toString('utf8').split('\n').find(l => l.startsWith('WEBUI_BASE_URL='));
    expect(fs.readFileSync(ENV, 'utf8').split('\n')).toContain(keep);
    expect(job.counts.providerKeys).toBe(1);
    expect(lines).toContain(`[Migration] Changed the payment provider key lines of ${ENV} (set: ${K}); the file as it was is kept at ${path.join(sup, '.env')}`);
    expect(doneLine('job-nb6f-01-01')).toContain(`graveyard entries; 1 payment provider key from the database applied to ${ENV}`);
  });

  it('row 2: a key cleared on Postgres leaves no line, and the provider reads it not set', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD }]]);
    pgDoc(db, opDoc({ stripe: { [K]: null } }));
    const { job } = await run(db, 'job-nb6f-02-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(K in envRead()).toBe(false);
    expect(jsonReads('stripe', K)).toBeUndefined();
  });
});

describe('rows 3 to 5: to Postgres, the row holds what this machine reads', () => {
  it('row 3: the keys of /data/.env win over a credentials.json left under /data/global, which goes aside with T1', async () => {
    jsonBot();
    await jsonRoute('stripe', { values: { [K]: NEW } });
    const stale = opDoc({ stripe: { [K]: OLD } });
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    fs.writeFileSync(MIRROR, stale);
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6f-03-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const row = rowOf(db);
    expect(row && JSON.parse(Buffer.from(row.body).toString('utf8')).stripe[K] === NEW).toBe(true);
    const sup = supersededOf('job-nb6f-03-01');
    const aside = path.join(sup, 'global', 'payment-providers', 'credentials.json');
    expect(fs.readFileSync(aside, 'utf8')).toBe(stale);
    expect(fs.existsSync(MIRROR)).toBe(false);
    expect(lines).toContain(`[Migration] Moved ${MIRROR} to ${aside}: a JSON bot never reads that file, so a move to Postgres takes the payment provider keys from /data/.env and the container environment, not from it`);
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    fs.writeFileSync(MIRROR, Buffer.from(row!.body));
    expect(postgresReads('stripe', K) === NEW).toBe(true);
  });

  it('row 4: keys in /data/.env only are copied as the op would store them, and counted', async () => {
    const db = await onPostgres([['stripe', { [K]: NEW, [K2]: OLD }]]);
    const row = rowOf(db);
    expect(row && Buffer.from(row.body).toString('utf8') === opDoc({ stripe: { [K]: NEW, [K2]: OLD } })).toBe(true);
    expect(readJson(JOURNAL).counts.providerKeys).toBe(2);
    expect(doneLine('job-nb6f-src-01')).toContain('graveyard entries; 2 payment provider keys copied into the database');
  });

  it('row 5: a key the container pins is copied with the container\'s value', async () => {
    process.env[K] = NEW;
    loadCredentials();
    const db = await onPostgres([['stripe', { [K]: OLD }]]);
    const row = rowOf(db);
    expect(row && JSON.parse(Buffer.from(row.body).toString('utf8')).stripe[K] === NEW).toBe(true);
  });
});

describe('rows 6 and 7: to JSON, a key the container pins', () => {
  it.each([
    ['a value that differs', { [K]: OLD }],
    ['a null', { [K]: null }],
  ])('row 6, %s: failed at reading with T4, nothing changed and nothing staged', async (_what, entry) => {
    const db = await onPostgres([]);
    pgDoc(db, opDoc({ stripe: entry }));
    process.env[K] = NEW;
    loadCredentials();
    const envBefore = fs.readFileSync(ENV);
    const markerBefore = fs.readFileSync(MARKER);
    const { job } = await run(db, 'job-nb6f-06-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading', error: T4(K) });
    expect(fs.readFileSync(ENV).equals(envBefore)).toBe(true);
    expect(fs.readFileSync(MARKER).equals(markerBefore)).toBe(true);
    expect(fs.readdirSync(root).filter(n => n.startsWith('.migrate-'))).toEqual([]);
  });

  it('row 7: a pinned key equal to the doc\'s is done (guard)', async () => {
    const db = await onPostgres([]);
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    process.env[K] = NEW;
    loadCredentials();
    const { job } = await run(db, 'job-nb6f-07-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
  });

  it('CR1: an unread doc with two keys of one provider pinned names that provider\'s keys', async () => {
    const db = await onPostgres([]);
    pgDoc(db, '{"stripe": sk_live_madeup_value_0456}');
    process.env[K] = NEW;
    process.env[K2] = NEW;
    loadCredentials();
    const { job } = await run(db, 'job-nb6f-cr1-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(String(job.error)).toContain(`${K}, ${K2} are set by the container environment`);
    expect(String(job.error)).toContain('none of that provider\'s keys');
  });
});

describe('rows 8 and 9: to JSON, a doc or an entry that cannot be read', () => {
  it('row 8: a doc that is not valid JSON: T6, every owned line removed and kept, no part of the value anywhere', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD, [K2]: OLD }], ['paypal', { [PK]: OLD }]]);
    const secret = 'sk_live_madeup_value_0123';
    pgDoc(db, `{"stripe": ${secret}}`);
    const before = fs.readFileSync(ENV);
    const { job } = await run(db, 'job-nb6f-08-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.notes).toContain('The payment provider keys in the database could not be read (payment-providers/credentials.json: it is not valid JSON), so none was copied; after the move the built-in providers read none of their keys until they are set in the premium tab');
    const after = envRead();
    for (const key of [K, K2, PK]) expect(key in after, key).toBe(false);
    expect(fs.readFileSync(path.join(supersededOf('job-nb6f-08-01'), '.env')).equals(before)).toBe(true);
    const written = [fs.readFileSync(JOURNAL, 'utf8'), fs.readFileSync(ENV, 'utf8'), ...lines].join('\n');
    for (const piece of [secret, secret.slice(0, 10), 'madeup_value']) expect(written.includes(piece)).toBe(false);
  });

  it('row 9: one entry that is not an object: T6 for stripe only, paypal\'s key applied', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD }], ['paypal', { [PK]: OLD }]]);
    pgDoc(db, opDoc({ stripe: 'x', paypal: { [PK]: NEW } }));
    const { job } = await run(db, 'job-nb6f-09-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(job.notes).toEqual(['The payment provider keys of stripe in the database could not be read (payment-providers/credentials.json: the entry of stripe is not an object), so none was copied; after the move stripe reads none of its keys until they are set in the premium tab']);
    expect(envRead()[PK] === NEW).toBe(true);
    expect(K in envRead()).toBe(false);
  });
});

describe('row 10: to Postgres, /data/.env changed before the second read', () => {
  it('fails at rereading with T3', async () => {
    jsonBot();
    await jsonRoute('stripe', { values: { [K]: OLD } });
    const db = new FakeDb();
    const { job } = await run(db, 'job-nb6f-10-01', 'postgres', {
      fault: p => { if (p === 'S7') fs.writeFileSync(ENV, fs.readFileSync(ENV, 'utf8').replace(OLD, NEW)); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'rereading', error: T3 });
  });
});

describe('rows 11, 11b and 12: faults around the /data/.env write', () => {
  it('row 11: a fault after the write: failed at placing; Postgres reads the doc\'s value from the lines; the rerun copies nothing again', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD }]]);
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    const first = await run(db, 'job-nb6f-11-01', 'file', { fault: p => { if (p === 'after-keys-env') throw new Error('injected failure'); } });
    expect(first.job, why(first.job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
    expect(fs.existsSync(MIRROR)).toBe(false);
    expect(postgresReads('stripe', K) === NEW).toBe(true);
    lines.length = 0;
    const again = await run(db, 'job-nb6f-11-02', 'file');
    expect(again.job, why(again.job)).toMatchObject({ state: 'done' });
    expect(fs.existsSync(path.join(supersededOf('job-nb6f-11-02'), '.env'))).toBe(false);
    expect(lines.some(l => l.startsWith('[Migration] Changed the payment provider key lines'))).toBe(false);
    expect(jsonReads('stripe', K) === NEW).toBe(true);
  });

  it('row 11b: a fault before the write: .env as before, the mirror in place, Postgres reads the doc; the rerun is done', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD }]]);
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    const before = fs.readFileSync(ENV);
    const first = await run(db, 'job-nb6f-11b-01', 'file', { fault: p => { if (p === 'before-keys-env') throw new Error('injected failure'); } });
    expect(first.job, why(first.job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
    expect(fs.readFileSync(ENV).equals(before)).toBe(true);
    expect(fs.existsSync(MIRROR)).toBe(true);
    expect(postgresReads('stripe', K) === NEW).toBe(true);
    const again = await run(db, 'job-nb6f-11b-02', 'file');
    expect(again.job, why(again.job)).toMatchObject({ state: 'done' });
    expect(jsonReads('stripe', K) === NEW).toBe(true);
    expect(fs.existsSync(MIRROR)).toBe(false);
  });

  it('row 12: a death after the write, then a new POST: done, keys as row 1', async () => {
    const db = await onPostgres([['stripe', { [K]: OLD }]]);
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    const first = await run(db, 'job-nb6f-12-01', 'file', {
      fault: p => { if (p === 'after-keys-env') throw Object.assign(new Error('the process died'), { simulateDeath: true }); },
    });
    expect(first.job.state).toBe('interrupted');
    const again = await run(db, 'job-nb6f-12-02', 'file');
    expect(again.job, why(again.job)).toMatchObject({ state: 'done' });
    expect(jsonReads('stripe', K) === NEW).toBe(true);
  });
});

describe('row 13 and W6: an unreadable /data/.env on a managed bot', () => {
  it('row 13: to Postgres with a folder at /data/.env fails at reading with T2', async () => {
    jsonBot();
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'made-up-token';
    fs.mkdirSync(ENV);
    const { job } = await run(new FakeDb(), 'job-nb6f-13-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    expect(String(job.error).startsWith(`${ENV} cannot be read: `)).toBe(true);
  });

  it('W6: to JSON with a folder at /data/.env and no credentials row is done (guard)', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'made-up-token';
    const db = await onPostgres([]);
    fs.rmSync(ENV, { force: true });
    fs.mkdirSync(ENV);
    const { job } = await run(db, 'job-nb6f-w6-01', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
  });
});

describe('S6, U3, V2: a /data/.env that is not valid UTF-8', () => {
  const latin1 = (text: string) => Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${text}`)]);

  it('S6: a managed bot whose file holds the doc\'s keys already is done, and nothing lands under /data/global/payment-providers', async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = 'made-up-token';
    jsonBot();
    fs.writeFileSync(ENV, latin1(`${K}=${NEW}\n`));
    const db = new FakeDb();
    expect((await run(db, 'job-nb6f-s6-01', 'postgres')).job.state).toBe('done');
    pgDoc(db, opDoc({ stripe: { [K]: NEW } }));
    const bytes = fs.readFileSync(ENV);
    const { job } = await run(db, 'job-nb6f-s6-02', 'file');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(fs.existsSync(MIRROR)).toBe(false);
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('U3: an unmanaged move to Postgres is refused with T11b and the file keeps its bytes', async () => {
    jsonBot();
    const bytes = latin1('A=1\n');
    fs.writeFileSync(ENV, bytes);
    const { job } = await run(new FakeDb(), 'job-nb6f-u3-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: T11b });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });

  it('V2: a done move, then a Latin-1 comment, then the same POST answers done with the file as it is (guard)', async () => {
    jsonBot();
    const db = new FakeDb();
    expect((await run(db, 'job-nb6f-v2-01', 'postgres')).job.state).toBe('done');
    const bytes = Buffer.concat([latin1(''), fs.readFileSync(ENV)]);
    fs.writeFileSync(ENV, bytes);
    const service = serviceFor(db, new FakeHost(), opts());
    const answer = await service.post({ jobId: 'job-nb6f-v2-01', to: 'postgres' });
    expect(answer.body, why(answer)).toMatchObject({ state: 'done' });
    expect(fs.readFileSync(ENV).equals(bytes)).toBe(true);
  });
});

describe('W5, X3, Y4, Z2: DATA_BACKEND\'s write judged before anything moves', () => {
  it('X3: a file ending "OTHER:\\n" with no DATA_BACKEND line: done, OTHER reads empty, DATA_BACKEND postgres', async () => {
    jsonBot();
    fs.writeFileSync(ENV, 'A=1\nOTHER:\n');
    const { job } = await run(new FakeDb(), 'job-nb6f-x3-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect(envRead()).toMatchObject({ A: '1', OTHER: '', DATA_BACKEND: 'postgres' });
  });

  it('X3: a file ending "OTHER:" with no line end is refused at checking with T5b naming OTHER', async () => {
    jsonBot();
    fs.writeFileSync(ENV, 'A=1\nOTHER:');
    const { job } = await run(new FakeDb(), 'job-nb6f-x3-02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'checking', error: T5b('DATA_BACKEND', 'OTHER') });
    expect(fs.readFileSync(ENV, 'utf8')).toBe('A=1\nOTHER:');
  });

  it('Z2: finish from switch with a file ending "X:" and no DATA_BACKEND line: 409 with T5b, marker and journal unchanged', async () => {
    const db = await onPostgres([]);
    const first = await run(db, 'job-nb6f-z2-01', 'file', {
      fault: p => { if (p === 'S10') throw Object.assign(new Error('the process died'), { simulateDeath: true }); },
    });
    expect(first.job.state).toBe('interrupted');
    fs.writeFileSync(ENV, 'A=1\nX:');
    const marker = fs.readFileSync(MARKER);
    const journal = fs.readFileSync(JOURNAL);
    const service = serviceFor(db, new FakeHost(), opts());
    const answer = await service.post({ jobId: 'job-nb6f-z2-01', to: 'file' });
    expect(answer, why(answer)).toMatchObject({ status: 409, body: { success: false, error: T5b('DATA_BACKEND', 'X') } });
    expect(fs.readFileSync(MARKER).equals(marker)).toBe(true);
    expect(fs.readFileSync(JOURNAL).equals(journal)).toBe(true);
  });
});

import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { format } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = { stripe: provider('stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) };
  return { get: (id: string) => providers[id], on: () => undefined, off: () => undefined };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({ getPaymentRegistry: () => registry }));

import { loadCredentials, providerCredentialsPath } from '../../src/utils/envLoader';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import type { ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, MARKER, PG_URL, freshJsonBot, readJson, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

const G1 = '880000000000000001';
const ENV = dataPath('.env');
const DOC_KEY = 'global/payment-providers/credentials.json';
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const K = 'STRIPE_SECRET_KEY';
const OLD = 'sk_old_madeup_0001';
const NEW = 'sk_new_madeup_0002';

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
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { void format(...a); });
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  setBackendKind(null);
  _resetRowQueue();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  clearProviderEnv();
});

async function run(db: FakeDb, jobId: string, to: 'postgres' | 'file', extra: ServiceOptions = {}) {
  const service = serviceFor(db, new FakeHost(), { rootConfigPath: CFG, sourceModulesDir: MODS, ...extra });
  const answer = await service.post({ jobId, to });
  await service.idle();
  return { answer, job: service.status().body.job };
}

async function onPostgres(): Promise<FakeDb> {
  freshJsonBot();
  seedFile(`${G1}/m/a.json`, '{"g":1}');
  const db = new FakeDb();
  const { job } = await run(db, 'job-ra51e-src-01', 'postgres');
  expect(job, why(job)).toMatchObject({ state: 'done' });
  return db;
}

/** A Postgres bot whose database holds a new value of K while /data/.env holds the old one, so a move to JSON changes K. */
async function withNewKey(): Promise<FakeDb> {
  const db = await onPostgres();
  const body = JSON.stringify({ stripe: { [K]: NEW } }, null, 2);
  const store = db.schemas.get('smdb_data')!;
  store.docs = (store.docs ?? []).filter(d => d.key !== DOC_KEY);
  store.docs.push({ key: DOC_KEY, body: Buffer.from(body), sha: shaOf(Buffer.from(body)), rev: 900, updated_by: 'webui' });
  fs.mkdirSync(path.dirname(providerCredentialsPath()), { recursive: true });
  fs.writeFileSync(providerCredentialsPath(), body);
  fs.writeFileSync(ENV, `DATA_BACKEND=postgres\n${K}=${OLD}\n`);
  loadCredentials();
  return db;
}

function supersededOf(jobId: string): string {
  const names = fs.readdirSync(path.join(root, '_superseded')).filter(n => n.endsWith(`-${jobId}`));
  expect(names).toHaveLength(1);
  return path.join(root, '_superseded', names[0]);
}

const isEnv = (p: unknown) => typeof p === 'string' && path.resolve(p) === path.resolve(ENV);

describe('S8 to JSON, the payment provider keys written to /data/.env', () => {
  it('a /data/.env that cannot be read when the keys are applied fails the job and leaves the file as it was', async () => {
    const db = await withNewKey();
    const { job } = await run(db, 'job-ra51e-env-01', 'file', {
      fault: p => {
        if (p !== 'before-keys-env') return;
        let armed = true;
        const real = fs.readFileSync;
        vi.spyOn(fs, 'readFileSync').mockImplementation(((f: any, ...rest: any[]) => {
          if (armed && isEnv(f)) {
            armed = false;
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          }
          return (real as any)(f, ...rest);
        }) as any);
        syncBuiltinESMExports();
      },
    });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(job, why(job)).not.toMatchObject({ state: 'done' });
    expect(job.error).toContain('EACCES: permission denied');
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`DATA_BACKEND=postgres\n${K}=${OLD}\n`);
  });

  it('a /data/.env gone when the keys are applied is written with the keys and the move is done', async () => {
    const db = await withNewKey();
    const { job } = await run(db, 'job-ra51e-env-02', 'file', {
      fault: p => { if (p === 'before-keys-env') fs.rmSync(ENV); },
    });
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const text = fs.readFileSync(ENV, 'utf8');
    expect(text).toContain(`${K}=${NEW}`);
    expect(text).toContain('DATA_BACKEND=file');
    expect(fs.existsSync(path.join(supersededOf('job-ra51e-env-02'), '.env'))).toBe(false);
    expect(readJson(MARKER)).toMatchObject({ live: 'file' });
  });

  it('a .env already in the superseded folder is refused and kept, and /data/.env is not changed', async () => {
    const db = await withNewKey();
    let stray = '';
    const { job } = await run(db, 'job-ra51e-env-03', 'file', {
      fault: p => {
        if (p !== 'before-keys-env') return;
        stray = path.join(supersededOf('job-ra51e-env-03'), '.env');
        fs.writeFileSync(stray, 'STRAY=1\n');
      },
    });
    expect(job, why(job)).not.toMatchObject({ state: 'done' });
    expect(job.error).toBe(`${stray} exists; nothing was moved`);
    expect(fs.readFileSync(stray, 'utf8')).toBe('STRAY=1\n');
    expect(fs.readFileSync(ENV, 'utf8')).toBe(`DATA_BACKEND=postgres\n${K}=${OLD}\n`);
  });

  it('a bot without a manager whose /data/.env cannot take DATA_BACKEND by placing time is refused before anything is placed', async () => {
    const db = await onPostgres();
    const { job } = await run(db, 'job-ra51e-env-04', 'file', {
      fault: p => { if (p === 'S8') fs.writeFileSync(ENV, 'A=1\nOTHER:'); },
    });
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'placing' });
    expect(job.error).toBe(`Writing DATA_BACKEND would change the value of OTHER in ${ENV}; edit that line of ${ENV}, then run the migration again`);
    expect(readJson(MARKER)).toMatchObject({ live: 'postgres' });
    expect(fs.readFileSync(ENV, 'utf8')).toBe('A=1\nOTHER:');
  });
});

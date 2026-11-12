import fs from 'fs';
import path from 'path';
import { format } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials, providerCredentialsPath } from '../../src/utils/envLoader';
import { flushAll, setGuildWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, shaOf } from '../../src/bot/internalSetup/utils/sharedStore';
import { supersededName, type ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { setBackendKind } from '../helpers/backendKind';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// The mutation gate's survivors in dataMigration.ts (chunk 45): the closed-tail names, the graveyard's used_at
// through the copy and its read-back, the credentials file moved aside, and the T4 texts of pinned keys.

const G1 = '880000000000000001';
const G2 = '880000000000000002';
const RETIRED = 1700000000000;
const USED = 1700000000500;
const CFG = path.join(root, 'cfg', 'config.json');
const MODS = path.join(root, 'srcmods');
const DOC_KEY = 'global/payment-providers/credentials.json';
const MIRROR = providerCredentialsPath();
const K = 'STRIPE_SECRET_KEY';
const K2 = 'STRIPE_WEBHOOK_SECRET';
const PK = 'PAYPAL_CLIENT_ID';
const OLD = 'sk_old_madeup_0001';
const NEW = 'sk_new_madeup_0002';
const TAIL_ONE = 'remove it from the container environment, restart the container, and run the migration again';
const TAIL_MANY = 'remove them from the container environment, restart the container, and run the migration again';

const opts = (extra: ServiceOptions = {}): ServiceOptions => ({ rootConfigPath: CFG, sourceModulesDir: MODS, ...extra });
let lines: string[];

function clearProviderEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (/^(STRIPE_|PAYPAL_|PATREON_|LEMONSQUEEZY_)|^WEBUI_BASE_URL$|^DATA_BACKEND$|^DISCORD_APPLICATION_ID$|^BOOST_TARGET_GUILD_ID$/.test(key)) delete process.env[key];
  }
}

beforeEach(async () => {
  await flushAll();
  wipeRoot();
  fs.writeFileSync(path.join(root, '.env'), '');
  loadCredentials();
  fs.rmSync(path.join(root, '.env'), { force: true });
  clearProviderEnv();
  setBackendKind(null);
  setGuildWriteGate(null);
  _resetRowQueue();
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.FLEET_SHARD_COUNT;
  loadCredentials();
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(format(...a)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
  setGuildWriteGate(null);
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

function graveRows(db: FakeDb): any[] {
  return (db.schemas.get('smdb_data') as any).grave;
}

describe('closed tails: each stream copied with a newline added is named in the job and the log', () => {
  it('names a stream of no module, a module stream of a guild and one of a graveyard entry', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"g":1}');
    seedFile(`${G1}/log.jsonl`, '{"e":1}');
    seedFile(`${G1}/m/s.jsonl`, '{"e":2}');
    seedFile(`_graveyard/${G2}-${RETIRED}/.graveyard.json`, JSON.stringify({ reason: 'left' }));
    seedFile(`_graveyard/${G2}-${RETIRED}/m/g.jsonl`, '{"e":3}');
    const { job } = await run(new FakeDb(), 'job-ra45-tail-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const expected = [`log.jsonl of guild ${G1}`, `m/s.jsonl of guild ${G1}`, `m/g.jsonl of graveyard entry ${G2}-${RETIRED}`];
    expect([...job.closedTails].sort()).toEqual([...expected].sort());
    for (const tail of expected) {
      expect(lines).toContain(`[Migration] The stream ${tail} did not end in a newline; it was copied with one added, so its last line stays a line of its own`);
    }
  });
});

describe('a graveyard entry\'s newest restore through a move to Postgres', () => {
  it('stores used_at on every row of the entry and the read-back matches the source', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"g":1}');
    seedFile(`_graveyard/${G2}-${RETIRED}/.graveyard.json`, JSON.stringify({ reason: 'left', usedAt: USED }));
    seedFile(`_graveyard/${G2}-${RETIRED}/m/a.json`, '{"d":1}');
    seedFile(`_graveyard/${G2}-${RETIRED}/m/b.json`, '{"d":2}');
    const db = new FakeDb();
    const { job } = await run(db, 'job-ra45-used-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const rows = graveRows(db);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.reason).toBe('left');
      expect(String(r.used_at)).toBe(String(USED));
    }
  });

  it('an entry with no restore stores no used_at and is done', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"g":1}');
    seedFile(`_graveyard/${G2}-${RETIRED}/.graveyard.json`, JSON.stringify({ reason: 'left' }));
    seedFile(`_graveyard/${G2}-${RETIRED}/m/a.json`, '{"d":1}');
    const db = new FakeDb();
    const { job } = await run(db, 'job-ra45-used-02', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    const rows = graveRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].used_at ?? null).toBeNull();
  });
});

describe('the credentials file under /data/global moved aside', () => {
  it('refuses when the superseded folder holds that file already, and moves nothing', async () => {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"g":1}');
    const stale = JSON.stringify({ stripe: { [K]: OLD } }, null, 2);
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    fs.writeFileSync(MIRROR, stale);
    const jobId = 'job-ra45-aside-01';
    const decoy = 'decoy bytes';
    const candidates: string[] = [];
    const t0 = Date.now();
    let posted: number | null = null;
    const service = serviceFor(new FakeDb(), new FakeHost(), opts({
      fault: p => {
        if (p !== 'S3') return;
        const t1 = posted ?? Date.now();
        for (let t = t0; t <= t1; t++) {
          const to = path.join(root, '_superseded', supersededName(jobId, new Date(t)), 'global', 'payment-providers', 'credentials.json');
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.writeFileSync(to, decoy);
          candidates.push(to);
        }
      },
    }));
    await service.post({ jobId, to: 'postgres' });
    posted = Date.now();
    await service.idle();
    const job = service.status().body.job;
    expect(job, why(job)).toMatchObject({ state: 'failed' });
    const named = candidates.filter(to => job.error === `${to} exists; nothing was moved`);
    expect(named, why(job)).toHaveLength(1);
    expect(fs.readFileSync(MIRROR, 'utf8')).toBe(stale);
    expect(fs.readFileSync(named[0], 'utf8')).toBe(decoy);
  });
});

describe('T4: a move to JSON refused when the container pins payment provider keys', () => {
  async function onPostgres(): Promise<FakeDb> {
    freshJsonBot();
    seedFile(`${G1}/m/a.json`, '{"g":1}');
    const db = new FakeDb();
    const { job } = await run(db, 'job-ra45-src-01', 'postgres');
    expect(job, why(job)).toMatchObject({ state: 'done' });
    return db;
  }

  function pgDoc(db: FakeDb, body: string): void {
    const store = db.schemas.get('smdb_data')!;
    store.docs = (store.docs ?? []).filter(d => d.key !== DOC_KEY);
    store.docs.push({ key: DOC_KEY, body: Buffer.from(body), sha: shaOf(Buffer.from(body)), rev: 900, updated_by: 'webui' });
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    fs.writeFileSync(MIRROR, body);
  }

  async function refusal(doc: string, pins: string[], jobId: string): Promise<string> {
    const db = await onPostgres();
    pgDoc(db, doc);
    for (const key of pins) process.env[key] = NEW;
    loadCredentials();
    const { job } = await run(db, jobId, 'file');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'reading' });
    return String(job.error);
  }

  it('two keys of the doc pinned: one text naming both, "them"', async () => {
    const error = await refusal(JSON.stringify({ stripe: { [K]: OLD, [K2]: OLD } }), [K, K2], 'job-ra45-t4-01');
    expect(error).toBe(`${K}, ${K2} are set by the container environment, which a JSON bot reads before /data/.env, so after the move the bot would not read those payment provider keys as the database holds them; ${TAIL_MANY}`);
  });

  it('an unread doc and one pinned key: names it, "that provider\'s", "it"', async () => {
    const error = await refusal('{"stripe": sk_madeup}', [K], 'job-ra45-t4-02');
    expect(error).toBe(`${K} is set by the container environment, and the database's payment provider keys cannot be read, so after the move the bot would read ${K} from the container while on Postgres it reads none of that provider's keys; ${TAIL_ONE}`);
  });

  it('an unread doc and keys of two providers pinned: "those providers\'", "them"', async () => {
    const error = await refusal('{"stripe": sk_madeup}', [K, PK], 'job-ra45-t4-03');
    expect(error).toBe(`${K}, ${PK} are set by the container environment, and the database's payment provider keys cannot be read, so after the move the bot would read them from the container while on Postgres it reads none of those providers' keys; ${TAIL_MANY}`);
  });

  it('an unread entry and its pinned key: names the provider', async () => {
    const error = await refusal(JSON.stringify({ stripe: 'x' }), [K], 'job-ra45-t4-04');
    expect(error).toBe(`${K} is set by the container environment, and the database's keys of stripe cannot be read, so after the move the bot would read ${K} from the container while on Postgres it reads none of stripe's keys; ${TAIL_ONE}`);
  });

  it('unread entries of two providers, each with a pinned key: the text names the first provider\'s key only', async () => {
    const error = await refusal(JSON.stringify({ stripe: 'x', paypal: 'y' }), [K, PK], 'job-ra45-t4-05');
    expect(error).toBe(`${K} is set by the container environment, and the database's keys of stripe cannot be read, so after the move the bot would read ${K} from the container while on Postgres it reads none of stripe's keys; ${TAIL_ONE}`);
  });
});

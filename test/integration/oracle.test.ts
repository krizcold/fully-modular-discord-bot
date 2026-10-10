import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { poolFor, startPostgres } from '../helpers/postgres';
import { FAKE_SCHEMA, startFakeApp, type DeleteFault, type WriteFault } from '../oracle/fakeApp';
import { dbCopy } from '../oracle/judge.mjs';
import { biteStatements, dumpSql, hashOf, parseLog } from '../oracle/oracle.mjs';

// The oracle end to end: the writer, the app-path reader, the fleet reader and
// the checker run as child processes against stand-in nodes on real
// Postgres, and the database copy is taken with the exact psql query the live
// runs use. The bite test (VERIFY.md 5.5) tampers with that database.

const here = path.dirname(fileURLToPath(import.meta.url));
const ORACLE = path.join(here, '../oracle/oracle.mjs');
const CHECK = path.join(here, '../oracle/check.mjs');
const GUILD = '123456789012345678';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let forkPool: Pool;
let dir: string;

function runNode(args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const file = (name: string) => path.join(dir, name);

async function psql(db: string, sql: string): Promise<string> {
  const r = await container.exec(['psql', '-U', container.getUsername(), '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
  if (r.exitCode !== 0) throw new Error(`psql: ${r.stderr || r.output}`);
  return r.stdout;
}

// testcontainers decodes exec output chunk by chunk, which splits a
// multi-byte character at a chunk edge: the listing comes out in base64, and
// only whole bytes are decoded.
async function dump(db: string, run: string, name: string): Promise<string> {
  const r = await container.exec(['sh', '-c', `psql -U "$U" -d "$D" -v ON_ERROR_STOP=1 -At -c "$Q" > /tmp/oracle-dump && base64 /tmp/oracle-dump`], {
    env: { U: container.getUsername(), D: db, Q: dumpSql(GUILD, run) },
  });
  if (r.exitCode !== 0) throw new Error(`psql: ${r.stderr || r.output}`);
  fs.writeFileSync(file(name), Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64'));
  return file(name);
}

async function write(run: string, lanes: string[], extra: string[], marks?: () => Promise<void>): Promise<string> {
  const log = file(`${run}.jsonl`);
  const [r] = await Promise.all([
    runNode([ORACLE, 'write', '--run', run, '--guild', GUILD, ...lanes.flatMap(l => ['--lane', l]), '--log', log, ...extra]),
    marks ? marks() : Promise.resolve(),
  ]);
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  return log;
}

async function check(args: string[]): Promise<{ code: number | null; stdout: string; result: any }> {
  const out = file(`check-${Math.random().toString(36).slice(2)}.json`);
  const r = await runNode([CHECK, ...args, '--out', out]);
  expect(r.stderr).toBe('');
  return { code: r.code, stdout: r.stdout, result: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const classes = (log: string) => new Set(parseLog(fs.readFileSync(log, 'utf8')).filter(e => e.t === 'ans').map(e => e.cls));

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-oracle-'));
  container = await startPostgres();
  pool = poolFor(container);
  await pool.query('CREATE DATABASE forkb');
  forkPool = new Pool({ connectionString: container.getConnectionUri().replace(/\/[^/]*$/, '/forkb'), max: 4 });
  for (const p of [pool, forkPool]) for (const ddl of FAKE_SCHEMA) await p.query(ddl);
});

afterAll(async () => {
  await forkPool?.end();
  await pool?.end();
  await container?.stop();
  // SMDB_KEEP_TEST_FILES keeps the logs and copies for a look after a failure.
  if (dir && !process.env.SMDB_KEEP_TEST_FILES) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the data-loss oracle end to end', () => {
  let cleanLog = '';

  it('passes a clean run through two nodes, with held, refused, ambiguous and unanswered writes', async () => {
    let n = 0;
    // Answers the route really gives that claim nothing lost: none may raise a verdict.
    const writeFault = (): WriteFault => {
      n += 1;
      if (n % 23 === 0) return 'hang';
      if (n % 11 === 0) return 'refuse';
      if (n % 10 === 0) return 'ambiguous';
      if (n % 9 === 0) return 'held';
      return 'normal';
    };
    const fleetState = (nodeId: string, leases: number[]) => () => ({
      initialized: true, role: nodeId === 'm' ? 'master' : 'co-worker', standalone: false, nodeId, shardCount: 2,
      leases: leases.map(shardId => ({ shardId, leaseId: `lease-${shardId}` })),
      shardTable: nodeId === 'm' ? [{ shardId: 0, nodeId: 'm', status: 'Ready' }, { shardId: 1, nodeId: 'w', status: 'Ready' }] : [],
      guildMap: { [GUILD]: 1 },
      // Fields the reduction must drop before anything is written.
      dataBackendUrl: 'postgres://smdb:hunter2@10.0.0.9:5432/smdb',
      nodes: [{ url: 'https://user:hunter2@node.example' }],
    });
    const master = await startFakeApp({ pools: [pool], writeFault, fleetState: fleetState('m', [0]) });
    const worker = await startFakeApp({ pools: [pool], writeFault, fleetState: fleetState('w', [1]) });
    const marks = file('clean-marks.txt');
    fs.writeFileSync(marks, '');
    try {
      cleanLog = await write('clean', [`a=${master.url}`, `b=${worker.url}`],
        ['--duration', '4', '--rate', '25', '--limiter', 'off', '--hot', '2', '--read-every', '3', '--max-size', '2048', '--timeout', '400', '--seed', '7', '--marks', marks],
        async () => {
          await sleep(1000);
          fs.appendFileSync(marks, 'begin burst\n');
          await sleep(1500);
          fs.appendFileSync(marks, 'end burst\n');
        });
      for (const [name, app] of [['app-a', master], ['app-b', worker]] as const) {
        const r = await runNode([ORACLE, 'read', '--log', cleanLog, '--target', app.url, '--name', name, '--limiter', 'off', '--out', file(`clean-${name}.jsonl`)]);
        expect(r.code).toBe(0);
        const f = await runNode([ORACLE, 'fleet', '--target', app.url, '--name', name, '--out', file(`clean-fleet-${name}.json`)]);
        expect(f.code).toBe(0);
      }
    } finally {
      await master.close();
      await worker.close();
    }
    expect(classes(cleanLog)).toEqual(new Set(['ACKED', 'HELD', 'REFUSED', 'UNKNOWN']));
    const fleetText = fs.readFileSync(file('clean-fleet-app-a.json'), 'utf8');
    expect(fleetText).not.toContain('hunter2');
    expect(JSON.parse(fleetText).state.leases).toEqual([{ shardId: 0 }]);

    const db = await dump('test', 'clean', 'clean-db.jsonl');
    const r = await check(['--log', cleanLog, '--db', `db=${db}`, '--app', file('clean-app-a.jsonl'), '--app', file('clean-app-b.jsonl'),
      '--agree', 'db,app-a,app-b', '--fleet', file('clean-fleet-app-a.json'), '--fleet', file('clean-fleet-app-b.json'), '--k', '3']);
    expect(r.result.verdicts).toEqual([]);
    expect(r.result.inconclusive).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('RESULT PASS (operator route; module path unproven)');
    expect(r.result.reads).toBeGreaterThan(0);
  });

  it('bites: a deleted acknowledged doc is LOST and a lowered counter is ROLLBACK', async () => {
    const bite = biteStatements([parseLog(fs.readFileSync(cleanLog, 'utf8'))]);
    const printed = await runNode([ORACLE, 'bite', '--log', cleanLog]);
    expect(printed.stdout).toContain(bite.lost.sql);
    expect(printed.stdout).toContain(bite.rollback.sql);
    await psql('test', bite.lost.sql);
    await psql('test', bite.rollback.sql);
    const db = await dump('test', 'clean', 'bitten-db.jsonl');
    const r = await check(['--log', cleanLog, '--db', `db=${db}`, '--no-fleet', '--k', '3']);
    expect(r.code).toBe(1);
    expect(r.result.verdicts.map((v: any) => `${v.v} ${v.key}`).sort())
      .toEqual([`LOST ${bite.lost.key}`, `ROLLBACK ${bite.rollback.key}`].sort());
  });

  it('names each injected fault on the doc it hit, and nothing else', async () => {
    const expected = new Map<string, string>();
    let unique = 0;
    const writeFault = (key: string, data: any): WriteFault => {
      if (data.kind !== 'u') return 'normal';
      unique += 1;
      const fault = ({ 4: 'ack-no-write', 7: 'held-no-write', 10: 'refuse-but-write', 13: 'corrupt' } as Record<number, WriteFault>)[unique];
      if (!fault) return 'normal';
      expected.set(key, { 'ack-no-write': 'LOST', 'held-no-write': 'HELD-MISSING', 'refuse-but-write': 'PHANTOM', corrupt: 'WRONG-CONTENT' }[fault as string] as string);
      return fault;
    };
    let resurrected = false;
    // The writer reads a doc before deleting it and deletes only the doc as
    // written, so the faulted docs are never deleted: the first delete is of a sound doc.
    const deleteFault = (key: string): DeleteFault => {
      if (resurrected) return 'normal';
      resurrected = true;
      expected.set(key, 'RESURRECTED');
      return 'ack-noop';
    };
    const staleKey = 'faults-h0.json';
    const app = await startFakeApp({ pools: [pool], writeFault, deleteFault, staleRead: key => key === staleKey });
    let log = '';
    try {
      log = await write('faults', [`a=${app.url}`, `b=${app.url}`],
        ['--duration', '3', '--rate', '25', '--limiter', 'off', '--hot', '1', '--delete-ratio', '0.2', '--read-every', '2', '--max-size', '1024', '--seed', '11']);
    } finally {
      await app.close();
    }
    expect(expected.size).toBe(5);
    const deleted = new Set(parseLog(fs.readFileSync(log, 'utf8')).filter(e => e.t === 'send' && e.op === 'delete').map(e => e.key));
    expect([...expected].filter(([k, v]) => v !== 'RESURRECTED' && deleted.has(k))).toEqual([]);
    const db = await dump('test', 'faults', 'faults-db.jsonl');
    const r = await check(['--log', log, '--db', `db=${db}`, '--no-fleet', '--k', '3']);
    expect(r.code).toBe(1);
    const final = r.result.verdicts.filter((v: any) => !v.during);
    expect(final.map((v: any) => `${v.v} ${v.key}`).sort()).toEqual([...expected].map(([k, v]) => `${v} ${k}`).sort());
    const during = r.result.verdicts.filter((v: any) => v.during);
    expect(during.every((v: any) => expected.has(v.key) || v.key === staleKey)).toBe(true);
    expect(during.some((v: any) => v.key === staleKey && (v.v === 'ROLLBACK' || v.v === 'LOST'))).toBe(true);
  });

  it('names a fork when two databases each took writes the other lacks', async () => {
    // Odd unique docs go to the second database, everything else to the first.
    const route = (key: string) => Number(/-u(\d+)\.json$/.exec(key)?.[1] ?? 0) % 2;
    const app = await startFakeApp({ pools: [pool, forkPool], route });
    let log = '';
    try {
      log = await write('fork', [`a=${app.url}`], ['--duration', '2', '--rate', '25', '--limiter', 'off', '--hot', '0', '--delete-ratio', '0', '--seed', '3']);
    } finally {
      await app.close();
    }
    const a = await dump('test', 'fork', 'fork-a.jsonl');
    const b = await dump('forkb', 'fork', 'fork-b.jsonl');
    for (const mode of ['--db', '--lag']) {
      const r = await check(['--log', log, '--db', `a=${a}`, mode, `b=${b}`, '--no-fleet', '--k', '3']);
      expect(r.code).toBe(1);
      expect(r.result.verdicts.some((v: any) => v.v === 'FORK')).toBe(true);
    }
  });

  it('keeps inside the web UI rate limit and body limit at its defaults', async () => {
    const app = await startFakeApp({ pools: [pool], rateLimit: true });
    const marks = file('limits-marks.txt');
    fs.writeFileSync(marks, '');
    let log = '';
    try {
      // Payloads up to ten times the body limit, each cut to fit before it is
      // sent, and a window that bursts until the limiter's reserve is spent.
      log = await write('limits', [`a=${app.url}`], ['--duration', '8', '--max-size', '100000', '--seed', '5', '--marks', marks], async () => {
        await sleep(1000);
        fs.appendFileSync(marks, 'begin burst\n');
        await sleep(5000);
        fs.appendFileSync(marks, 'end burst\n');
      });
    } finally {
      await app.close();
    }
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    expect(events.filter(e => e.t === 'mark')).toHaveLength(2);
    expect(events.filter(e => e.t === 'ans' && (e.status === 429 || e.status === 500))).toEqual([]);
    expect(Math.max(...events.filter(e => e.t === 'send').map(e => e.size))).toBeGreaterThan(5000);
    const db = await dump('test', 'limits', 'limits-db.jsonl');
    const c = await check(['--log', log, '--db', `db=${db}`, '--no-fleet', '--k', '3']);
    expect(c.result.verdicts).toEqual([]);
    expect(c.code).toBe(0);
  });

  it('reads and cleans up at the web UI rate limit, past its burst of 10', async () => {
    const open = await startFakeApp({ pools: [pool] });
    let log = '';
    try {
      log = await write('pace', [`a=${open.url}`], ['--duration', '3', '--rate', '10', '--limiter', 'off', '--hot', '0', '--delete-ratio', '0', '--read-every', '0', '--seed', '9']);
    } finally {
      await open.close();
    }
    const keys = new Set(parseLog(fs.readFileSync(log, 'utf8')).filter(e => e.t === 'send').map(e => e.key));
    expect(keys.size).toBeGreaterThan(15);
    const limited = await startFakeApp({ pools: [pool], rateLimit: true });
    try {
      const r = await runNode([ORACLE, 'read', '--log', log, '--target', limited.url, '--name', 'paced', '--out', file('pace-app.jsonl')]);
      expect(r.code).toBe(0);
      const rows = fs.readFileSync(file('pace-app.jsonl'), 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l));
      expect(rows).toHaveLength(keys.size);
      expect(rows.filter(row => row.s !== 'present')).toEqual([]);
      const c = await check(['--log', log, '--db', `db=${await dump('test', 'pace', 'pace-db.jsonl')}`, '--app', file('pace-app.jsonl'), '--no-fleet', '--k', '3']);
      expect(c.code).toBe(0);
      const clean = await runNode([ORACLE, 'cleanup', '--log', log, '--target', limited.url]);
      expect(clean.code).toBe(0);
    } finally {
      await limited.close();
    }
    expect(fs.readFileSync(await dump('test', 'pace', 'pace-after.jsonl'), 'utf8').trim()).toBe('');
  }, 120_000);

  it('stops within its grace when requests hang, and still writes its end line', async () => {
    const app = await startFakeApp({ pools: [pool], writeFault: () => 'hang' });
    const began = Date.now();
    let log = '';
    try {
      log = await write('grace', [`a=${app.url}`, `b=${app.url}`], ['--duration', '1', '--limiter', 'off', '--timeout', '60000']);
    } finally {
      await app.close();
    }
    expect(Date.now() - began).toBeLessThan(15_000);
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    expect(events.at(-1)?.t).toBe('end');
    const answers = events.filter(e => e.t === 'ans');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every(e => e.cls === 'UNKNOWN' && /cut short/.test(e.err))).toBe(true);
  });

  it('sends no delete once stopped, even after the read before it', async () => {
    // The read before a delete answers 3 s late, past the stop at 1 s and inside the 5 s grace.
    const app = await startFakeApp({ pools: [pool], readDelayMs: 3000 });
    let log = '';
    try {
      log = await write('nodel', [`a=${app.url}`],
        ['--duration', '1', '--rate', '25', '--limiter', 'off', '--hot', '0', '--hot-ratio', '0', '--delete-ratio', '1', '--read-every', '0']);
    } finally {
      await app.close();
    }
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    expect(events.some(e => e.t === 'read')).toBe(true);
    expect(events.filter(e => e.t === 'send' && e.op === 'delete')).toEqual([]);
    expect(events.at(-1)?.t).toBe('end');
  });

  it('judges two writers on one run, each with its own log', async () => {
    const app = await startFakeApp({ pools: [pool] });
    let logs: string[] = [];
    try {
      logs = await Promise.all(['a', 'b'].map(async lane => {
        const out = file(`two-${lane}.jsonl`);
        const r = await runNode([ORACLE, 'write', '--run', 'two', '--guild', GUILD, '--lane', `${lane}=${app.url}`, '--log', out,
          '--duration', '3', '--rate', '20', '--limiter', 'off', '--hot', '1', '--seed', lane === 'a' ? '1' : '2']);
        expect(r.code).toBe(0);
        return out;
      }));
      // A read line names its own lane; the lane the served content names goes under `by`.
      const reads = logs.map((l, i) => parseLog(fs.readFileSync(l, 'utf8')).filter(e => e.t === 'read').map(e => ({ ...e, own: ['a', 'b'][i] })));
      expect(reads.flat().every(e => e.lane === e.own)).toBe(true);
      const present = reads.flat().filter(e => e.s === 'present');
      expect(present.length).toBeGreaterThan(0);
      expect(present.every(e => typeof e.by === 'string')).toBe(true);
      const both = logs.flatMap(l => ['--log', l]);
      expect((await runNode([ORACLE, 'read', ...both, '--target', app.url, '--name', 'two-app', '--limiter', 'off', '--out', file('two-app.jsonl')])).code).toBe(0);
      const c = await check([...both, '--db', `db=${await dump('test', 'two', 'two-db.jsonl')}`, '--app', file('two-app.jsonl'), '--no-fleet', '--k', '3']);
      expect(c.result.verdicts).toEqual([]);
      expect(c.code).toBe(0);
      expect((await runNode([ORACLE, 'cleanup', ...both, '--target', app.url, '--limiter', 'off'])).code).toBe(0);
    } finally {
      await app.close();
    }
    expect(fs.readFileSync(await dump('test', 'two', 'two-after.jsonl'), 'utf8').trim()).toBe('');
  });

  it('takes a database copy that keeps multi-byte text whole', async () => {
    const content = { run: 'bytes', lane: 'a', kind: 'u', key: 'bytes-a-u1.json', c: 1, pad: '🙂漢é "\\'.repeat(12000) };
    await pool.query('INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, $2, $3, $4)',
      [GUILD, 'oracle', 'bytes-a-u1.json', JSON.stringify(content, null, 2)]);
    const copy = dbCopy('db', 'judged', fs.readFileSync(await dump('test', 'bytes', 'bytes-db.jsonl'), 'utf8'));
    expect(copy.docs.get('bytes-a-u1.json')).toEqual({ s: 'present', h: hashOf(content), lane: 'a', c: 1 });
  });

  it('runs piped into node with no checkout, its log on stdout', async () => {
    const app = await startFakeApp({ pools: [pool] });
    let r;
    try {
      r = await runNode(['--input-type=module', '-', 'write', '--run', 'piped', '--guild', GUILD, '--lane', `a=${app.url}`, '--duration', '1', '--rate', '20'],
        fs.readFileSync(ORACLE, 'utf8'));
    } finally {
      await app.close();
    }
    expect(r.code).toBe(0);
    fs.writeFileSync(file('piped.jsonl'), r.stdout);
    const db = await dump('test', 'piped', 'piped-db.jsonl');
    const c = await check(['--log', file('piped.jsonl'), '--db', `db=${db}`, '--no-fleet', '--k', '3']);
    expect(c.result.verdicts).toEqual([]);
    expect(c.code).toBe(0);
  });

  it('names a shard leased to two nodes', async () => {
    const state = (nodeId: string) => () => ({ initialized: true, nodeId, shardCount: 2, leases: [{ shardId: 1 }], shardTable: [], guildMap: {} });
    const m = await startFakeApp({ pools: [pool], fleetState: state('m') });
    const w = await startFakeApp({ pools: [pool], fleetState: state('w') });
    // A node whose bot child did not answer: the route still says 200.
    const down = await startFakeApp({ pools: [pool], fleetState: () => ({ initialized: false }) });
    try {
      for (const [name, app] of [['m', m], ['w', w]] as const) {
        expect((await runNode([ORACLE, 'fleet', '--target', app.url, '--name', name, '--out', file(`twice-${name}.json`)])).code).toBe(0);
      }
      expect((await runNode([ORACLE, 'fleet', '--target', down.url, '--name', 'down', '--out', file('twice-down.json')])).code).toBe(1);
      expect(JSON.parse(fs.readFileSync(file('twice-down.json'), 'utf8')).state.initialized).toBe(false);
    } finally {
      await m.close();
      await w.close();
      await down.close();
    }
    const db = await dump('test', 'clean', 'twice-db.jsonl');
    const fleets = ['--fleet', file('twice-m.json'), '--fleet', file('twice-w.json')];
    const r = await check(['--log', cleanLog, '--db', `db=${db}`, ...fleets, '--k', '3']);
    expect(r.result.verdicts.some((v: any) => v.v === 'CONTROL' && /shard 1 is leased to 2 nodes/.test(v.detail))).toBe(true);
    // Seen again in a second set, listed the other way round, it still counts.
    const again = await check(['--log', cleanLog, '--db', `db=${db}`, ...fleets, '--fleet-again', file('twice-w.json'), '--fleet-again', file('twice-m.json'), '--k', '3']);
    expect(again.result.verdicts.filter((v: any) => v.v === 'CONTROL').map((v: any) => v.detail)).toEqual(['shard 1 is leased to 2 nodes at once: m, w']);
    expect(again.code).toBe(1);
    expect((await runNode([CHECK, '--log', cleanLog, '--db', `db=${db}`, '--fleet-again', file('twice-m.json')])).code).toBe(64);
  });

  it('refuses a streamed copy cut short, and judges the writer\'s own file', async () => {
    const app = await startFakeApp({ pools: [pool] });
    let r;
    try {
      r = await runNode([ORACLE, 'write', '--run', 'sinks', '--guild', GUILD, '--lane', `a=${app.url}`, '--log', file('sinks.jsonl'), '--log', '-',
        '--duration', '1', '--rate', '20', '--limiter', 'off']);
    } finally {
      await app.close();
    }
    expect(r.code).toBe(0);
    const streamed = r.stdout.trim().split('\n');
    expect(JSON.parse(streamed[0]).sink).toBe('stream');
    expect(parseLog(fs.readFileSync(file('sinks.jsonl'), 'utf8'))[0].sink).toBe('file');
    fs.writeFileSync(file('sinks-cut.jsonl'), `${streamed.slice(0, -1).join('\n')}\n`);
    const db = await dump('test', 'sinks', 'sinks-db.jsonl');
    const cut = await runNode([CHECK, '--log', file('sinks-cut.jsonl'), '--db', `db=${db}`, '--no-fleet', '--k', '3']);
    expect(cut.code).toBe(64);
    expect(cut.stderr).toMatch(/streamed copy with no end line/);
    const whole = await check(['--log', file('sinks.jsonl'), '--db', `db=${db}`, '--no-fleet', '--k', '3']);
    expect(whole.result.verdicts).toEqual([]);
    expect(whole.code).toBe(0);
  });

  it('refuses a database copy when psql fails', async () => {
    await expect(dump('nosuchdb', 'none', 'none-db.jsonl')).rejects.toThrow(/psql/);
  });

  it('logs an end mark written just before the stop', async () => {
    const app = await startFakeApp({ pools: [pool] });
    const marks = file('last-marks.txt');
    fs.writeFileSync(marks, '');
    let log = '';
    try {
      // The marks file is polled once a minute here, so only the poll at the stop can see these lines.
      log = await write('last', [`a=${app.url}`], ['--duration', '2', '--limiter', 'off', '--marks', marks, '--marks-every', '60000'], async () => {
        await sleep(500);
        fs.appendFileSync(marks, 'begin x\nend x\n');
      });
    } finally {
      await app.close();
    }
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    expect(events.filter(e => e.t === 'mark').map(e => e.label)).toEqual(['begin x', 'end x']);
    expect(events.at(-1)?.t).toBe('end');
  });

  it('ends its log on SIGHUP, and on a second signal mid-request', async () => {
    // A Node child takes signals only on POSIX, so the writer runs in the image the live procedure uses.
    const box = await new GenericContainer('node:24-alpine')
      .withCopyFilesToContainer([{ source: ORACLE, target: '/o/oracle.mjs' }])
      .withCommand(['sleep', '600'])
      .start();
    const sh = async (cmd: string) => (await box.exec(['sh', '-c', cmd])).stdout;
    const start = (run: string, port: number) => sh(`node /o/oracle.mjs write --run ${run} --guild ${GUILD} --lane a=http://127.0.0.1:${port} `
      + `--duration 0 --rate 5 --limiter off --timeout 60000 --log /tmp/${run}.jsonl > /dev/null 2>&1 & echo $! > /tmp/${run}.pid`);
    const ended = async (run: string) => {
      for (let i = 0; i < 100; i++) {
        const events = parseLog(await sh(`cat /tmp/${run}.jsonl`));
        if (events.at(-1)?.t === 'end') return events;
        await sleep(100);
      }
      throw new Error(`${run}: no end line`);
    };
    try {
      // Nothing listens on 8080, so requests fail at once.
      await start('hup', 8080);
      await sleep(1000);
      await sh('kill -HUP $(cat /tmp/hup.pid)');
      expect((await ended('hup')).some(e => e.t === 'ans')).toBe(true);
      // A server that never answers holds the first request through the stop grace; a second signal ends the run at once.
      await sh(`node -e "require('net').createServer(() => {}).listen(8081)" > /dev/null 2>&1 &`);
      await sleep(500);
      await start('term', 8081);
      await sleep(1000);
      await sh('kill -TERM $(cat /tmp/term.pid)');
      await sleep(300);
      await sh('kill -TERM $(cat /tmp/term.pid)');
      const term = await ended('term');
      const answered = new Set(term.filter(e => e.t === 'ans').map(e => e.id));
      expect(term.some(e => e.t === 'send' && !answered.has(e.id))).toBe(true);
    } finally {
      await box.stop();
    }
  }, 120_000);
});

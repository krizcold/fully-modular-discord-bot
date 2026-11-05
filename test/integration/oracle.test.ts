import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endPool } from '../helpers/endPool';
import { poolFor, startPostgres } from '../helpers/postgres';
import { FAKE_SCHEMA, startFakeApp, type DeleteFault, type WriteFault } from '../oracle/fakeApp';
import { dbCopy } from '../oracle/judge.mjs';
import { biteStatements, dumpSql, hashOf, parseLog } from '../oracle/oracle.mjs';

// The oracle end to end: the writer, the app-path reader, the fleet reader and
// the checker run as child processes against fake nodes on real
// Postgres, and the database copy is taken with the exact psql query the live
// runs use. The bite test (VERIFY.md 5.5) tampers with that database.

const here = path.dirname(fileURLToPath(import.meta.url));
const ORACLE = path.join(here, '../oracle/oracle.mjs');
const CHECK = path.join(here, '../oracle/check.mjs');
const GUILD = '123456789012345678';
const SHARD_CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS smdb_data.shard_claims (shard_count integer NOT NULL, shard_id integer NOT NULL,
  claim bigint NOT NULL, holder_process text NOT NULL, holder_node text, released boolean NOT NULL DEFAULT false, PRIMARY KEY (shard_count, shard_id))`;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let forkPool: Pool;
let dir: string;

function runNode(args: string[], input?: string, tap?: { stdout: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (tap) tap.stdout = stdout;
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const file = (name: string) => path.join(dir, name);

// A writer the test stops runs until its log holds what the test needs, so a
// loaded machine makes a run longer, never thinner; this duration only ends a
// writer whose test failed before stopping it.
const BACKSTOP_S = '60';
// Past this wait the writer is stopped anyway and the test's own checks fail.
const UNTIL_MS = 20_000;
const logOf = (log: string) => () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

async function until(logs: (() => string)[], enough: (events: any[][]) => boolean): Promise<void> {
  const began = Date.now();
  while (!enough(logs.map(text => parseLog(text()))) && Date.now() - began < UNTIL_MS) await sleep(50);
}

const started = (events: any[]) => events.some(e => e.t === 'start');
const ackedIn = (events: any[]) => events.filter(e => e.t === 'ans' && e.cls === 'ACKED');
const marked = (events: any[], label: string) => events.find(e => e.t === 'mark' && e.label === label);
// Acknowledged answers after a begin mark, the ones the checker counts in that window.
const ackedSince = (events: any[], label: string) => {
  const begin = marked(events, label);
  return begin ? ackedIn(events).filter(e => e.at >= begin.at).length : 0;
};
// Sends whose answer is in the log.
const answeredSends = (events: any[]) => {
  const answers = new Map(events.filter(e => e.t === 'ans').map(e => [e.id, e]));
  return events.filter(e => e.t === 'send' && answers.has(e.id)).map(e => ({ ...e, ans: answers.get(e.id) }));
};

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

// With stopFile (the writer's --marks), a stop line follows the marks callback however it ends.
async function write(run: string, lanes: string[], extra: string[], marks?: (log: () => string) => Promise<void>, stopFile?: string): Promise<string> {
  const log = file(`${run}.jsonl`);
  const [r] = await Promise.all([
    runNode([ORACLE, 'write', '--run', run, '--guild', GUILD, ...lanes.flatMap(l => ['--lane', l]), '--log', log, ...extra]),
    (async () => {
      try {
        if (marks) await marks(logOf(log));
      } finally {
        if (stopFile) fs.appendFileSync(stopFile, 'stop\n');
      }
    })(),
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
  await endPool(forkPool);
  await endPool(pool);
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
      initialized: true, nodeId, shardCount: 2,
      leases: leases.map(shardId => ({ shardId, leaseId: `lease-${shardId}` })),
      shardTable: leases.map(shardId => ({ shardId, nodeId, status: 'Ready' })),
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
        ['--duration', BACKSTOP_S, '--rate', '25', '--limiter', 'off', '--hot', '2', '--read-every', '3', '--max-size', '2048', '--timeout', '400', '--seed', '7', '--marks', marks],
        async log => {
          await until([log], ([e]) => ackedIn(e).length > 0);
          fs.appendFileSync(marks, 'begin burst\n');
          await until([log], ([e]) => ackedSince(e, 'begin burst') >= 3);
          fs.appendFileSync(marks, 'end burst\n');
          await until([log], ([e]) => marked(e, 'end burst') && e.some(x => x.t === 'read')
            && new Set(e.filter(x => x.t === 'ans').map(x => x.cls)).size === 4);
        }, marks);
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
    expect(JSON.parse(fleetText).state.leases).toEqual([{ shardId: 0, claim: null }]);

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
    const marks = file('faults-marks.txt');
    fs.writeFileSync(marks, '');
    // A read of the hot doc served an older version than one acknowledged before it.
    const staleSeen = (e: any[]) => e.some(r => r.t === 'read' && r.key === staleKey && r.s === 'present'
      && answeredSends(e).some(w => w.key === staleKey && w.ans.cls === 'ACKED' && w.ans.at < r.at0 && w.c > r.c));
    let log = '';
    try {
      log = await write('faults', [`a=${app.url}`, `b=${app.url}`],
        ['--duration', BACKSTOP_S, '--rate', '25', '--limiter', 'off', '--hot', '1', '--delete-ratio', '0.2', '--read-every', '2', '--max-size', '1024', '--seed', '11', '--marks', marks],
        log => until([log], ([e]) => expected.size === 5 && staleSeen(e)
          && [...expected].every(([k, v]) => answeredSends(e).some(s => s.key === k && s.op === (v === 'RESURRECTED' ? 'delete' : 'write')))), marks);
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
    const marks = file('fork-marks.txt');
    fs.writeFileSync(marks, '');
    let log = '';
    try {
      log = await write('fork', [`a=${app.url}`], ['--duration', BACKSTOP_S, '--rate', '25', '--limiter', 'off', '--hot', '0', '--delete-ratio', '0', '--seed', '3', '--marks', marks],
        log => until([log], ([e]) => {
          const sides = new Set(answeredSends(e).filter(s => s.ans.cls === 'ACKED').map(s => route(s.key)));
          return sides.size === 2 && ackedIn(e).length >= 3;
        }), marks);
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
      log = await write('limits', [`a=${app.url}`], ['--duration', BACKSTOP_S, '--max-size', '100000', '--seed', '5', '--marks', marks], async log => {
        await until([log], ([e]) => started(e));
        fs.appendFileSync(marks, 'begin burst\n');
        const began = Date.now();
        await until([log], ([e]) => Date.now() - began >= 5000 && ackedSince(e, 'begin burst') >= 3);
        fs.appendFileSync(marks, 'end burst\n');
        await until([log], ([e]) => marked(e, 'end burst') && e.some(x => x.t === 'send' && x.size > 5000));
      }, marks);
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
    const marks = file('pace-marks.txt');
    fs.writeFileSync(marks, '');
    let log = '';
    try {
      log = await write('pace', [`a=${open.url}`], ['--duration', BACKSTOP_S, '--rate', '10', '--limiter', 'off', '--hot', '0', '--delete-ratio', '0', '--read-every', '0', '--seed', '9', '--marks', marks],
        log => until([log], ([e]) => e.filter(x => x.t === 'send').length > 15), marks);
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
    const marks = file('two-marks.txt');
    fs.writeFileSync(marks, '');
    const logs = ['a', 'b'].map(lane => file(`two-${lane}.jsonl`));
    try {
      // Both writers poll one marks file; each runs until both logs hold a read that found its doc.
      const [results] = await Promise.all([
        Promise.all(['a', 'b'].map((lane, i) => runNode([ORACLE, 'write', '--run', 'two', '--guild', GUILD, '--lane', `${lane}=${app.url}`, '--log', logs[i],
          '--duration', BACKSTOP_S, '--rate', '20', '--limiter', 'off', '--hot', '1', '--seed', lane === 'a' ? '1' : '2', '--marks', marks]))),
        until(logs.map(logOf), each => each.every(e => e.some(x => x.t === 'read' && x.s === 'present'))).finally(() => fs.appendFileSync(marks, 'stop\n')),
      ]);
      for (const r of results) expect(r.code).toBe(0);
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
    const marks = file('piped-marks.txt');
    fs.writeFileSync(marks, '');
    const tap = { stdout: '' };
    let r;
    try {
      [r] = await Promise.all([
        runNode(['--input-type=module', '-', 'write', '--run', 'piped', '--guild', GUILD, '--lane', `a=${app.url}`, '--duration', BACKSTOP_S, '--rate', '20', '--marks', marks],
          fs.readFileSync(ORACLE, 'utf8'), tap),
        until([() => tap.stdout], ([e]) => ackedIn(e).length >= 3).finally(() => fs.appendFileSync(marks, 'stop\n')),
      ]);
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
    expect(r.result.verdicts.some((v: any) => v.v === 'CONTROL' && /shard 1 is leased to 2 processes/.test(v.detail))).toBe(true);
    // Seen again in a second set, listed the other way round, it still counts.
    const again = await check(['--log', cleanLog, '--db', `db=${db}`, ...fleets, '--fleet-again', file('twice-w.json'), '--fleet-again', file('twice-m.json'), '--k', '3']);
    expect(again.result.verdicts.filter((v: any) => v.v === 'CONTROL').map((v: any) => v.detail)).toEqual(['shard 1 is leased to 2 processes at once: m, w']);
    expect(again.code).toBe(1);
    expect((await runNode([CHECK, '--log', cleanLog, '--db', `db=${db}`, '--fleet-again', file('twice-m.json')])).code).toBe(64);
  });

  it('names one claim reported by two processes, and a claim sequence that went back below a live claim', async () => {
    const state = (nodeId: string, processId: string, shardId: number, claim: number) => () =>
      ({ initialized: true, nodeId, processId, shardCount: 2, leases: [{ shardId, leaseId: `lease-${shardId}`, claim }], shardTable: [], guildMap: {} });
    const m = await startFakeApp({ pools: [pool], fleetState: state('m', 'p1', 0, 7) });
    const w = await startFakeApp({ pools: [pool], fleetState: state('w', 'q1', 1, 7) });
    try {
      for (const [name, app] of [['m', m], ['w', w]] as const) {
        expect((await runNode([ORACLE, 'fleet', '--target', app.url, '--name', name, '--out', file(`claim-${name}.json`)])).code).toBe(0);
      }
    } finally {
      await m.close();
      await w.close();
    }
    const reduced = JSON.parse(fs.readFileSync(file('claim-m.json'), 'utf8')).state;
    expect(reduced.processId).toBe('p1');
    expect(reduced.leases).toEqual([{ shardId: 0, claim: 7 }]);
    await psql('test', 'CREATE TABLE IF NOT EXISTS smdb_data.guild_ownership (guild_id text PRIMARY KEY, claim bigint NOT NULL)');
    await psql('test', 'CREATE SEQUENCE IF NOT EXISTS smdb_data.claim_seq');
    await psql('test', SHARD_CLAIMS_DDL);
    await psql('test', "INSERT INTO smdb_data.guild_ownership (guild_id, claim) VALUES ('10', 4), ('11', 5)");
    await psql('test', "SELECT setval('smdb_data.claim_seq', 3)");
    const listing = await runNode([ORACLE, 'sql', 'ownership']);
    expect(listing.code).toBe(0);
    fs.writeFileSync(file('ownership.jsonl'), await psql('test', listing.stdout.trim()));
    // The copy taken before the bite test lowered and deleted clean docs: these checks judge the control facts.
    const db = file('clean-db.jsonl');
    const judged = (ownership: string) => check(['--log', cleanLog, '--db', `db=${db}`, '--fleet', file('claim-m.json'), '--fleet', file('claim-w.json'), '--ownership', ownership, '--k', '3']);
    const r = await judged(file('ownership.jsonl'));
    expect(r.result.verdicts.filter((v: any) => v.v === 'CONTROL').map((v: any) => v.detail)).toEqual([
      'claim 7 is reported 2 times: shard 0 by m (process p1), shard 1 by w (process q1)',
      'a live process holds claim 7, and the next take would draw claim 6 (claim_seq at 3, called; highest guild_ownership claim 5; highest shard_claims claim none): the claim sequence went back',
    ]);
    expect(r.result.notes).toContain('leases were not compared with shard_claims: no claims listing was given (--claims)');
    expect(r.code).toBe(1);
    // A later take of claim 9 that stopped is normal, whether its claim is left in guild_ownership or in shard_claims.
    await psql('test', "INSERT INTO smdb_data.guild_ownership (guild_id, claim) VALUES ('12', 9)");
    await psql('test', "SELECT setval('smdb_data.claim_seq', 9)");
    fs.writeFileSync(file('ownership-later.jsonl'), await psql('test', listing.stdout.trim()));
    const only = ['claim 7 is reported 2 times: shard 0 by m (process p1), shard 1 by w (process q1)'];
    expect((await judged(file('ownership-later.jsonl'))).result.verdicts.map((v: any) => v.detail)).toEqual(only);
    await psql('test', "DELETE FROM smdb_data.guild_ownership WHERE guild_id = '12'");
    await psql('test', "SELECT setval('smdb_data.claim_seq', 3)");
    await psql('test', "INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, released) VALUES (2, 1, 9, 'z1', true)");
    fs.writeFileSync(file('ownership-claims.jsonl'), await psql('test', listing.stdout.trim()));
    expect(JSON.parse(fs.readFileSync(file('ownership-claims.jsonl'), 'utf8'))).toEqual({ last: 3, called: true, highest: 5, claims: 9 });
    expect((await judged(file('ownership-claims.jsonl'))).result.verdicts.map((v: any) => v.detail)).toEqual(only);
    await psql('test', 'DELETE FROM smdb_data.shard_claims');
  });

  it('compares each lease with the shard claims listing, and counts only what both reads show', async () => {
    await psql('test', SHARD_CLAIMS_DDL);
    await psql('test', 'DELETE FROM smdb_data.shard_claims');
    const listingSql = await runNode([ORACLE, 'sql', 'claims']);
    expect(listingSql.code).toBe(0);
    let leases: Record<string, { processId: string; held: Record<number, number> }> = {};
    const state = (nodeId: string) => () => {
      const { processId, held } = leases[nodeId];
      const shards = Object.keys(held).map(Number);
      return { initialized: true, nodeId, processId, shardCount: 2, leases: shards.map(shardId => ({ shardId, leaseId: `lease-${shardId}`, claim: held[shardId] })), shardTable: [], guildMap: {} };
    };
    const rows = async (...list: [number, number, string, boolean?, string?][]) => {
      await psql('test', 'DELETE FROM smdb_data.shard_claims');
      for (const [shard, claim, process, released, node] of list) {
        await psql('test', `INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, released) VALUES (2, ${shard}, ${claim}, '${process}', ${node ? `'${node}'` : 'NULL'}, ${released === true})`);
      }
    };
    const m = await startFakeApp({ pools: [pool], fleetState: state('m') });
    const w = await startFakeApp({ pools: [pool], fleetState: state('w') });
    // One read: each node's control facts, then the listing.
    const read = async (tag: string) => {
      for (const [name, app] of [['m', m], ['w', w]] as const) {
        expect((await runNode([ORACLE, 'fleet', '--target', app.url, '--name', name, '--out', file(`${tag}-${name}.json`)])).code).toBe(0);
      }
      fs.writeFileSync(file(`${tag}-claims.jsonl`), await psql('test', listingSql.stdout.trim()));
    };
    try {
      leases = { m: { processId: 'p1', held: { 0: 11 } }, w: { processId: 'q1', held: { 1: 12 } } };
      await rows([0, 11, 'p1'], [1, 12, 'q1']);
      await read('r1');
      // A legal takeover between the reads: p1 lapsed and stopped serving, q1 took shard 0.
      leases = { m: { processId: 'p1', held: {} }, w: { processId: 'q1', held: { 0: 13, 1: 12 } } };
      await rows([0, 13, 'q1'], [1, 12, 'q1']);
      await read('r2');
      // q1's clean stop released its rows while its last fleet read still showed them.
      await rows([0, 13, 'q1', true], [1, 12, 'q1', true]);
      await read('r2b');
      // w's next process q2 took both shards.
      leases = { m: { processId: 'p1', held: {} }, w: { processId: 'q2', held: { 0: 14, 1: 15 } } };
      await rows([0, 14, 'q2'], [1, 15, 'q2']);
      await read('r3');
      // p1 serves shard 0 under a claim the table does not hold, and q2 no longer reports it.
      leases = { m: { processId: 'p1', held: { 0: 16 } }, w: { processId: 'q2', held: { 1: 15 } } };
      await read('r4');
      await read('r5');
      // Both serve shard 0.
      leases = { m: { processId: 'p1', held: { 0: 16 } }, w: { processId: 'q2', held: { 0: 14, 1: 15 } } };
      await read('r6');
      leases = { m: { processId: 'p1', held: {} }, w: { processId: 'q2', held: { 1: 15 } } };
      await rows([1, 15, 'q2', false, 'w']);
      await read('h1');
      // q2's release hands shard 1 to m while w's last fleet read still shows the lease.
      await rows([1, 15, 'q2', true, 'm']);
      await read('h2');
      // m's next process p2 took the row kept for its node.
      leases = { m: { processId: 'p2', held: { 1: 17 } }, w: { processId: 'q2', held: {} } };
      await rows([1, 17, 'p2', false, 'm']);
      await read('h3');
    } finally {
      await m.close();
      await w.close();
      await psql('test', 'DELETE FROM smdb_data.shard_claims');
    }
    expect(JSON.parse(fs.readFileSync(file('r1-claims.jsonl'), 'utf8'))).toEqual({
      rows: [{ count: 2, shard: 0, claim: 11, process: 'p1', released: false }, { count: 2, shard: 1, claim: 12, process: 'q1', released: false }],
    });
    const db = file('clean-db.jsonl');
    const judged = (a: string, b: string) => check(['--log', cleanLog, '--db', `db=${db}`, '--fleet', file(`${a}-m.json`), '--fleet', file(`${a}-w.json`),
      '--fleet-again', file(`${b}-m.json`), '--fleet-again', file(`${b}-w.json`), '--claims', file(`${a}-claims.jsonl`), '--claims', file(`${b}-claims.jsonl`), '--k', '3']);
    const stale = 'm (process p1) holds a lease on shard 0 under claim 16, which shard_claims does not hold for it';
    for (const [a, b] of [['r1', 'r2'], ['r2', 'r3'], ['r2b', 'r3'], ['r3', 'r4'], ['h1', 'h2'], ['h2', 'h3']]) {
      const r = await judged(a, b);
      expect(r.result.verdicts).toEqual([]);
      expect(r.code).toBe(0);
    }
    expect((await judged('r2b', 'r3')).result.notes.some((n: string) => /w \(process q1\) holds a lease on shard 0 under claim 13, which shard_claims does not hold for it/.test(n))).toBe(true);
    const lasting = await judged('r4', 'r5');
    expect(lasting.result.verdicts.map((v: any) => v.detail)).toEqual([stale]);
    expect(lasting.code).toBe(1);
    const both = await judged('r6', 'r6');
    expect(both.result.verdicts.map((v: any) => v.detail)).toEqual(['shard 0 is leased to 2 processes at once: m (process p1), w (process q2)', stale]);
    // One listing for one set of facts.
    const one = await check(['--log', cleanLog, '--db', `db=${db}`, '--fleet', file('r4-m.json'), '--fleet', file('r4-w.json'), '--claims', file('r4-claims.jsonl'), '--k', '3']);
    expect(one.result.verdicts.map((v: any) => v.detail)).toEqual([stale]);
    expect((await runNode([CHECK, '--log', cleanLog, '--db', `db=${db}`, '--fleet', file('r4-m.json'), '--claims', file('r4-claims.jsonl'), '--claims', file('r5-claims.jsonl')])).code).toBe(64);
  });

  it('refuses a streamed copy cut short, and judges the writer\'s own file', async () => {
    const app = await startFakeApp({ pools: [pool] });
    const marks = file('sinks-marks.txt');
    fs.writeFileSync(marks, '');
    let r;
    try {
      [r] = await Promise.all([
        runNode([ORACLE, 'write', '--run', 'sinks', '--guild', GUILD, '--lane', `a=${app.url}`, '--log', file('sinks.jsonl'), '--log', '-',
          '--duration', BACKSTOP_S, '--rate', '20', '--limiter', 'off', '--marks', marks]),
        until([logOf(file('sinks.jsonl'))], ([e]) => ackedIn(e).length >= 3).finally(() => fs.appendFileSync(marks, 'stop\n')),
      ]);
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
      // A writer takes its marks file's size at its start, so lines written before its start line are never read.
      log = await write('last', [`a=${app.url}`], ['--duration', '2', '--limiter', 'off', '--marks', marks, '--marks-every', '60000'], async log => {
        await until([log], ([e]) => started(e));
        fs.appendFileSync(marks, 'begin x\nend x\n');
      });
    } finally {
      await app.close();
    }
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    expect(events.filter(e => e.t === 'mark').map(e => e.label)).toEqual(['begin x', 'end x']);
    expect(events.at(-1)?.t).toBe('end');
  });

  it('stops on a stop line in its marks file, on any host', async () => {
    const app = await startFakeApp({ pools: [pool] });
    const marks = file('stopline-marks.txt');
    fs.writeFileSync(marks, '');
    const began = Date.now();
    let log = '';
    try {
      log = await write('stopline', [`a=${app.url}`], ['--duration', '60', '--rate', '20', '--limiter', 'off', '--marks', marks], async log => {
        await until([log], ([e]) => started(e));
        fs.appendFileSync(marks, 'begin x\nend x\nstop\n');
      });
    } finally {
      await app.close();
    }
    expect(Date.now() - began).toBeLessThan(15_000);
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    expect(events.filter(e => e.t === 'mark').map(e => e.label)).toEqual(['begin x', 'end x']);
    expect(events.at(-1)?.t).toBe('end');
  });

  it('in node:24-alpine, ends its log on SIGHUP and on a second signal, and stops at once when its log cannot be written', async () => {
    // A Node child takes signals only on POSIX, and a file size limit is POSIX too, so the writer runs in the image the live procedure uses.
    const fill = [
      "import { openOut } from '/o/oracle.mjs';",
      "const write = openOut('/tmp/fill.jsonl');",
      "try { write({ pad: 'x'.repeat(40000) }); console.log('written'); } catch (error) { console.log(error.code); }",
    ].join('\n');
    const box = await new GenericContainer('node:24-alpine')
      .withCopyFilesToContainer([{ source: ORACLE, target: '/o/oracle.mjs' }])
      .withCopyContentToContainer([{ content: fill, target: '/o/fill.mjs' }])
      .withCommand(['sleep', '600'])
      .start();
    const sh = async (cmd: string) => (await box.exec(['sh', '-c', cmd])).stdout;
    // Each writer starts 2 s late, asleep before its own code runs, as on a busy machine, so the waits below are pinned.
    const late = Buffer.from('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);').toString('base64');
    const start = (run: string, port: number) => sh(`NODE_OPTIONS='--import=data:text/javascript;base64,${late}' node /o/oracle.mjs write --run ${run} --guild ${GUILD} --lane a=http://127.0.0.1:${port} `
      + `--duration 0 --rate 5 --limiter off --timeout 60000 --log /tmp/${run}.jsonl > /dev/null 2>&1 & echo $! > /tmp/${run}.pid`);
    const ended = async (run: string) => {
      for (let i = 0; i < 100; i++) {
        const events = parseLog(await sh(`cat /tmp/${run}.jsonl`));
        if (events.at(-1)?.t === 'end') return events;
        await sleep(100);
      }
      throw new Error(`${run}: no end line`);
    };
    // The writer takes signals once it logs a request: it sets its handlers before the first one (a signal before
    // that ends node at once, with no end line).
    const logged = async (run: string, t: string) => {
      for (let i = 0; i < 300; i++) {
        if (parseLog(await sh(`cat /tmp/${run}.jsonl 2>/dev/null`)).some(e => e.t === t)) return;
        await sleep(100);
      }
      throw new Error(`${run}: no ${t} line`);
    };
    try {
      // Nothing listens on 8080, so requests fail at once.
      await start('hup', 8080);
      await logged('hup', 'ans');
      await sh('kill -HUP $(cat /tmp/hup.pid)');
      expect((await ended('hup')).some(e => e.t === 'ans')).toBe(true);
      // A server that never answers holds the first request through the stop grace; a second signal ends the run at once.
      await sh(`node -e "require('net').createServer(() => {}).listen(8081, () => require('fs').writeFileSync('/tmp/8081.up', ''))" > /dev/null 2>&1 &`);
      for (let i = 0; (await sh('test -f /tmp/8081.up && echo up')).trim() !== 'up'; i++) {
        if (i === 300) throw new Error('nothing listens on 8081');
        await sleep(100);
      }
      await start('term', 8081);
      await logged('term', 'send');
      await sh('kill -TERM $(cat /tmp/term.pid)');
      await sleep(300);
      await sh('kill -TERM $(cat /tmp/term.pid)');
      const term = await ended('term');
      const answered = new Set(term.filter(e => e.t === 'ans').map(e => e.id));
      expect(term.some(e => e.t === 'send' && !answered.has(e.id))).toBe(true);
      // A line that runs past the file size limit is an error, not a short write the request would follow.
      expect((await sh("trap '' XFSZ; ulimit -f 16; node /o/fill.mjs")).trim()).toBe('EFBIG');
      // A writer whose log fills up exits at once, with a log the checker can read and no end line.
      const full = await sh(`trap '' XFSZ; ulimit -f 4; timeout -s KILL 15 node /o/oracle.mjs write --run full --guild ${GUILD} `
        + '--lane a=http://127.0.0.1:8080 --lane b=http://127.0.0.1:8080 --duration 0 --rate 20 --hot 0 --hot-ratio 0 --limiter off '
        + '--marks /tmp/full-marks.txt --log /tmp/full.jsonl > /dev/null 2> /tmp/full.err; echo $?');
      expect(full.trim()).toBe('64');
      expect(await sh('cat /tmp/full.err')).toMatch(/EFBIG/);
      const filled = parseLog(await sh('cat /tmp/full.jsonl'));
      expect(filled.length).toBeGreaterThan(1);
      expect(filled.some(e => e.t === 'end')).toBe(false);
    } finally {
      await box.stop();
    }
  }, 120_000);
});

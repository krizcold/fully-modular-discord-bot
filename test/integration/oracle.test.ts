import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GuildRequestSweep } from '../../src/bot/internalSetup/fleet/guildRequests';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import type { DataWriteReply, GuildDataWriteRequest } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setBackendKind } from '../helpers/backendKind';
import { endPool } from '../helpers/endPool';
import { takeShard } from '../helpers/pgClaims';
import { poolFor, startPostgres } from '../helpers/postgres';
import { FAKE_SCHEMA, SHARED_UPSERT, shaOfText, startFakeApp, syncMirror, writeMirror, type DeleteFault, type WriteFault } from '../oracle/fakeApp';
import { dbCopy, parseRequests } from '../oracle/judge.mjs';
import { biteStatements, claimsSql, dumpSql, hashOf, ownershipSql, parseLog, requestsSql, sharedDumpSql, sharedKey } from '../oracle/oracle.mjs';

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
  return dumpQuery(db, dumpSql(GUILD, run), name);
}

async function dumpQuery(db: string, query: string, name: string): Promise<string> {
  const r = await container.exec(['sh', '-c', `psql -U "$U" -d "$D" -v ON_ERROR_STOP=1 -At -c "$Q" > /tmp/oracle-dump && base64 /tmp/oracle-dump`], {
    env: { U: container.getUsername(), D: db, Q: query },
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

// NB7 test 12, the L6 scenario of the request route: two bot processes on one database (one holds the guild's shard,
// one the other shard) and two web UIs whose machines do not run the guild, one with its bot running and one with it
// down. The holder is killed between the claim and the answer (before its apply, and after its flush) and between
// the apply's accept and its flush; each time a new process of its machine takes the shard. The oracle compares every
// answer with the stored docs and with the request rows.
describe('NB7 test 12: changes sent to the machine that runs the guild, its holder killed mid-change', () => {
  type Requests = typeof import('../../src/webui/utils/guildRequests');
  type KillPoint = 'claim' | 'accept' | 'flush';
  interface Child {
    processId: string;
    nodeId: string;
    token: FenceToken;
    shardId: number;
    applied: string[];
    dead: () => boolean;
    arm: (point: KillPoint) => void;
    kill: () => void;
  }

  const L6 = 'nb7l6';
  const RUN = 'nb7l6';
  const guildShard = Number((BigInt(GUILD) >> 22n) % 2n);
  const otherShard = 1 - guildShard;
  let url = '';
  let backend: PostgresBackend;
  const pools: Pool[] = [];
  const children: Child[] = [];
  const closers: (() => Promise<void>)[] = [];

  const waitFor = async (done: () => boolean, ms: number): Promise<boolean> => {
    const began = Date.now();
    while (!done()) {
      if (Date.now() - began > ms) return false;
      await sleep(100);
    }
    return true;
  };
  const poolOf = (max: number) => {
    const p = new Pool({ connectionString: url, max });
    p.on('error', () => undefined);
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    await pool.query(`CREATE DATABASE ${L6}`);
    url = container.getConnectionUri().replace(/\/[^/]*$/, `/${L6}`);
    backend = new PostgresBackend(fixedDatabase(url));
    backend.start();
    expect(await waitFor(() => backend.connectionState().state === 'ready', 60_000)).toBe(true);
    await poolOf(1).query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  });

  afterAll(async () => {
    for (const c of children) c.kill();
    for (const close of closers) await close();
    await backend?.stop();
    for (const p of pools) await endPool(p);
  });

  /**
   * A bot process: it takes its shard's claim, keeps it renewed, and runs NB7's sweep, which applies each claimed
   * request through the fenced flush. Armed, the next apply kills the process at that point: it answers nothing,
   * flushes nothing more and renews nothing, and its row stays 'applying'.
   */
  async function startChild(processId: string, nodeId: string, shardId: number): Promise<Child> {
    const db = poolOf(2);
    const token = await takeShard(db, { processId, nodeId, shardId, shardCount: 2 });
    if (shardId === guildShard) expect((await backend.hydrateGuild(GUILD, token)).ok).toBe(true);
    const renew = () => db.query(`UPDATE smdb_data.shard_claims SET renewed_at = now() WHERE holder_process = $1 AND NOT released`, [processId]).catch(() => undefined);
    await renew();
    const renewal = setInterval(() => { void renew(); }, 1000);
    let dead = false;
    let armed: KillPoint | null = null;
    const applied: string[] = [];
    const hang = () => new Promise<DataWriteReply>(() => undefined);
    const kill = () => {
      if (dead) return;
      dead = true;
      clearInterval(renewal);
      sweep.stop();
    };
    const dies = (point: KillPoint) => {
      if (dead) return true;
      if (armed !== point) return false;
      kill();
      return true;
    };
    const apply = async (req: GuildDataWriteRequest): Promise<DataWriteReply> => {
      if (dies('claim')) return hang();
      const key = { module: req.module, filename: req.filename };
      const batch: GuildFlushBatch = req.op === 'delete'
        ? { upserts: [], deletes: [key], appends: [] }
        : { upserts: [{ key, doc: req.contentJson ?? '' }], deletes: [], appends: [] };
      if (dies('accept')) return hang();
      const out = await backend.flushGuild(req.guildId, batch, token);
      if (out.ok) applied.push(`${req.op} ${req.filename} ${req.contentJson ?? ''}`);
      if (dies('flush')) return hang();
      if (out.ok) return { ok: true };
      if (out.reason === 'deposed') return { ok: false, code: 'not-owner', error: 'deposed' };
      return { ok: false, code: 'backend-unavailable', error: `the database did not take the change (${out.detail ?? 'no answer'})` };
    };
    const sweep = new GuildRequestSweep({
      db: { query: (text, values, boundMs) => db.query({ text, values, query_timeout: boundMs } as any) },
      processId: () => processId,
      pairs: () => [{ shardCount: 2, shardId, claim: token.claim as number }],
      stoppedServing: () => false,
      isStopping: () => false,
      apply,
    });
    sweep.start();
    const child: Child = { processId, nodeId, token, shardId, applied, dead: () => dead, arm: point => { armed = point; }, kill };
    children.push(child);
    return child;
  }

  /** A web UI process of its own: a fresh copy of the request route's modules, on this database, as this machine. */
  async function webuiModules(nodeName: string, nodeId: string) {
    vi.resetModules();
    const requests: Requests = await import('../../src/webui/utils/guildRequests');
    // vi.resetModules keeps mocked modules, so envLoader's mock still reads the backendKind loaded before the reset.
    setBackendKind('postgres');
    (await import('../../src/webui/utils/webuiDataReader')).setWebuiDataStoreUrl({ url });
    requests._setGuildRequestDeps({ nodeName: () => nodeName, nodeId: () => nodeId });
    const { sendHopReply } = await import('../../src/webui/routes/config');
    return { requests, sendHopReply };
  }

  /** The operator data routes the writer uses, through the real plan, send and answer of routes/config.ts. */
  async function startWebui(modules: Awaited<ReturnType<typeof webuiModules>>, bot: any, fleetState: () => unknown) {
    const { requests, sendHopReply } = modules;
    let active = 0;
    const split = (fileId: string) => {
      const parts = fileId.split('/');
      return { module: parts.length >= 2 ? parts[0] : '', filename: parts[parts.length - 1] };
    };
    const server = http.createServer(async (req, res) => {
      active += 1;
      const answer = {
        status: (code: number) => ({
          json: (payload: unknown) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          },
        }),
      };
      try {
        const at = new URL(req.url ?? '/', 'http://webui');
        if (req.method === 'GET' && at.pathname === '/api/fleet/state') {
          answer.status(200).json({ success: true, ...(fleetState() as object) });
        } else if (req.method === 'GET' && at.pathname === '/api/config/data/get') {
          const { module, filename } = split(at.searchParams.get('file') ?? '');
          const doc = await requests.remoteReadDoc(at.searchParams.get('guildId') ?? '', module, filename, 5000);
          if (doc === null) answer.status(404).json({ success: false, error: 'Data file not found' });
          else answer.status(200).json({ success: true, data: JSON.parse(doc), exists: true });
        } else if (req.method === 'POST' && (at.pathname === '/api/config/data/update' || at.pathname === '/api/config/data/delete')) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const { module, filename } = split(String(b.file));
          const op = at.pathname.endsWith('/update') ? 'write' as const : 'delete' as const;
          const plan = await requests.planGuildChange(bot, b.guildId, op);
          const payload: GuildDataWriteRequest = op === 'write'
            ? { guildId: b.guildId, module, filename, op, contentJson: JSON.stringify(b.data, null, 2) }
            : { guildId: b.guildId, module, filename, op };
          const reply = plan.kind === 'refuse' ? plan.reply : await requests.sendGuildChange(bot, plan, payload);
          sendHopReply(answer as any, reply, {}, op);
        } else {
          answer.status(404).json({ success: false, error: 'no route' });
        }
      } catch (error) {
        answer.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        active -= 1;
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    closers.push(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, idle: () => active === 0 };
  }

  const factsOf = (child: () => Child) => () => {
    const c = child();
    return {
      initialized: true, nodeId: c.nodeId, processId: c.processId, shardCount: 2,
      leases: [{ shardId: c.shardId, claim: c.token.claim }], shardTable: [], guildMap: { [GUILD]: guildShard },
    };
  };
  const isCantConfirm = (e: any) => e.t === 'ans' && e.cls === 'REFUSED' && !e.definite && /can't confirm/.test(e.err ?? '');
  const isNothingSaved = (e: any) => e.t === 'ans' && e.cls === 'REFUSED' && e.definite && /nothing was/.test(e.err ?? '');

  it('finds no change applied twice and no answer that its rows or the stored docs contradict', async () => {
    const alpha = await startChild('p-alpha', 'n-alpha', otherShard);
    let bravo = await startChild('p-bravo-1', 'n-bravo', guildShard);
    const alphaModules = await webuiModules('ALPHA', 'n-alpha');
    const charlieModules = await webuiModules('CHARLIE', 'n-charlie');
    const notHeld = {
      isRunning: () => true,
      writerRoute: () => ({ route: 'child' }),
      writeGuildData: async () => ({ ok: false, code: 'not-held' }),
      readGuildData: async () => ({ ok: false, code: 'not-held' }),
    };
    const down = { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' };
    const botDown = { isRunning: () => false, writerRoute: () => down, writeGuildData: async () => down, readGuildData: async () => down };
    const alphaUi = await startWebui(alphaModules, notHeld, factsOf(() => alpha));
    const charlieUi = await startWebui(charlieModules, botDown, () => ({ initialized: false }));
    // The guild's machine serves only its control facts here: no lane writes through it.
    const bravoUi = await startWebui(charlieModules, botDown, factsOf(() => bravo));

    const windows: [string, KillPoint][] = [['kill-claim', 'claim'], ['kill-flush', 'flush'], ['kill-accept', 'accept']];
    const marks = file('l6-marks.txt');
    fs.writeFileSync(marks, '');
    let nothingSavedWhileDead = 0;
    let ackedAfterLastTake = 0;
    // The cleanup deletes an answered row 2 minutes after its answer: the request rows are snapshotted every 30 s.
    const requests = file('l6-requests.jsonl');
    fs.writeFileSync(requests, '');
    const snapshot = async (span: { from: string; to: string | null }, name = 'l6-requests-one.jsonl') => {
      const one = await dumpQuery(L6, requestsSql(GUILD, RUN, span), name);
      fs.appendFileSync(requests, fs.readFileSync(one));
      return one;
    };
    let snapping = true;
    const snapshots = (async () => {
      let from: string | undefined;
      while (snapping) {
        if (from === undefined) {
          try {
            from = parseLog(fs.readFileSync(file(`${RUN}.jsonl`), 'utf8')).find(e => e.t === 'start')?.startedAt;
          } catch {
            from = undefined;
          }
        }
        if (from !== undefined) await snapshot({ from, to: null });
        await waitFor(() => !snapping, from === undefined ? 200 : 30_000);
      }
    })();
    snapshots.catch(() => undefined);
    closers.push(async () => {
      snapping = false;
      await snapshots.catch(() => undefined);
    });
    const log = await write(RUN, [`a=${alphaUi.url}`, `c=${charlieUi.url}`],
      ['--duration', '400', '--rate', '4', '--limiter', 'off', '--hot', '1', '--delete-ratio', '0.1', '--read-every', '4', '--max-size', '512',
        '--timeout', '45000', '--seed', '12', '--marks', marks],
      async text => {
        const events = () => parseLog(text());
        expect(await waitFor(() => ackedIn(events()).length >= 3, 60_000)).toBe(true);
        for (const [name, point] of windows) {
          fs.appendFileSync(marks, `begin ${name}\n`);
          bravo.arm(point);
          expect(await waitFor(() => bravo.dead(), 90_000)).toBe(true);
          if (point === 'claim') {
            // A change sent while the dead process still holds the shard is refused as never applied.
            const before = events().filter(isNothingSaved).length;
            expect(await waitFor(() => events().filter(isNothingSaved).length > before, 60_000)).toBe(true);
            nothingSavedWhileDead = events().filter(isNothingSaved).length - before;
          }
          bravo = await startChild(`p-bravo-${children.filter(c => c.shardId === guildShard).length + 1}`, 'n-bravo', guildShard);
        }
        const acked = ackedIn(events()).length;
        expect(await waitFor(() => events().filter(isCantConfirm).length >= windows.length && ackedIn(events()).length >= acked + 3, 120_000)).toBe(true);
        ackedAfterLastTake = ackedIn(events()).length - acked;
        for (const [name] of windows) fs.appendFileSync(marks, `end ${name}\n`);
        expect(await waitFor(() => windows.every(([name]) => marked(events(), `end ${name}`)), 10_000)).toBe(true);
      }, marks);
    // A request the writer cut short at its stop is still followed by its web UI.
    expect(await waitFor(() => alphaUi.idle() && charlieUi.idle(), 90_000)).toBe(true);

    const events = parseLog(fs.readFileSync(log, 'utf8'));
    expect(nothingSavedWhileDead).toBeGreaterThan(0);
    expect(ackedAfterLastTake).toBeGreaterThanOrEqual(3);
    expect(events.filter(isCantConfirm).length).toBeGreaterThanOrEqual(windows.length);
    // The bot processes' own record: no change landed twice.
    const applied = children.flatMap(c => c.applied);
    expect(new Set(applied).size).toBe(applied.length);

    for (const [name, ui] of [['alpha', alphaUi], ['bravo', bravoUi]] as const) {
      expect((await runNode([ORACLE, 'fleet', '--target', ui.url, '--name', name, '--limiter', 'off', '--out', file(`l6-fleet-${name}.json`)])).code).toBe(0);
    }
    const printed = await runNode([ORACLE, 'sql', 'requests', '--log', log]);
    const span = { from: events.find(e => e.t === 'start').startedAt, to: events.find(e => e.t === 'end')?.endedAt ?? null };
    expect(printed.stdout).toBe(`${requestsSql(GUILD, RUN, span)}\n`);
    const db = await dump(L6, RUN, 'l6-db.jsonl');
    if (span.to !== null) {
      const due = async () => (await pool.query(`SELECT now() >= $1::timestamptz + interval '30 seconds' AS due`, [span.to])).rows[0].due === true;
      const began = Date.now();
      while (!(await due()) && Date.now() - began < 60_000) await sleep(1000);
    }
    snapping = false;
    await snapshots;
    const last = await snapshot(span);
    const claims = await dumpQuery(L6, claimsSql(), 'l6-claims.jsonl');
    const ownership = await dumpQuery(L6, ownershipSql(), 'l6-ownership.jsonl');
    const listing = parseRequests('requests', fs.readFileSync(requests, 'utf8'));
    expect(listing.snapshots?.length).toBeGreaterThanOrEqual(2);
    const rows = listing.rows;
    // Each kill left a row its process took and never answered.
    expect(rows.filter(row => row.state === 'applying' && row.taken).length).toBeGreaterThanOrEqual(windows.length);

    const judged = ['--log', log, '--db', `db=${db}`, '--fleet', file('l6-fleet-alpha.json'), '--fleet', file('l6-fleet-bravo.json'),
      '--claims', claims, '--ownership', ownership, ...windows.flatMap(([name]) => ['--window', name]), '--k', '2'];
    const r = await check([...judged, '--requests', `requests=${requests}`]);
    expect(r.result.verdicts).toEqual([]);
    expect(r.result.inconclusive).toEqual([]);
    expect(r.result.notes).toEqual([]);
    expect(r.code).toBe(0);

    // A holder's claim empties the body (NB15 decision 16): every taken row of the last snapshot is listed with no key.
    // The bites copy its newest one, which the cleanup still keeps.
    const taken = parseRequests('last', fs.readFileSync(last, 'utf8')).rows.filter(row => row.op === 'write' && row.taken && row.state === 'done');
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.every(row => row.key === null && row.h === null)).toBe(true);
    const copied = taken[taken.length - 1].id;
    const withSnapshots = (one: string, name: string) => {
      fs.writeFileSync(file(name), Buffer.concat([fs.readFileSync(requests), fs.readFileSync(one)]));
      return file(name);
    };
    const ackedRemote = answeredSends(events).filter(s => s.op === 'write' && s.ans.cls === 'ACKED' && s.ans.remote === true);
    expect(ackedRemote.length).toBeGreaterThanOrEqual(2);

    // Bites: more started write rows than writes sent is TWICE; acknowledged writes whose rows the holder answered as
    // never applied are FALSE-ANSWER.
    const writesSent = events.filter(e => e.t === 'send' && e.op === 'write').length;
    await psql(L6, `INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, state, created_at,
      claim_by, answer_by, claim_batch, applier_claim, taken_at, reply, done_at)
      SELECT gen_random_uuid(), guild_id, shard_count, shard_id, for_process, op, body, requested_by, state, created_at, claim_by, answer_by,
        gen_random_uuid(), applier_claim, taken_at, reply, done_at FROM smdb_data.guild_requests, generate_series(1, ${writesSent + 1})
       WHERE id = '${copied}'`);
    const doubled = withSnapshots(await dumpQuery(L6, requestsSql(GUILD, RUN, span), 'l6-requests-twice-one.jsonl'), 'l6-requests-twice.jsonl');
    const b1 = await check([...judged, '--requests', `requests=${doubled}`]);
    expect(b1.code).toBe(1);
    expect(b1.result.verdicts.map((v: any) => `${v.v} ${v.key}`)).toEqual(['TWICE (write rows with no key)']);
    await psql(L6, `DELETE FROM smdb_data.guild_requests WHERE claim_batch IS NOT NULL AND id <> '${copied}' AND body = '' AND op = 'write'
      AND reply = (SELECT reply FROM smdb_data.guild_requests WHERE id = '${copied}') AND created_at = (SELECT created_at FROM smdb_data.guild_requests WHERE id = '${copied}')`);
    await psql(L6, `UPDATE smdb_data.guild_requests SET reply = '{"ok":false,"code":"not-taken","unapplied":true}'
      WHERE id IN (${taken.map(row => `'${row.id}'`).join(', ')})`);
    const untrue = withSnapshots(await dumpQuery(L6, requestsSql(GUILD, RUN, span), 'l6-requests-untrue-one.jsonl'), 'l6-requests-untrue.jsonl');
    const b2 = await check([...judged, '--requests', `requests=${untrue}`]);
    expect(b2.code).toBe(1);
    // A row an earlier snapshot caught with its body is judged by its own key.
    expect(b2.result.verdicts.map((v: any) => `${v.v} ${v.key}`)).toContain('FALSE-ANSWER (write rows with no key)');
    expect(b2.result.verdicts.every((v: any) => v.v === 'FALSE-ANSWER')).toBe(true);
  }, 420_000);
});

describe('NB6: the shared files of a Postgres bot of two machines', () => {
  const SHARED = 'oracle/s1.json';
  const SEED = JSON.stringify({ seed: 1 }, null, 2);
  const shared = ['--shared', SHARED, '--shared-ratio', '1', '--hot-ratio', '0', '--delete-ratio', '0', '--read-every', '0', '--limiter', 'off', '--rate', '10'];

  // The row and both machines' mirrors start on one version, as after a pass.
  async function seedShared(folders: string[]): Promise<void> {
    await pool.query(SHARED_UPSERT, [sharedKey(SHARED), Buffer.from(SEED, 'utf8'), shaOfText(SEED), 'seed']);
    for (const folder of folders) writeMirror(folder, SHARED, SEED);
  }

  async function copies(run: string, log: string, folders: [string, string][]): Promise<string[]> {
    const guild = await dump('test', run, `${run}-db.jsonl`);
    const rows = await dumpQuery('test', sharedDumpSql([SHARED]), `${run}-shared.jsonl`);
    const args = ['--log', log, '--db', `db=${guild}`, '--shared-db', `shared=${rows}`, '--shared-bound', '0', '--no-fleet', '--k', '0'];
    for (const [name, folder] of folders) {
      const out = file(`${run}-${name}-${Math.random().toString(36).slice(2)}.mirror.jsonl`);
      const r = await runNode([ORACLE, 'mirror', '--log', log, '--data', folder, '--name', name, '--out', out]);
      expect(r.code).toBe(0);
      args.push('--mirror', out);
    }
    return args;
  }

  it('passes saves each machine compared, and names a mirror or a row put back to an older version', async () => {
    const ma = file('nb6a');
    const mb = file('nb6b');
    await seedShared([ma, mb]);
    const a = await startFakeApp({ pools: [pool], sharedMirror: ma });
    const b = await startFakeApp({ pools: [pool], sharedMirror: mb });
    // Each machine's pass, faster than the bot's so the lanes meet each other's versions.
    const pass = setInterval(() => { void syncMirror(pool, ma, [SHARED]); void syncMirror(pool, mb, [SHARED]); }, 50);
    let log = '';
    try {
      log = await write('nb6s', [`a=${a.url}`, `b=${b.url}`], ['--duration', BACKSTOP_S, '--marks', file('nb6s-marks.txt'), ...shared], async l => {
        await until([l], ([e]) => e.filter(x => x.t === 'shared-ans' && x.cls === 'ACKED').length >= 6);
      }, file('nb6s-marks.txt'));
    } finally {
      clearInterval(pass);
      await a.close();
      await b.close();
    }
    await syncMirror(pool, ma, [SHARED]);
    await syncMirror(pool, mb, [SHARED]);
    const events = parseLog(fs.readFileSync(log, 'utf8'));
    const answers = new Map(events.filter(e => e.t === 'shared-ans').map(e => [e.id, e]));
    // A save another machine's change refused is a change no machine applied.
    for (const e of answers.values()) if (e.cls === 'REFUSED') expect(e.definite).toBe(true);
    const clean = await check(await copies('nb6s', log, [['ma', ma], ['mb', mb]]));
    expect(clean.result.verdicts).toEqual([]);
    expect(clean.result.inconclusive).toEqual([]);
    expect(clean.code).toBe(0);

    const stored = (await pool.query('SELECT body FROM smdb_data.shared_docs WHERE key = $1', [sharedKey(SHARED)])).rows[0].body.toString('utf8');
    const older = events.find(e => e.t === 'shared-send' && answers.get(e.id)?.cls === 'ACKED' && hashOf(e.content) !== hashOf(JSON.parse(stored)));
    expect(older).toBeDefined();
    writeMirror(mb, SHARED, JSON.stringify(older.content, null, 2));
    const staleMirror = await check(await copies('nb6s', log, [['ma', ma], ['mb', mb]]));
    expect(staleMirror.code).toBe(1);
    expect(staleMirror.result.verdicts.map((v: any) => `${v.v} ${v.copy}`).sort()).toEqual(['SHARED-FORK ma,mb', 'SHARED-LOST mb']);

    writeMirror(mb, SHARED, stored);
    await pool.query('UPDATE smdb_data.shared_docs SET body = $2 WHERE key = $1', [sharedKey(SHARED), Buffer.from(JSON.stringify(older.content, null, 2), 'utf8')]);
    const staleRow = await check(await copies('nb6s', log, [['ma', ma], ['mb', mb]]));
    expect(staleRow.code).toBe(1);
    expect(staleRow.result.verdicts.map((v: any) => `${v.v} ${v.copy}`)).toEqual(['SHARED-LOST shared']);
  }, 120_000);

  it('names SHARED-OVERWRITE when the machines store saves over versions they were not built on', async () => {
    const ma = file('nb6c');
    const mb = file('nb6d');
    await seedShared([ma, mb]);
    // No compare and no pass: each machine builds on its own copy, and both first saves were built on the seed.
    const a = await startFakeApp({ pools: [pool], sharedMirror: ma, sharedCompare: false });
    const b = await startFakeApp({ pools: [pool], sharedMirror: mb, sharedCompare: false });
    let log = '';
    try {
      log = await write('nb6o', [`a=${a.url}`, `b=${b.url}`], ['--duration', BACKSTOP_S, '--marks', file('nb6o-marks.txt'), ...shared], async l => {
        await until([l], ([e]) => new Set(e.filter(x => x.t === 'shared-ans' && x.cls === 'ACKED')
          .map(x => e.find(s => s.t === 'shared-send' && s.id === x.id)?.lane)).size === 2);
      }, file('nb6o-marks.txt'));
    } finally {
      await a.close();
      await b.close();
    }
    await syncMirror(pool, ma, [SHARED]);
    await syncMirror(pool, mb, [SHARED]);
    const r = await check(await copies('nb6o', log, [['ma', ma], ['mb', mb]]));
    expect(r.code).toBe(1);
    expect(r.result.verdicts.map((v: any) => v.v)).toContain('SHARED-OVERWRITE');
    expect(r.result.verdicts.find((v: any) => v.v === 'SHARED-OVERWRITE').key).toBe(SHARED);
  }, 120_000);

  it('takes a listing that keeps multi-byte text and a body that is not JSON whole', async () => {
    const text = JSON.stringify({ t: 'é漢🙂 "q" \ end' }, null, 2);
    await pool.query(SHARED_UPSERT, [sharedKey('oracle/s2.json'), Buffer.from(text, 'utf8'), shaOfText(text), 'test']);
    await pool.query(SHARED_UPSERT, [sharedKey('oracle/s3.json'), Buffer.from([0xff, 0x00, 0x41]), 'x', 'test']);
    const listing = fs.readFileSync(await dumpQuery('test', sharedDumpSql(['oracle/s2.json', 'oracle/s3.json']), 'nb6-listing.jsonl'), 'utf8');
    const rows = listing.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
    expect(rows.map(r => r.k)).toEqual(['oracle/s2.json', 'oracle/s3.json']);
    expect(Buffer.from(rows[0].b, 'base64').toString('utf8')).toBe(text);
    expect([...Buffer.from(rows[1].b, 'base64')]).toEqual([0xff, 0x00, 0x41]);
  });
});

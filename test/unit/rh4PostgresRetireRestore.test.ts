import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend, deadlineIn, msLeft } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { MoveSteps } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { FLUSH_STATEMENT_BYTES, flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { installHoldingChooser } from '../helpers/nb6Hold';
import { type Answer, scriptedBackend } from '../helpers/scriptedPg';

// The module fetch's read, a retire's and a restore's failure paths and the move's batch read, through the real
// PostgresBackend over scripted clients: what each answers, logs, releases and whether it starts the hold.

const token: FenceToken = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 };
const READ = 'SELECT bytes FROM smdb_data.shared_module_files WHERE module = $1';
const backends: PostgresBackend[] = [];
let errors: string[];
let logs: string[];

beforeEach(() => {
  errors = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

function scripted(answer?: Answer) {
  const rigged = scriptedBackend(answer);
  backends.push(rigged.backend);
  const hold = installHoldingChooser(rigged.backend);
  return { ...rigged, hold };
}

const reset = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
const answeredError = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'ERROR' });
const bytesOf = (text: string, values: unknown[]) =>
  Buffer.byteLength(text) + values.reduce<number>((n, v) => n + (v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);

/** Resolves once the deadline has less than floorMs left, polling on a bound. */
function whenLeftBelow(deadline: bigint, floorMs: number): Promise<undefined> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (msLeft(deadline) < floorMs) { clearInterval(timer); resolve(undefined); } else if (Date.now() - started > 2000) { clearInterval(timer); reject(new Error('the deadline did not pass')); }
    }, 2);
  });
}

describe("the module fetch's read (sharedRead) when its SELECT fails", () => {
  const boundMs = flushBoundMs(FLUSH_STATEMENT_BYTES);
  const timeout = () => answeredError('57014', 'canceling statement due to statement timeout');

  function clocked(afterMs: number, base: number) {
    let now = base;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return scripted(sql => {
      if (sql !== READ) return undefined;
      now += afterMs;
      return timeout();
    });
  }

  it('a 57014 at the bound answers the statement size, the time it ran, the bound and atBound true', async () => {
    const { backend, releases } = clocked(boundMs, 1_000);
    const outcome = await backend.sharedRead(READ, ['mod']);
    expect(outcome).toEqual({
      kind: 'failed', step: 'statements', code: '57014', detail: 'SQLSTATE 57014: canceling statement due to statement timeout',
      timeout: { bytes: bytesOf(READ, ['mod']), elapsedMs: boundMs, boundMs, atBound: true },
    });
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });

  it('a 57014 before the bound (a cancel) answers atBound false, however late the clock reads', async () => {
    const { backend } = clocked(2_000, boundMs * 10);
    const outcome = await backend.sharedRead(READ, ['mod']);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', code: '57014', timeout: { elapsedMs: 2_000, boundMs, atBound: false } });
  });

  it('another answered error carries no timeout facts and starts no hold', async () => {
    const { backend, hold } = scripted(sql => (sql === READ ? answeredError('42P01', 'relation "smdb_data.shared_module_files" does not exist') : undefined));
    const outcome = await backend.sharedRead(READ, ['mod']);
    expect(outcome).toEqual({
      kind: 'failed', step: 'statements', code: '42P01', detail: 'SQLSTATE 42P01: relation "smdb_data.shared_module_files" does not exist',
    });
    expect(Object.keys(outcome)).not.toContain('timeout');
    expect(hold.epochs).toEqual([]);
  });

  it('a SELECT that got no answer starts the hold', async () => {
    const { backend, hold } = scripted(sql => (sql === READ ? reset() : undefined));
    const outcome = await backend.sharedRead(READ, ['mod']);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', detail: 'Connection terminated unexpectedly' });
    expect(hold.epochs).toEqual([backend.databaseEpoch()]);
    expect(backend.holdWords()).toContain('the database did not answer');
  });

  it('gives its client back to the pool after an answered read', async () => {
    const { backend, releases } = scripted(sql => (sql === READ ? { rows: [{ bytes: Buffer.from([7]) }], rowCount: 1 } : undefined));
    expect(await backend.sharedRead(READ, ['mod'])).toEqual({ kind: 'read', rows: [{ bytes: Buffer.from([7]) }] });
    expect(releases).toEqual([{ client: 1, destroyed: false }]);
  });
});

const isMoveOut = (sql: string) => sql.includes('gd AS (DELETE FROM smdb_data.guild_data WHERE guild_id = $1 RETURNING');
const isCopyIn = (sql: string) => sql.startsWith('WITH src AS (');
const isLiveCheck = (sql: string) => sql.startsWith('SELECT EXISTS (SELECT 1 FROM smdb_data.guild_data WHERE guild_id = $1)');
const isBatchFound = (sql: string) => sql.startsWith('SELECT 1 FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2');

describe('a retire that stops before its COMMIT', () => {
  it('the graveyard took fewer rows than it moved: rolled back, logged, and a ROLLBACK with no answer starts the hold', async () => {
    const { backend, hold, sent } = scripted(sql => {
      if (isMoveOut(sql)) return { rows: [{ at: '900', docs: '2', streams: '1', put: '2' }], rowCount: 1 };
      if (sql === 'ROLLBACK') return reset();
      return undefined;
    });
    expect(await backend.retireGuild('4401', 'left', token)).toEqual({ ok: false, reason: 'incomplete' });
    expect(errors).toContain('[PostgresBackend] retireGuild of guild 4401: the graveyard took 2 of 3 row(s); rolled back');
    expect(sent.some(s => s.sql === 'COMMIT')).toBe(false);
    expect(hold.epochs).toEqual([backend.databaseEpoch()]);
  });

  it('too little time left for its COMMIT: rolled back, and a ROLLBACK with no answer starts the hold', async () => {
    const { backend, hold, sent } = scripted(sql => {
      if (isMoveOut(sql)) return { rows: [{ at: '900', docs: '1', streams: '0', put: '1' }], rowCount: 1 };
      if (sql === 'ROLLBACK') return reset();
      return undefined;
    });
    expect(await backend.retireGuild('4402', 'left', token, deadlineIn(1_900))).toEqual({ ok: false, reason: 'out-of-time' });
    expect(sent.map(s => s.sql).slice(-1)).toEqual(['ROLLBACK']);
    expect(sent.some(s => s.sql === 'COMMIT')).toBe(false);
    expect(hold.epochs).toEqual([backend.databaseEpoch()]);
  });

  it('runs out of time after BEGIN: answers out-of-time and destroys its client, which is inside a transaction', async () => {
    const deadline = deadlineIn(1_100);
    const { backend, releases, sent } = scripted(sql => (sql === 'BEGIN' ? whenLeftBelow(deadline, 990) : undefined));
    expect(await backend.retireGuild('4403', 'left', token, deadline)).toEqual({ ok: false, reason: 'out-of-time' });
    expect(sent.map(s => s.sql)).toEqual(['BEGIN']);
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });

  it('an answered error starts no hold and tells no login-refused listener', async () => {
    const { backend, hold } = scripted(sql => (isMoveOut(sql) ? answeredError('28000', 'role "smdb_bot" is not permitted to log in') : undefined));
    let refusedLogins = 0;
    backend.onLoginRefused(() => { refusedLogins += 1; });
    expect(await backend.retireGuild('4404', 'left', token)).toEqual({ ok: false, reason: 'refused', detail: 'SQLSTATE 28000: role "smdb_bot" is not permitted to log in' });
    expect(hold.epochs).toEqual([]);
    expect(backend.holdWords()).toBeNull();
    expect(refusedLogins).toBe(0);
  });
});

describe('a restore through the scripted database', () => {
  type Script = { live?: unknown; moveOut?: unknown; commit?: unknown; begin?: () => unknown };
  function restoring(script: Script = {}) {
    const rig = scripted(sql => {
      if (sql === 'BEGIN' && script.begin) return script.begin();
      if (isBatchFound(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (isMoveOut(sql)) return script.moveOut ?? { rows: [{ at: null, docs: '0', streams: '0', put: '0' }], rowCount: 1 };
      if (isLiveCheck(sql)) return script.live ?? { rows: [{ present: false }], rowCount: 1 };
      if (isCopyIn(sql)) return { rows: [{ taken: '2', put: '2', reason: 'left', used_at: '1234' }], rowCount: 1 };
      if (sql === 'COMMIT') return script.commit;
      return undefined;
    });
    (rig.backend as unknown as { provisioned: boolean }).provisioned = true;
    return rig;
  }

  it('a live check that reads no row lets the copy in go ahead', async () => {
    const { backend } = restoring({ live: { rows: [], rowCount: 0 } });
    expect(await backend.restoreGuild('4501', 500, token, () => null, deadlineIn(5_000))).toEqual({ ok: true, copied: 2, retiredAt: 500, reason: 'left', usedAt: 1234 });
  });

  it('a replace logs how many rows went to which new batch', async () => {
    const { backend } = restoring({ moveOut: { rows: [{ at: '777', docs: '2', streams: '1', put: '3' }], rowCount: 1 } });
    expect(await backend.restoreGuild('4502', 500, token, () => null, deadlineIn(5_000), true)).toEqual({
      ok: true, copied: 2, retiredAt: 500, reason: 'left', usedAt: 1234, replaced: { retiredAt: 777, moved: 3, reason: 'replaced-by-restore-500' },
    });
    expect(logs).toContain('[PostgresBackend] Guild 4502 restored from graveyard batch 500; 2 row(s) copied in; 3 row(s) moved to batch 777');
  });

  it('a plain restore whose COMMIT got no answer answers unknown with no replaced batch', async () => {
    const { backend } = restoring({ commit: reset() });
    const outcome = await backend.restoreGuild('4503', 500, token, () => null, deadlineIn(5_000));
    expect(outcome).toEqual({ ok: false, reason: 'unknown', retiredAt: 500 });
    expect(Object.keys(outcome)).not.toContain('replaced');
  });

  it('runs out of time after BEGIN: answers out-of-time and destroys its client, which is inside a transaction', async () => {
    const deadline = deadlineIn(1_100);
    const { backend, releases, sent } = restoring({ begin: () => whenLeftBelow(deadline, 990) });
    expect(await backend.restoreGuild('4504', 500, token, () => null, deadline)).toEqual({ ok: false, reason: 'out-of-time' });
    expect(sent.map(s => s.sql)).toEqual(['BEGIN']);
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });
});

describe("the move's read of a retire's batch (retireReached)", () => {
  const BATCH = /AND retired_at = \$2\) AS present/;
  type Wire = { text: string; values: unknown[] };

  function fakePool(sent: Wire[]) {
    const run = async (config: unknown, more?: unknown[]) => {
      const text = typeof config === 'string' ? config : String((config as { text: string }).text);
      const values = typeof config === 'string' ? (more ?? []) : ((config as { values?: unknown[] }).values ?? []);
      sent.push({ text, values });
      if (BATCH.test(text)) {
        const present = values.length === 2 && values[0] === '111' && values[1] === 5;
        return { rows: [{ present }], rowCount: 1 };
      }
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    };
    return {
      connect: async () => ({ query: run, release: () => {}, end: async () => {}, on: () => {} }),
      query: run,
      on: () => {},
      end: async () => {},
    };
  }

  async function readDuringMove(guildId: string, retiredAt: number): Promise<{ read: unknown; sent: Wire[] }> {
    const pools: Wire[][] = [];
    vi.spyOn(PostgresBackend.prototype as unknown as { makePool(config: unknown): unknown }, 'makePool').mockImplementation(() => {
      const sent: Wire[] = [];
      pools.push(sent);
      return fakePool(sent);
    });
    const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
    backends.push(backend);
    backend.latch({ kind: 'replaced', machine: 'machine-two', generation: 4 });
    let read: unknown;
    const steps: MoveSteps = {
      checkTarget: async () => null,
      claims: async () => {
        read = await backend.retireReached(guildId, retiredAt).then(v => v, (e: unknown) => e);
        return true;
      },
      settleRetires: async () => true,
      moved: () => undefined,
    };
    expect(await backend.useDatabase('postgres://nobody@127.0.0.1:9/other', steps)).toBe(true);
    return { read, sent: pools[1].filter(s => BATCH.test(s.text)) };
  }

  it("reads the batch on the move's target while the latch is up, and answers true when it is there", async () => {
    const { read, sent } = await readDuringMove('111', 5);
    expect(read).toBe(true);
    expect(sent.map(s => s.values)).toEqual([['111', 5]]);
  });

  it('answers false when the target does not hold the batch', async () => {
    const { read } = await readDuringMove('111', 6);
    expect(read).toBe(false);
  });
});

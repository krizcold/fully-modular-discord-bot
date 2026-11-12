import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresBackend, deadlineIn } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { MoveSteps } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { installHoldingChooser } from '../helpers/nb6Hold';

const URL_A = 'postgres://nobody@127.0.0.1:9/none';
const URL_B = 'postgres://nobody@127.0.0.1:9/other';
const URL_C = 'postgres://nobody@127.0.0.1:9/third';
const REPLACED = 'was replaced by machine-two (generation 4)';

type Result = { rows: Array<Record<string, unknown>>; rowCount: number };
type Answer = (text: string, values: unknown[]) => Promise<Result>;
type Wire = { text: string; values: unknown[] };

const answered = (rows: Array<Record<string, unknown>> = [], rowCount = rows.length): Promise<Result> => Promise.resolve({ rows, rowCount });

// Postgres refuses a statement whose bind message carries a different number of parameters than its text uses.
function onTheWire(config: unknown, more: unknown[] | undefined): Wire {
  const { text, values } = typeof config === 'string' ? { text: config, values: more ?? [] } : (config as { text: string; values?: unknown[] });
  const given = values ?? [];
  let wanted = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) wanted = Math.max(wanted, Number(match[1]));
  if (given.length > 0 && given.length !== wanted) {
    throw Object.assign(new Error(`bind message supplies ${given.length} parameters, but prepared statement "" requires ${wanted}`), { code: '08P01', severity: 'ERROR' });
  }
  return { text, values: given };
}

interface FakePool {
  sent: Wire[];
  clientSent: Wire[];
  released: unknown[];
  clientEnds: number;
  endRejects: boolean;
  connect(): Promise<unknown>;
  query(config: unknown, values?: unknown[]): Promise<Result>;
  on(): void;
  end(): Promise<void>;
}

function fakePool(answer: Answer, connect: (() => Promise<never>) | undefined): FakePool {
  const pool: FakePool = {
    sent: [],
    clientSent: [],
    released: [],
    clientEnds: 0,
    endRejects: true,
    async connect() {
      if (connect) return connect();
      const pending = new Set<(error: Error) => void>();
      return {
        query: (config: unknown, values?: unknown[]) => {
          const statement = onTheWire(config, values);
          pool.sent.push(statement);
          pool.clientSent.push(statement);
          return new Promise<Result>((resolve, reject) => {
            pending.add(reject);
            answer(statement.text, statement.values).then(resolve, reject).finally(() => pending.delete(reject));
          });
        },
        release: (destroy?: boolean) => pool.released.push(destroy),
        end: async () => {
          pool.clientEnds += 1;
          if (!pool.endRejects) return;
          for (const reject of pending) reject(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' }));
        },
        on() {},
      };
    },
    async query(config: unknown, values?: unknown[]) {
      const statement = onTheWire(config, values);
      pool.sent.push(statement);
      return answer(statement.text, statement.values);
    },
    on() {},
    async end() {},
  };
  return pool;
}

let built: FakePool[] = [];
let nextAnswer: Answer = () => answered();
let nextConnect: (() => Promise<never>) | undefined;
let backends: PostgresBackend[] = [];

beforeEach(() => {
  built = [];
  backends = [];
  nextAnswer = () => answered();
  nextConnect = undefined;
  vi.spyOn(PostgresBackend.prototype as unknown as { makePool(config: unknown): unknown }, 'makePool').mockImplementation(() => {
    const answer = nextAnswer;
    const pool = fakePool((text, values) => answer(text, values), nextConnect);
    built.push(pool);
    return pool;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  for (const backend of backends) await backend.stop();
  vi.restoreAllMocks();
});

function backendOn(): PostgresBackend {
  const backend = new PostgresBackend(fixedDatabase(URL_A));
  backends.push(backend);
  return backend;
}

async function until(condition: () => boolean, boundMs = 2000): Promise<boolean> {
  const end = Date.now() + boundMs;
  while (!condition()) {
    if (Date.now() > end) return false;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return true;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const passingSteps = (): MoveSteps => ({
  checkTarget: async () => null,
  claims: async () => true,
  settleRetires: async () => true,
  moved: () => undefined,
});

const warnCalls = () => (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const bootstrapFailure = () => warnCalls().find(call => String(call[0]).includes('Bootstrap attempt 1 failed'));
const latchTwo = (backend: PostgresBackend) => backend.latch({ kind: 'replaced', machine: 'machine-two', generation: 4 });
const BATCH = /AND retired_at = \$2\) AS present/;

describe('statements while a move runs', () => {
  async function moveInClaims(): Promise<{ backend: PostgresBackend; release(ok: boolean): Promise<boolean> }> {
    nextAnswer = text => (BATCH.test(text) ? answered([{ present: true }]) : answered([{ '?column?': 1 }]));
    const backend = backendOn();
    latchTwo(backend);
    const claims = deferred<boolean>();
    let entered!: () => void;
    const inClaims = new Promise<void>(resolve => { entered = resolve; });
    const move = backend.useDatabase(URL_B, { ...passingSteps(), claims: () => { entered(); return claims.promise; } });
    await inClaims;
    return { backend, release: async ok => { claims.resolve(ok); return move; } };
  }

  it('refuses a statement outside the move while the move runs', async () => {
    const { backend, release } = await moveInClaims();
    await expect(backend.askDatabase()).resolves.toBe('unreachable');
    expect(built[1].sent).toEqual([]);
    await expect(release(true)).resolves.toBe(true);
    await expect(backend.askDatabase()).resolves.toBe('answers');
  });

  it("lets the move's own read through to the target while the move runs", async () => {
    const { backend, release } = await moveInClaims();
    await expect(backend.retireReached('111', 5)).resolves.toBe(true);
    expect(built[1].sent.map(s => s.values)).toEqual([['111', 5]]);
    await expect(release(true)).resolves.toBe(true);
  });

  it("ends a failed attempt with the move flag down and refuses the move's read after it", async () => {
    const { backend, release } = await moveInClaims();
    expect(backend.isMoving()).toBe(true);
    await expect(release(false)).resolves.toBe(false);
    expect(backend.isMoving()).toBe(false);
    const error = await backend.retireReached('111', 5).then(() => null, (e: unknown) => e as Error);
    expect(error?.name).toBe('OwnStateRefusal');
    expect(error?.message).toContain(REPLACED);
    expect(built[1].sent).toEqual([]);
  });

  it('keeps the move flag of a later attempt when an earlier attempt ends', async () => {
    const backend = backendOn();
    latchTwo(backend);
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    const inFirst = new Promise<void>(resolve => { enteredFirst = resolve; });
    const inSecond = new Promise<void>(resolve => { enteredSecond = resolve; });
    const moveA = backend.useDatabase(URL_B, { ...passingSteps(), claims: () => { enteredFirst(); return first.promise; } });
    await inFirst;
    const moveB = backend.useDatabase(URL_C, { ...passingSteps(), claims: () => { enteredSecond(); return second.promise; } });
    await inSecond;
    first.resolve(true);
    await expect(moveA).resolves.toBe(false);
    expect(backend.isMoving()).toBe(true);
    second.resolve(false);
    await expect(moveB).resolves.toBe(false);
    expect(backend.isMoving()).toBe(false);
  });
});

describe('the outage alert', () => {
  it('tells the alert listeners once the hold has lasted ten seconds', () => {
    vi.useFakeTimers();
    const backend = backendOn();
    installHoldingChooser(backend);
    const alerts: Array<[string, string]> = [];
    backend.onAlert((event, detail) => alerts.push([event, detail]));
    backend.noteLapse();
    vi.advanceTimersByTime(9_999);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(alerts).toEqual([['outage', 'data backend unreachable for 10s']]);
  });
});

describe('the bootstrap loop', () => {
  it('sends nothing to the database while the backend is held', async () => {
    const backend = backendOn();
    installHoldingChooser(backend);
    backend.noteLapse();
    backend.start();
    expect(await until(() => bootstrapFailure() !== undefined, 1500)).toBe(true);
    const error = bootstrapFailure()![1] as Error & { phase?: string };
    expect(error.name).toBe('OwnStateRefusal');
    expect(error.phase).toBe('held');
    expect(built[0].sent).toEqual([]);
  });

  it('does not tell the login-refused listeners about a refusal of a database latched since', async () => {
    const first = deferred<Result>();
    nextAnswer = () => first.promise;
    const backend = backendOn();
    let refusedLogins = 0;
    backend.onLoginRefused(() => { refusedLogins += 1; });
    backend.start();
    expect(await until(() => built[0].sent.length > 0, 1000)).toBe(true);
    latchTwo(backend);
    first.reject(Object.assign(new Error('role "nobody" is not permitted to log in'), { code: '28000', severity: 'FATAL' }));
    expect(await until(() => bootstrapFailure() !== undefined, 1500)).toBe(true);
    expect(refusedLogins).toBe(0);
  });

  function provisionAnswers(): Answer {
    return text => {
      if (text === 'SELECT 1') return answered([{ '?column?': 1 }]);
      if (text === 'SELECT pg_is_in_recovery() AS in_recovery') return answered([{ in_recovery: false }]);
      if (text === 'BEGIN' || text === 'ROLLBACK' || text.startsWith('SET ')) return answered();
      if (/pg_try_advisory_xact_lock\(hashtext\('smdb_data_bootstrap'\)\)/.test(text)) return answered([{ locked: true }]);
      if (text === 'SHOW server_version_num') return answered([{ server_version_num: '160004' }]);
      if (text === 'SHOW server_encoding') return answered([{ server_encoding: 'UTF8' }]);
      if (/has_database_privilege/.test(text)) {
        return answered([{ role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true, relations: [], meta: null }]);
      }
      return Promise.reject(Object.assign(new Error('interner Fehler'), { code: 'XX000', severity: 'FEHLER' }));
    };
  }

  it('sends the provisioning statements with no bind parameters', async () => {
    nextAnswer = provisionAnswers();
    const backend = backendOn();
    backend.start();
    expect(await until(() => bootstrapFailure() !== undefined, 1500)).toBe(true);
    const sent = built[0].clientSent;
    expect(sent.slice(0, 3).map(s => s.text)).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', expect.stringContaining("hashtext('smdb_data_bootstrap')")]);
    expect(sent.every(s => s.values.length === 0)).toBe(true);
  });

  it('sends nothing more on a provisioning client whose statement got no answer, and retries', async () => {
    nextAnswer = provisionAnswers();
    const backend = backendOn();
    const alerts: string[] = [];
    backend.onAlert(event => alerts.push(event));
    backend.start();
    expect(await until(() => bootstrapFailure() !== undefined || alerts.length > 0, 1500)).toBe(true);
    expect(alerts).toEqual([]);
    const error = bootstrapFailure()![1] as { code?: string };
    expect(error.code).toBe('XX000');
    const sent = built[0].clientSent.map(s => s.text);
    expect(sent).not.toContain('ROLLBACK');
    expect(built[0].released).toEqual([true]);
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
  });
});

describe('a lease and the epoch it was taken under', () => {
  it('sends nothing more on a lease taken before a move that has since finished', async () => {
    const begin = deferred<Result>();
    nextAnswer = text => (text === 'BEGIN' ? begin.promise : answered([{ locked: true }]));
    const backend = backendOn();
    built[0].endRejects = false;
    const sweep = backend.sweepGraveyard(1000).then(() => null, (e: unknown) => e as Error);
    expect(await until(() => built[0].sent.length > 0, 1000)).toBe(true);
    latchTwo(backend);
    nextAnswer = () => answered();
    await expect(backend.useDatabase(URL_B, passingSteps())).resolves.toBe(true);
    begin.resolve({ rows: [], rowCount: 0 });
    const error = await sweep;
    expect(error?.name).toBe('OwnStateRefusal');
    expect(error?.message).toContain(REPLACED);
    expect(built[0].sent.map(s => s.text)).toEqual(['BEGIN']);
    expect(built[0].released).toEqual([true]);
  });

  it('starts no hold for a failed connect to the database this process has since left', async () => {
    const connect = deferred<never>();
    nextConnect = () => connect.promise;
    const backend = backendOn();
    nextConnect = undefined;
    const hold = installHoldingChooser(backend);
    const asked = backend.askDatabase();
    latchTwo(backend);
    await expect(backend.useDatabase(URL_B, passingSteps())).resolves.toBe(true);
    connect.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }));
    await expect(asked).resolves.toBe('unreachable');
    expect(hold.epochs).toEqual([]);
    expect(backend.connectionState()).toEqual({ state: 'ready' });
  });

  it("answers the latch's refusal for a read the latch cut", async () => {
    nextAnswer = () => new Promise<Result>(() => {});
    const backend = backendOn();
    const read = backend.guildFileExists('111', { module: 'm', filename: 'a.json' }).then(() => null, (e: unknown) => e as Error);
    expect(await until(() => built[0].sent.length > 0, 1000)).toBe(true);
    latchTwo(backend);
    const error = await read;
    expect(error?.name).toBe('OwnStateRefusal');
    expect(error?.message).toContain(REPLACED);
    expect(built[0].released).toEqual([true]);
  });

  it("returns an answered read's client to the pool, and a later latch leaves it alone", async () => {
    const backend = backendOn();
    await expect(backend.askDatabase()).resolves.toBe('answers');
    expect(built[0].released).toEqual([undefined]);
    latchTwo(backend);
    expect(built[0].clientEnds).toBe(0);
  });

  it('starts the hold for a retire statement that got no answer under its own deadline', async () => {
    nextAnswer = () => Promise.reject({ message: 'Query read timeout' });
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    const token = { nodeId: 'node-a', claim: 3, processId: 'p-1', shardId: 0, shardCount: 1 };
    const outcome = await backend.retireGuild('111', 'left', token, deadlineIn(5_000));
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(hold.epochs).toEqual([backend.databaseEpoch()]);
    expect(backend.holdWords()).toContain('the database did not answer');
  });
});

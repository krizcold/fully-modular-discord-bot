import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser, MoveSteps } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { installHoldingChooser } from '../helpers/nb6Hold';

const URL_A = 'postgres://nobody@127.0.0.1:9/none';
const URL_B = 'postgres://nobody@127.0.0.1:9/other';

type Result = { rows: Array<Record<string, unknown>>; rowCount: number };
type Answer = (text: string, values: unknown[]) => Promise<Result>;

// Postgres refuses a statement whose bind message carries a different number of parameters than its text uses.
function onTheWire(config: unknown, more: unknown[] | undefined): { text: string; values: unknown[] } {
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
  sent: string[];
  released: unknown[];
  ends: number;
  connect(): Promise<unknown>;
  query(config: unknown, values?: unknown[]): Promise<Result>;
  on(): void;
  end(): Promise<void>;
}

function fakePool(answer: Answer, connect?: () => Promise<never>): FakePool {
  const pool: FakePool = {
    sent: [],
    released: [],
    ends: 0,
    async connect() {
      if (connect) return connect();
      let cutBy: ((error: Error) => void) | null = null;
      return {
        query: (config: unknown, values?: unknown[]) => {
          const statement = onTheWire(config, values);
          pool.sent.push(statement.text);
          return new Promise<Result>((resolve, reject) => {
            cutBy = reject;
            answer(statement.text, statement.values).then(resolve, reject);
          });
        },
        release: (destroy?: boolean) => pool.released.push(destroy),
        end: async () => {
          cutBy?.(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' }));
        },
        on() {},
      };
    },
    async query(config: unknown, values?: unknown[]) {
      const statement = onTheWire(config, values);
      pool.sent.push(statement.text);
      return answer(statement.text, statement.values);
    },
    on() {},
    async end() {
      pool.ends += 1;
    },
  };
  return pool;
}

const answered = (rows: Array<Record<string, unknown>> = [], rowCount = rows.length): Promise<Result> => Promise.resolve({ rows, rowCount });

let built: Array<{ pool: FakePool }> = [];
let nextAnswer: Answer = () => answered();
let nextConnect: (() => Promise<never>) | undefined;
let backends: PostgresBackend[] = [];

beforeEach(() => {
  built = [];
  backends = [];
  nextAnswer = () => answered();
  nextConnect = undefined;
  vi.spyOn(PostgresBackend.prototype as unknown as { makePool(config: unknown): unknown }, 'makePool').mockImplementation(() => {
    const pool = fakePool(nextAnswer, nextConnect);
    built.push({ pool });
    return pool;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const backend of backends) await backend.stop();
  vi.restoreAllMocks();
});

function backendOn(chooser: { chooser: DatabaseChooser } = fixedDatabase(URL_A)): PostgresBackend {
  const backend = new PostgresBackend(chooser);
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

const passingSteps = (): MoveSteps => ({
  checkTarget: async () => null,
  claims: async () => true,
  settleRetires: async () => true,
  moved: () => undefined,
});

const warnLines = () => (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const bootstrapFailure = () => warnLines().find(call => String(call[0]).includes('Bootstrap attempt 1 failed'));

describe('the graveyard sweep on its lease', () => {
  it('answers 0 and logs the skip when another holder has the graveyard lock', async () => {
    nextAnswer = text => (/pg_try_advisory_xact_lock/.test(text) ? answered([{ locked: false }]) : answered());
    const backend = backendOn();
    await expect(backend.sweepGraveyard(1000)).resolves.toBe(0);
    expect(built[0].pool.sent).toEqual(['BEGIN', expect.stringContaining('pg_try_advisory_xact_lock'), 'ROLLBACK']);
    expect(built[0].pool.released).toEqual([undefined]);
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(call => call[0])).toContain(
      "[Data] Graveyard row sweep skipped: the graveyard lock is held (a restore, or another process's sweep); the next sweep runs it",
    );
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
  });

  it('answers the number of rows the committed sweep deleted', async () => {
    nextAnswer = text => {
      if (/pg_try_advisory_xact_lock/.test(text)) return answered([{ locked: true }]);
      if (/DELETE FROM/.test(text)) return answered([], 3);
      return answered();
    };
    const backend = backendOn();
    await expect(backend.sweepGraveyard(1000)).resolves.toBe(3);
    expect(built[0].pool.sent.at(-1)).toBe('COMMIT');
    expect(built[0].pool.released).toEqual([undefined]);
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
  });

  it('rethrows a database answer, destroys the client and starts no hold', async () => {
    const answer = Object.assign(new Error('update or delete violates foreign key constraint'), { code: '23503', severity: 'ERROR' });
    nextAnswer = text => {
      if (/pg_try_advisory_xact_lock/.test(text)) return answered([{ locked: true }]);
      if (/DELETE FROM/.test(text)) return Promise.reject(answer);
      return answered();
    };
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    await expect(backend.sweepGraveyard(1000)).rejects.toBe(answer);
    expect(built[0].pool.sent).not.toContain('COMMIT');
    expect(built[0].pool.released).toEqual([true]);
    expect(hold.epochs).toEqual([]);
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
  });

  it('reads a 28000 the database answered inside the sweep as no outage and no refused login', async () => {
    const answer = Object.assign(new Error('role may not log in'), { code: '28000', severity: 'ERROR' });
    nextAnswer = text => {
      if (/pg_try_advisory_xact_lock/.test(text)) return answered([{ locked: true }]);
      if (/DELETE FROM/.test(text)) return Promise.reject(answer);
      return answered();
    };
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    let refusedLogins = 0;
    backend.onLoginRefused(() => { refusedLogins += 1; });
    await expect(backend.sweepGraveyard(1000)).rejects.toBe(answer);
    expect(refusedLogins).toBe(0);
    expect(hold.epochs).toEqual([]);
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
    expect(backend.holdWords()).toBeNull();
  });

  it('enters the hold when the sweep gets no answer', async () => {
    const lost = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    nextAnswer = text => {
      if (/pg_try_advisory_xact_lock/.test(text)) return answered([{ locked: true }]);
      if (/DELETE FROM/.test(text)) return Promise.reject(lost);
      return answered();
    };
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    await expect(backend.sweepGraveyard(1000)).rejects.toBe(lost);
    expect(built[0].pool.released).toEqual([true]);
    expect(hold.epochs).toEqual([backend.databaseEpoch()]);
    expect(backend.connectionState().state).toBe('outage');
    expect(backend.holdWords()).toContain('the database did not answer');
  });

  it("answers the latch's refusal when the latch cut the sweep's client", async () => {
    let deleteSent!: () => void;
    const sent = new Promise<void>(resolve => { deleteSent = resolve; });
    nextAnswer = text => {
      if (/pg_try_advisory_xact_lock/.test(text)) return answered([{ locked: true }]);
      if (/DELETE FROM/.test(text)) {
        deleteSent();
        return new Promise<Result>(() => {});
      }
      return answered();
    };
    const backend = backendOn();
    const sweep = backend.sweepGraveyard(1000);
    await sent;
    backend.latch({ kind: 'replaced', machine: 'machine-two', generation: 4 });
    const error = await sweep.then(() => null, (e: unknown) => e as Error);
    expect(error).not.toBeNull();
    expect(error!.name).toBe('OwnStateRefusal');
    expect(error!.message).toContain('was replaced by machine-two (generation 4)');
    expect(built[0].pool.released).toEqual([true]);
  });
});

describe('the move flag', () => {
  it('is up only between step (b) and the end of the attempt', async () => {
    const backend = backendOn();
    backend.latch({ kind: 'replaced', machine: 'machine-two', generation: 2 });
    expect(backend.isMoving()).toBe(false);
    const seen: boolean[] = [];
    const moved = await backend.useDatabase(URL_B, { ...passingSteps(), claims: async () => { seen.push(backend.isMoving()); return false; } });
    expect(moved).toBe(false);
    expect(seen).toEqual([true]);
    expect(backend.isMoving()).toBe(false);
  });

  it('runs a move on the steps setMoveSteps gave', async () => {
    const backend = backendOn();
    backend.latch({ kind: 'replaced', machine: 'machine-two', generation: 2 });
    const checked: string[] = [];
    backend.setMoveSteps({ ...passingSteps(), checkTarget: async entry => { checked.push(entry); return 'the target is refused by this test'; } });
    const move = backend.useDatabase(URL_B);
    expect(checked).toEqual([URL_B]);
    await expect(move).resolves.toBe(false);
  });
});

describe('the hold as the backend reports it', () => {
  it('reports nothing held and asks the chooser for nothing before any hold', () => {
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
    expect(backend.confirmingWords()).toBeNull();
    expect(backend.refusesByOwnState()).toBe(false);
    backend.confirmNow();
    expect(hold.confirms).toBe(0);
  });

  it('in the outage phase: no confirming cause, saves not refused by its own state, a drain hurries the chooser', () => {
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    backend.noteLapse();
    const state = backend.connectionState();
    expect(state.state).toBe('outage');
    expect(typeof state.outageSinceMs).toBe('number');
    expect(backend.confirmingWords()).toBeNull();
    expect(backend.refusesByOwnState()).toBe(false);
    backend.confirmNow();
    expect(hold.confirms).toBe(1);
  });

  it('in the confirming phase: the outage start, the latest cause, and saves refused', () => {
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    backend.noteLapse();
    const since = backend.connectionState().outageSinceMs;
    const epoch = hold.epochs[0];
    backend.noteEntryAnswered(epoch);
    expect(backend.connectionState()).toEqual({ state: 'confirming', outageSinceMs: since });
    expect(typeof since).toBe('number');
    expect(backend.confirmingWords()).toBe('checking');
    backend.noteConfirmingCause('the main announced generation 3 from another machine', epoch);
    expect(backend.confirmingWords()).toBe('the main announced generation 3 from another machine');
    expect(backend.refusesByOwnState()).toBe(true);
    hold.release();
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
    expect(backend.confirmingWords()).toBeNull();
    expect(backend.refusesByOwnState()).toBe(false);
  });
});

describe('askDatabase', () => {
  it("answers the chooser's last pass before any database is chosen", async () => {
    const backend = backendOn({
      chooser: {
        chosen: () => null,
        awaitChoice: () => new Promise<string | null>(() => {}),
        lastPassLogin: () => 'refused',
        holdStarted() {},
        confirmNow() {},
        stop() {},
      },
    });
    await expect(backend.askDatabase()).resolves.toBe('refused');
  });

  it('answers that the database answers when SELECT 1 goes through', async () => {
    const backend = backendOn();
    const hold = installHoldingChooser(backend);
    await expect(backend.askDatabase()).resolves.toBe('answers');
    expect(built[0].pool.sent).toEqual(['SELECT 1']);
    expect(hold.epochs).toEqual([]);
  });
});

describe('the bootstrap loop', () => {
  it('starts on the entry chosen before start() without waiting on the chooser', async () => {
    let asked = 0;
    nextAnswer = () => new Promise<Result>(() => {});
    const backend = backendOn({
      chooser: {
        chosen: () => URL_A,
        awaitChoice: () => { asked += 1; return new Promise<string | null>(() => {}); },
        lastPassLogin: () => 'unreachable',
        holdStarted() {},
        confirmNow() {},
        stop() {},
      },
    });
    backend.start();
    expect(await until(() => built[0].pool.sent.length > 0, 1000)).toBe(true);
    expect(built[0].pool.sent).toEqual(['SELECT 1']);
    expect(asked).toBe(0);
  });

  it('refuses a database in recovery, after it answered', async () => {
    nextConnect = () => Promise.reject(new Error('no session in this test'));
    nextAnswer = text => (text === 'SELECT pg_is_in_recovery() AS in_recovery' ? answered([{ in_recovery: true }]) : text === '' ? answered() : answered([{ '?column?': 1 }]));
    const backend = backendOn();
    backend.start();
    expect(await until(() => bootstrapFailure() !== undefined, 1500)).toBe(true);
    const error = bootstrapFailure()![1] as Error;
    expect(error.message).toBe('the database is in recovery (read-only); the bot serves only from a database that takes writes');
    expect(backend.connectionState()).toEqual({ state: 'connecting' });
  });

  it('keeps the database a move chose while the boot wait ran', async () => {
    let choose!: (entry: string | null) => void;
    nextAnswer = () => new Promise<Result>(() => {});
    const backend = backendOn({
      chooser: {
        chosen: () => null,
        awaitChoice: () => new Promise<string | null>(resolve => { choose = resolve; }),
        lastPassLogin: () => 'unreachable',
        holdStarted() {},
        confirmNow() {},
        stop() {},
      },
    });
    backend.start();
    backend.latch({ kind: 'replaced', machine: 'machine-two', generation: 5 });
    await expect(backend.useDatabase(URL_B, passingSteps())).resolves.toBe(true);
    const epoch = backend.databaseEpoch();
    expect(built).toHaveLength(1);
    choose(URL_A);
    expect(await until(() => built.some(b => b.pool.sent.length > 0), 1000)).toBe(true);
    expect(backend.chosenEntry()).toBe(URL_B);
    expect(backend.databaseEpoch()).toBe(epoch);
    expect(built).toHaveLength(1);
  });

  it('tells the listeners when the database refuses the login at bootstrap', async () => {
    nextAnswer = () => Promise.reject(Object.assign(new Error('role "nobody" is not permitted to log in'), { code: '28000', severity: 'FATAL' }));
    const backend = backendOn();
    let refusedLogins = 0;
    backend.onLoginRefused(() => { refusedLogins += 1; });
    backend.start();
    expect(await until(() => bootstrapFailure() !== undefined, 1500)).toBe(true);
    expect(refusedLogins).toBe(1);
  });

  it('does not tell them about a refusal observed on a database this process latched since', async () => {
    let refuse!: () => void;
    nextAnswer = () => new Promise<Result>((_resolve, reject) => {
      refuse = () => reject(Object.assign(new Error('role "nobody" is not permitted to log in'), { code: '28000', severity: 'FATAL' }));
    });
    const backend = backendOn();
    let refusedLogins = 0;
    backend.onLoginRefused(() => { refusedLogins += 1; });
    backend.start();
    expect(await until(() => built[0].pool.sent.length > 0, 1000)).toBe(true);
    backend.latch({ kind: 'replaced', machine: 'machine-two', generation: 6 });
    refuse();
    expect(await until(() => bootstrapFailure() !== undefined, 1500)).toBe(true);
    expect(refusedLogins).toBe(0);
  });
});

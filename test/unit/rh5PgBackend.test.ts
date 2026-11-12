import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresBackend, oversizeFailure } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { FLUSH_STATEMENT_BYTES } from '../../src/bot/internalSetup/utils/storableData';

const URL_A = 'postgres://nobody@127.0.0.1:9/none';
const GUILD = '111';
const TOKEN: FenceToken = { nodeId: 'node-1', claim: 5, processId: 'proc-1', shardId: 0, shardCount: 1 };

type Row = Record<string, unknown> | null;
type Result = { rows: Row[]; rowCount: number };
type Wire = { text: string; values: unknown[] };
type Answer = (wire: Wire) => Promise<Result>;

const answered = (rows: Row[] = [], rowCount = rows.length): Promise<Result> => Promise.resolve({ rows, rowCount });
const serverError = (message: string, code: string, severity = 'ERROR') => Object.assign(new Error(message), { code, severity });

// Postgres answers a bind message whose parameter count differs from the statement's with SQLSTATE 08P01.
function onTheWire(config: unknown, more: unknown[] | undefined): Wire {
  const { text, values } = typeof config === 'string' ? { text: config, values: more ?? [] } : (config as { text: string; values?: unknown[] });
  const given = values ?? [];
  let wanted = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) wanted = Math.max(wanted, Number(match[1]));
  return { text, values: given, ...(given.length !== wanted ? { mismatch: `bind message supplies ${given.length} parameters, but prepared statement "" requires ${wanted}` } : {}) } as Wire;
}

interface FakePool {
  sent: Wire[];
  released: unknown[];
  connect(): Promise<unknown>;
  query(config: unknown, values?: unknown[]): Promise<Result>;
  on(): void;
  end(): Promise<void>;
}

function fakePool(answer: Answer): FakePool {
  const run = (config: unknown, values?: unknown[]): Promise<Result> => {
    const wire = onTheWire(config, values) as Wire & { mismatch?: string };
    pool.sent.push({ text: wire.text, values: wire.values });
    if (wire.mismatch) return Promise.reject(serverError(wire.mismatch, '08P01'));
    return answer(wire);
  };
  const pool: FakePool = {
    sent: [],
    released: [],
    async connect() {
      return { query: run, release: (destroy?: boolean) => pool.released.push(destroy), end: async () => undefined, on() {} };
    },
    query: run,
    on() {},
    async end() {},
  };
  return pool;
}

function quietChooser(url: string): DatabaseChooser {
  return {
    chosen: () => url,
    awaitChoice: async () => url,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

let built: FakePool[] = [];
let nextAnswer: Answer = () => answered();
let backends: PostgresBackend[] = [];

beforeEach(() => {
  built = [];
  backends = [];
  nextAnswer = () => answered();
  vi.spyOn(PostgresBackend.prototype as unknown as { makePool(config: unknown): unknown }, 'makePool').mockImplementation(() => {
    const answer = nextAnswer;
    const pool = fakePool(wire => answer(wire));
    built.push(pool);
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

function backendOn(answer: Answer): PostgresBackend {
  nextAnswer = answer;
  const backend = new PostgresBackend({ chooser: quietChooser(URL_A) });
  backends.push(backend);
  return backend;
}

const BATCH_PRESENT = /guild_data_graveyard WHERE guild_id = \$1 AND retired_at = \$2\) AS present/;
const OWNERSHIP_UPSERT = /INSERT INTO smdb_data\.guild_ownership AS o/;
const OWNER_SELECT = /^SELECT node_id, claim FROM smdb_data\.guild_ownership WHERE guild_id = \$1$/;
const HYDRATE_BYTES = /AS bytes$/;
const DOCS_READ = /^SELECT module, filename, doc FROM smdb_data\.guild_data WHERE guild_id = \$1$/;
const noAnswer = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });

describe('retireReached: whether a retired batch is on the database', () => {
  it('answers true when the batch is there and gives the client back to the pool for reuse', async () => {
    const backend = backendOn(w => (BATCH_PRESENT.test(w.text) ? answered([{ present: true }]) : answered()));
    await expect(backend.retireReached(GUILD, 77)).resolves.toBe(true);
    expect(built[0].sent.map(s => s.values)).toEqual([[GUILD, 77]]);
    expect(built[0].released).toEqual([undefined]);
  });

  it('answers false when the read returns no row', async () => {
    const backend = backendOn(() => answered([]));
    await expect(backend.retireReached(GUILD, 77)).resolves.toBe(false);
    expect(built[0].released).toEqual([undefined]);
  });

  it('answers false when the batch is not there', async () => {
    const backend = backendOn(() => answered([{ present: false }]));
    await expect(backend.retireReached(GUILD, 77)).resolves.toBe(false);
  });
});

describe('hydrateGuild: the owner read and the ROLLBACK after a failure', () => {
  it('names the current owner, read by guild id, when another process holds the guild', async () => {
    const backend = backendOn(w => {
      if (OWNERSHIP_UPSERT.test(w.text)) return answered([], 0);
      if (OWNER_SELECT.test(w.text)) return w.values[0] === GUILD ? answered([{ node_id: 'node-2', claim: '9' }]) : answered([]);
      return answered();
    });
    const outcome = await backend.hydrateGuild(GUILD, TOKEN);
    expect(outcome).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-2', claim: 9 } });
    expect(built[0].sent.find(s => OWNER_SELECT.test(s.text))?.values).toEqual([GUILD]);
  });

  it('sends a plain ROLLBACK after an answered error, and an answered error starts no hold', async () => {
    const backend = backendOn(w => (OWNERSHIP_UPSERT.test(w.text) ? Promise.reject(serverError('duplicate key value', '23505')) : answered()));
    const outcome = await backend.hydrateGuild(GUILD, TOKEN);
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
    expect(built[0].sent.filter(s => s.text === 'ROLLBACK')).toEqual([{ text: 'ROLLBACK', values: [] }]);
    expect(backend.holdWords()).toBeNull();
  });

  it("enters the hold for the operation's own failure, not for the ROLLBACK that failed after it", async () => {
    const backend = backendOn(w => {
      if (OWNERSHIP_UPSERT.test(w.text)) return answered([], 1);
      if (HYDRATE_BYTES.test(w.text)) return answered([{ bytes: '0' }]);
      if (DOCS_READ.test(w.text)) return answered([null]);
      if (w.text === 'ROLLBACK') return Promise.reject(serverError('terminating connection due to administrator command', '57P01', 'FATAL'));
      return answered();
    });
    const outcome = await backend.hydrateGuild(GUILD, TOKEN);
    expect(outcome).toEqual({ ok: false, reason: 'unavailable' });
    expect(built[0].sent.some(s => s.text === 'ROLLBACK')).toBe(true);
    const words = backend.holdWords();
    expect(words).toMatch(/^the database did not answer; /);
    expect(words).not.toContain('57P01');
  });
});

describe('reads that get no answer start the hold', () => {
  it('guildFileExists', async () => {
    const backend = backendOn(() => Promise.reject(noAnswer()));
    await expect(backend.guildFileExists(GUILD, { module: 'm', filename: 'a.json' })).rejects.toThrow('Connection terminated unexpectedly');
    expect(backend.holdWords()).toMatch(/^the database did not answer; /);
  });

  it('sharedSelect', async () => {
    const backend = backendOn(() => Promise.reject(noAnswer()));
    await expect(backend.sharedSelect('SELECT 1', [], 1000)).rejects.toThrow('Connection terminated unexpectedly');
    expect(backend.holdWords()).toMatch(/^the database did not answer; /);
  });

  it('an answered read starts nothing', async () => {
    const backend = backendOn(() => answered([{ present: true }]));
    await expect(backend.guildFileExists(GUILD, { module: 'm', filename: 'a.json' })).resolves.toBe(true);
    expect(backend.holdWords()).toBeNull();
  });
});

describe('oversizeFailure', () => {
  it('names the bytes a statement carries and the limit, and says it was not sent', () => {
    const bytes = FLUSH_STATEMENT_BYTES + 1;
    expect(oversizeFailure({ text: 'INSERT', values: [Buffer.alloc(bytes)] } as never)).toEqual({
      kind: 'failed', step: 'build',
      detail: `a statement carries ${bytes} bytes of values, over the ${FLUSH_STATEMENT_BYTES} a statement may carry; it was not sent`,
    });
  });
});

// A guild's live rows and graveyard, changed by the re-save's statements as Postgres would run them: a row is kept by
// `(module, filename) NOT IN (unnest(...))` unless the comparison is true or null for none of the kept pairs.
interface Stored { docs: string[]; appends: string[]; graveyard: string[] }

function sqlNotIn(module: string, filename: string, modules: unknown[], files: unknown[]): boolean | null {
  let sawNull = false;
  for (let i = 0; i < Math.max(modules.length, files.length); i += 1) {
    const parts = [[module, modules[i]], [filename, files[i]]].map(([a, b]) => (b === null || b === undefined ? null : a === b));
    if (parts.includes(false)) continue;
    if (parts.includes(null)) sawNull = true;
    else return false;
  }
  return sawNull ? null : true;
}

function resaveModel(stored: Stored): Answer {
  const split = (key: string) => key.split('/') as [string, string];
  const goes = (key: string, modules: unknown, files: unknown) => sqlNotIn(...split(key), modules as unknown[], files as unknown[]) === true;
  return w => {
    if (/^INSERT INTO smdb_data\.guild_ownership AS o/.test(w.text.trim())) return answered([], 1);
    if (w.text.startsWith('WITH batch AS')) {
      const [, docModules, docFiles, appendModules, appendFiles] = w.values;
      const moved = [...stored.docs.filter(k => goes(k, docModules, docFiles)), ...stored.appends.filter(k => goes(k, appendModules, appendFiles))];
      stored.graveyard.push(...moved);
      return answered([{ moved: String(moved.length), retired_at: '1000' }]);
    }
    if (w.text.startsWith('DELETE FROM smdb_data.guild_data WHERE')) {
      stored.docs = stored.docs.filter(k => !goes(k, w.values[1], w.values[2]));
      return answered();
    }
    if (w.text.startsWith('DELETE FROM smdb_data.guild_append WHERE')) {
      stored.appends = stored.appends.filter(k => !goes(k, w.values[1], w.values[2]));
      return answered();
    }
    return answered();
  };
}

describe('flushGuild with a re-save: the rows the set does not hold go to the graveyard, the rest stay', () => {
  it('keeps every held key, moves and deletes every other one', async () => {
    const stored: Stored = {
      docs: ['m1/a.json', 'm2/a.json', 'm1/b.json'],
      appends: ['m1/log.json', 'm3/log.json', 'm1/old.json'],
      graveyard: [],
    };
    const backend = backendOn(resaveModel(stored));
    const batch: GuildFlushBatch = {
      upserts: [], deletes: [], appends: [],
      replace: {
        docKeys: [{ module: 'm1', filename: 'a.json' }, { module: 'm2', filename: 'c.json' }],
        appendKeys: [{ module: 'm1', filename: 'log.json' }],
        reason: 'resave',
      },
    };
    await expect(backend.flushGuild(GUILD, batch, TOKEN)).resolves.toEqual({ ok: true });
    expect(stored.docs).toEqual(['m1/a.json']);
    expect(stored.appends).toEqual(['m1/log.json']);
    expect(stored.graveyard.sort()).toEqual(['m1/b.json', 'm1/old.json', 'm2/a.json', 'm3/log.json']);
    expect(built[0].sent.at(-1)?.text).toBe('COMMIT');
  });
});

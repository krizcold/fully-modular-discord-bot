import { EventEmitter } from 'events';
import util from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const URL = 'postgres://nobody@127.0.0.1:9/none';
const backends: PostgresBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
  vi.restoreAllMocks();
});

function quietChooser(url: string | null) {
  const calls = { stop: 0 };
  const chooser: DatabaseChooser = {
    chosen: () => url,
    awaitChoice: async () => url,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() { calls.stop += 1; },
  };
  return { chooser, calls };
}

function made(url: string | null = URL) {
  const { chooser, calls } = quietChooser(url);
  const backend = new PostgresBackend({ chooser });
  backends.push(backend);
  return { backend, calls };
}

type Query = { text: string; values?: unknown[] };

// A client that answers as the server does: a statement given more parameters than its text names is a protocol error.
function wireClient(lockRows: unknown[] = [{ locked: true }]) {
  const sent: Query[] = [];
  const client = {
    query: async (config: Query) => {
      sent.push(config);
      const wanted = new Set(config.text.match(/\$\d+/g) ?? []).size;
      if ((config.values?.length ?? 0) !== wanted) {
        throw Object.assign(new Error(`bind message supplies ${config.values?.length ?? 0} parameters, but prepared statement "" requires ${wanted}`), { severity: 'ERROR', code: '08P01' });
      }
      if (/pg_try_advisory_xact_lock/.test(config.text)) return { rows: lockRows, rowCount: lockRows.length };
      return { rows: [], rowCount: 3 };
    },
    release: () => undefined,
  };
  return { client, sent };
}

function withClient(backend: PostgresBackend, connect: () => Promise<unknown>) {
  (backend as unknown as { pool: unknown }).pool = { connect, end: async () => undefined };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('the condition did not come true in time');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('the graveyard sweep on the wire', () => {
  it('sends BEGIN and the lock try with no parameters and returns the rows it deleted', async () => {
    const { backend } = made();
    const { client, sent } = wireClient();
    withClient(backend, async () => client);
    expect(await backend.sweepGraveyard(1000)).toBe(3);
    expect(sent.map(q => q.text.split(/\s/)[0])).toEqual(['BEGIN', 'SELECT', 'DELETE', 'COMMIT']);
    expect(backend.holdWords()).toBeNull();
  });

  it('reads a lock answer with no row as a held lock and skips the sweep', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { backend } = made();
    const { client, sent } = wireClient([]);
    withClient(backend, async () => client);
    expect(await backend.sweepGraveyard(1000)).toBe(0);
    expect(sent.map(q => q.text)).toContain('ROLLBACK');
    expect(sent.some(q => q.text.startsWith('DELETE'))).toBe(false);
    expect(log.mock.calls.some(args => String(args[0]).startsWith('[Data] Graveyard row sweep skipped: the graveyard lock is held'))).toBe(true);
  });
});

describe('a sweep whose connect fails', () => {
  it('enters the hold when the database did not answer the connect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = made();
    const failure = new Error('connect ECONNREFUSED 127.0.0.1:9');
    withClient(backend, async () => { throw failure; });
    await expect(backend.sweepGraveyard(1000)).rejects.toBe(failure);
    expect(backend.holdWords()).toMatch(/^the database did not answer; this process checks that /);
  });

  it('leaves the hold and the login listeners alone when the database answered the connect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = made();
    const heard: number[] = [];
    backend.onLoginRefused(() => heard.push(1));
    const failure = Object.assign(new Error('role "nobody" is not permitted to log in'), { severity: 'ERREUR', code: '28000' });
    withClient(backend, async () => { throw failure; });
    await expect(backend.sweepGraveyard(1000)).rejects.toBe(failure);
    expect(backend.holdWords()).toBeNull();
    expect(heard).toEqual([]);
  });

  it('says that no database is chosen yet before the choice', async () => {
    const { backend } = made(null);
    expect(() => backend.getPool()).toThrow('no database is chosen yet');
    await expect(backend.sweepGraveyard(1000)).rejects.toThrow('no database is chosen yet');
  });
});

describe('the backend lifecycle', () => {
  it('stops its chooser when it stops', async () => {
    const { backend, calls } = made();
    await backend.stop();
    expect(calls.stop).toBe(1);
  });

  it('names the guild-data pool when one of its clients fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend } = made();
    const client = new EventEmitter();
    backend.getPool().emit('connect', client);
    client.emit('error', new Error('connection reset'));
    expect(warn).toHaveBeenCalledWith('[Postgres] Connection error on the guild-data pool:', 'connection reset');
  });

  it('logs a bootstrap attempt that its own hold refused under the refusal name', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend } = made();
    backend.noteObservation(new Error('read ECONNRESET'), backend.databaseEpoch());
    expect(backend.holdWords()).not.toBeNull();
    backend.start();
    await until(() => warn.mock.calls.some(args => String(args[0]).startsWith('[PostgresBackend] Bootstrap attempt 1 failed')));
    const line = warn.mock.calls.find(args => String(args[0]).startsWith('[PostgresBackend] Bootstrap attempt 1 failed'))!;
    expect(util.format(...line).split('\n')[0]).toBe(`[PostgresBackend] Bootstrap attempt 1 failed (retrying): OwnStateRefusal: ${backend.holdWords()}`);
  });
});

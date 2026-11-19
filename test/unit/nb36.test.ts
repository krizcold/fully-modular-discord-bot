import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB36: `smdb data provision` with the connection (openJobSession) and the provisioning call
// (provisionStoreInTransaction) faked at their modules. Each row collects what the verb did and asserts after it.

const fake = vi.hoisted(() => ({
  url: '' as string | undefined,
  sent: [] as string[],
  ended: 0,
  opened: [] as Array<{ url: string; application: string; kind: string }>,
  connectError: null as unknown,
  schemaHeld: false,
  provisionError: null as unknown,
  commitError: null as unknown,
  provisioned: 0,
  commitTag: 'COMMIT',
  commitHangs: false,
  destroyed: 0,
  verdict: { kind: 'matches' } as unknown,
}));

vi.mock('../../src/utils/envLoader', async orig => {
  const real = await orig<any>();
  return { ...(await import('../helpers/backendKind')).withBackendKind(real), loadCredentials: () => ({ ...real.loadCredentials(), DATA_BACKEND_URL: fake.url }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataMigration', async orig => ({
  ...(await orig<any>()),
  openJobSession: async (url: string, application: string, kind: string) => {
    fake.opened.push({ url, application, kind });
    if (fake.connectError) throw fake.connectError;
    return {
      query: async (text: string) => {
        fake.sent.push(text);
        if (text.includes('pg_namespace')) return { rows: fake.schemaHeld ? [{ '?column?': 1 }] : [] };
        if (text === 'COMMIT' && fake.commitError) throw fake.commitError;
        if (text === 'COMMIT' && fake.commitHangs) return new Promise(() => undefined);
        if (text === 'COMMIT') return { rows: [], command: fake.commitTag };
        return { rows: [] };
      },
      end: async () => { fake.ended++; },
      connection: { stream: { destroy: () => { fake.destroyed++; } } },
    };
  },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async orig => ({
  ...(await orig<any>()),
  provisionStoreInTransaction: async (client: { query(text: string): Promise<unknown> }) => {
    fake.provisioned++;
    fake.sent.push('<provision>');
    if (fake.provisionError) throw fake.provisionError;
    await client.query('<provision statements>');
    return '11111111-2222-4333-8444-555555555555';
  },
  inspectStore: async () => {
    fake.sent.push('<inspect>');
    return fake.verdict;
  },
}));

import { dispatch } from '../../src/cli/commands';
import { EXIT_ERR, EXIT_OK, EXIT_USAGE } from '../../src/cli/output';
import { SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { provisionEmptyStore } from '../../src/bot/internalSetup/utils/storeProvision';

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

const URL_ONE = 'postgres://bot:secret-pw@db.example:5433/botdata?sslmode=disable';
const SHOWN = 'db.example:5433/botdata';

async function run(positionals: string[], flags: Record<string, string | boolean> = {}, tty = true) {
  let out = '';
  let err = '';
  const requests: string[] = [];
  const client: any = { request: async (m: string, p: string) => { requests.push(`${m} ${p}`); return { status: 200, ok: true, body: {} }; } };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as any);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => { out += String(s); return true; }) as any);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: any) => { err += String(s); return true; }) as any);
  const ttyBefore = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true, writable: true });
  let code: number | undefined | 'none' = 'none';
  try {
    await dispatch(client, positionals, flags);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    exitSpy.mockRestore();
    outSpy.mockRestore();
    errSpy.mockRestore();
    if (ttyBefore) Object.defineProperty(process.stdout, 'isTTY', ttyBefore);
    else delete (process.stdout as any).isTTY;
  }
  return { code, out, err, requests };
}

beforeEach(() => {
  fake.url = URL_ONE;
  fake.sent = [];
  fake.ended = 0;
  fake.opened = [];
  fake.connectError = null;
  fake.schemaHeld = false;
  fake.provisionError = null;
  fake.commitError = null;
  fake.provisioned = 0;
  fake.commitTag = 'COMMIT';
  fake.commitHangs = false;
  fake.destroyed = 0;
  fake.verdict = { kind: 'matches' };
});

afterEach(() => { vi.restoreAllMocks(); });

describe('smdb data provision', () => {
  it('provisions under the bootstrap lock in one transaction, prints the store id and the layout version, exits 0', async () => {
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toBe(`store id: 11111111-2222-4333-8444-555555555555\nlayout version: ${SCHEMA_VERSION}\n`);
    expect(r.err).toBe('');
    expect(r.requests).toEqual([]);
    expect(fake.opened).toEqual([{ url: URL_ONE, application: 'smdb-provision', kind: 'job' }]);
    expect(fake.sent).toEqual([
      'BEGIN',
      `SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`,
      `SELECT 1 FROM pg_namespace WHERE nspname = 'smdb_data'`,
      '<provision>',
      '<provision statements>',
      '<inspect>',
      'COMMIT',
    ]);
    expect(fake.ended).toBe(1);
  });

  it('prints one JSON object under --json and when stdout is no terminal', async () => {
    const flagged = await run(['data', 'provision'], { json: true });
    const piped = await run(['data', 'provision'], {}, false);
    for (const r of [flagged, piped]) {
      expect(r.code).toBe(EXIT_OK);
      expect(JSON.parse(r.out)).toEqual({ storeId: '11111111-2222-4333-8444-555555555555', layoutVersion: SCHEMA_VERSION });
    }
  });

  it('refuses a database that holds smdb_data, naming it without its login, and creates nothing', async () => {
    fake.schemaHeld = true;
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.out).toBe('');
    expect(r.err).toBe(`smdb: data provision refused: the database ${SHOWN} already holds the schema smdb_data; nothing was created\n`);
    expect(r.err).not.toContain('secret-pw');
    expect(fake.provisioned).toBe(0);
    expect(fake.sent).toContain('ROLLBACK');
    expect(fake.sent).not.toContain('COMMIT');
    expect(fake.ended).toBe(1);
  });

  it('refuses a database it cannot reach, with the reason', async () => {
    fake.connectError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5433'), { code: 'ECONNREFUSED' });
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.out).toBe('');
    expect(r.err).toBe(`smdb: data provision refused: the database ${SHOWN} could not be opened (connect ECONNREFUSED 10.0.0.9:5433); nothing was created\n`);
    expect(fake.provisioned).toBe(0);
  });

  it('names the SQLSTATE of a refused login', async () => {
    fake.connectError = Object.assign(new Error('role "bot" is not permitted to log in'), { code: '28000' });
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.err).toBe(`smdb: data provision refused: the database ${SHOWN} could not be opened (SQLSTATE 28000: role "bot" is not permitted to log in); nothing was created\n`);
  });

  it('refuses when DATA_BACKEND_URL is not set', async () => {
    for (const value of [undefined, '', '   ']) {
      fake.url = value;
      const r = await run(['data', 'provision']);
      expect(r.code).toBe(EXIT_ERR);
      expect(r.err).toBe('smdb: data provision refused: DATA_BACKEND_URL is not set; nothing was created\n');
    }
    expect(fake.opened).toEqual([]);
  });

  it('refuses a list of addresses', async () => {
    fake.url = `${URL_ONE},postgres://bot:pw@other:5432/botdata`;
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.err).toBe('smdb: data provision refused: DATA_BACKEND_URL lists 2 database addresses (live copies on other machines); a provision needs one database address, so remove the live copies first; nothing was created\n');
    expect(fake.opened).toEqual([]);
  });

  it('names the empty entry of a list with a trailing comma', async () => {
    fake.url = `${URL_ONE},`;
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.err).toBe('smdb: data provision refused: entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://; nothing was created\n');
    expect(fake.opened).toEqual([]);
  });

  it("rolls back a store the bot's own check refuses, with that check's reason", async () => {
    fake.verdict = { kind: 'refused', cause: 'encoding', refusal: { header: 'h', lines: [], reason: "the database's server_encoding is LATIN1, and this bot needs a UTF8 database", fix: 'f' }, found: 'LATIN1' };
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.out).toBe('');
    expect(r.err).toBe(`smdb: data provision refused: the database ${SHOWN} can't hold this bot's store: the database's server_encoding is LATIN1, and this bot needs a UTF8 database; nothing was created\n`);
    expect(fake.sent.slice(-2)).toEqual(['<inspect>', 'ROLLBACK']);
    expect(fake.sent).not.toContain('COMMIT');
  });

  it('a COMMIT answered with a ROLLBACK tag says nothing was created', async () => {
    fake.commitTag = 'ROLLBACK';
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.out).toBe('');
    expect(r.err).toBe(`smdb: data provision failed at ${SHOWN}: the database rolled the transaction back at its COMMIT; nothing was created\n`);
  });

  it("a COMMIT with no answer within its bound can't be confirmed and its socket is destroyed", async () => {
    fake.commitHangs = true;
    const outcome = await provisionEmptyStore(URL_ONE, { commitBoundMs: 50 });
    expect(outcome).toEqual({ state: 'unconfirmed', line: `can't confirm whether data provision created a store at ${SHOWN}: the COMMIT got no answer within 0.05 s; check whether the schema smdb_data exists there` });
    expect(fake.destroyed).toBe(1);
    expect(fake.ended).toBe(0);
  });

  it('refuses an address that is not a database address', async () => {
    fake.url = 'mysql://db/x';
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.err).toBe('smdb: data provision refused: DATA_BACKEND_URL does not start with postgresql:// or postgres://; nothing was created\n');
    expect(fake.opened).toEqual([]);
  });

  it('a failure before the commit rolls back and says nothing was created', async () => {
    fake.provisionError = Object.assign(new Error('permission denied for database botdata'), { code: '42501' });
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.out).toBe('');
    expect(r.err).toBe(`smdb: data provision failed at ${SHOWN}: SQLSTATE 42501: permission denied for database botdata; nothing was created\n`);
    expect(fake.sent).toContain('ROLLBACK');
    expect(fake.sent).not.toContain('COMMIT');
    expect(fake.ended).toBe(1);
  });

  it("a commit with no clear answer can't be confirmed", async () => {
    fake.commitError = new Error('Connection terminated unexpectedly');
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.out).toBe('');
    expect(r.err).toBe(`smdb: can't confirm whether data provision created a store at ${SHOWN}: the COMMIT got no clear answer (Connection terminated unexpectedly); check whether the schema smdb_data exists there\n`);
    expect(fake.ended).toBe(1);
  });

  it('a commit the server refused says nothing was created', async () => {
    fake.commitError = Object.assign(new Error('could not serialize access'), { code: '40001', severity: 'ERROR' });
    const r = await run(['data', 'provision']);
    expect(r.code).toBe(EXIT_ERR);
    expect(r.err).toBe(`smdb: data provision failed at ${SHOWN}: SQLSTATE 40001: could not serialize access; nothing was created\n`);
  });

  it('takes no arguments', async () => {
    const r = await run(['data', 'provision', 'extra']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.err).toBe('smdb: data provision takes no arguments\n');
    expect(fake.opened).toEqual([]);
  });
});

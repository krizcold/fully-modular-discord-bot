import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const h = vi.hoisted(() => ({
  verdict: { state: 'mismatch', found: '{"v":1}' } as any,
  identity: { ok: true } as any,
  released: 0,
  closed: 0,
  adopts: [] as boolean[],
}));

vi.mock('../../src/utils/envLoader', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadCredentials: () => ({ DATA_BACKEND_URL: 'postgres://nobody@127.0.0.1:9/none' }),
  resolveDataBackend: () => 'postgres',
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async importOriginal => ({
  ...(await importOriginal<object>()),
  evaluateRecognitionGuard: () => ({ state: 'boot', live: 'postgres' }),
  readFileMarker: () => ({ live: 'postgres', storeId: 'store-1', flippedAt: 1 }),
  verifyStoreIdentity: async (_url: string, adopt: boolean) => { h.adopts.push(adopt); return h.identity; },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  PostgresBackend: class {
    start() {}
    stop() { return Promise.resolve(); }
    provisionVerdict() { return h.verdict === 'never' ? new Promise(() => {}) : Promise.resolve(h.verdict); }
    onHoldChanged() {}
    setMoveSteps() {}
    chosenEntry() { return 'postgresql://u:p@db:5432/bot'; }
  },
}));

// NB5 decision 7: the data layer awaits the chooser's choice; here it chose one entry at once.
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', async importOriginal => ({
  ...(await importOriginal<object>()),
  MainChooser: class {
    chosen() { return 'postgresql://u:p@db:5432/bot'; }
    awaitChoice() { return Promise.resolve('postgresql://u:p@db:5432/bot'); }
    lastPassLogin() { return 'unreachable'; }
    holdStarted() {}
    confirmNow() {}
    stop() {}
    attach() {}
  },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async importOriginal => ({
  ...(await importOriginal<object>()),
  initWorkingSet: () => ({}),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => ({
  ...(await importOriginal<object>()),
  initDataReadiness: () => ({ release() { h.released++; }, stop() {} }),
  getDataReadiness: () => ({ causeOf: () => 'loading' }),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => ({
  ...(await importOriginal<object>()),
  setGuildDataBackend: () => {},
  closeGuildWrites: () => { h.closed++; },
}));

beforeEach(() => {
  vi.resetModules();
  h.released = 0;
  h.closed = 0;
  h.adopts = [];
  h.identity = { ok: true };
});

async function boot() {
  const mod = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
  mod.initDataBackendLayer();
  await new Promise(resolve => { setTimeout(resolve, 20); });
  return mod;
}

// NB1 round 1, F2: a database of another schema version keeps its store id, so the identity check passes; the data
// boot must still refuse it, as it refuses a wrong store.
describe('a database of another schema version', () => {
  it('refuses the data boot: state refused, guild writes closed, the readiness driver held, members read refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.verdict = { state: 'mismatch', found: '{"v":1}' };
    const mod = await boot();
    const status = mod.getDataBootStatus();
    expect(status.state).toBe('refused');
    expect(status.refusalReason).toContain('{"v":1}');
    expect(h.closed).toBe(1);
    expect(h.released).toBe(0);
    expect(mod.gateCauseNow('123', performance.now())).toBe('refused');
    const lines = error.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('DATA_BACKEND/DATA_BACKEND_URL'))).toBe(false);
  });

  it('serves once provisioning passed and the identity verified', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.verdict = { state: 'provisioned' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('serving');
    expect(h.released).toBe(1);
    expect(h.closed).toBe(0);
  });
});

// NB1 round 2, R2-4: the identity check runs beside the provisioning wait. Whichever refusal comes first refuses; the
// data boot serves only once both passed.
describe('the identity check beside the provisioning wait', () => {
  it('refuses a wrong store whose provisioning never finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.verdict = 'never';
    h.identity = { ok: false, pending: false, reason: 'the database holds another store' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(mod.getDataBootStatus().refusalReason).toBe('the database holds another store');
    expect(h.closed).toBe(1);
    expect(h.released).toBe(0);
  });

  it('refuses a schema mismatch while the identity is still pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verdict = { state: 'mismatch', found: '{"v":1}' };
    h.identity = { ok: false, pending: true, reason: 'no identity yet' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(mod.getDataBootStatus().refusalReason).toContain('{"v":1}');
    expect(h.released).toBe(0);
  });

  it('does not serve on a verified identity while provisioning is pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verdict = 'never';
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('starting');
    expect(h.released).toBe(0);
    expect(warn.mock.calls.some(c => String(c[0]).startsWith('[Data] Waiting on the data backend'))).toBe(true);
  });

  it('does not serve on a passed provisioning while the identity is pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verdict = { state: 'provisioned' };
    h.identity = { ok: false, pending: true, reason: 'no identity yet' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('starting');
    expect(h.released).toBe(0);
    expect(warn.mock.calls.some(c => String(c[0]).startsWith('[Data] Waiting on the data backend'))).toBe(true);
  });
});

// NB16 sheet section 8 item 3: a shape verdict refuses with the reason and fix line the backend composed.
const KEPT = 'Gates stay closed and nothing in the database was changed; ';
const SHAPE_FIX = `${KEPT}point DATA_BACKEND_URL at a database whose smdb_data matches this bot's schema in the web UI env editor, or correct the differences above in the database and restart the bot`;
const RESTORE = "; a table or partition reported missing may have held data that is not in this database: restore a backup (the manager's Database window) rather than creating it empty";
const LOGIN_TAIL = ', or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot';
const shapeVerdicts: Array<[string, string, string]> = [
  ['a provisioned store with a difference',
    `the database's smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}): smdb_data.x (table) is not part of this bot's schema`,
    SHAPE_FIX],
  ['a provisioned store with a missing table',
    `the database's smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}): smdb_data.guild_data (partitioned table) is missing`,
    SHAPE_FIX + RESTORE],
  ['a provisioned store with a difference and a privilege line',
    `the database's smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}): this bot's database role smdb_bot lacks INSERT on smdb_data.guild_data; smdb_data.x (table) is not part of this bot's schema`,
    `${SHAPE_FIX}; and, as the owner of smdb_data's tables and sequences or a superuser, run GRANT INSERT ON smdb_data.guild_data TO smdb_bot`],
  ['no version row',
    "the database's smdb_data holds objects but no schema_version, so this bot can't confirm what made them or that they are complete: smdb_data.guild_data_graveyard (table); compared with this bot's schema: smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL",
    `${KEPT}point DATA_BACKEND_URL at a database without the schema smdb_data, or at one this bot provisioned, in the web UI env editor, or rename smdb_data aside in the database (ALTER SCHEMA smdb_data RENAME TO ...) and restart the bot`],
  ["a version that can't be read",
    "the database's smdb_data holds objects and its schema_version can't be read (smdb_data.meta has no text column value), so this bot can't confirm what made them or that they are complete: smdb_data.meta (table); compared with this bot's schema: smdb_data.meta column value is jsonb, where this bot's schema has text",
    `${KEPT}smdb_data.meta is this bot's version table: correct it to the shape the difference lines give (key text, value text NOT NULL, its primary key meta_pkey, row level security off) and restart the bot; do not rename smdb_data aside while its tables hold this bot's data, since the next boot would then make and serve a new, empty store and leave every row in the renamed schema`],
  ['the gate, row 65',
    "this bot's database role smdb_bot lacks privileges it needs on smdb_data, so the schema itself was not compared: this bot's database role smdb_bot lacks CREATE on schema smdb_data",
    `${KEPT}as the owner of smdb_data or a superuser, run GRANT CREATE ON SCHEMA smdb_data TO smdb_bot${LOGIN_TAIL}`],
  ['the gate, row 66 on a store',
    "this bot's database role smdb_bot lacks privileges it needs on database smdb, so the schema itself was not compared: this bot's database role smdb_bot lacks CREATE on database smdb",
    `${KEPT}as the owner of database smdb or a superuser, run GRANT CREATE ON DATABASE smdb TO smdb_bot${LOGIN_TAIL}`],
  ['the gate, row 66 on a fresh database',
    "this bot's database role smdb_bot lacks privileges it needs on database smdb, so no smdb_data exists and none was made: this bot's database role smdb_bot lacks CREATE on database smdb",
    `${KEPT}as the owner of database smdb or a superuser, run GRANT CREATE ON DATABASE smdb TO smdb_bot${LOGIN_TAIL}`],
  ['the right shape, a privilege missing',
    `this bot's database role smdb_bot lacks privileges on smdb_data, which matches this bot's schema (version ${SCHEMA_VERSION}): this bot's database role smdb_bot lacks INSERT on smdb_data.guild_data`,
    `${KEPT}as the owner of smdb_data's tables and sequences or a superuser, run GRANT INSERT ON smdb_data.guild_data TO smdb_bot${LOGIN_TAIL}`],
  ['a fresh store that differed',
    "the schema this bot made in the database differed from this bot's schema and was rolled back (an event trigger or another program changes new tables): smdb_data.guild_data has trigger t (CREATE TRIGGER t), which this bot's schema does not have",
    `${KEPT}remove what changes new tables in that database (its event triggers are listed by SELECT evtname FROM pg_event_trigger) and restart the bot`],
  ['a fresh store that lacked privileges',
    "this bot's database role smdb_bot lacked privileges on the schema it made in the database, so it was rolled back (default privileges or an event trigger take them from new tables): this bot's database role smdb_bot lacks INSERT on smdb_data.guild_data",
    `${KEPT}as smdb_bot or a superuser, run ALTER DEFAULT PRIVILEGES FOR ROLE smdb_bot GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smdb_bot; ALTER DEFAULT PRIVILEGES FOR ROLE smdb_bot GRANT USAGE, UPDATE ON SEQUENCES TO smdb_bot (SELECT * FROM pg_default_acl lists what is set), remove any event trigger that revokes privileges on new tables, and restart the bot`],
  ['the encoding',
    "the database's server_encoding is LATIN1, and this bot needs a UTF8 database; smdb_data was not read",
    `${KEPT}point DATA_BACKEND_URL, in the web UI env editor, at a database whose encoding is UTF8 (CREATE DATABASE <name> TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' makes one on any server), then restart the bot`],
];

describe('a database whose smdb_data, privileges or encoding the backend refused (NB16)', () => {
  it.each(shapeVerdicts)('%s: refused with that reason and fix line', async (_name, reason, fix) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verdict = { state: 'shape', reason, fix };
    const mod = await boot();
    const status = mod.getDataBootStatus();
    expect(status.state).toBe('refused');
    expect(status.refusalReason).toBe(reason);
    const lines = error.mock.calls.map(c => String(c[0]));
    expect(lines).toContain(`[Data] REFUSING to serve: ${reason}`);
    expect(lines).toContain(`[Data] ${fix}`);
    expect(h.closed).toBe(1);
    expect(h.released).toBe(0);
    expect(h.adopts.length).toBeGreaterThan(0);
    expect(h.adopts.every(a => a === false)).toBe(true);
    if (/can't be read/.test(reason)) expect(fix).not.toContain('RENAME');
  });
});

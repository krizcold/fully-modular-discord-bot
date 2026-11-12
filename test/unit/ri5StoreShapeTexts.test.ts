import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  freshVersionRefusal,
  gateRefusal,
  privilegeDifference,
  refusalLogLines,
  schemaDdlRefusal,
  scratchRefusal,
  serverRelease,
  serverVersionRefusal,
  shapeRefusal,
  storeIdRefusal,
  unversionedRefusal,
  type Difference,
  type FoundList,
  type FoundRelation,
  type Privilege,
} from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

const KEPT = 'Gates stay closed and nothing in the database was changed; ';
const LOGIN_TAIL = ', or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot';
const MAKE_SCHEMA = 'make a schema in database smdb (smdb_data, or the copy of its schema it compares with at every boot)';

function found(over: Partial<FoundList> = {}): FoundList {
  return {
    role: 'bot', db: 'smdb', dbCreate: true, schemaExists: true, schemaUsage: true, schemaCreate: true,
    relations: [], meta: null, ...over,
  };
}

function rel(name: string, kind: string, over: Partial<FoundRelation> = {}): FoundRelation {
  const table = kind === 'S' ? null : true;
  const seq = kind === 'S' ? true : null;
  return {
    name, kind, isPartition: false, select: table, insert: table, update: table, delete: table,
    usage: seq, updateSeq: seq, ...over,
  };
}

const priv = (scope: Privilege['scope'], target: string, privilege: string) =>
  privilegeDifference('bot', 'smdb', { scope, target, privilege });

describe('ri5: the gate refusal names every reason and grant', () => {
  it('joins three reasons with commas and "or", and lists both schema privileges in one GRANT', () => {
    const r = gateRefusal(found({ dbCreate: false, schemaUsage: false, schemaCreate: false }))!;
    expect(r.header).toBe(
      "schema-mismatch: this bot's database role bot lacks 3 privilege(s) it needs on database smdb and smdb_data; "
      + `the schema itself was not compared, since without them the bot can't ${MAKE_SCHEMA}, read its schema_version `
      + 'or make its tables in smdb_data; refusing to serve',
    );
    expect(r.fix).toBe(
      `${KEPT}as the owner of database smdb or a superuser, run GRANT CREATE ON DATABASE smdb TO bot; `
      + `as the owner of smdb_data or a superuser, run GRANT USAGE, CREATE ON SCHEMA smdb_data TO bot${LOGIN_TAIL}`,
    );
  });

  it('a lacking sequence USAGE is not a reason the bot cannot read its schema_version', () => {
    const r = gateRefusal(found({ dbCreate: false, relations: [rel('claim_seq', 'S', { usage: false })] }))!;
    expect(r.lines).toEqual([
      "this bot's database role bot lacks CREATE on database smdb",
      "this bot's database role bot lacks USAGE on sequence smdb_data.claim_seq",
    ]);
    expect(r.header).toBe(
      "schema-mismatch: this bot's database role bot lacks 2 privilege(s) it needs on database smdb and smdb_data; "
      + `the schema itself was not compared, since without them the bot can't ${MAKE_SCHEMA}; refusing to serve`,
    );
  });

  it('a lacking SELECT on a table other than meta is not a reason the bot cannot read its schema_version', () => {
    const r = gateRefusal(found({ dbCreate: false, relations: [rel('guild_ownership', 'r', { select: false })] }))!;
    expect(r.lines).toContain("this bot's database role bot lacks SELECT on smdb_data.guild_ownership");
    expect(r.header).toBe(
      "schema-mismatch: this bot's database role bot lacks 2 privilege(s) it needs on database smdb and smdb_data; "
      + `the schema itself was not compared, since without them the bot can't ${MAKE_SCHEMA}; refusing to serve`,
    );
  });

  it('a lacking INSERT on meta is not a reason the bot cannot read its schema_version', () => {
    const r = gateRefusal(found({
      dbCreate: false,
      relations: [rel('meta', 'r', { insert: false })],
      meta: { kind: 'r', keyText: true, valueText: true, valueNotNull: true, rls: false, uniqueKey: true, select: true },
    }))!;
    expect(r.lines).toContain("this bot's database role bot lacks INSERT on smdb_data.meta");
    expect(r.header).toBe(
      "schema-mismatch: this bot's database role bot lacks 2 privilege(s) it needs on database smdb and smdb_data; "
      + `the schema itself was not compared, since without them the bot can't ${MAKE_SCHEMA}; refusing to serve`,
    );
  });

  it('builds a refusal when the gate closes on a found list that names no lacking privilege', () => {
    const r = gateRefusal(found({
      meta: { kind: 'r', keyText: true, valueText: true, valueNotNull: true, rls: false, uniqueKey: true, select: false },
    }))!;
    expect(r.lines).toEqual([]);
    expect(r.fix).toBe(`${KEPT}${LOGIN_TAIL}`);
  });
});

describe('ri5: the GRANT statements of a privileges-only shape refusal', () => {
  it('groups each relation by scope and name, privileges in GRANT order', () => {
    const r = shapeRefusal([
      priv('sequence', 's', 'UPDATE'),
      priv('table', 'a', 'INSERT'),
      priv('sequence', 'a', 'UPDATE'),
      priv('table', 'b', 'DELETE'),
      priv('sequence', 's', 'USAGE'),
      priv('table', 'a', 'SELECT'),
    ]);
    expect(r.header).toBe(
      `schema-mismatch: this bot's database role bot lacks 6 privilege(s) on smdb_data; smdb_data matches this bot's schema (version ${SCHEMA_VERSION}); refusing to serve`,
    );
    expect(r.fix).toBe(
      `${KEPT}as the owner of smdb_data's tables and sequences or a superuser, run `
      + 'GRANT SELECT, INSERT ON smdb_data.a TO bot; GRANT DELETE ON smdb_data.b TO bot; '
      + 'GRANT UPDATE ON SEQUENCE smdb_data.a TO bot; GRANT USAGE, UPDATE ON SEQUENCE smdb_data.s TO bot'
      + LOGIN_TAIL,
    );
  });

  it('orders the GRANT statements by relation name whatever order the differences sort in', () => {
    const d = (k: string, target: string): Difference => ({
      text: `lacks SELECT on ${target}`, key: [0, 2, k, 0], role: 'bot', db: 'smdb',
      privilege: { scope: 'table', target, privilege: 'SELECT' },
    });
    const r = shapeRefusal([d('a', 'zeta'), d('b', 'alpha')]);
    expect(r.fix).toBe(
      `${KEPT}as the owner of smdb_data's tables and sequences or a superuser, run `
      + `GRANT SELECT ON smdb_data.alpha TO bot; GRANT SELECT ON smdb_data.zeta TO bot${LOGIN_TAIL}`,
    );
  });

  it('separates the database and schema groups with a semicolon', () => {
    const r = shapeRefusal([priv('database', 'smdb', 'CREATE'), priv('schema', 'smdb_data', 'USAGE')]);
    expect(r.fix).toBe(
      `${KEPT}as the owner of database smdb or a superuser, run GRANT CREATE ON DATABASE smdb TO bot; `
      + `as the owner of smdb_data or a superuser, run GRANT USAGE ON SCHEMA smdb_data TO bot${LOGIN_TAIL}`,
    );
  });

  it('leaves the role and database empty when the differences do not name them', () => {
    const r = shapeRefusal([
      { text: 'lacks CREATE', key: [0, 0, '', 0], privilege: { scope: 'database', target: 'smdb', privilege: 'CREATE' } },
      { text: 'lacks SELECT', key: [0, 2, 'x', 0], privilege: { scope: 'table', target: 'x', privilege: 'SELECT' } },
    ]);
    expect(r.header).toBe(
      `schema-mismatch: this bot's database role  lacks 2 privilege(s) on smdb_data; smdb_data matches this bot's schema (version ${SCHEMA_VERSION}); refusing to serve`,
    );
    expect(r.fix).toBe(
      `${KEPT}as the owner of database  or a superuser, run GRANT CREATE ON DATABASE  TO ; `
      + `as the owner of smdb_data's tables and sequences or a superuser, run GRANT SELECT ON smdb_data.x TO ${LOGIN_TAIL}`,
    );
  });
});

describe('ri5: the shape refusal for shape differences', () => {
  const BASE = `${KEPT}point DATA_BACKEND_URL at a database whose smdb_data matches this bot's schema in the web UI env editor, or correct the differences above in the database and restart the bot`;

  it('an empty list of differences is a shape refusal in 0 places', () => {
    const r = shapeRefusal([]);
    expect(r.header).toBe(`schema-mismatch: smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}) in 0 place(s); refusing to serve`);
    expect(r.lines).toEqual([]);
    expect(r.fix).toBe(BASE);
  });

  it('with shape differences, the fix grants only the relation privileges', () => {
    const r = shapeRefusal([
      { text: 'smdb_data.x has column y (text), which this bot\'s schema does not have', key: [1, 'x', 10, 'y'] },
      priv('database', 'smdb', 'CREATE'),
      priv('table', 'guild_ownership', 'SELECT'),
    ]);
    expect(r.fix).toBe(
      `${BASE}; and, as the owner of smdb_data's tables and sequences or a superuser, run GRANT SELECT ON smdb_data.guild_ownership TO bot`,
    );
  });
});

describe('ri5: the unversioned refusal names its objects', () => {
  it('names exactly five objects with no "more" count', () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const r = unversionedRefusal(found({ relations: names.map(n => rel(n, 'r')) }), { differences: [], counted: 0, total: 5 });
    expect(r.reason).toBe(
      "the database's smdb_data holds objects but no schema_version, so this bot can't confirm what made them or that they are complete: "
      + 'smdb_data.a (table), smdb_data.b (table), smdb_data.c (table), smdb_data.d (table), smdb_data.e (table)'
      + "; they match their counterparts in this bot's schema, but the bot does not take over a schema without a version",
    );
  });

  it('names five objects and counts the sixth', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const r = unversionedRefusal(found({ relations: names.map(n => rel(n, 'r')) }), { differences: [], counted: 0, total: 6 });
    expect(r.reason).toContain('smdb_data.e (table) and 1 more; they match');
  });
});

describe('ri5: server release and the refusals that list no difference', () => {
  it('reads PostgreSQL 10 releases as major.minor', () => {
    expect(serverRelease(100000)).toBe('10.0');
    expect(serverRelease(100023)).toBe('10.23');
    expect(serverRelease(90624)).toBe('9.6.24');
  });

  it('the server version refusal lists no difference', () => {
    const r = serverVersionRefusal('12.17');
    expect(r.lines).toEqual([]);
    expect(refusalLogLines(r)).toEqual([`[PostgresBackend] ${r.header}`]);
  });

  it('the fresh version refusal says what happened and how to fix it', () => {
    expect(freshVersionRefusal('no row')).toEqual({
      header: 'schema-mismatch: the schema_version row this bot wrote into the schema it made in the database could not be read back (no row), so the schema was rolled back before it was committed (an event trigger, a rule or another program changes new tables); refusing to serve',
      lines: [],
      reason: 'the schema_version row this bot wrote into the schema it made in the database could not be read back (no row), so the schema was rolled back (an event trigger, a rule or another program changes new tables)',
      fix: `${KEPT}remove what changes new tables in that database (its event triggers are listed by SELECT evtname FROM pg_event_trigger) and restart the bot`,
    });
  });

  it('the store id refusal heads with its reason and lists no difference', () => {
    const r = storeIdRefusal('s-1');
    expect(r.header).toBe(`schema-mismatch: ${r.reason}; refusing to serve`);
    expect(r.reason).toContain('records store s-1');
    expect(r.lines).toEqual([]);
  });

  it('the scratch and schema DDL refusals list no difference', () => {
    expect(scratchRefusal('42P07', 'exists', 'bot', 'smdb').lines).toEqual([]);
    expect(schemaDdlRefusal('42P07', 'exists', 'bot', 'smdb').lines).toEqual([]);
  });
});

describe('ri5: the refusal log lines', () => {
  it('logs exactly fifty differences with no count line', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `d${i}`);
    const out = refusalLogLines({ header: 'h', lines, reason: 'r', fix: 'f' });
    expect(out).toHaveLength(51);
    expect(out[50]).toBe('[PostgresBackend] schema difference: d49');
  });

  it('counts the fifty-first difference', () => {
    const lines = Array.from({ length: 51 }, (_, i) => `d${i}`);
    const out = refusalLogLines({ header: 'h', lines, reason: 'r', fix: 'f' });
    expect(out[51]).toBe('[PostgresBackend] schema difference: and 1 more not listed');
  });
});

import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { _setOwnerChannelDeps, _resetOwnerChannel, ownerMessagesFile } from '../../src/webui/utils/ownerChannel';
import { _resetWebuiChoice, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { configureRowFlush, type RowBackend } from '../../src/bot/internalSetup/utils/sharedStore';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';

// NB23 (sheets/NB6.md:743-744): on a Postgres bot the notify-owner route's key record is also kept in the main
// database (smdb_data.meta rows 'owner-message:<key>'), so a manager that repeats a key to the new main's bot after a
// switch gets "not posted". This machine's /data/owner-messages.json stays the record of a JSON bot and the record the
// route still checks when the database cannot be read. The route runs over a fake REST and a fake row backend.

const TOKEN = 'nb23-token';
const ENTRY = 'postgres://bot:pw@db.example:5432/bot';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;

const db = {
  rows: new Map<string, string>(),
  selects: [] as Array<{ text: string; values: unknown[] }>,
  txs: [] as Array<Array<{ text: string; values: unknown[] }>>,
  selectFails: null as Error | null,
  tx: 'committed' as 'committed' | 'failed' | 'unknown' | 'refused',
};

const fake: RowBackend = {
  async sharedSelect(text, values) {
    db.selects.push({ text, values });
    if (db.selectFails) throw db.selectFails;
    const value = db.rows.get(String(values[0]));
    return { rows: value === undefined ? [] : [{ value }] };
  },
  async sharedTx(spec) {
    const statements = spec.statements(null);
    if (!Array.isArray(statements)) throw new Error('no statements');
    db.txs.push(statements.map(s => ({ text: s.text, values: s.values })));
    if (db.tx === 'failed') return { kind: 'failed', step: 'connect', detail: 'connect ECONNREFUSED' };
    if (db.tx === 'refused') return { kind: 'refused', phase: 'latched', detail: 'the web panel cannot use the bot\'s main database now: checking the databases' };
    if (db.tx === 'unknown') return { kind: 'unknown', detail: 'the connection ended while COMMIT was on the wire' };
    const insert = statements[0];
    db.rows.set(String(insert.values[0]), String(insert.values[1]));
    return { kind: 'committed', results: [] };
  },
};

beforeAll(async () => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(a => a.use('/api/managed', createManagedRoutes({} as BotManager)));
});
afterAll(async () => {
  await app.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
});
beforeEach(() => {
  rest = new FakeOwnerRest(300);
  _setManagedTiming({ notifyMs: 600, switchMs: 750 });
  _resetOwnerChannel();
  _resetWebuiChoice();
  db.rows.clear();
  db.selects.length = 0;
  db.txs.length = 0;
  db.selectFails = null;
  db.tx = 'committed';
  _setOwnerChannelDeps({ readRow: async () => null, readMs: 150 });
  configureRowFlush({ backend: () => fake });
  setBackendKind('postgres');
  setWebuiDataStoreUrl({ url: ENTRY });
  fs.rmSync(ownerMessagesFile(), { force: true });
  fs.rmSync(dataPath('owner-channel.json'), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setOwnerChannelDeps(null);
  configureRowFlush({ backend: () => null });
  setWebuiDataStoreUrl(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

async function notify(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/notify-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const fileKeys = () => (fs.existsSync(ownerMessagesFile()) ? Object.keys(JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8')).keys) : []);

describe('a Postgres bot keeps the key record in the main database', () => {
  it('a key another machine posted (in the database, not in this machine\'s file) is not posted again', async () => {
    const at = '2026-11-09T08:00:00.000Z';
    db.rows.set('owner-message:backup-1', JSON.stringify(at));
    const res = await notify({ text: 'Backup failed', key: 'backup-1' });
    expect(res).toEqual({ status: 200, body: { success: true, posted: false, note: `A message with this key was posted on ${at}; this repeat was not posted.` } });
    expect(rest.creates()).toHaveLength(0);
    expect(db.selects).toEqual([{ text: 'SELECT value FROM smdb_data.meta WHERE key = $1', values: ['owner-message:backup-1'] }]);
  });

  it('a new key posts, then is recorded in this machine\'s file and in the database in one transaction with the prune', async () => {
    const res = await notify({ text: 'Backup failed', key: 'backup-2' });
    expect(res).toEqual({ status: 200, body: { success: true, posted: true, place: 'dm' } });
    expect(rest.creates(DM)).toHaveLength(1);
    expect(fileKeys()).toEqual(['backup-2']);
    expect(db.txs).toHaveLength(1);
    const [insert, old, over] = db.txs[0];
    expect(insert.values[0]).toBe('owner-message:backup-2');
    expect(Date.parse(JSON.parse(String(insert.values[1])))).not.toBeNaN();
    expect(insert.text).toMatch(/^INSERT INTO smdb_data\.meta \(key, value, updated_at\) VALUES \(\$1, \$2, now\(\)\) ON CONFLICT \(key\) DO UPDATE/);
    expect(old.text).toContain("interval '90 days'");
    expect(over.text).toContain('OFFSET 1000');
    const again = await notify({ text: 'Backup failed', key: 'backup-2' });
    expect(again.body.posted).toBe(false);
    expect(rest.creates()).toHaveLength(1);
  });

  it('a database that cannot be read: this machine\'s record decides, the text posts with a note, and the database is not written', async () => {
    db.selectFails = new Error('connect ECONNREFUSED');
    const res = await notify({ text: 'one', key: 'k1' });
    expect(res).toEqual({ status: 200, body: {
      success: true, posted: true, place: 'dm',
      note: "The repeat check in the bot's main database could not be read (connect ECONNREFUSED), so only this machine's record of posted messages was checked, and this key is recorded only there.",
    } });
    expect(fileKeys()).toEqual(['k1']);
    expect(db.txs).toHaveLength(0);
  });

  it('a key in this machine\'s file is not posted, and the database is not read', async () => {
    fs.writeFileSync(ownerMessagesFile(), JSON.stringify({ keys: { k2: '2026-11-09T08:00:00.000Z' } }));
    const res = await notify({ text: 'one', key: 'k2' });
    expect(res.body.posted).toBe(false);
    expect(db.selects).toHaveLength(0);
  });

  it.each([
    ['failed', "The repeat check could not be saved in the bot's main database (connect ECONNREFUSED), so a repeat of this key would post again after the main database moves to another machine."],
    ['refused', "The repeat check could not be saved in the bot's main database (the web panel cannot use the bot's main database now: checking the databases), so a repeat of this key would post again after the main database moves to another machine."],
    ['unknown', "can't confirm whether the repeat check was saved in the bot's main database (the connection ended while COMMIT was on the wire), so a repeat of this key may post again after the main database moves to another machine."],
  ] as const)('a database write that ended %s answers posted with its note', async (kind, note) => {
    db.tx = kind;
    const res = await notify({ text: 'one', key: `k-${kind}` });
    expect(res).toEqual({ status: 200, body: { success: true, posted: true, place: 'dm', note } });
    expect(fileKeys()).toEqual([`k-${kind}`]);
  });

  it('a missing meta table reads as no key', async () => {
    db.selectFails = Object.assign(new Error('relation "smdb_data.meta" does not exist'), { code: '42P01' });
    const res = await notify({ text: 'one', key: 'k3' });
    expect(res).toEqual({ status: 200, body: { success: true, posted: true, place: 'dm' } });
  });
});

describe('a JSON bot keeps only its file', () => {
  it('no database read or write', async () => {
    setBackendKind('file');
    const res = await notify({ text: 'one', key: 'k4' });
    expect(res).toEqual({ status: 200, body: { success: true, posted: true, place: 'dm' } });
    expect(db.selects).toHaveLength(0);
    expect(db.txs).toHaveLength(0);
    expect(fileKeys()).toEqual(['k4']);
  });
});

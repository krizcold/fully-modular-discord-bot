import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import type { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { _resetRowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runSharedPass, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';
import { emptySessions, makeTemplate, newDatabase, poolOf, startNb16Rig, stopNb16Rig, TEMPLATE, urlOf, type Nb16Rig } from '../helpers/nb16Rig';
import { backendOn, until } from '../helpers/nb6Pg';
import { setView } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// NB6 test 26 [pg] (wip-redesign/sheets/NB6.md rows 18, 40 and 98; decisions 30 and 49 step 3, C3 as D14 words it;
// part 8): NB5's move to a second database that holds an older row. Both databases are copies of a template the bot's
// own boot provisioned at the current version (nb16Rig.ts `newDatabase`), the older row written in the template before the
// copies; the newer one is stored on the first by the bot's flush. After the move a queued write built on the newer
// version is refused, and the pass with the new main tag moves the newer mirror aside and writes the second's row,
// both live through the listener and in a process restarted before its first pass.

const CATEGORY = 'nb6switch';
const KEY = `global/${CATEGORY}/doc.json`;
const FILE = dataPath('global', CATEGORY, 'doc.json');
const OLD = JSON.stringify({ v: 'old' }, null, 2);
const NEW = JSON.stringify({ v: 'new' }, null, 2);
const steps = { checkTarget: async () => null, claims: async () => true, settleRetires: async () => true, moved: () => undefined };
const REPLACED = { kind: 'replaced', machine: 'BRAVO', generation: 2 } as const;

let rig: Nb16Rig;
let backend: PostgresBackend;

const read = () => { try { return fs.readFileSync(FILE, 'utf8'); } catch { return null; } };
function superseded(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(dataPath('_superseded'));
  return out;
}

beforeAll(async () => {
  rig = await startNb16Rig();
  await makeTemplate(rig);
  const tpl = poolOf(rig, TEMPLATE);
  await tpl.query(
    `INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ($1, $2, $3, nextval('smdb_data.shared_rev_seq'), 'ALPHA/p-old')`,
    [KEY, Buffer.from(OLD), sha(OLD)],
  );
  await emptySessions(rig, TEMPLATE);
}, 240_000);

afterAll(async () => {
  await stopNb16Rig(rig);
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  setBackendKind('postgres');
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  await newDatabase(rig, 'nb6_sw_a', 'store');
  await newDatabase(rig, 'nb6_sw_b', 'store');
  await emptySessions(rig, 'nb6_sw_a');
  await emptySessions(rig, 'nb6_sw_b');
  setView(1, 'ALPHA');
  backend = await backendOn(urlOf(rig, 'nb6_sw_a'));
  dm.setGuildDataBackend(backend);
}, 120_000);

afterEach(async () => {
  _resetSharedMirror();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await backend?.stop();
  vi.restoreAllMocks();
});

/** The older row mirrored, then the newer one stored on the first database by the bot's flush. */
async function newerOnFirst(): Promise<void> {
  await runSharedPass({ rehash: true });
  expect(read()).toBe(OLD);
  const res = dm.saveDataTracked('doc.json', { scope: 'global', category: CATEGORY }, { v: 'new' }) as { ticket: RowTicket };
  await dm.flushAll();
  expect(rowTicketState(res.ticket)).toBe('landed');
  expect(read()).toBe(NEW);
  const record = readDocRecord();
  expect(record.ok && record.record.docs[KEY]).toMatchObject({ sha: sha(NEW), main: '1:ALPHA' });
}

describe('rows 18 and 40: the move with the listener up', () => {
  it('a write built on the newer version is refused on the second; the listener reopens there and its pass puts the older row in place', async () => {
    await newerOnFirst();
    startSharedPass();
    await until(async () => (await poolOf(rig, 'nb6_sw_a').query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'smdb-shared-listen'`)).rows[0].n === 1);

    dm.setGuildDataBackend(null);
    const queued = dm.saveDataTracked('doc.json', { scope: 'global', category: CATEGORY }, { v: 'newer still' }) as { ticket: RowTicket };
    backend.latch(REPLACED);
    expect(await backend.useDatabase(urlOf(rig, 'nb6_sw_b'), steps)).toBe(true);
    setView(2, 'BRAVO');
    dm.setGuildDataBackend(backend);
    await dm.flushAll();
    expect(rowTicketState(queued.ticket)).toBe('refused');
    expect(queued.ticket.op.refusal?.cause).toBe('changed-elsewhere');

    await until(() => read() === OLD, 20_000);
    expect(superseded()).toContain(NEW);
    const record = readDocRecord();
    expect(record.ok && record.record.docs[KEY]).toMatchObject({ sha: sha(OLD), main: '2:BRAVO' });
  }, 120_000);
});

describe('row 98: a process restarted between the move and its pass', () => {
  it('its first pass reads the record\'s older main tag and moves the newer mirror aside', async () => {
    await newerOnFirst();
    backend.latch(REPLACED);
    expect(await backend.useDatabase(urlOf(rig, 'nb6_sw_b'), steps)).toBe(true);
    _resetSharedMirror();
    setView(2, 'BRAVO');
    const res = await runSharedPass({ rehash: true });
    expect(res.answered).toBe(true);
    expect(read()).toBe(OLD);
    expect(superseded()).toEqual([NEW]);
  }, 120_000);
});

import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';

// The boot populate of config.json on a Postgres bot: its log line names what it added and kept, a refused update
// says so and is not logged as synchronized, and a newer stored value that is no JSON object is left as it is.

const h = vi.hoisted(() => ({ refusal: null as null | { accepted: false; cause: string; reason?: string } }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, updateRawTracked: (...args: unknown[]) => h.refusal ?? real.updateRawTracked(...args) };
});

// configManager loads first: loaded after dataManager, it binds the real updateRawTracked and the mock never runs.
import { ensureConfigPopulated, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, latestRowTicket, rowTicketState } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

const KEY = 'config.json';
const text = (value: unknown) => JSON.stringify(value, null, 2);

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let logs: string[];
let errors: string[];

async function fullConfig(): Promise<Record<string, unknown>> {
  setBackendKind('file');
  expect(ensureConfigPopulated()).toBe('written');
  await dm.flushAll();
  const full = JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'));
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  setBackendKind('postgres');
  logs.length = 0;
  return full;
}

async function stored(value: Record<string, unknown>): Promise<void> {
  expect(dm.writeRawAtomicTracked(ROOT_CONFIG_PATH, text(value)).accepted).toBe(true);
  await dm.flushAll();
  expect(rows.docs.get(KEY)?.sha).toBe(sha(text(value)));
  logs.length = 0;
}

const synchronizedLines = () => logs.filter(l => l.startsWith('[ConfigManager] Config synchronized'));

beforeEach(async () => {
  logs = [];
  errors = [];
  h.refusal = null;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  setBackendKind('file');
  await dm.flushAll();
  _resetRowQueue();
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  h.refusal = null;
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  setBackendKind(null);
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  vi.restoreAllMocks();
});

describe('the populate log line on a Postgres bot', () => {
  it('a config.json holding every key and nothing else logs that it was synchronized, with nothing kept', async () => {
    const full = await fullConfig();
    await stored(full);
    const n = Object.keys(full).length;

    expect(ensureConfigPopulated()).toBe('unchanged');

    expect(synchronizedLines()).toEqual([`[ConfigManager] Config synchronized with schema (0 added, ${n} preserved)`]);
  });

  it('a config.json lacking two keys and holding no unknown key logs the two added and nothing kept', async () => {
    const full = await fullConfig();
    const partial: Record<string, unknown> = { ...full };
    delete partial['metrics.enabled'];
    delete partial.testMode;
    await stored(partial);
    const n = Object.keys(full).length;

    expect(ensureConfigPopulated()).toBe('written');
    await dm.flushAll();

    expect(synchronizedLines()).toEqual([`[ConfigManager] Config synchronized with schema (2 added, ${n - 2} preserved)`]);
    expect(JSON.parse(rows.docs.get(KEY)!.body.toString('utf8'))).toEqual(full);
  });
});

describe('a populate update the data layer refused', () => {
  it.each([
    [{ accepted: false as const, cause: 'storage-failing' }, 'storage-failing'],
    [{ accepted: false as const, cause: 'io', reason: 'the stored text could not be read whole' }, 'the stored text could not be read whole'],
  ])('answers refused and logs why (%j), never synchronized', async (refusal, why) => {
    h.refusal = refusal;

    expect(ensureConfigPopulated()).toBe('refused');

    expect(errors).toContain(`[ConfigManager] config.json was not synchronized with the schema (${why}); it was left as it was`);
    expect(synchronizedLines()).toEqual([]);
  });
});

describe('a newer stored config.json that is no JSON object, met by the flush\'s re-run', () => {
  it.each([
    ['an array', '[1, 2]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['a number', '5'],
  ])('%s is left as it is and the update is refused with why', async (_what, body) => {
    const full = await fullConfig();
    const partial: Record<string, unknown> = { ...full };
    delete partial['metrics.enabled'];
    await stored(partial);

    expect(ensureConfigPopulated()).toBe('written');
    const ticket = latestRowTicket(KEY);
    expect(ticket).toBeDefined();
    rows.put(KEY, body);
    await dm.flushAll();

    expect(rows.docs.get(KEY)?.body.toString('utf8')).toBe(body);
    expect(rowTicketState(ticket!)).toBe('refused');
    expect(ticket!.op.refusal?.reason).toBe('config.json: the update could not be applied to the newer version another machine saved (config.json does not hold a JSON object)');
  });
});

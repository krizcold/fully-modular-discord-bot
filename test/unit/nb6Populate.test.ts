import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { ensureConfigPopulated, ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

// NB6 test 35 (wip-redesign/sheets/NB6.md decision 34, row 107; part 21): on a Postgres bot the populate is an update
// of the root config's row that adds each schema key the stored value lacks and keeps every other key, those of a
// newer image's schema included; a body that adds nothing writes nothing. The row and the mirror come from the real
// facade's write and the real flush over scripted clients that answer as the shared tables do.

const KEY = 'config.json';
const text = (value: unknown) => JSON.stringify(value, null, 2);

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let logs: string[];

/** Every key of this image's root schema, as a full populate of this image writes it. */
async function fullConfig(): Promise<Record<string, unknown>> {
  setBackendKind('file');
  expect(ensureConfigPopulated()).toBe('written');
  await dm.flushAll();
  const full = JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'));
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  setBackendKind('postgres');
  return full;
}

/** A root config stored by the real facade write and flush: its row and its mirror. */
async function stored(value: Record<string, unknown>): Promise<void> {
  expect(dm.writeRawAtomicTracked(ROOT_CONFIG_PATH, text(value)).accepted).toBe(true);
  await dm.flushAll();
  expect(rows.docs.get(KEY)?.sha).toBe(sha(text(value)));
}

const storedValue = () => JSON.parse((rows.docs.get(KEY)?.body as Buffer).toString('utf8'));

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  setBackendKind(null);
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  vi.restoreAllMocks();
});

describe('the populate on a Postgres bot (row 107)', () => {
  it('a config.json written by a newer schema keeps its unknown keys and gains the keys it lacks', async () => {
    const full = await fullConfig();
    const newer: Record<string, unknown> = { ...full, DEVS: ['42'], 'future.flag': true, 'future.limit': 7 };
    delete newer['metrics.enabled'];
    delete newer['giveaway.itemsPerPage'];
    await stored(newer);

    expect(ensureConfigPopulated()).toBe('written');
    await dm.flushAll();

    const after = storedValue();
    expect(after['future.flag']).toBe(true);
    expect(after['future.limit']).toBe(7);
    expect(after.DEVS).toEqual(['42']);
    expect(after['metrics.enabled']).toBe(full['metrics.enabled']);
    expect(after['giveaway.itemsPerPage']).toBe(full['giveaway.itemsPerPage']);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(full), 'future.flag', 'future.limit'].sort());
    expect(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8')).toBe((rows.docs.get(KEY)?.body as Buffer).toString('utf8'));
    const preserved = Object.keys(full).length - 2;
    expect(logs).toContain(`[ConfigManager] Config synchronized with schema (2 added, ${preserved} preserved; kept 2 keys this version does not know: future.flag, future.limit)`);
  });

  it('nothing is written when nothing is added, unknown keys and all', async () => {
    const full = await fullConfig();
    await stored({ ...full, 'future.flag': true });
    const before = rows.history.length;
    const revBefore = rows.docs.get(KEY)?.rev;
    logs.length = 0;

    ensureConfigPopulated();
    expect(rowQueue.keys()).not.toContain(KEY);
    await dm.flushAll();

    expect(rows.history.length).toBe(before);
    expect(rows.docs.get(KEY)?.rev).toBe(revBefore);
    expect(storedValue()['future.flag']).toBe(true);
    expect(logs.some(line => line.includes('removed'))).toBe(false);
  });

  it('the update re-runs on a newer row another machine stored before it was sent', async () => {
    const full = await fullConfig();
    const partial: Record<string, unknown> = { ...full };
    delete partial['metrics.enabled'];
    await stored(partial);

    expect(ensureConfigPopulated()).toBe('written');
    // Stored in the same turn as the accept, before the op's first statement is answered.
    rows.put(KEY, text({ ...partial, DEVS: ['7'], 'bravo.only': 'kept' }));
    await dm.flushAll();

    const after = storedValue();
    expect(after['bravo.only']).toBe('kept');
    expect(after.DEVS).toEqual(['7']);
    expect(after['metrics.enabled']).toBe(full['metrics.enabled']);
  });
});

import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreJournalPath, readRestoreJournal, type RestoreJournal } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import {
  DEFAULT_SETTINGS, defaultState, readSettings, readState, settingsPath, settingsUnreadableText, statePath, stateUnreadableText,
  writeRestoreJournal, writeSettings, writeState,
} from '../../src/webui/backups/state';
import { dataPath } from '../../src/utils/dataRoot';

// NB8 H2: state.ts's own rows. A write that throws keeps the previous whole file and answers the error; a missing
// or unparsable file reads as its default, and an unparsable one names its cause (decision 15's notes).

const snaps = () => dataPath('_snapshots');
const journal = (stage: RestoreJournal['stage']): RestoreJournal => ({
  format: 1, name: 'hourly-2026-11-13T10-00-00-000Z', startedAt: 1_000, stage, staging: '.restore-x', preRestore: '.pre-restore-x',
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(snaps(), { recursive: true, force: true });
});

function put(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function failRename(code: string) {
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (path.resolve(path.dirname(String(to))) === path.resolve(snaps())) throw Object.assign(new Error(`${code}: stubbed, rename`), { code });
    return rename(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();
}

const writers = [
  ['state.json', statePath, () => writeState({ ...defaultState(), watchingSince: 2 }), JSON.stringify({ ...defaultState(), watchingSince: 1 })],
  ['settings.json', settingsPath, () => writeSettings({ enabled: false, hour: 7 }), JSON.stringify({ enabled: true, hour: 3 })],
  ['restore.json', restoreJournalPath, () => writeRestoreJournal(journal('staged')), JSON.stringify(journal('staging'))],
] as const;

describe('a write that throws', () => {
  it.each(writers)('%s keeps the previous whole file and throws the error', (_name, file, write, before) => {
    put(file(), before);
    failRename('EIO');
    let thrown: unknown;
    try { write(); } catch (e) { thrown = e; }
    expect((thrown as NodeJS.ErrnoException)?.code).toBe('EIO');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    expect(fs.readdirSync(snaps()).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it.each(writers)('%s with no folder yet makes _snapshots and writes the file', (_name, file, write) => {
    write();
    expect(fs.existsSync(file())).toBe(true);
  });
});

describe('a write that works', () => {
  it('state.json holds what was written and reads back the same', () => {
    const state = { ...defaultState(), watchingSince: 5, lastAttempt: { name: 'hourly-x', at: 6, result: 'ok' as const } };
    writeState(state);
    expect(readState()).toEqual({ state, cause: null });
  });

  it('settings.json holds what was written and reads back the same', () => {
    writeSettings({ enabled: false, hour: 0 });
    expect(readSettings()).toEqual({ settings: { enabled: false, hour: 0 }, cause: null });
  });

  it('restore.json is read by the journal reader', () => {
    writeRestoreJournal(journal('swapping'));
    expect(readRestoreJournal()).toEqual({ state: 'read', journal: journal('swapping') });
  });
});

describe('reads', () => {
  it('a missing settings.json reads as enabled at hour 4 with no cause', () => {
    expect(readSettings()).toEqual({ settings: { enabled: true, hour: 4 }, cause: null });
    expect(DEFAULT_SETTINGS).toEqual({ enabled: true, hour: 4 });
  });

  it('a missing state.json reads as the default state with no cause', () => {
    expect(readState()).toEqual({ state: defaultState(), cause: null });
    expect(defaultState()).toEqual({
      lastAttempt: null, lastRefusal: null, watchingSince: null, test: { day: null, running: null, last: null, lastPassed: null }, alerts: {},
    });
  });

  it('settings.json with one field takes the other from the default', () => {
    put(settingsPath(), JSON.stringify({ hour: 9 }));
    expect(readSettings()).toEqual({ settings: { enabled: true, hour: 9 }, cause: null });
  });

  it('state.json with some fields takes the others from the default', () => {
    put(statePath(), JSON.stringify({ watchingSince: 3, test: { day: '2026-11-13' } }));
    expect(readState()).toEqual({
      state: { ...defaultState(), watchingSince: 3, test: { ...defaultState().test, day: '2026-11-13' } }, cause: null,
    });
  });

  it.each([
    ['torn JSON', '{"enabled": tr', 'not valid JSON'],
    ['an array', '[1]', 'not a JSON object'],
    ['enabled as text', '{"enabled":"yes","hour":4}', 'enabled is not true or false'],
    ['hour 24', '{"enabled":true,"hour":24}', 'hour is not a whole number from 0 to 23'],
    ['hour 1.5', '{"enabled":true,"hour":1.5}', 'hour is not a whole number from 0 to 23'],
  ])('settings.json holding %s reads as the default and names its cause', (_what, text, cause) => {
    put(settingsPath(), text);
    expect(readSettings()).toEqual({ settings: DEFAULT_SETTINGS, cause });
  });

  it.each([
    ['torn JSON', '{"watchingSince": 1', 'not valid JSON'],
    ['null', 'null', 'not a JSON object'],
    ['test as a number', '{"test":1}', 'test is not a JSON object'],
    ['alerts as an array', '{"alerts":[]}', 'alerts is not a JSON object'],
  ])('state.json holding %s reads as the default and names its cause', (_what, text, cause) => {
    put(statePath(), text);
    expect(readState()).toEqual({ state: defaultState(), cause });
  });

  it('a folder at each path reads as the default and names the read error', () => {
    fs.mkdirSync(settingsPath(), { recursive: true });
    fs.mkdirSync(statePath(), { recursive: true });
    const settings = readSettings();
    const state = readState();
    expect(settings.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.state).toEqual(defaultState());
    expect(settings.cause).toBe('EISDIR');
    expect(state.cause).toBe('EISDIR');
  });

  it('the default state is a new object each time', () => {
    const a = defaultState();
    a.test.day = 'x';
    a.alerts.y = {} as any;
    expect(defaultState()).toEqual(readState().state);
    expect(defaultState().test.day).toBeNull();
  });
});

describe('the notes of decision 15', () => {
  it('names the file and the cause', () => {
    expect(settingsUnreadableText('not valid JSON')).toBe(
      'The backup settings (/data/_snapshots/settings.json) cannot be read (not valid JSON); backups are taken and none is deleted until it can be read.',
    );
    expect(stateUnreadableText('EIO')).toBe(
      'The backup record (/data/_snapshots/state.json) cannot be read (EIO); backups are taken and none is deleted until it can be read.',
    );
  });
});

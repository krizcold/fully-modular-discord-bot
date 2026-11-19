import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALERT_AFTER_MS, RETRY_MS, alertKey, snapshotFailedText, testFailedText, updateAlerts, _resetAlertsForTests, _setAlertTimingForTests,
} from '../../src/webui/backups/alerts';
import { postOwnerMessage } from '../../src/webui/utils/ownerNotify';
import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { defaultState, readState, statePath, writeState, type BackupState } from '../../src/webui/backups/state';
import type { SnapshotEntry } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { formatSnapshotName } from '../../src/bot/internalSetup/utils/backups/snapshotNames';
import { hashNonce } from '../../src/utils/ownerMessages';
import { _resetOwnerChannel, _setOwnerChannelDeps, ownerMessagesFile } from '../../src/webui/utils/ownerChannel';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { DM, FakeOwnerRest, discordError } from '../helpers/fakeOwnerRest';

// NB8 test 11 (decision 10 with C17, B6 and decision 57): the two alerts, their 3-hour rule, the owner message's key
// and fates, the hourly retry and the frames of the DM texts. The scheduler's tick rows are part 10b's.

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const TOKEN = 'nb8-alerts-token';
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
let errors: string[];

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
  _setManagedTiming({ notifyMs: 600 });
  _setAlertTimingForTests({ budgetMs: 600 });
  _resetAlertsForTests();
  _resetOwnerChannel();
  _setOwnerChannelDeps({ readKey: async () => null, recordKey: async () => ({ kind: 'ok' }) });
  setBackendKind('file');
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});
afterEach(() => {
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setAlertTimingForTests(null);
  _setOwnerChannelDeps(null);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
  fs.rmSync(ownerMessagesFile(), { force: true });
});

function snapshot(takenAt: number, kind: 'hourly' | 'daily' | 'pre-restore' = 'hourly'): SnapshotEntry {
  const name = formatSnapshotName(kind, takenAt);
  return {
    name, kind, time: takenAt, state: 'complete',
    manifest: {
      format: 1, name, kind, takenAt, botVersion: '1.0.0',
      counts: { files: 0, bytes: 0, dirs: 0, guilds: 0, graveyardEntries: 0 }, files: [], dirs: [],
    },
  };
}

function state(over: Partial<BackupState> = {}): BackupState {
  return { ...defaultState(), ...over };
}

const onDisk = () => readState().state;
const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const failedAttempt = (at: number, error = 'Could not read /data/123/x.json (EIO); the backup was not kept.') => ({ name: 'hourly-x', at, result: 'failed' as const, error });

function failStateRename(): void {
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (path.resolve(String(to)) === path.resolve(statePath())) throw Object.assign(new Error('EIO: stubbed, rename'), { code: 'EIO' });
    return rename(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();
}

function healStateRename(): void {
  vi.mocked(fs.renameSync).mockRestore();
  syncBuiltinESMExports();
}

async function notify(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/managed/notify-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('the 3-hour rule (snapshot-failed)', () => {
  // Each case: the first tick's time and state, the second tick's, and whether the second raises the alert.
  it.each([
    ['none yet: watching for 2 h 59 min, after an attempt', { newest: null, watching: T0 - 2 * H - 59 * 60_000, attempt: true, ran: 0 }, false],
    ['none yet: watching for 3 h, after an attempt', { newest: null, watching: T0 - 3 * H, attempt: true, ran: 0 }, true],
    ['newest 2 h old', { newest: T0 - 2 * H, watching: T0 - 10 * H, attempt: true, ran: 0 }, false],
    ['newest 4 h old, after an attempt', { newest: T0 - 4 * H, watching: T0 - 10 * H, attempt: true, ran: 0 }, true],
    ['newest 4 h old, watching again for 1 h (the switch went back on)', { newest: T0 - 4 * H, watching: T0 - H, attempt: true, ran: 0 }, false],
    ['newest 4 h old, just started, no attempt by this process', { newest: T0 - 4 * H, watching: T0 - 10 * H, attempt: false, ran: 0 }, false],
    ['newest 4 h old, no attempt, the process ran 3 h', { newest: T0 - 4 * H, watching: T0 - 10 * H, attempt: false, ran: 3 * H }, true],
    ['only a pre-restore backup, 1 h old, watching for 5 h', { newest: null, preRestore: T0 - H, watching: T0 - 5 * H, attempt: true, ran: 0 }, true],
  ])('%s', async (_name, c: { newest: number | null; preRestore?: number; watching: number; attempt: boolean; ran: number }, raised) => {
    const start = T0 - c.ran - 60_000;
    const snapshots = [...(c.newest === null ? [] : [snapshot(c.newest)]), ...(c.preRestore === undefined ? [] : [snapshot(c.preRestore, 'pre-restore')])];
    const old = failedAttempt(start - 10 * H);
    await updateAlerts({ now: start, state: state({ watchingSince: c.watching, lastAttempt: old }), snapshots });
    const s = state({ watchingSince: c.watching, lastAttempt: c.attempt ? failedAttempt(start + 30_000) : old });
    await updateAlerts({ now: T0, state: s, snapshots });
    const alert = onDisk().alerts['snapshot-failed'];
    expect(alert !== undefined).toBe(raised);
    expect(rest.creates(DM)).toHaveLength(raised ? 1 : 0);
    if (raised) expect(alert.message.state).toBe('sent');
  });

  it('a standing alert stays across a restart, and the new process sends nothing again', async () => {
    const s = state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0 - 60_000) });
    await updateAlerts({ now: T0 - 60_000, state: s, snapshots: [snapshot(T0 - 5 * H)] });
    await updateAlerts({ now: T0, state: s, snapshots: [snapshot(T0 - 5 * H)] });
    const raised = onDisk().alerts['snapshot-failed'];
    expect(raised.message.state).toBe('sent');
    _resetAlertsForTests();
    await updateAlerts({ now: T0 + 2 * H, state: onDisk(), snapshots: [snapshot(T0 - 5 * H)] });
    expect(onDisk().alerts['snapshot-failed']).toEqual(raised);
    expect(rest.creates(DM)).toHaveLength(1);
  });
});

describe('test-failed', () => {
  it('stands while the last test failed, is sent at once and is cleared by a pass', async () => {
    const last = { name: 'daily-2026-11-13T04-00-00-000Z', at: T0 - H, result: 'failed' as const, detail: 'The copy differs from what was recorded when the backup was taken: 1 difference(s), first 123/a.json (content).' };
    const s = state({ test: { day: '2026-11-13', running: null, last, lastPassed: null } });
    await updateAlerts({ now: T0, state: s, snapshots: [snapshot(T0 - H, 'daily')] });
    const alert = onDisk().alerts['test-failed'];
    expect(alert).toMatchObject({ since: T0, key: alertKey('test-failed', T0), text: testFailedText(last), message: { state: 'sent', at: T0, place: 'dm' } });
    expect(rest.creates(DM)[0].options.body.content).toBe(testFailedText(last));
    s.test.last = { name: last.name, at: T0 + H, result: 'passed' };
    await updateAlerts({ now: T0 + H, state: s, snapshots: [snapshot(T0 - H, 'daily')] });
    expect(onDisk().alerts).toEqual({});
  });
});

describe('while state.json cannot be read (fix 10b)', () => {
  const last = { name: 'daily-2026-11-13T04-00-00-000Z', at: T0 - H, result: 'failed' as const, detail: 'x.' };
  const failedTest = () => state({ test: { day: '2026-11-13', running: null, last, lastPassed: null } });

  function unreadable(): void {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(statePath(), 'not json');
  }

  it('an alert raised then is sent and leaves the file as it is', async () => {
    unreadable();
    await updateAlerts({ now: T0, state: failedTest(), snapshots: [], fileCause: 'not valid JSON' });
    expect(rest.creates(DM)).toHaveLength(1);
    expect(fs.readFileSync(statePath(), 'utf8')).toBe('not json');
    expect(errors).toEqual([]);
  });

  it('the alert is written at the first tick after the file reads again, beside what the file holds', async () => {
    unreadable();
    const s = failedTest();
    await updateAlerts({ now: T0, state: s, snapshots: [], fileCause: 'not valid JSON' });
    writeState({ ...defaultState(), test: { ...s.test, lastPassed: 'daily-2026-11-12T04-00-00-000Z' } });
    await updateAlerts({ now: T0 + 60_000, state: onDisk(), snapshots: [], fileCause: null });
    expect(onDisk().alerts['test-failed']).toMatchObject({ since: T0, key: alertKey('test-failed', T0), message: { state: 'sent', at: T0 } });
    expect(onDisk().test.lastPassed).toBe('daily-2026-11-12T04-00-00-000Z');
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('an alert raised with a readable file is written at its raise', async () => {
    await updateAlerts({ now: T0, state: failedTest(), snapshots: [], fileCause: null });
    expect(onDisk().alerts['test-failed']).toMatchObject({ since: T0, message: { state: 'sent' } });
  });

  it('a sent alert through one unreadable tick is not cleared, and no second DM is sent (fix 3B)', async () => {
    await updateAlerts({ now: T0, state: failedTest(), snapshots: [], fileCause: null });
    const good = fs.readFileSync(statePath(), 'utf8');
    fs.writeFileSync(statePath(), 'not json');
    await updateAlerts({ now: T0 + 60_000, state: defaultState(), snapshots: [], fileCause: 'not valid JSON' });
    fs.writeFileSync(statePath(), good);
    await updateAlerts({ now: T0 + 120_000, state: onDisk(), snapshots: [], fileCause: null });
    expect(rest.creates(DM)).toHaveLength(1);
    expect(onDisk().alerts['test-failed']).toMatchObject({ since: T0, key: alertKey('test-failed', T0), message: { state: 'sent' } });
  });

  it("a process started while the file cannot be read keeps the file's standing alert once it reads (fix 3B)", async () => {
    await updateAlerts({ now: T0, state: failedTest(), snapshots: [], fileCause: null });
    const good = fs.readFileSync(statePath(), 'utf8');
    _resetAlertsForTests();
    fs.writeFileSync(statePath(), 'not json');
    await updateAlerts({ now: T0 + 60_000, state: defaultState(), snapshots: [], fileCause: 'not valid JSON' });
    fs.writeFileSync(statePath(), good);
    await updateAlerts({ now: T0 + 120_000, state: onDisk(), snapshots: [], fileCause: null });
    expect(rest.creates(DM)).toHaveLength(1);
    expect(onDisk().alerts['test-failed']).toMatchObject({ since: T0, key: alertKey('test-failed', T0), message: { state: 'sent' } });
  });
});

describe('the key and the fates of the message', () => {
  const failing = () => state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0) });
  const list = [snapshot(T0 - 4 * H)];

  it('the key is bot-backup:<case>:<since ISO>, posted with the nonce of dm:<key>', async () => {
    await updateAlerts({ now: T0, state: failing(), snapshots: list });
    const alert = onDisk().alerts['snapshot-failed'];
    expect(alert.since).toBe(T0);
    expect(alert.key).toBe('bot-backup:snapshot-failed:2026-11-13T12:00:00.000Z');
    expect(alertKey('snapshot-failed', T0)).toBe(alert.key);
    expect(rest.creates(DM)[0].options.body.nonce).toBe(hashNonce(`dm:${alert.key}`));
    expect(JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8')).keys[alert.key]).toBeTypeOf('string');
  });

  it('posted true is sent with the time, the place and the note', async () => {
    fs.writeFileSync(dataPath('owner-channel.json'), '{not json');
    try {
      await updateAlerts({ now: T0, state: failing(), snapshots: list });
    } finally {
      fs.rmSync(dataPath('owner-channel.json'), { force: true });
    }
    const message = onDisk().alerts['snapshot-failed'].message;
    expect(message).toMatchObject({ state: 'sent', at: T0, place: 'dm' });
    expect(message.note).toMatch(/^Posted in the owner's DMs: the chosen channel setting could not be read/);
  });

  it('posted false is already, with the note', async () => {
    const key = alertKey('snapshot-failed', T0);
    expect((await notify({ text: 'earlier', key })).body.posted).toBe(true);
    await updateAlerts({ now: T0, state: failing(), snapshots: list });
    const message = onDisk().alerts['snapshot-failed'].message;
    expect(message).toMatchObject({ state: 'already', at: T0 });
    expect(message.note).toMatch(/^A message with this key was posted on .+; this repeat was not posted\.$/);
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('a 502 with unknown is unknown and is never sent again', async () => {
    rest.answering = false;
    await updateAlerts({ now: T0, state: failing(), snapshots: list });
    expect(onDisk().alerts['snapshot-failed'].message).toEqual({
      state: 'unknown', at: T0, error: "can't confirm whether the message was posted: Discord did not answer within 20 s",
    });
    rest.answering = true;
    const calls = rest.calls.length;
    const s = onDisk();
    for (const later of [T0 + H, T0 + 5 * H, T0 + 30 * H]) await updateAlerts({ now: later, state: s, snapshots: list });
    expect(rest.calls).toHaveLength(calls);
    expect(onDisk().alerts['snapshot-failed'].message.state).toBe('unknown');
  });

  it('a 502 refusal is failed, and is sent again at the first tick an hour or more later with the same key', async () => {
    rest.fail('post', /^\/channels\/\d+\/messages$/, discordError(403, 50007, 'Cannot send messages to this user'));
    await updateAlerts({ now: T0, state: failing(), snapshots: list });
    const first = onDisk().alerts['snapshot-failed'];
    expect(first.message).toEqual({ state: 'failed', at: T0, error: "Discord refused the message to the bot's owner (50007 Cannot send messages to this user)" });
    rest = new FakeOwnerRest(300);
    const s = onDisk();
    await updateAlerts({ now: T0 + RETRY_MS - 60_000, state: s, snapshots: list });
    expect(rest.creates(DM)).toHaveLength(0);
    await updateAlerts({ now: T0 + RETRY_MS, state: s, snapshots: list });
    expect(rest.creates(DM)).toHaveLength(1);
    expect(rest.creates(DM)[0].options.body.nonce).toBe(hashNonce(`dm:${first.key}`));
    expect(onDisk().alerts['snapshot-failed']).toMatchObject({ key: first.key, since: T0, message: { state: 'sent', at: T0 + RETRY_MS } });
  });

  it('a 502 without unknown (the record of posted messages cannot be read) is failed with its error', async () => {
    fs.mkdirSync(ownerMessagesFile(), { recursive: true });
    try {
      await updateAlerts({ now: T0, state: failing(), snapshots: list });
    } finally {
      fs.rmSync(ownerMessagesFile(), { recursive: true, force: true });
    }
    const message = onDisk().alerts['snapshot-failed'].message;
    expect(message.state).toBe('failed');
    expect(message.error).toMatch(/^The record of posted messages \(\/data\/owner-messages\.json\) cannot be read/);
  });

  it('C17: a 503 KEY_BUSY is failed and sent again an hour later', async () => {
    const key = alertKey('snapshot-failed', T0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rest.on('post', /^\/channels\/\d+\/messages$/, async () => { await gate; return undefined; });
    _setManagedTiming({ notifyMs: 2_000 });
    _setAlertTimingForTests({ budgetMs: 100 });
    const holder = notify({ text: 'held', key });
    await vi.waitFor(() => expect(rest.creates(DM)).toHaveLength(1));
    await updateAlerts({ now: T0, state: failing(), snapshots: list });
    expect(onDisk().alerts['snapshot-failed'].message).toEqual({ state: 'failed', at: T0, error: 'Another request for this key is still running; try again' });
    release();
    expect((await holder).body.posted).toBe(true);
    await updateAlerts({ now: T0 + RETRY_MS, state: onDisk(), snapshots: list });
    expect(onDisk().alerts['snapshot-failed'].message).toMatchObject({ state: 'already', at: T0 + RETRY_MS });
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('C17: a 503 KEY_LAPSED is failed and sent again an hour later', async () => {
    setBackendKind('postgres');
    _setOwnerChannelDeps({ readKey: () => new Promise(() => undefined), recordKey: async () => ({ kind: 'ok' }) });
    _setAlertTimingForTests({ budgetMs: 100 });
    await updateAlerts({ now: T0, state: failing(), snapshots: list });
    expect(onDisk().alerts['snapshot-failed'].message).toEqual({
      state: 'failed', at: T0, error: 'This request waited for an earlier request for this key and ran out of time; nothing was posted; try again',
    });
    expect(rest.creates()).toHaveLength(0);
    setBackendKind('file');
    _setAlertTimingForTests({ budgetMs: 600 });
    await updateAlerts({ now: T0 + RETRY_MS, state: onDisk(), snapshots: list });
    expect(onDisk().alerts['snapshot-failed'].message).toMatchObject({ state: 'sent', at: T0 + RETRY_MS });
  });

  it('A1.w: a notify-owner request and an alert of one key run in line, and the later one is already', async () => {
    const key = alertKey('snapshot-failed', T0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rest.on('post', /^\/channels\/\d+\/messages$/, async () => { await gate; return undefined; });
    _setManagedTiming({ notifyMs: 2_000 });
    _setAlertTimingForTests({ budgetMs: 2_000 });
    const holder = notify({ text: 'held', key });
    await vi.waitFor(() => expect(rest.creates(DM)).toHaveLength(1));
    const alert = updateAlerts({ now: T0, state: failing(), snapshots: list });
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    expect((await holder).body.posted).toBe(true);
    await alert;
    expect(onDisk().alerts['snapshot-failed'].message.state).toBe('already');
    expect(rest.creates(DM)).toHaveLength(1);
  });

  it('postOwnerMessage answers as the route does', async () => {
    expect(await postOwnerMessage({ text: 'one', key: 'direct' }, 600)).toEqual({ status: 200, body: { success: true, posted: true, place: 'dm' } });
    expect(await postOwnerMessage({ text: 'one', key: 'direct' }, 600)).toMatchObject({ status: 200, body: { success: true, posted: false } });
  });
});

describe('sending found at a start', () => {
  const failing = () => state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0) });
  const list = [snapshot(T0 - 4 * H)];

  /** The state.json the real writer left when the process died after its `sending` write, with the post's create held. */
  async function killedAfterSending(posted: boolean): Promise<string> {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (posted) rest.on('post', /^\/channels\/\d+\/messages$/, async () => { await gate; return undefined; });
    else rest.hang('post', /^\/channels\/\d+\/messages$/);
    const run = updateAlerts({ now: T0, state: failing(), snapshots: list });
    await vi.waitFor(() => expect(rest.creates(DM)).toHaveLength(1));
    const left = fs.readFileSync(statePath(), 'utf8');
    release();
    await run;
    return left;
  }

  it('is sent again with the same key', async () => {
    const left = await killedAfterSending(false);
    expect(JSON.parse(left).alerts['snapshot-failed'].message).toEqual({ state: 'sending', at: T0 });
    fs.writeFileSync(statePath(), left);
    fs.rmSync(ownerMessagesFile(), { force: true });
    rest = new FakeOwnerRest(300);
    _resetAlertsForTests();
    await updateAlerts({ now: T0 + 10 * 60_000, state: onDisk(), snapshots: list });
    const alert = onDisk().alerts['snapshot-failed'];
    expect(alert).toMatchObject({ since: T0, key: alertKey('snapshot-failed', T0), message: { state: 'sent', at: T0 + 10 * 60_000 } });
    expect(rest.creates(DM)[0].options.body.nonce).toBe(hashNonce(`dm:${alert.key}`));
  });

  it('a key the first process posted and recorded is already, and nothing new is posted', async () => {
    const left = await killedAfterSending(true);
    fs.writeFileSync(statePath(), left);
    _resetAlertsForTests();
    await updateAlerts({ now: T0 + 10 * 60_000, state: onDisk(), snapshots: list });
    expect(onDisk().alerts['snapshot-failed'].message.state).toBe('already');
    expect(rest.creates(DM)).toHaveLength(1);
  });
});

describe('clearing, a new key later, and state.json writes that fail', () => {
  it('a backup clears the alert; a later failure is a new alert with a new key', async () => {
    const s = state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0) });
    await updateAlerts({ now: T0, state: s, snapshots: [snapshot(T0 - 4 * H)] });
    const first = onDisk().alerts['snapshot-failed'];
    await updateAlerts({ now: T0 + H, state: s, snapshots: [snapshot(T0 + H - 60_000)] });
    expect(onDisk().alerts).toEqual({});
    s.lastAttempt = failedAttempt(T0 + 4 * H);
    await updateAlerts({ now: T0 + 4 * H, state: s, snapshots: [snapshot(T0 + H - 60_000)] });
    const second = onDisk().alerts['snapshot-failed'];
    expect(second.key).toBe(alertKey('snapshot-failed', T0 + 4 * H));
    expect(second.key).not.toBe(first.key);
    expect(rest.creates(DM)).toHaveLength(2);
  });

  it('A1.d: the writes fail: the alert stays in memory, each failure is logged and the DM is sent once', async () => {
    failStateRename();
    const s = state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0) });
    await updateAlerts({ now: T0, state: s, snapshots: [snapshot(T0 - 4 * H)] });
    await updateAlerts({ now: T0 + 2 * H, state: s, snapshots: [snapshot(T0 - 4 * H)] });
    expect(fs.existsSync(statePath())).toBe(false);
    expect(s.alerts['snapshot-failed'].message.state).toBe('sent');
    expect(rest.creates(DM)).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBe('[Backup] The backup record (/data/_snapshots/state.json) could not be written (EIO: stubbed, rename); the web panel keeps the change in memory and writes it at its next check.');
    healStateRename();
    await updateAlerts({ now: T0 + 3 * H, state: s, snapshots: [snapshot(T0 - 4 * H)] });
    expect(onDisk().alerts['snapshot-failed']).toMatchObject({ since: T0, message: { state: 'sent' } });
  });

  it('A2.f: a clear whose write fails is logged and written at the next tick', async () => {
    const s = state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0) });
    await updateAlerts({ now: T0, state: s, snapshots: [snapshot(T0 - 4 * H)] });
    failStateRename();
    const fresh = [snapshot(T0 + H - 60_000)];
    await updateAlerts({ now: T0 + H, state: s, snapshots: fresh });
    expect(onDisk().alerts['snapshot-failed']).toBeDefined();
    expect(errors).toHaveLength(1);
    healStateRename();
    await updateAlerts({ now: T0 + H + 60_000, state: s, snapshots: fresh });
    expect(onDisk().alerts).toEqual({});
  });
});

describe('the DM texts', () => {
  const newest = T0 - 4 * H;

  it('names "Last error" when the failed attempt is newer than the refusal', () => {
    const s = state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0 - H), lastRefusal: { at: T0 - 2 * H, words: 'the bot was stopping.' } });
    expect(snapshotFailedText(s, newest)).toBe(
      `No backup of this bot's data has succeeded since ${stamp(newest)}. Last error: Could not read /data/123/x.json (EIO); the backup was not kept. The Dashboard tab of the bot's web panel lists the backups.`,
    );
  });

  it('names an unknown attempt the same way', () => {
    const s = state({ lastAttempt: { name: 'hourly-x', at: T0 - H, result: 'unknown', error: "can't confirm whether the backup was taken: the bot did not answer within 12 minutes." } });
    expect(snapshotFailedText(s, newest)).toContain(" Last error: can't confirm whether the backup was taken: the bot did not answer within 12 minutes. The Dashboard");
  });

  it('names "No backup could be started at" when the refusal is newer', () => {
    const s = state({ lastAttempt: failedAttempt(T0 - 2 * H), lastRefusal: { at: T0 - H, words: 'the bot was stopping.' } });
    expect(snapshotFailedText(s, newest)).toBe(
      `No backup of this bot's data has succeeded since ${stamp(newest)}. No backup could be started at ${stamp(T0 - H)}: the bot was stopping. The Dashboard tab of the bot's web panel lists the backups.`,
    );
  });

  it('names "The backup started at <time> was not kept:" for a refusal with startedAt', () => {
    const s = state({ lastRefusal: { at: T0 - H, startedAt: T0 - H - 120_000, words: 'the bot began stopping during the backup.' } });
    expect(snapshotFailedText(s, newest)).toBe(
      `No backup of this bot's data has succeeded since ${stamp(newest)}. The backup started at ${stamp(T0 - H - 120_000)} was not kept: the bot began stopping during the backup. The Dashboard tab of the bot's web panel lists the backups.`,
    );
  });

  it('says "No backup was attempted." when neither exists, and an ok attempt does not count', () => {
    const watching = T0 - 5 * H;
    expect(snapshotFailedText(state({ watchingSince: watching }), null)).toBe(
      `No backup of this bot's data has succeeded since the web panel began backing it up at ${stamp(watching)}. No backup was attempted. The Dashboard tab of the bot's web panel lists the backups.`,
    );
    expect(snapshotFailedText(state({ lastAttempt: { name: 'hourly-x', at: T0 - H, result: 'ok' } }), newest)).toContain(' No backup was attempted. ');
  });

  it('an error, words or detail ending in a period get one period; one without gets it from the frame', () => {
    expect(snapshotFailedText(state({ lastAttempt: failedAttempt(T0, 'disk gone.') }), newest)).toContain(' Last error: disk gone. The Dashboard');
    expect(snapshotFailedText(state({ lastAttempt: failedAttempt(T0, 'disk gone') }), newest)).toContain(' Last error: disk gone. The Dashboard');
    expect(snapshotFailedText(state({ lastRefusal: { at: T0, words: 'the bot was stopping' } }), newest)).toContain(': the bot was stopping. The Dashboard');
    const last = { name: 'daily-2026-11-13T04-00-00-000Z', at: T0, result: 'failed' as const, detail: 'The test was cut short twice (the web panel restarted during it).' };
    expect(testFailedText(last)).toBe(
      "The daily test restore of this bot's newest backup (daily-2026-11-13T04-00-00-000Z) failed: The test was cut short twice (the web panel restarted during it). That backup may not restore. The Dashboard tab of the bot's web panel shows the details.",
    );
    expect(testFailedText({ ...last, detail: 'no copy' })).toContain('failed: no copy. That backup may not restore.');
  });

  it('the raised alert carries the text the DM sends', async () => {
    const s = state({ watchingSince: T0 - 10 * H, lastAttempt: failedAttempt(T0) });
    await updateAlerts({ now: T0, state: s, snapshots: [snapshot(newest)] });
    const alert = onDisk().alerts['snapshot-failed'];
    expect(alert.text).toBe(snapshotFailedText(s, newest));
    expect(rest.creates(DM)[0].options.body.content).toBe(alert.text);
    expect(ALERT_AFTER_MS).toBe(3 * H);
  });
});

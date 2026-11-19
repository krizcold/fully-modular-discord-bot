import fs from 'fs';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, settle } from '../helpers/jsxRig';
import { timeText } from '../../src/bot/internalSetup/utils/folderChain';
import { takeSyncText } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { restoreView } from '../../src/webui/backups/restore';
import {
  _resetRestoreStateForTests, gateRestartText, gateStartText, RESTART_DURING_RESTORE_TEXT, setRestoreLatch, setRestoreOp, type RestoreLatch,
} from '../../src/webui/backups/restoreState';
import { settingsUnreadableText, stateUnreadableText, writeRestoreJournal } from '../../src/webui/backups/state';
import { restoreJournalPath, type RestoreJournal } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { dataPath } from '../../src/utils/dataRoot';

// NB8 test 18 (decisions 14 and 15 with 31, 44, 54, 62, 70, B11, C14, C20 and N5): the Dashboard's "Data backups"
// section and the header badge, run in the jsx rig. GET /api/backups' body has part 12's shape; the lines GET renders
// itself (`restore.line`, `notes`, an attempt's error) come from the real producers where a row checks one.

const PUBLIC = (rel: string) => fileURLToPath(new URL(`../../src/webui/public/${rel}`, import.meta.url));
const PANEL = PUBLIC('components/DataBackupsPanel.jsx');
const APP = PUBLIC('app.jsx');

const NAME = 'hourly-2026-11-14T09-00-00-000Z';
const OLDER = 'daily-2026-11-14T04-00-00-000Z';
const PRE = 'pre-restore-2026-11-14T10-00-00-000Z';
const NOW = Date.UTC(2026, 10, 14, 10, 30);
const TAKEN = Date.UTC(2026, 10, 14, 9, 0, 12);

interface Held { method: string; url: string; body?: any; done: boolean; answer: (v: any) => void; reject: (e: unknown) => void }

function held() {
  const calls: Held[] = [];
  const make = (method: string) => (url: string, body?: any) => new Promise<any>((resolve, reject) => {
    const c: Held = { method, url, body, done: false, answer: v => { c.done = true; resolve(v); }, reject: e => { c.done = true; reject(e); } };
    calls.push(c);
  });
  return { calls, api: { get: make('GET'), post: make('POST'), put: make('PUT') } };
}

const snap = (name: string, takenAt: number, over: Record<string, unknown> = {}) => ({
  name, kind: name.split('-')[0], takenAt, files: 12, bytes: 1572864, guilds: 2, graveyardEntries: 0, test: null, state: 'complete', ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  success: true, enabled: true, hour: 4, json: true, snapshots: [], newest: null, lastAttempt: null, lastRefusal: null,
  test: { last: null, running: null }, work: null, alerts: {}, migration: { kind: 'none' }, restore: null, notes: [], ...over,
});

const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status, body: { success: false, error: message } });

function openPanel(confirms: boolean[] = []) {
  const { calls, api } = held();
  const toasts: Array<{ message: string; type: string }> = [];
  const asked: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cleared: number[] = [];
  const alerts: unknown[] = [];
  const panel = mount(PANEL, 'DataBackupsPanel', { api, onBackupAlert: (a: unknown) => alerts.push(a) }, {
    showToast: (message: string, type: string) => toasts.push({ message, type }),
    confirm: (q: string) => { asked.push(q); return confirms.shift() ?? false; },
    setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id: number) => { cleared.push(id); },
  });
  const pending = (re: RegExp) => calls.find(c => !c.done && re.test(c.url));
  const reply = async (re: RegExp, value: any) => {
    await settle();
    const c = pending(re);
    if (!c) throw new Error(`no call waits for ${re}; made: ${calls.map(x => `${x.method} ${x.url}${x.done ? ' (answered)' : ''}`).join(', ')}`);
    c.answer(value);
    await settle();
    return c;
  };
  const rejectWith = async (re: RegExp, error: unknown) => {
    await settle();
    const c = pending(re);
    if (!c) throw new Error(`no call waits for ${re}`);
    c.reject(error);
    await settle();
    return c;
  };
  const text = () => panel.text(panel.tree!);
  const restoreButtons = () => panel.all(el => el.type === 'button' && /^Restore$/.test(panel.text(el)));
  return { calls, panel, toasts, asked, alerts, timers, cleared, reply, rejectWith, text, restoreButtons };
}

async function shown(over: Record<string, unknown>) {
  const p = openPanel();
  await p.reply(/^\/backups$/, body(over));
  return p;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  _resetRestoreStateForTests();
});

afterEach(() => {
  _resetRestoreStateForTests();
  vi.useRealTimers();
});

describe('the panel lines (decision 15)', () => {
  it('nothing taken yet: no backup yet, no test restore yet, the switch on and the hour', async () => {
    const { panel, text } = await shown({});
    expect(text()).toContain('Data backups');
    expect(text()).toContain('No backup yet.');
    expect(text()).toContain('No test restore yet: the first runs after the first daily backup.');
    expect(text()).not.toContain('Backups are off');
    const box = panel.all(el => el.type === 'input' && el.props.type === 'checkbox')[0];
    expect(box.props.checked).toBe(true);
    expect(panel.selects()[0].props.value).toBe(4);
  });

  it('the newest backup with its time, its files and its size in MiB', async () => {
    const newest = snap(NAME, TAKEN);
    const { text } = await shown({ snapshots: [newest], newest });
    expect(text()).toContain(`Newest backup: ${NAME}, taken ${timeText(TAKEN)}, 12 files, 1.5 MiB.`);
    expect(text()).not.toContain('No backup yet.');
  });

  it.each([
    ['failed', { result: 'failed', error: 'The disk filled up while the backup was copied (/data/123/a.json); the partial copy was removed.' },
      `Last attempt failed at ${timeText(NOW - 60_000)}: The disk filled up while the backup was copied (/data/123/a.json); the partial copy was removed.`],
    ['failed, an error with no period', { result: 'failed', error: 'Could not read /data/123/a.json (EIO); the backup was not kept' },
      `Last attempt failed at ${timeText(NOW - 60_000)}: Could not read /data/123/a.json (EIO); the backup was not kept.`],
    ['unknown', { result: 'unknown', error: "can't confirm whether the backup was taken: the bot stopped before answering." },
      `Last attempt at ${timeText(NOW - 60_000)}: can't confirm whether the backup was taken: the bot stopped before answering.`],
  ])('the last attempt line when it %s', async (_name, attempt, line) => {
    const { text } = await shown({ lastAttempt: { name: NAME, at: NOW - 60_000, tries: 1, ...attempt } });
    expect(text()).toContain(line);
  });

  it('no attempt line when the newest attempt worked', async () => {
    const newest = snap(NAME, TAKEN);
    const { text } = await shown({ snapshots: [newest], newest, lastAttempt: { name: NAME, at: TAKEN, result: 'ok', tries: 1 } });
    expect(text()).not.toContain('Last attempt');
  });

  it('a refusal while the current hour has no backup and no attempt, and the running-take frame for one that began', async () => {
    const words = 'the bot was starting and had not opened its data files yet.';
    expect((await shown({ lastRefusal: { at: NOW - 60_000, words } })).text())
      .toContain(`No backup could be started at ${timeText(NOW - 60_000)}: ${words}`);
    const began = { at: NOW - 60_000, words: 'the bot began stopping during the backup.', startedAt: NOW - 120_000 };
    const frame = (await shown({ lastRefusal: began })).text();
    expect(frame).toContain(`The backup started at ${timeText(NOW - 120_000)} was not kept: the bot began stopping during the backup.`);
    expect(frame).not.toContain('No backup could be started');
  });

  it('no refusal line once the current hour has a complete backup or an attempt', async () => {
    const refusal = { at: NOW - 60_000, words: 'the bot was stopping.' };
    const newest = snap(NAME, NOW - 30_000);
    expect((await shown({ lastRefusal: refusal, snapshots: [newest], newest })).text()).not.toContain('No backup could be started');
    const attempt = { name: NAME, at: NOW - 30_000, result: 'failed', error: 'The backup took longer than 10 minutes and was stopped; the partial copy was removed.', tries: 1 };
    expect((await shown({ lastRefusal: refusal, lastAttempt: attempt })).text()).not.toContain('No backup could be started');
  });

  it.each([
    ['passed', { name: OLDER, at: NOW - 600_000, result: 'passed' }, `Last test restore: passed at ${timeText(NOW - 600_000)} (${OLDER}).`],
    ['failed', { name: OLDER, at: NOW - 600_000, result: 'failed', detail: 'The copy differs from what was recorded when the backup was taken: 1 difference(s), first 123/mod/a.json (content).' },
      `Last test restore: failed at ${timeText(NOW - 600_000)} (${OLDER}): The copy differs from what was recorded when the backup was taken: 1 difference(s), first 123/mod/a.json (content).`],
  ])('the test line when the last test %s', async (_name, last, line) => {
    const { text } = await shown({ test: { last, running: null } });
    expect(text()).toContain(line);
    expect(text()).not.toContain('No test restore yet');
  });

  it.each([
    ['the switch is off', { enabled: false }, 'Backups are off for this bot: no backup is taken and none is deleted.'],
    ['a migration runs', { migration: { kind: 'running', jobId: 'job-1' } }, 'A data migration is running; backups wait until it has finished.'],
    ['a migration did not finish (C14)', { migration: { kind: 'unfinished', jobId: 'job-1', stage: 'S4' } },
      'Data migration job-1 did not finish (it stopped at S4); backups wait until it is run again and has finished.'],
    ["a migration's state cannot be read (C14)", { migration: { kind: 'unknown', cause: '/data/.data-backend.json cannot be read (EIO)' } },
      "can't confirm whether a data migration is running or unfinished (/data/.data-backend.json cannot be read (EIO)); backups wait until that can be read."],
  ])('the line when %s', async (_name, over, line) => {
    expect((await shown(over)).text()).toContain(line);
  });

  it('a Postgres bot gets its line and no list', async () => {
    const newest = snap(NAME, TAKEN);
    const { text, restoreButtons } = await shown({ json: false, snapshots: [newest], newest });
    expect(text()).toContain("This bot keeps its data in Postgres, so it takes no backups of its own; the Bot Manager backs up the databases it runs.");
    expect(text()).not.toContain('Newest backup');
    expect(text()).not.toContain('No backup yet.');
    expect(restoreButtons()).toEqual([]);
  });

  const ALERT = "No backup of this bot's data has succeeded since 2026-11-14 04:00 UTC. Last error: The backup took longer than 10 minutes and was stopped; the partial copy was removed. The Dashboard tab of the bot's web panel lists the backups.";
  it.each([
    ['sent as a DM', { state: 'sent', at: NOW - 60_000, place: 'dm' }, `The owner was sent a DM at ${timeText(NOW - 60_000)}.`],
    ['sent in the channel', { state: 'sent', at: NOW - 60_000, place: 'channel' }, `The owner was sent a message in the owner messages channel at ${timeText(NOW - 60_000)}.`],
    ['sent, no place', { state: 'sent', at: NOW - 60_000 }, `The owner was sent a Discord message at ${timeText(NOW - 60_000)}.`],
    ['sent with a note', { state: 'sent', at: NOW - 60_000, place: 'dm', note: 'The key could not be recorded.' },
      `The owner was sent a DM at ${timeText(NOW - 60_000)}. The key could not be recorded.`],
    ['already', { state: 'already', at: NOW - 60_000 }, 'The bot had already posted this message, so nothing new was posted.'],
    ['sending', { state: 'sending', at: NOW - 60_000 }, 'The message is being sent.'],
    ['failed', { state: 'failed', at: NOW - 60_000, error: 'Discord answered 500' }, 'The message could not be sent (Discord answered 500); it is tried again every hour.'],
    ['unknown', { state: 'unknown', at: NOW - 60_000, error: 'the request timed out' }, "can't confirm the owner got the message: the request timed out. It is not sent again."],
  ])('an alert with its message line when the message was %s (NM2)', async (_name, message, line) => {
    const { text } = await shown({ alerts: { 'snapshot-failed': { since: NOW - 3_600_000, key: 'k', text: ALERT, message } } });
    expect(text()).toContain(ALERT);
    expect(text()).toContain(line);
  });

  it("shows GET's notes as they are", async () => {
    const notes = [settingsUnreadableText('not valid JSON'), stateUnreadableText('EACCES')];
    const { text } = await shown({ notes });
    for (const note of notes) expect(text()).toContain(note);
  });

  it("a GET that fails shows the route's error", async () => {
    const p = openPanel();
    await p.rejectWith(/^\/backups$/, withStatus('The backups could not be read: EIO: stubbed', 500));
    expect(p.text()).toContain('The backups could not be read: EIO: stubbed');
    expect(p.text().split('The backups could not be read').length).toBe(2);
  });

  it('a read that fails after a good one shows only the error: no old lines, list or buttons (fix 13, D1)', async () => {
    const newest = snap(NAME, TAKEN);
    const p = openPanel();
    await p.reply(/^\/backups$/, body({ snapshots: [newest], newest }));
    expect(p.restoreButtons()).toHaveLength(1);
    p.timers[0].fn();
    await p.rejectWith(/^\/backups$/, new TypeError('Failed to fetch'));
    expect(p.text()).toBe('Data backupsThe backups could not be read: Failed to fetch');
    expect(p.restoreButtons()).toEqual([]);
    expect(p.panel.selects()).toEqual([]);
  });

  it('a first read with no answer says the backups could not be read (fix 13, D1)', async () => {
    const p = openPanel();
    await p.rejectWith(/^\/backups$/, new TypeError('Failed to fetch'));
    expect(p.text()).toContain('The backups could not be read: Failed to fetch');
  });

  it("hands each read's standing alert to the header, the snapshot-failed one first (fix 13, badge ruling)", async () => {
    const p = openPanel();
    const text = 'The daily test restore failed.';
    await p.reply(/^\/backups$/, body({
      alerts: {
        'test-failed': { since: 1, key: 'k2', text, message: { state: 'sent', at: 2 } },
        'snapshot-failed': { since: 1, key: 'k1', text: 'No backup.', message: { state: 'sent', at: 2 } },
      },
    }));
    p.timers[0].fn();
    await p.reply(/^\/backups$/, body({ alerts: { 'test-failed': { since: 1, key: 'k2', text, message: { state: 'sent', at: 2 } } } }));
    p.timers[0].fn();
    await p.reply(/^\/backups$/, body());
    p.timers[0].fn();
    await p.rejectWith(/^\/backups$/, new TypeError('Failed to fetch'));
    expect(p.alerts).toEqual([{ case: 'snapshot-failed', text: 'No backup.' }, { case: 'test-failed', text }, null]);
  });
});

describe('a restore from the list (decisions 14 and 15, B11)', () => {
  const confirmText = `Restore ${NAME}, taken ${timeText(TAKEN)}? Every server's data, the deleted servers' data, the data of no server (the premium data included), config.json and the owner messages channel setting go back to that time; the App Store's state and this machine's identity stay as they are. The data there now is kept as a backup named pre-restore-<time>, which you can restore to undo this. A bot in maintenance is stopped for the restore and started again in maintenance; a stopped bot stays stopped.`;

  it('asks with the confirm text; a cancel sends nothing', async () => {
    const newest = snap(NAME, TAKEN);
    const p = openPanel([false]);
    await p.reply(/^\/backups$/, body({ snapshots: [newest], newest }));
    p.restoreButtons()[0].props.onClick();
    await settle();
    expect(p.asked).toEqual([confirmText]);
    expect(p.calls.filter(c => c.method === 'POST')).toEqual([]);
  });

  it("posts the name, reads GET again and shows the restore's line until it has a result; no Restore button meanwhile", async () => {
    const newest = snap(NAME, TAKEN);
    const older = snap(OLDER, TAKEN - 5 * 3_600_000);
    const p = openPanel([true]);
    await p.reply(/^\/backups$/, body({ snapshots: [newest, older], newest }));
    expect(p.restoreButtons()).toHaveLength(2);
    p.restoreButtons()[0].props.onClick();
    const post = await p.reply(/^\/backups\/restore$/, { success: true, state: 'started', name: NAME });
    expect(post.body).toEqual({ name: NAME });
    const running = `Restoring ${NAME}: copying and checking the backup.`;
    await p.reply(/^\/backups$/, body({ snapshots: [newest, older], newest, restore: { name: NAME, stage: 'staging', state: 'running', running: true, waiting: null, latch: null, line: running } }));
    expect(p.text()).toContain(running);
    expect(p.restoreButtons()).toEqual([]);
    const done = `Restored ${NAME} (taken ${timeText(TAKEN)}) at ${timeText(NOW)}: 12 files. The data it replaced is kept as backup ${PRE}. The bot is now stopped.`;
    p.timers[0].fn();
    await p.reply(/^\/backups$/, body({ snapshots: [snap(PRE, NOW), newest, older], newest: snap(PRE, NOW), restore: { name: NAME, stage: 'done', state: 'clear', running: false, waiting: null, latch: null, line: done, result: 'done' } }));
    expect(p.text()).toContain(done);
    expect(p.text()).not.toContain(running);
    expect(p.restoreButtons()).toHaveLength(3);
  });

  it('a damaged backup has no Restore button', async () => {
    const damaged = { name: NAME, kind: 'hourly', takenAt: null, files: null, bytes: null, guilds: null, graveyardEntries: null, test: null, state: 'damaged', cause: 'not valid JSON' };
    const older = snap(OLDER, TAKEN - 5 * 3_600_000);
    const { text, restoreButtons } = await shown({ snapshots: [damaged, older], newest: older });
    expect(text()).toContain(NAME);
    expect(text()).toContain('not valid JSON');
    expect(restoreButtons()).toHaveLength(1);
  });

  it('no Restore button while the replaced data is still being recorded at placed (fix 13, D2)', async () => {
    const newest = snap(NAME, TAKEN);
    const line = `Restoring ${NAME}: recording the replaced data.`;
    const placed = { name: NAME, stage: 'placed', state: 'clear', running: false, waiting: null, latch: null, line };
    const { text, restoreButtons } = await shown({ snapshots: [newest], newest, restore: placed });
    expect(text()).toContain(line);
    expect(restoreButtons()).toEqual([]);
  });

  it("a refusal shows the route's text, and GET is read again", async () => {
    const newest = snap(NAME, TAKEN);
    const p = openPanel([true]);
    await p.reply(/^\/backups$/, body({ snapshots: [newest], newest }));
    p.restoreButtons()[0].props.onClick();
    const refusal = 'Stop the bot, or put it in maintenance, before a restore: a running bot would keep writing the data the restore replaces.';
    await p.rejectWith(/^\/backups\/restore$/, withStatus(refusal, 409));
    expect(p.toasts).toContainEqual({ message: refusal, type: 'error' });
    expect(p.calls.filter(c => c.url === '/backups')).toHaveLength(2);
  });

  it("a POST with no answer says it can't confirm the restore started", async () => {
    const newest = snap(NAME, TAKEN);
    const p = openPanel([true]);
    await p.reply(/^\/backups$/, body({ snapshots: [newest], newest }));
    p.restoreButtons()[0].props.onClick();
    await p.rejectWith(/^\/backups\/restore$/, new TypeError('Failed to fetch'));
    expect(p.toasts).toContainEqual({ message: `can't confirm whether the restore of ${NAME} started: Failed to fetch`, type: 'error' });
  });

  it("a restore already running answers its note", async () => {
    const newest = snap(NAME, TAKEN);
    const p = openPanel([true]);
    await p.reply(/^\/backups$/, body({ snapshots: [newest], newest }));
    p.restoreButtons()[0].props.onClick();
    await p.reply(/^\/backups\/restore$/, { success: true, state: 'running', name: OLDER, note: `A restore of ${OLDER} is already running.` });
    expect(p.toasts).toContainEqual({ message: `A restore of ${OLDER} is already running.`, type: 'info' });
  });
});

describe('the switch and the hour (decision 13)', () => {
  it('the switch sends the change with the value it replaces, then reads GET again', async () => {
    const p = openPanel();
    await p.reply(/^\/backups$/, body());
    p.panel.all(el => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } });
    const put = await p.reply(/^\/backups\/settings$/, { success: true, settings: { enabled: false, hour: 4 } });
    expect(put.method).toBe('PUT');
    expect(put.body).toEqual({ enabled: false, expected: { enabled: true } });
    await p.reply(/^\/backups$/, body({ enabled: false }));
    expect(p.text()).toContain('Backups are off for this bot: no backup is taken and none is deleted.');
  });

  it('the hour sends the new hour with the stored one', async () => {
    const p = openPanel();
    await p.reply(/^\/backups$/, body());
    p.panel.selects()[0].props.onChange({ target: { value: '6' } });
    const put = await p.reply(/^\/backups\/settings$/, { success: true, settings: { enabled: true, hour: 6 } });
    expect(put.body).toEqual({ hour: 6, expected: { hour: 4 } });
  });

  it("a 409 shows the route's text and reads GET again", async () => {
    const p = openPanel();
    await p.reply(/^\/backups$/, body());
    p.panel.selects()[0].props.onChange({ target: { value: '6' } });
    const changed = 'The backup settings changed since they were read; nothing was saved. Read them again, then save.';
    await p.rejectWith(/^\/backups\/settings$/, withStatus(changed, 409));
    expect(p.toasts).toContainEqual({ message: changed, type: 'error' });
    await p.reply(/^\/backups$/, body({ hour: 7 }));
    expect(p.panel.selects()[0].props.value).toBe(7);
  });

  it("a PUT with no answer says it can't confirm the settings were saved (fix 13, D3)", async () => {
    const p = openPanel();
    await p.reply(/^\/backups$/, body());
    p.panel.selects()[0].props.onChange({ target: { value: '6' } });
    await p.rejectWith(/^\/backups\/settings$/, new TypeError('Failed to fetch'));
    expect(p.toasts).toEqual([{ message: "can't confirm whether the backup settings were saved: Failed to fetch", type: 'error' }]);
  });
});

describe('the reads (decision 14)', () => {
  it('reads every 60 s, keeps a newer answer over a late older one, and stops reading when it leaves the page', async () => {
    const p = openPanel();
    expect(p.timers.map(t => t.ms)).toEqual([60_000]);
    p.timers[0].fn();
    await settle();
    const reads = p.calls.filter(c => c.url === '/backups');
    expect(reads).toHaveLength(2);
    reads[1].answer(body({ enabled: false }));
    await settle();
    reads[0].answer(body());
    await settle();
    expect(p.text()).toContain('Backups are off for this bot');
    p.panel.unmount();
    expect(p.cleared).toEqual([1]);
  });
});

describe("the lines GET renders, as the panel shows them (N5's 'open' forms and the restore lines)", () => {
  const host = { getStatus: () => ({ running: false }) } as any;
  const journal = (stage: RestoreJournal['stage'], extra: Record<string, unknown> = {}): RestoreJournal => ({
    format: 1, name: NAME, startedAt: NOW - 600_000, stage, staging: '.restore-2026-11-14T10-20-00-000Z', preRestore: PRE, ...extra,
  });
  const latched = (l: Omit<RestoreLatch, 'at' | 'name'>) => setRestoreLatch({ at: NOW, name: NAME, ...l } as RestoreLatch);
  const restartTail = "Restart the bot's container: the web panel syncs the folders again and finishes the restore when it starts, before it starts the bot.";
  const until = "Until the bot's container is restarted, nothing more is moved, no change to the data is saved and the bot cannot be started.";

  async function lineShown(expected: string) {
    const view = restoreView(host);
    expect(view?.line).toBe(expected);
    const newest = snap(NAME, TAKEN);
    const { text, restoreButtons } = await shown({ snapshots: [newest], newest, restore: view });
    expect(text()).toContain(expected);
    return { restoreButtons };
  }

  it("step 3's cause, 'open': the failed line", async () => {
    const cause = "/data/_snapshots/.restore-2026-11-14T10-20-00-000Z could not be opened for its sync while the copied backup was synced (EMFILE), so can't confirm the copy is on disk.";
    writeRestoreJournal(journal('failed', { result: 'failed', error: cause, finishedAt: NOW }));
    await lineShown(`The restore of ${NAME} failed before any data was changed: ${cause} The bot is now stopped.`);
  });

  it("the take's sync, 'open': the last attempt line", async () => {
    const error = takeSyncText({ failed: true, kind: 'open', dir: dataPath('123'), errno: 'EMFILE', error: null });
    const { text } = await shown({ lastAttempt: { name: NAME, at: NOW - 60_000, result: 'failed', error, tries: 1 } });
    expect(text()).toContain(`Last attempt failed at ${timeText(NOW - 60_000)}: /data/123 could not be opened for its sync while the backup's folders were synced (EMFILE), so can't confirm the backup is on disk; the backup was not kept.`);
  });

  it("the swapping record's sync, 'open': latch journal-sync, and no Restore button", async () => {
    writeRestoreJournal(journal('swapping'));
    latched({ kind: 'journal-sync', stage: 'swapping', folder: dataPath('_snapshots'), errno: 'EMFILE', open: true, record: true });
    const { restoreButtons } = await lineShown(`The restore of ${NAME} stopped before any data was moved: /data/_snapshots could not be opened for its sync (EMFILE) after the restore's record was written, so can't confirm the record is on disk. The data is unchanged. Until the bot's container is restarted, nothing is moved, no change to the data is saved and the bot cannot be started. Restart the bot's container: the web panel then ends this restore as failed, with the data unchanged, before it starts the bot; start the restore again after that.`);
    expect(restoreButtons()).toEqual([]);
  });

  it("the sync before placing, 'open': latch fsync", async () => {
    writeRestoreJournal(journal('swapping'));
    latched({ kind: 'fsync', stage: 'swapping', folder: dataPath('global'), errno: 'EMFILE', open: true, preRestore: PRE });
    await lineShown(`The restore of ${NAME} stopped part way: /data/global could not be opened for its sync (EMFILE) after the current data was moved aside, so can't confirm that move is on disk. ${until} ${restartTail} The data the restore replaced is in /data/_snapshots/.${PRE}.`);
  });

  it("step 6's sync, 'open': latch fsync", async () => {
    writeRestoreJournal(journal('placing'));
    latched({ kind: 'fsync', stage: 'placing', folder: dataPath('global'), errno: 'ENOENT', open: true, preRestore: PRE });
    await lineShown(`The restore of ${NAME} stopped after moving the data: /data/global could not be opened for its sync (ENOENT), so can't confirm the moved data is on disk. ${until} ${restartTail} The data the restore replaced is in /data/_snapshots/.${PRE}.`);
  });

  it("step 8's sync, 'open': step 8's latch fsync", async () => {
    writeRestoreJournal(journal('placed', { placedAt: NOW - 60_000 }));
    latched({ kind: 'fsync', stage: 'placed', folder: dataPath('_snapshots'), errno: 'EMFILE', open: true, preRestore: PRE, placedAt: NOW - 60_000 });
    await lineShown(`Restored ${NAME} at ${timeText(NOW - 60_000)}. The data it replaced is in /data/_snapshots/${PRE}, but /data/_snapshots could not be opened for its sync (EMFILE) after that folder was renamed, so can't confirm its new name is on disk, and the restore's record was not finished. No other restore can start until the bot's container is restarted. After the restart the web panel syncs the folder again and finishes the record within a minute.`);
  });

  it('a stuck journal: its stuck text, and no Restore button', async () => {
    writeRestoreJournal(journal('stuck', { stuckAt: 'placing', path: 'global/mod', cause: 'rename', errno: 'EACCES' }));
    const { restoreButtons } = await lineShown(`The restore of ${NAME} stopped part way: ${'/data/global/mod'} could not be moved (EACCES). The bot does not start until the restore finishes. Fix the cause, then restart the bot's container: the web panel finishes the restore when it starts, before it starts the bot. The data the restore replaced is in /data/_snapshots/.${PRE}.`);
    expect(restoreButtons()).toEqual([]);
  });

  it("an unreadable journal: the can't-confirm line, and no Restore button", async () => {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(restoreJournalPath(), '{');
    const { restoreButtons } = await lineShown("can't confirm the state of the last backup restore: /data/_snapshots/restore.json cannot be read (not valid JSON). Until it can be read, the bot cannot be started, no change to the data is saved and no backup is taken; if no restore ran, remove that file.");
    expect(restoreButtons()).toEqual([]);
  });

  it('an op that runs: its running line (a recovery op, fix 13, D5)', async () => {
    writeRestoreJournal(journal('staged'));
    setRestoreOp({ kind: 'recovery', name: NAME });
    await lineShown(`Restoring ${NAME}: stopping the bot.`);
  });
});

describe('the header badge and the bot control texts (app.jsx)', () => {
  function openApp() {
    const { calls, api } = held();
    const toasts: Array<{ message: string; type: string }> = [];
    const control: { props: any } = { props: null };
    const section: { props: any } = { props: null };
    const app = mount(APP, 'App', {}, {
      ReactDOM: { render: () => undefined },
      document: { getElementById: () => null },
      window: {
        location: { pathname: '/dashboard', search: '', hash: '', reload: () => undefined },
        history: { pushState: () => undefined },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        BOT_BUILD: undefined,
      },
      wsClient: { on: () => () => undefined },
      readServedBuild: async () => null,
      api,
      showToast: (message: string, type: string) => toasts.push({ message, type }),
      confirm: () => true,
      botDataFilesText: () => null,
      BotControlPanel: (props: any) => { control.props = props; return { type: 'bot-control', props: {}, children: [] }; },
      DataBackupsPanel: (props: any) => { section.props = props; return { type: 'data-backups', props: {}, children: [] }; },
    });
    const reply = async (re: RegExp, value: any) => {
      await settle();
      const c = calls.find(x => !x.done && re.test(x.url));
      if (!c) throw new Error(`no call waits for ${re}`);
      c.answer(value);
      await settle();
    };
    const rejectWith = async (re: RegExp, error: unknown) => {
      await settle();
      const c = calls.find(x => !x.done && re.test(x.url));
      if (!c) throw new Error(`no call waits for ${re}`);
      c.reject(error);
      await settle();
    };
    const load = async (backups: unknown, running = true) => {
      await reply(/^\/bot\/status$/, { success: true, status: { running, uptime: 5, crashed: false, processId: 9, backups } });
      await reply(/^\/setup\/status$/, { success: true, configured: true });
      await reply(/^\/bot\/logs/, { success: true, logs: { current: [] } });
    };
    return { app, toasts, control, section, load, rejectWith };
  }

  it.each([
    ['snapshot-failed', 'Backup failed'],
    ['test-failed', 'Backup test failed'],
  ])('a standing %s alert shows its badge beside the status badge, its tooltip the alert text', async (alertCase, label) => {
    const { app, load } = openApp();
    const text = 'The daily test restore of this bot\'s newest backup (x) failed. That backup may not restore. The Dashboard tab of the bot\'s web panel shows the details.';
    await load({ alert: { case: alertCase, text }, restoring: false });
    const badges = app.all(el => typeof el.props.className === 'string' && el.props.className.startsWith('status-badge'));
    expect(badges).toHaveLength(2);
    expect(app.text(badges[1])).toBe(label);
    expect(badges[1].props.title).toBe(text);
  });

  it("the badge follows the alert of the section's latest read (fix 13, badge ruling)", async () => {
    const { app, section, load } = openApp();
    await load({ alert: null, restoring: false });
    const badge = () => app.all(el => el.props.className === 'status-badge crashed' && /^Backup/.test(app.text(el)))[0];
    expect(badge()).toBeUndefined();
    section.props.onBackupAlert({ case: 'test-failed', text: 'T' });
    await settle();
    expect(app.text(badge())).toBe('Backup test failed');
    expect(badge().props.title).toBe('T');
    section.props.onBackupAlert(null);
    await settle();
    expect(badge()).toBeUndefined();
  });

  it('no badge without an alert; the section sits under the bot controls on the Dashboard', async () => {
    const { app, load } = openApp();
    await load({ alert: null, restoring: false });
    expect(app.text(app.tree!)).not.toContain('Backup failed');
    const types = app.all(el => el.type === 'bot-control' || el.type === 'data-backups').map(el => el.type);
    expect(types).toEqual(['bot-control', 'data-backups']);
  });

  it.each([
    ['restart, a restore running', '/bot/restart', () => gateRestartText({ state: 'running', name: NAME, latch: null })],
    ['restart, a restore began during it', '/bot/restart', () => RESTART_DURING_RESTORE_TEXT],
    ['start, a restore running', '/bot/start', () => gateStartText({ state: 'running', name: NAME, latch: null })],
  ])("the control route's text for a %s is shown as it returns it", async (_name, url, textOf) => {
    const { toasts, control, load, rejectWith } = openApp();
    await load({ alert: null, restoring: true }, url === '/bot/restart');
    if (url === '/bot/restart') control.props.onRestart(true);
    else control.props.onStart();
    await rejectWith(new RegExp(`^${url}$`), withStatus(textOf(), 409));
    expect(toasts).toContainEqual({ message: textOf(), type: 'error' });
  });
});

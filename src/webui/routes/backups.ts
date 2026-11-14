// The bot's own JSON backups (NB8 decision 13): the list and the state the Dashboard's section shows, a restore, and
// the schedule's settings. Mounted at /api/backups behind requireAuth; the manager does not back up JSON bots.

import * as fs from 'fs';
import * as path from 'path';
import { Router, Request, Response } from 'express';
import type { BotManager } from '../botManager';
import { diskError, failedRecordWrite, containerPath, writeErrorText, diskRecord } from '../../bot/internalSetup/utils/folderChain';
import { listSnapshots, snapshotsRoot, type SnapshotEntry } from '../../bot/internalSetup/utils/backups/snapshotList';
import { isOpenStage, readRestoreJournal } from '../../bot/internalSetup/utils/backups/restoreJournal';
import { migrationState } from '../../bot/internalSetup/utils/dataMigration';
import { readSettings, readState, settingsUnreadableText, stateUnreadableText, writeSettings, type BackupSettings, type BackupState } from '../backups/state';
import { backupWorkRunning } from '../backups/restoreState';
import { diskNoteText, isJsonBot, postRestore, restoreView } from '../backups/restore';

const limits = { countMax: 10_000 };

/** Tests only: the file count's limit. */
export function _setBackupRouteLimitsForTests(next: Partial<typeof limits> = {}): void {
  Object.assign(limits, { countMax: 10_000 }, next);
}

type Shown = {
  name: string; kind: string | null; takenAt: number | null; files: number | null; bytes: number | null; guilds: number | null;
  graveyardEntries: number | null; test: 'passed' | 'failed' | null; state: 'complete' | 'damaged'; cause?: string;
};

function shownSnapshot(entry: SnapshotEntry, state: BackupState): Shown {
  const last = state.test.last;
  const test = last && last.name === entry.name ? last.result : null;
  if (entry.state === 'damaged') {
    return { name: entry.name, kind: entry.kind, takenAt: null, files: null, bytes: null, guilds: null, graveyardEntries: null, test, state: 'damaged', cause: entry.cause };
  }
  const { manifest } = entry;
  return {
    name: entry.name, kind: entry.kind, takenAt: manifest.takenAt, files: manifest.counts.files, bytes: manifest.counts.bytes,
    guilds: manifest.counts.guilds, graveyardEntries: manifest.counts.graveyardEntries, test, state: 'complete',
  };
}

// G2: a stray .pre-restore folder's files are counted only here, cached by its name and mtime.
const counted = new Map<string, { mtimeMs: number; count: number | 'more' | { errno: string } }>();

async function countFiles(dir: string): Promise<number | 'more' | { errno: string }> {
  let count = 0;
  const walk = async (at: string): Promise<boolean> => {
    for (const entry of await fs.promises.readdir(at, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!(await walk(path.join(at, entry.name)))) return false;
      } else if (++count > limits.countMax) {
        return false;
      }
    }
    return true;
  };
  try {
    return (await walk(dir)) ? count : 'more';
  } catch (error) {
    return { errno: String((error as { code?: unknown } | null)?.code ?? 'EIO') };
  }
}

/** F3 and F4: each `.pre-restore-<t>` that no open journal (`staging` to `placed`, or `stuck`) names, while the journal can be read. */
async function strayNotes(): Promise<string[]> {
  const read = readRestoreJournal();
  if (read.state === 'unreadable') return [];
  const open = read.state === 'read' && (isOpenStage(read.journal.stage) || read.journal.stage === 'placed');
  const owned = open && read.state === 'read' ? `.${read.journal.preRestore}` : null;
  let names: string[];
  try {
    names = (await fs.promises.readdir(snapshotsRoot(), { withFileTypes: true }))
      .filter(d => d.isDirectory() && d.name.startsWith('.pre-restore-') && d.name !== owned)
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
  const notes: string[] = [];
  for (const name of names) {
    const dir = path.join(snapshotsRoot(), name);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.promises.stat(dir)).mtimeMs;
    } catch {
      continue;
    }
    let found = counted.get(name);
    if (!found || found.mtimeMs !== mtimeMs) {
      found = { mtimeMs, count: await countFiles(dir) };
      counted.set(name, found);
    }
    const words = containerPath(dir);
    const { count } = found;
    if (count === 0) {
      notes.push(`${words} is a folder a restore left under that name; it holds no file, so it can be deleted.`);
      continue;
    }
    const holds = count === 'more' ? `more than ${limits.countMax} files`
      : typeof count === 'number' ? `${count} ${count === 1 ? 'file' : 'files'}`
        : `files that could not be counted (${count.errno})`;
    notes.push(`${words} is a folder a restore left under that name. It holds ${holds}, which may be the data that restore replaced; nothing offers them as a backup, and can't confirm they are complete. Copy what you need from it by hand, then delete it.`);
  }
  for (const name of [...counted.keys()]) if (!names.includes(name)) counted.delete(name);
  return notes;
}

/** Decision 15's can't-read texts, C20's disk line (K4: the record or this process's flag), B5's, and F4's. */
async function notesOf(settingsCause: string | null, stateCause: string | null): Promise<string[]> {
  const notes: string[] = [];
  if (settingsCause) notes.push(settingsUnreadableText(settingsCause));
  if (stateCause) notes.push(stateUnreadableText(stateCause));
  const disk = diskError();
  if (disk) {
    notes.push(diskNoteText(disk));
    const failed = failedRecordWrite();
    if (failed && !diskRecord()) {
      notes.push(`The disk error could not be recorded in ${containerPath(failed.tried)} (${failed.errno}), so a restart of the bot's container alone would clear it.`);
    }
  }
  notes.push(...await strayNotes());
  return notes;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createBackupRoutes(botManager: BotManager): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { settings, cause: settingsCause } = readSettings();
      const { state, cause: stateCause } = readState();
      const list = (await listSnapshots()).reverse();
      const snapshots = list.map(entry => shownSnapshot(entry, state));
      const newest = snapshots.find(s => s.state === 'complete') ?? null;
      res.json({
        success: true,
        enabled: settings.enabled,
        hour: settings.hour,
        json: isJsonBot(),
        snapshots,
        newest,
        lastAttempt: state.lastAttempt,
        lastRefusal: state.lastRefusal,
        test: { last: state.test.last, running: state.test.running },
        work: backupWorkRunning(),
        alerts: state.alerts,
        migration: migrationState(botManager.migrationRunning()),
        restore: restoreView(botManager),
        notes: await notesOf(settingsCause, stateCause),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: `The backups could not be read: ${errorText(error)}` });
    }
  });

  router.post('/restore', async (req: Request, res: Response) => {
    const name = (req.body as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || name === '') {
      res.status(400).json({ success: false, error: 'name is required: the name of a backup' });
      return;
    }
    try {
      const answer = await postRestore(botManager, name);
      res.status(answer.status).json(answer.body);
    } catch (error) {
      res.status(500).json({ success: false, error: `can't confirm whether the restore of ${name} started: ${errorText(error)}` });
    }
  });

  router.put('/settings', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const bad = (error: string) => res.status(400).json({ success: false, error });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('the body must be a JSON object');
    const changes: Partial<BackupSettings> = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return bad('enabled must be true or false');
      changes.enabled = body.enabled;
    }
    if (body.hour !== undefined) {
      if (!Number.isInteger(body.hour) || (body.hour as number) < 0 || (body.hour as number) > 23) return bad('hour must be a whole number from 0 to 23');
      changes.hour = body.hour as number;
    }
    const keys = Object.keys(changes) as Array<keyof BackupSettings>;
    if (keys.length === 0) return bad('enabled or hour is required');
    const expected = body.expected as Record<string, unknown> | undefined;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || keys.some(k => !(k in expected))) {
      return bad('expected is required: the stored value of each setting you change');
    }
    const { settings } = readSettings();
    if (keys.some(k => expected[k] !== settings[k])) {
      return res.status(409).json({ success: false, error: 'The backup settings changed since they were read; nothing was saved. Read them again, then save.', settings });
    }
    const next: BackupSettings = { ...settings, ...changes };
    try {
      writeSettings(next);
    } catch (error) {
      return res.status(500).json({ success: false, error: writeErrorText('The backup settings', error) });
    }
    return res.json({ success: true, settings: next });
  });

  return router;
}

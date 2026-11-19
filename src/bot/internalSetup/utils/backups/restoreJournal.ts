import * as fs from 'fs';
import { dataPath } from '../../../../utils/dataRoot';

export type RestoreStage = 'staging' | 'staged' | 'swapping' | 'placing' | 'stuck' | 'placed' | 'done' | 'failed';

export const RESTORE_STAGES: readonly RestoreStage[] = ['staging', 'staged', 'swapping', 'placing', 'stuck', 'placed', 'done', 'failed'];

/** The stages at which a restore is open: no bot starts, no write is saved, no take, prune or import runs. */
export const OPEN_STAGES: readonly RestoreStage[] = ['staging', 'staged', 'swapping', 'placing', 'stuck'];

export interface RestoreJournal {
  format: 1;
  name: string;
  startedAt: number;
  stage: RestoreStage;
  staging: string;
  preRestore: string;
  [field: string]: unknown;
}

export type JournalRead =
  | { state: 'none' }
  | { state: 'read'; journal: RestoreJournal }
  | { state: 'unreadable'; cause: string };

export function restoreJournalPath(): string {
  return dataPath('_snapshots', 'restore.json');
}

export function isOpenStage(stage: RestoreStage): boolean {
  return OPEN_STAGES.includes(stage);
}

function parseJournal(text: string): RestoreJournal | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'not valid JSON';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a JSON object';
  const j = value as Record<string, unknown>;
  if (j.format !== 1) return j.format === undefined ? 'no format field' : `format ${JSON.stringify(j.format)}, which this version cannot read`;
  if (typeof j.stage !== 'string' || !RESTORE_STAGES.includes(j.stage as RestoreStage)) return j.stage === undefined ? 'no stage field' : `unknown stage ${JSON.stringify(j.stage)}`;
  for (const field of ['name', 'staging', 'preRestore'] as const) {
    if (typeof j[field] !== 'string') return j[field] === undefined ? `no ${field} field` : `${field} is not a string`;
  }
  if (typeof j.startedAt !== 'number') return j.startedAt === undefined ? 'no startedAt field' : 'startedAt is not a number';
  return j as RestoreJournal;
}

/** Reads restore.json synchronously, in the caller's turn. */
export function readRestoreJournal(): JournalRead {
  let text: string;
  try {
    text = fs.readFileSync(restoreJournalPath(), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'none' };
    return { state: 'unreadable', cause: code ?? String(e) };
  }
  const parsed = parseJournal(text);
  return typeof parsed === 'string' ? { state: 'unreadable', cause: parsed } : { state: 'read', journal: parsed };
}

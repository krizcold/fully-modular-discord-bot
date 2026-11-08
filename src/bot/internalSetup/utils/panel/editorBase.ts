import { baseOf } from '../dataManager';
import { sharedKeyOf } from '../sharedStore';

// NB6 decision 50: the sha of the body a Discord editor showed, kept in memory per user, panel and file, so its save
// is stored only over that version. A modal's custom id holds at most 100 characters, too few for a key and a sha.

/** An interaction's life: a base older than this belongs to an editor that may show old values. */
export const EDITOR_BASE_LIFE_MS = 15 * 60_000;

/** T14: a submit with no remembered base. */
export const EDITOR_BASE_GONE_TEXT = 'This editor was opened before the bot restarted, or more than 15 minutes ago, so it may show old values; nothing was saved. Open it again to see the current values.';

const bases = new Map<string, { sha: string; at: number }>();

const entryKey = (userId: string, panelId: string, fileKey: string): string => JSON.stringify([userId, panelId, fileKey]);

export function rememberBase(userId: string, panelId: string, fileKey: string, sha: string): void {
  const now = Date.now();
  for (const [key, entry] of bases) {
    if (now - entry.at > EDITOR_BASE_LIFE_MS) bases.delete(key);
  }
  bases.set(entryKey(userId, panelId, fileKey), { sha, at: now });
}

/** The remembered base, removed; null when there is none or it is older than an interaction's life. */
export function takeBase(userId: string, panelId: string, fileKey: string): string | null {
  const key = entryKey(userId, panelId, fileKey);
  const entry = bases.get(key);
  bases.delete(key);
  if (!entry || Date.now() - entry.at > EDITOR_BASE_LIFE_MS) return null;
  return entry.sha;
}

/** A view render or a modal open of the file at absPath: remembers the sha the facade holds for it now (a Postgres bot only). */
export function noteEditorBase(userId: string, panelId: string, absPath: string): void {
  const key = sharedKeyOf(absPath);
  if (key !== null) rememberBase(userId, panelId, key, baseOf(absPath));
}

/**
 * The options a submit, reset or delete of the file at absPath saves with: the remembered base on a Postgres bot,
 * nothing on a JSON bot; null when a Postgres bot has no base for it (refused with T14 before anything is queued).
 */
export function editorSaveOptions(userId: string, panelId: string, absPath: string): { baseSha?: string } | null {
  const key = sharedKeyOf(absPath);
  if (key === null) return {};
  const sha = takeBase(userId, panelId, key);
  return sha === null ? null : { baseSha: sha };
}

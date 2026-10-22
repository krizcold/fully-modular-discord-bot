// The web UI's reads of a document an editor opens or a backup copies, from the
// process that serves it: the bot child while it runs (its working set and its
// write queue hold writes this process cannot see), this process's own queue
// for a write it queued itself. A read made while the bot is down says so. A
// file that exists but cannot be read is an error, never an absent file.

import * as path from 'path';
import { readRawStrict } from '../../bot/internalSetup/utils/dataManager';
import { filesPending } from '../../bot/internalSetup/utils/dataBackends/fileBackend';
import { routeFor } from '../../bot/internalSetup/utils/dataBackends/routeResolver';
import { getWebuiDataReader } from './webuiDataReader';
import type { BotManager } from '../botManager';

/** childQueued: the child still holds a queued write of the file, so a write from this process now could land under it. */
export type ServedRead =
  | { ok: true; content: string | null; notice?: string; childQueued?: boolean; childFailing?: boolean }
  | { ok: false; status: number; error: string };

export const BOT_DOWN_DISK_NOTICE = "The bot is not running: this was read from this node's disk, and a change the bot had not saved yet is not in it.";
export const BOT_DOWN_DATABASE_NOTICE = 'The bot is not running: this was read from the database, and a change the bot had not saved yet is not in it.';
export const STILL_WRITING = 'A save of this file is still being written; retry in a moment.';
export const WRITE_FAILING = 'The bot has not been able to write an earlier save of this file yet (its attempts are failing; see the bot logs); nothing was saved.';

const unreadable = (code: string): { ok: false; status: number; error: string } => ({
  ok: false,
  status: 500,
  error: `The stored file could not be read (${code}); nothing was changed.`,
});

/** The refusal for a write while the child holds a queued write of the same file. */
export function childQueuedError(read: { childFailing?: boolean }): string {
  return read.childFailing ? WRITE_FAILING : STILL_WRITING;
}

export interface GlobalReadTarget { root?: 'config'; rel?: string; path: string }
export interface GuildReadTarget { guildId: string; module: string; filename: string; path: string }

/** A read the bot never answered, by why (botManager readNoAnswer). */
function noAnswerText(cause: unknown, detail: string | undefined): string {
  if (cause === 'timeout') return 'The bot did not answer the read in time; nothing was changed. Retry in a moment; if it keeps happening, see the bot logs.';
  if (cause === 'stopped') return 'The bot stopped before answering the read; nothing was changed. Retry once it is running.';
  return `The read could not be sent to the bot (${detail || 'unknown error'}); nothing was changed. See the bot logs.`;
}

function refused(reply: any, fallback: string): ServedRead {
  const detail = reply && typeof reply.error === 'string' ? reply.error : undefined;
  switch (reply?.code) {
    case 'frozen':
      return { ok: false, status: 503, error: 'Guild data is frozen for a shard migration; retry after it completes' };
    case 'not-owner':
    case 'owner-unreachable':
    case 'stale-term':
      return { ok: false, status: 503, error: 'guild temporarily unavailable' };
    case 'backend-unavailable':
      return { ok: false, status: 503, error: detail || 'the database backend is unavailable' };
    case 'invalid':
      return { ok: false, status: 400, error: detail || 'Invalid request' };
    case 'unreadable':
      return unreadable(detail || 'unknown error');
    case 'no-answer':
      return { ok: false, status: 503, error: noAnswerText(reply.cause, detail) };
    default:
      return { ok: false, status: 500, error: detail || fallback };
  }
}

const bodyOf = (reply: any): string | null => (typeof reply?.contentJson === 'string' ? reply.contentJson : null);

/** This process's queue-first read of the path. */
function readHere(absPath: string, notice?: string): ServedRead {
  try {
    const content = readRawStrict(absPath);
    return notice ? { ok: true, content, notice } : { ok: true, content };
  } catch (error) {
    return unreadable((error as NodeJS.ErrnoException)?.code || (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * A file both processes may queue writes to: when only this one holds a
 * queued write, that write is the newest; when both do, which lands last is
 * unknowable and the read is refused (409). A write of this process that was
 * queued at either side of the child's read counts: if it landed meanwhile,
 * the child may have read the disk before it did.
 */
function combine(target: { path: string }, queuedBefore: boolean, reply: any): ServedRead {
  if (queuedBefore || filesPending([target.path])) {
    if (reply.pending) return { ok: false, status: 409, error: childQueuedError({ childFailing: reply.failing === true }) };
    return readHere(target.path);
  }
  return { ok: true, content: bodyOf(reply), childQueued: reply.pending === true, childFailing: reply.failing === true };
}

/** A global file. */
export async function readServedGlobal(botManager: BotManager, target: GlobalReadTarget): Promise<ServedRead> {
  const queuedBefore = filesPending([target.path]);
  const reply = botManager.isRunning()
    ? await botManager.readGlobalData(target.root ? { root: target.root } : { rel: target.rel })
    : { ok: false, code: 'bot-down' };
  if (!reply?.ok) {
    if (reply?.code === 'bot-down') return readHere(target.path, BOT_DOWN_DISK_NOTICE);
    return refused(reply, 'Data read failed');
  }
  return combine(target, queuedBefore, reply);
}

/**
 * A guild document, through the child's read hop (queue first on the owning
 * node). A file-routed guild's files are also written by this process (its
 * saves and restores queue here), so its own queue counts as for a global file.
 */
export async function readServedGuild(botManager: BotManager, target: GuildReadTarget): Promise<ServedRead> {
  const fileRouted = routeFor(target.guildId) !== 'postgres';
  const queuedBefore = fileRouted && filesPending([target.path]);
  const reply = await botManager.readGuildData({ guildId: target.guildId, module: target.module, filename: target.filename });
  if (reply?.ok) return fileRouted ? combine(target, queuedBefore, reply) : { ok: true, content: bodyOf(reply) };
  if (reply?.code !== 'bot-down') return refused(reply, 'Guild data operation failed');
  if (!fileRouted) {
    try {
      const reader = getWebuiDataReader();
      const exists = await reader.exists(target.guildId, target.module, target.filename);
      const doc = exists ? await reader.readDoc(target.guildId, target.module, target.filename) : null;
      return { ok: true, content: doc, notice: BOT_DOWN_DATABASE_NOTICE };
    } catch {
      return { ok: false, status: 503, error: 'Data backend unreachable; retry shortly' };
    }
  }
  return readHere(target.path, BOT_DOWN_DISK_NOTICE);
}

const held = new Map<string, Promise<void>>();

/**
 * Runs one operator write of a file (its serving read, backup and write) after
 * every earlier one of the same file in this process has finished, so each
 * builds on and backs up the body the one before it accepted. Keyed by the
 * absolute path, since a config key and a data key can name the same file.
 */
export async function withTargetLock<T>(absPath: string, run: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(absPath);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const before = held.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  const tail = before.then(() => mine);
  held.set(key, tail);
  await before;
  try {
    return await run();
  } finally {
    release();
    if (held.get(key) === tail) held.delete(key);
  }
}

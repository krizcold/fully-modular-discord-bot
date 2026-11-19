import { resolveDataBackend } from '../../utils/envLoader';
import { atomicWriteFileSync } from '../../bot/internalSetup/utils/atomicWrite';
import { FolderSyncError, writeErrorText } from '../../bot/internalSetup/utils/folderChain';
import { channelCause, discordWords, hashNonce, placeWords, postInPlace, type OwnerPlace } from '../../utils/ownerMessages';
import {
  noteChannelPosted, noteChannelRefusal, ownerMessagesFile, readOwnerChannelSetting, readOwnerMessageKey, recordOwnerMessageKey,
} from './ownerChannel';
import { keptKeys, readKeyFile, type KeyTimes } from '../../bot/internalSetup/utils/ownerMessageRecord';

const KEY_READ_MS = 5_000;

function readKeyRecord(): { ok: true; record: { keys: KeyTimes } } | { ok: false; cause: string } {
  const read = readKeyFile(ownerMessagesFile());
  return read.ok ? { ok: true, record: { keys: read.keys } } : read;
}

/**
 * Records a posted key: at most 1000 keys and none older than 90 days, the oldest first to go. The file is read again
 * here, since requests with other keys post and record while this one ran.
 */
function writeKeyRecord(key: string): void {
  const now = Date.now();
  const current = readKeyRecord();
  if (!current.ok) throw new Error(current.cause);
  const kept = keptKeys({ ...current.record.keys, [key]: new Date(now).toISOString() }, now);
  atomicWriteFileSync(ownerMessagesFile(), JSON.stringify({ keys: kept }, null, 2));
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const keyLocks = new Map<string, Promise<void>>();

/** Whether `earlier` settled before the deadline. */
function settledBy(earlier: Promise<void>, deadline: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); });
  return Promise.race([earlier.then(() => true), lapsed]).finally(() => clearTimeout(timer));
}

/**
 * Requests in one line run one after the other, each holding the line until its Discord calls settled. A request whose
 * budget ends while it waits answers `busy` and runs nothing.
 */
export async function inLine(key: string, deadline: number, busy: string, work: () => Promise<Answer>): Promise<Answer> {
  const before = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  const tail = before.then(() => mine);
  keyLocks.set(key, tail);
  void tail.then(() => { if (keyLocks.get(key) === tail) keyLocks.delete(key); });
  try {
    if (!(await settledBy(before, deadline))) return lapsedAnswer(busy);
    return await work();
  } finally {
    release();
  }
}

const KEY_BUSY = 'Another request for this key is still running; try again';
const KEY_LAPSED = 'This request waited for an earlier request for this key and ran out of time; nothing was posted; try again';

/** The step's answer, or 'lapsed' once the deadline set at the request's arrival passed first. */
export async function beforeDeadline<T>(step: Promise<T>, deadline: number): Promise<T | 'lapsed'> {
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<'lapsed'>(resolve => { timer = setTimeout(() => resolve('lapsed'), Math.max(0, deadline - Date.now())); });
  try {
    return await Promise.race([step, lapsed]);
  } finally {
    clearTimeout(timer);
  }
}

export const lapsedAnswer = (busy: string): Answer => ({ status: 503, body: { success: false, error: busy } });

async function notifyOwner(text: string, key: string, deadline: number): Promise<Answer> {
  const read = readKeyRecord();
  if (!read.ok) {
    return { status: 502, body: { success: false, error: `The record of posted messages (/data/owner-messages.json) cannot be read (${read.cause}); nothing was posted` } };
  }
  const notes: string[] = [];
  let known: string | undefined = read.record.keys[key];
  let inMain = false;
  if (known === undefined && resolveDataBackend() === 'postgres') {
    const bound = Math.max(1, Math.min(KEY_READ_MS, deadline - Date.now()));
    const remote = await beforeDeadline(
      readOwnerMessageKey(key, bound).then(at => ({ at }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
      deadline,
    );
    if (remote === 'lapsed') return lapsedAnswer(KEY_LAPSED);
    if ('error' in remote) {
      notes.push(`The repeat check in the bot's main database could not be read (${remote.error}), so only this machine's record of posted messages was checked, and this key is recorded only there.`);
    } else {
      known = remote.at ?? undefined;
      inMain = true;
    }
  }
  if (known !== undefined) {
    return { status: 200, body: { success: true, posted: false, note: `A message with this key was posted on ${known}; this repeat was not posted.` } };
  }
  const setting = await beforeDeadline(readOwnerChannelSetting(), deadline);
  if (setting === 'lapsed' || Date.now() >= deadline) return lapsedAnswer(KEY_LAPSED);
  if (setting.kind === 'unreadable') notes.push(`Posted in the owner's DMs: the chosen channel setting could not be read (${setting.cause}).`);
  const place: OwnerPlace = setting.kind === 'id' ? { kind: 'channel', id: setting.id } : { kind: 'dm' };
  const nonce = hashNonce(place.kind === 'dm' ? `dm:${key}` : `channel:${place.id}:${key}`);
  const post = await postInPlace(place, { content: text }, nonce, deadline);
  if (!post.ok) {
    if (post.failure.timeout) {
      return { status: 502, body: { success: false, unknown: true, error: "can't confirm whether the message was posted: Discord did not answer within 20 s" } };
    }
    if (post.failure.unconfirmed) {
      return { status: 502, body: { success: false, unknown: true, error: `can't confirm whether the message was posted: ${post.failure.cause}` } };
    }
    if (place.kind === 'channel') {
      const cause = channelCause(post.failure);
      noteChannelRefusal(place.id, cause);
      return {
        status: 502,
        body: {
          success: false,
          error: `Discord refused the message in the chosen channel ${place.id} (${discordWords(post.failure)}): ${cause}. Nothing was posted; give the bot access to that channel in Discord, or choose another place in the web panel.`,
        },
      };
    }
    return { status: 502, body: { success: false, error: `Discord refused the message to the bot's owner (${discordWords(post.failure)})` } };
  }
  let inDm = place.kind === 'dm';
  if (post.channelId !== post.askedChannel) {
    const where = await placeWords(post.channelId, deadline);
    inDm = where === "the owner's DMs";
    const asked = place.kind === 'dm' ? "the owner's DMs" : `channel ${place.id}`;
    notes.push(`Discord answered with a message in ${where} instead of a new one in ${asked}.`);
  } else if (place.kind === 'channel') {
    noteChannelPosted(place.id);
  }
  const postedAt = new Date().toISOString();
  try {
    writeKeyRecord(key);
  } catch (error) {
    notes.push(error instanceof FolderSyncError
      ? `${writeErrorText('The repeat check', error)}, so a repeat of this key may post again.`
      : `The repeat check could not be saved (${error instanceof Error ? error.message : String(error)}), so a repeat of this key would post again.`);
  }
  if (inMain) {
    const answered = await beforeDeadline(recordOwnerMessageKey(key, postedAt), Math.max(deadline, Date.now() + KEY_READ_MS));
    const saved = answered === 'lapsed' ? { kind: 'unknown' as const, cause: 'the database did not answer in time' } : answered;
    if (saved.kind === 'not-saved') {
      notes.push(`The repeat check could not be saved in the bot's main database (${saved.cause}), so a repeat of this key would post again after the main database moves to another machine.`);
    } else if (saved.kind === 'unknown') {
      notes.push(`can't confirm whether the repeat check was saved in the bot's main database (${saved.cause}), so a repeat of this key may post again after the main database moves to another machine.`);
    }
  }
  return { status: 200, body: { success: true, posted: true, place: inDm ? 'dm' : 'channel', ...(notes.length > 0 ? { note: notes.join(' ') } : {}) } };
}

/** Contract 7's message, posted once per key: requests of one key run in line, within the budget set here. */
export function postOwnerMessage(msg: { text: string; key: string }, budgetMs: number): Promise<Answer> {
  const deadline = Date.now() + budgetMs;
  return inLine(`key:${msg.key}`, deadline, KEY_BUSY, () => notifyOwner(msg.text, msg.key, deadline));
}

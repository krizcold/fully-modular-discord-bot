// Manager-facing surface. It takes the per-instance token both sides already hold;
// the browser's routes are authenticated at the deployment boundary instead.

import crypto from 'crypto';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import { addressesTiming, type BotManager } from '../botManager';
import { resolveDataBackend } from '../../utils/envLoader';
import { checkAddressList } from '../../utils/databaseAddress';
import { checkMemoryReading, refusedLine } from '../../utils/memoryReading';
import { atomicWriteFileSync } from '../../bot/internalSetup/utils/atomicWrite';
import { decideMain } from '../../bot/internalSetup/utils/dataBackends/mainDatabase';
import {
  channelCause, discordWords, hashNonce, noticeEmbed, pinMessage, placeWords, postInPlace, readNoticesIn, unpinMessages,
  type Notice, type OwnerPlace, type RequestFailureInfo,
} from '../../utils/ownerMessages';
import {
  noteChannelPosted, noteChannelRefusal, ownerMessagesFile, readOwnerChannelSetting, readOwnerMessageKey, recordOwnerMessageKey,
} from '../utils/ownerChannel';
import { unknownStoreWords, webuiChoiceDeps } from '../utils/webuiDataReader';
import { DEFAULT_MAINTENANCE_MESSAGE } from '../../bot/internalSetup/utils/maintenanceGate';
import { MAINTENANCE_MESSAGE_MAX, readMaintenanceFile, writeMaintenanceFile } from '../../utils/maintenanceFile';
import { MigrationService } from '../../bot/internalSetup/utils/dataMigration';

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Compare a fixed-width digest so the length itself is not an oracle.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest(),
  );
}

/**
 * An unset token means NO manager owns this instance (a hand deployment), and
 * an empty expected value must never turn into an open door: refuse everything.
 */
function requireManagerToken(req: Request, res: Response, next: NextFunction): void {
  const expected = (process.env.BOT_MANAGER_UPDATE_TOKEN || '').trim();
  if (!expected) {
    res.status(403).json({ success: false, error: 'this instance is not managed; no manager token is configured' });
    return;
  }
  const given = String(req.headers['x-bot-token'] || '').trim();
  if (!given || !tokensMatch(given, expected)) {
    res.status(403).json({ success: false, error: 'invalid manager token' });
    return;
  }
  next();
}

// ============================================================================
// OWNER MESSAGES (NB5 decisions 14 and 15) AND THE ADDRESSES HOOK (decision 22)
// ============================================================================

const managedTiming = { notifyMs: 20_000, switchMs: 25_000 };

/** Tests shorten the routes' budgets and the addresses ack bound; null restores them. */
export function _setManagedTiming(over: { notifyMs?: number; switchMs?: number; addressesAckMs?: number } | null): void {
  managedTiming.notifyMs = over?.notifyMs ?? 20_000;
  managedTiming.switchMs = over?.switchMs ?? 25_000;
  addressesTiming.ackMs = over?.addressesAckMs ?? 5_000;
}

const RECORD_KEYS_MAX = 1000;
const RECORD_DAYS = 90;
const KEY_READ_MS = 5_000;
const FILE_BOT = 'This bot keeps its data in files, so it has no main database';

type KeyRecord = { keys: Record<string, string> };

function readKeyRecord(): { ok: true; record: KeyRecord } | { ok: false; cause: string } {
  let text: string;
  try {
    text = fs.readFileSync(ownerMessagesFile(), 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') return { ok: true, record: { keys: {} } };
    return { ok: false, cause: typeof code === 'string' ? code : error instanceof Error ? error.message : String(error) };
  }
  try {
    const parsed = JSON.parse(text) as { keys?: unknown };
    const keys = parsed?.keys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.values(keys).some(v => typeof v !== 'string')) {
      return { ok: false, cause: 'it holds no record of keys' };
    }
    return { ok: true, record: { keys: { ...(keys as Record<string, string>) } } };
  } catch (error) {
    return { ok: false, cause: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Records a posted key: at most 1000 keys and none older than 90 days, the oldest first to go. The file is read again
 * here, since requests with other keys post and record while this one ran.
 */
function writeKeyRecord(key: string): void {
  const now = Date.now();
  const current = readKeyRecord();
  if (!current.ok) throw new Error(current.cause);
  const keys = { ...current.record.keys, [key]: new Date(now).toISOString() };
  const kept = Object.entries(keys)
    .filter(([, at]) => now - Date.parse(at) <= RECORD_DAYS * 86_400_000)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, RECORD_KEYS_MAX);
  atomicWriteFileSync(ownerMessagesFile(), JSON.stringify({ keys: Object.fromEntries(kept) }, null, 2));
}

interface Answer {
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
async function inLine(key: string, deadline: number, busy: string, work: () => Promise<Answer>): Promise<Answer> {
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
const SWITCH_BUSY = 'Another switch notice is still being posted; try again';
const KEY_LAPSED = 'This request waited for an earlier request for this key and ran out of time; nothing was posted; try again';
const SWITCH_LAPSED = 'This switch notice waited for an earlier one and ran out of time; nothing was posted; try again';

/** The step's answer, or 'lapsed' once the deadline set at the request's arrival passed first. */
async function beforeDeadline<T>(step: Promise<T>, deadline: number): Promise<T | 'lapsed'> {
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<'lapsed'>(resolve => { timer = setTimeout(() => resolve('lapsed'), Math.max(0, deadline - Date.now())); });
  try {
    return await Promise.race([step, lapsed]);
  } finally {
    clearTimeout(timer);
  }
}

const lapsedAnswer = (busy: string): Answer => ({ status: 503, body: { success: false, error: busy } });

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
    notes.push(`The repeat check could not be saved (${error instanceof Error ? error.message : String(error)}), so a repeat of this key would post again.`);
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

/** Decision 15's checks of the body; null when it is valid. */
function switchBody(body: any): { notice: Notice } | null {
  const machine = body?.machine;
  if (typeof machine !== 'string' || machine.length < 1 || machine.length > 256) return null;
  const raw = body?.generation;
  const generation = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  const date = body?.date;
  if (typeof date !== 'string' || !date.endsWith('Z') || Number.isNaN(Date.parse(date))) return null;
  return { notice: { machine, generation, date } };
}

const SWITCH_REFUSED = (words: string) => `Discord refused the switch notice to the bot's owner (${words}). A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again.`;

async function switchNotice(notice: Notice, deadline: number): Promise<Answer> {
  const deps = webuiChoiceDeps();
  const answers = await beforeDeadline(deps.probe(deps.entries()), deadline);
  if (answers === 'lapsed') return lapsedAnswer(SWITCH_LAPSED);
  let markerStoreId: string | null;
  try {
    markerStoreId = deps.markerStoreId();
  } catch (error) {
    return { status: 409, body: { success: false, error: `can't confirm the main database: ${unknownStoreWords(error)}; no notice was posted` } };
  }
  const decision = decideMain(answers, { kind: 'none' }, { markerStoreId, noticeCheckOff: deps.noticeCheckOff() });
  if (decision.outcome !== 'chosen') {
    const reason = decision.outcome === 'needs-notice' ? 'the switch notices were not read' : decision.reason;
    return { status: 409, body: { success: false, error: `can't confirm the main database: ${reason}; no notice was posted` } };
  }
  if (decision.generation !== notice.generation || decision.machine !== notice.machine) {
    return {
      status: 409,
      body: { success: false, error: `The databases this bot reaches hold generation ${decision.generation} (${decision.machine ?? 'no machine named'}) as the main, not ${notice.generation} (${notice.machine}); no notice was posted` },
    };
  }
  const main = answers.find(a => a.kind === 'answered' && a.entry === decision.chosen.entry);
  const ownerChannel = main?.ownerChannel ?? { kind: 'none' as const };

  const notes: string[] = [];
  let posted = false;
  let pinned: boolean | undefined;
  const existing = await readNoticesIn({ kind: 'dm' }, deadline);
  if (existing.ok && existing.best && existing.best.generation >= notice.generation) {
    if (!existing.best.pinned) await pinMessage(existing.channel, existing.best.messageId, deadline);
    notes.push(`A switch notice of generation ${existing.best.generation} (${existing.best.machine}) is already posted; this one was not posted.`);
  } else {
    if (Date.now() >= deadline) return lapsedAnswer(SWITCH_LAPSED);
    const post = await postInPlace({ kind: 'dm' }, { embeds: [noticeEmbed(notice)] }, `smdb-main-${notice.generation}`, deadline);
    if (!post.ok) {
      if (post.failure.timeout) {
        return { status: 502, body: { success: false, unknown: true, error: "can't confirm whether the notice was posted: Discord did not answer within 25 s" } };
      }
      if (post.failure.unconfirmed) {
        return { status: 502, body: { success: false, unknown: true, error: `can't confirm whether the notice was posted: ${post.failure.cause}` } };
      }
      return { status: 502, body: { success: false, error: SWITCH_REFUSED(discordWords(post.failure)) } };
    }
    if (post.channelId !== post.askedChannel) {
      return { status: 502, body: { success: false, error: SWITCH_REFUSED(`Discord returned a message in channel ${post.channelId} instead`) } };
    }
    posted = true;
    const pinFailure = await pinMessage(post.channelId, post.messageId, deadline);
    pinned = pinFailure === null;
    if (pinFailure) {
      notes.push(`Posted, but not pinned (${pinFailure.cause}); a machine that comes back after more than 100 later messages in that conversation will not find it`);
    } else if (existing.ok) {
      const older = existing.pinned.filter(n => n.generation < notice.generation).map(n => n.messageId);
      await unpinMessages(post.channelId, older, deadline);
    }
  }

  let channel: 'posted' | 'already' | 'none' | 'failed' = 'none';
  if (ownerChannel.kind === 'unreadable') {
    channel = 'failed';
    notes.push(`The notice is in the owner's DMs, but its copy in the chosen channel was not posted (${ownerChannel.cause})`);
  } else if (ownerChannel.kind === 'id') {
    const id = ownerChannel.id;
    const failed = (cause: string) => {
      channel = 'failed';
      notes.push(`The notice is in the owner's DMs, but its copy in channel ${id} was not posted (${cause})`);
    };
    if (Date.now() >= deadline) failed(`the route's budget of 25 s ran out`);
    else {
      const there = await readNoticesIn({ kind: 'channel', id }, deadline);
      if (there.ok && there.best && there.best.generation >= notice.generation) channel = 'already';
      else {
        const copy = await postInPlace({ kind: 'channel', id }, { embeds: [noticeEmbed(notice)] }, hashNonce(`copy:${id}:${notice.generation}`), deadline);
        if (!copy.ok) {
          if (copy.failure.timeout) {
            channel = 'failed';
            notes.push(`can't confirm whether the copy in channel ${id} was posted: Discord did not answer in time`);
          } else if (copy.failure.unconfirmed) {
            channel = 'failed';
            notes.push(`can't confirm whether the copy in channel ${id} was posted: ${copy.failure.cause}`);
          } else {
            const cause = channelCause(copy.failure);
            noteChannelRefusal(id, cause);
            failed(`${discordWords(copy.failure)}: ${cause}`);
          }
        } else if (copy.channelId !== id) {
          failed(`Discord returned a message in ${await placeWords(copy.channelId, deadline)} instead of a copy in channel ${id}`);
        } else {
          channel = 'posted';
          noteChannelPosted(id);
        }
      }
    }
  }
  return {
    status: 200,
    body: { success: true, posted, ...(pinned !== undefined ? { pinned } : {}), channel, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) },
  };
}

export function createManagedRoutes(botManager: BotManager, migration: MigrationService = new MigrationService(botManager)): Router {
  const router = Router();
  router.use(requireManagerToken);

  // Contract 9: the data migration. The POST answers within 5 seconds; the job runs on behind it.
  router.post('/migrate', async (req: Request, res: Response) => {
    const answer = await migration.post(req.body);
    res.status(answer.status).json(answer.body);
  });

  router.get('/migrate', (_req: Request, res: Response) => {
    const answer = migration.status();
    res.status(answer.status).json(answer.body);
  });

  // Contract 1: the state is saved first; entering, the bot process then saves what it holds; leaving, the bot process
  // saves what it holds and asks for its restart once nothing is held.
  router.post('/maintenance', async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { state?: unknown; message?: unknown };
    const { state, message } = body;
    if (state !== 'running' && state !== 'maintenance') {
      res.status(400).json({ success: false, error: "state must be 'running' or 'maintenance'" });
      return;
    }
    if (message !== undefined && typeof message !== 'string') {
      res.status(400).json({ success: false, error: 'message must be a string' });
      return;
    }
    if (typeof message === 'string' && message.length > MAINTENANCE_MESSAGE_MAX) {
      res.status(400).json({ success: false, error: `message must be at most ${MAINTENANCE_MESSAGE_MAX} characters` });
      return;
    }
    const running = botManager.migrationRunning?.();
    if (state === 'running' && running) {
      res.status(409).json({ success: false, error: `A data migration is running (migration ${running.jobId}); the bot stays in maintenance until it ends` });
      return;
    }
    const before = readMaintenanceFile();
    const given = typeof message === 'string' && message.trim() !== '' ? message : null;
    // Leaving keeps the saved message, which a later refused database login shows.
    const text = given ?? (state === 'running' ? before.message : DEFAULT_MAINTENANCE_MESSAGE);
    try {
      writeMaintenanceFile(state, text);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      console.error(`[Maintenance] The maintenance state could not be saved: ${cause}`);
      res.status(500).json({ success: false, error: `The maintenance state could not be saved: ${cause}` });
      return;
    }
    if (state === 'maintenance') {
      const result = await botManager.enterMaintenance(text);
      res.json({ success: true, state, ...result });
      return;
    }
    if (before.state === 'running' && botManager.isServingNormally()) {
      res.json({ success: true, state, restarting: false, note: 'The bot is already running.' });
      return;
    }
    console.log('[Maintenance] Leaving maintenance: asking the bot process to save what it holds and restart');
    const result = await botManager.leaveMaintenance();
    res.json({ success: true, state, ...result });
  });

  // Contract 7: a message for the bot's owner, posted once per key.
  router.post('/notify-owner', async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { text?: unknown; key?: unknown };
    const { text, key } = body;
    if (typeof text !== 'string' || text.length < 1 || text.length > 2000) {
      res.status(400).json({ success: false, error: 'text must be a string of 1 to 2000 characters' });
      return;
    }
    if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
      res.status(400).json({ success: false, error: 'key must be a string of 1 to 200 characters' });
      return;
    }
    const deadline = Date.now() + managedTiming.notifyMs;
    const answer = await inLine(`key:${key}`, deadline, KEY_BUSY, () => notifyOwner(text, key, deadline));
    res.status(answer.status).json(answer.body);
  });

  // Contract 5: the switch notice, posted only for a generation a database holds.
  router.post('/switch-notice', async (req: Request, res: Response) => {
    const parsed = switchBody(req.body);
    if (!parsed) {
      res.status(400).json({ success: false, error: 'machine must be 1 to 256 characters, generation a whole number of at least 1, and date an ISO 8601 UTC time ending in Z' });
      return;
    }
    if (resolveDataBackend() !== 'postgres') {
      res.status(409).json({ success: false, error: FILE_BOT });
      return;
    }
    const deadline = Date.now() + managedTiming.switchMs;
    const answer = await inLine('switch', deadline, SWITCH_BUSY, () => switchNotice(parsed.notice, deadline));
    res.status(answer.status).json(answer.body);
  });

  // NB5 decision 22: the list of database addresses the bot process uses from now on.
  router.post('/addresses', async (req: Request, res: Response) => {
    const url = (req.body as { url?: unknown } | undefined)?.url;
    const value = typeof url === 'string' ? url.trim() : '';
    const error = value === '' ? 'url must be a non-empty string' : checkAddressList(value);
    if (error) {
      res.status(400).json({ success: false, error });
      return;
    }
    if (resolveDataBackend() !== 'postgres') {
      res.status(409).json({ success: false, error: FILE_BOT });
      return;
    }
    const answer = await botManager.applyAddressList(value);
    res.status(answer.status).json(answer.body);
  });

  // NB9 19, 37 and 51: the manager's memory reading, kept by the web UI process and pushed to the bot process.
  router.post('/memory', (req: Request, res: Response) => {
    const refused = checkMemoryReading(req.body);
    if (refused) {
      console.warn(refusedLine(refused));
      res.status(400).json({ success: false, error: refused });
      return;
    }
    const body = req.body as { room: boolean | null; useMb: number | null; freeMb: number | null; at: string; error?: string };
    botManager.noteMemoryReading({
      room: body.room, useMb: body.useMb, freeMb: body.freeMb, at: body.at,
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    });
    res.json({ success: true });
  });

  return router;
}

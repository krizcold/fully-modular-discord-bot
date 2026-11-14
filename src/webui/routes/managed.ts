// Manager-facing surface. It takes the per-instance token both sides already hold;
// the browser's routes are authenticated at the deployment boundary instead.

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { addressesTiming, type BotManager } from '../botManager';
import { resolveDataBackend } from '../../utils/envLoader';
import { checkAddressList } from '../../utils/databaseAddress';
import { checkMemoryReading, refusedLine } from '../../utils/memoryReading';
import { FolderSyncError, writeErrorText } from '../../bot/internalSetup/utils/folderChain';
import { decideMain } from '../../bot/internalSetup/utils/dataBackends/mainDatabase';
import {
  channelCause, discordWords, hashNonce, machineList, machinesAt, namesOf, noticeEmbed, pinMessage, placeWords, postInPlace,
  readNoticesIn, sortedMachines, unpinMessages,
  type FoundNotice, type Notice, type RequestFailureInfo,
} from '../../utils/ownerMessages';
import { noteChannelPosted, noteChannelRefusal } from '../utils/ownerChannel';
import { beforeDeadline, inLine, lapsedAnswer, postOwnerMessage, type Answer } from '../utils/ownerNotify';
import { unknownStoreWords, webuiChoiceDeps } from '../utils/webuiDataReader';
import { DEFAULT_MAINTENANCE_MESSAGE } from '../../bot/internalSetup/utils/maintenanceGate';
import { MAINTENANCE_MESSAGE_MAX, readMaintenanceFile, writeMaintenanceFile } from '../../utils/maintenanceFile';
import { MigrationService } from '../../bot/internalSetup/utils/dataMigration';
import { gateWriteText, restoreGate } from '../backups/restoreState';

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

/** Tests shorten the routes' budgets and the addresses ack bound; null restores them. Each call forgets the tie copies. */
export function _setManagedTiming(over: { notifyMs?: number; switchMs?: number; addressesAckMs?: number } | null): void {
  tieCopies.clear();
  managedTiming.notifyMs = over?.notifyMs ?? 20_000;
  managedTiming.switchMs = over?.switchMs ?? 25_000;
  addressesTiming.ackMs = over?.addressesAckMs ?? 5_000;
}

const FILE_BOT = 'This bot keeps its data in files, so it has no main database';

const SWITCH_BUSY = 'Another switch notice is still being posted; try again';
const SWITCH_LAPSED = 'This switch notice waited for an earlier one and ran out of time; nothing was posted; try again';

/** Decision 15's checks of the body; null when it is valid. */
function switchBody(body: any): { notice: Notice; repeat: boolean } | null {
  const machine = body?.machine;
  if (typeof machine !== 'string' || machine.length < 1 || machine.length > 256) return null;
  const raw = body?.generation;
  const generation = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  const date = body?.date;
  if (typeof date !== 'string' || !date.endsWith('Z') || Number.isNaN(Date.parse(date))) return null;
  const repeat = body?.repeat;
  if (repeat !== undefined && typeof repeat !== 'boolean') return null;
  return { notice: { machine, generation, date }, repeat: repeat === true };
}

const SWITCH_NOT_SENT = (cause: string) => `The switch notice to the bot's owner was not sent (${cause}); nothing was posted. A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again.`;
const SWITCH_REFUSED = (words: string) => `Discord refused the switch notice to the bot's owner (${words}). A machine whose database was the main will not learn from Discord that it was replaced: keep it off, or rejoin it as a live copy, before it starts again.`;
const BUDGET_GONE = "the route's budget of 25 s ran out";
const ANOTHER_MESSAGE = 'Discord returned another message instead';
const PIN_LATER = 'a machine that comes back after more than 100 later messages in that conversation will not find it';

/** The cause of a create that was never sent (NB24 decision 7). */
const unsentCause = (failure: RequestFailureInfo) => (failure.lapsed ? BUDGET_GONE : failure.cause);

type ChannelOutcome = 'posted' | 'already' | 'none' | 'failed';

const TIE_COPIES_MAX = 1000;
/** Tie copies this process posted, by channel, generation and machine: a repeat or a failed read does not post again. */
const tieCopies = new Set<string>();

type OwnerChannel = { kind: 'none' } | { kind: 'id'; id: string } | { kind: 'unreadable'; cause: string };

/**
 * The copy in the chosen channel (decision 23): `others` given, the tie copy (NB24). A copy of this machine at the
 * generation, or any notice above it, is already there.
 */
async function copyStep(ownerChannel: OwnerChannel, notice: Notice, others: string[] | null, repeat: boolean, deadline: number, notes: string[]): Promise<ChannelOutcome> {
  if (ownerChannel.kind === 'none') return 'none';
  if (ownerChannel.kind === 'unreadable') {
    notes.push(`The notice is in the owner's DMs, but its copy in the chosen channel was not posted (${ownerChannel.cause})`);
    return 'failed';
  }
  const id = ownerChannel.id;
  const failed = (cause: string): ChannelOutcome => {
    notes.push(`The notice is in the owner's DMs, but its copy in channel ${id} was not posted (${cause})`);
    return 'failed';
  };
  if (Date.now() >= deadline) return failed(BUDGET_GONE);
  const there = await readNoticesIn({ kind: 'channel', id }, deadline);
  const mine = (n: FoundNotice) => n.generation > notice.generation
    || (n.generation === notice.generation && n.machine === notice.machine && (others === null || n.tie));
  if (there.ok && there.found.some(mine)) return 'already';
  const tieKey = JSON.stringify([id, notice.generation, notice.machine]);
  if (others !== null && (!there.ok || (repeat && there.messages === 0)) && tieCopies.has(tieKey)) {
    let shown: string;
    if (there.ok) {
      shown = 'the channel shows the bot no messages (it may lack Read Message History there)';
    } else {
      shown = `the channel could not be read (${unsentCause(there.failure)})`;
      if (there.failure.status === 403 || there.failure.status === 404) noteChannelRefusal(id, channelCause(there.failure));
    }
    notes.push(`can't confirm that the copy in channel ${id} of the notice saying that two machines announced generation ${notice.generation} is still there: ${shown}; this web UI process posted it earlier and did not post it again`);
    return 'already';
  }
  const parts = others === null ? ['copy', id, notice.generation, notice.machine] : ['copy', id, notice.generation, notice.machine, 'tie'];
  const copy = await postInPlace({ kind: 'channel', id }, { embeds: [noticeEmbed(notice, others ?? undefined)] }, hashNonce(JSON.stringify(parts)), deadline);
  if (!copy.ok) {
    if (!copy.sent) return failed(unsentCause(copy.failure));
    if (copy.failure.timeout) {
      notes.push(`can't confirm whether the copy in channel ${id} was posted: Discord did not answer in time`);
      return 'failed';
    }
    if (copy.failure.unconfirmed) {
      notes.push(`can't confirm whether the copy in channel ${id} was posted: ${copy.failure.cause}`);
      return 'failed';
    }
    const cause = channelCause(copy.failure);
    noteChannelRefusal(id, cause);
    return failed(`${discordWords(copy.failure)}: ${cause}`);
  }
  if (copy.channelId !== id) {
    return failed(`Discord returned a message in ${await placeWords(copy.channelId, deadline)} instead of a copy in channel ${id}`);
  }
  noteChannelPosted(id);
  if (others !== null) {
    if (tieCopies.size >= TIE_COPIES_MAX) tieCopies.delete(tieCopies.values().next().value as string);
    tieCopies.add(tieKey);
  }
  return 'posted';
}

type DmRead = { channel: string; found: FoundNotice[]; pinned: Array<{ messageId: string; generation: number }> };
type TieCreate = { kind: 'refused'; cause: string } | { kind: 'unconfirmed'; cause: string } | { kind: 'other'; other: string };

async function switchNotice(notice: Notice, repeat: boolean, deadline: number): Promise<Answer> {
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

  const machine = notice.machine;
  const g = notice.generation;
  const notes: string[] = [];
  const existing = await readNoticesIn({ kind: 'dm' }, deadline);
  if (!existing.ok && repeat) {
    return { status: 503, body: { success: false, error: `The switch notices could not be read (${unsentCause(existing.failure)}); nothing was posted` } };
  }
  const othersAt = (found: FoundNotice[]) => machinesAt(found, g).some(m => m !== machine);

  const done = async (posted: boolean, extra: Record<string, unknown> = {}): Promise<Answer> => {
    const channel = repeat ? null : await copyStep(ownerChannel, notice, null, false, deadline, notes);
    return {
      status: 200,
      body: { success: true, posted, ...extra, ...(channel !== null ? { channel } : {}), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) },
    };
  };

  const tieAnswer = (named: string[], clause: (end: string) => string, fields: { posted: boolean | null; present: boolean | null; pinned: boolean; channel: ChannelOutcome }): Answer => {
    const machines = sortedMachines([...named, machine]);
    const one = named.length === 1 ? named[0] : null;
    const end = one === null ? '.' : `, so the bot on ${one} may still be writing.`;
    const closing = one === null
      ? "The bot stops on every machine that reads the switch notices, until the owner presses Keep this machine as the main in one machine's Bot Manager"
      : `The bot on ${machine} stops at its next read of the switch notices; the bot on ${one} stops only once a notice for ${machine} is in the owner's DMs, and the next switch-notice call for generation ${g} tries again`;
    return {
      status: 409,
      body: {
        success: false,
        error: `${machineList(machines)} announced main generation ${g}; can't confirm which is the main. ${clause(end)} ${closing}`,
        tie: { generation: g, machines, named }, ...fields, ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      },
    };
  };

  const tieCopySkipped = (unconfirmed: boolean): ChannelOutcome => {
    if (ownerChannel.kind === 'none') return 'none';
    const where = ownerChannel.kind === 'id' ? `channel ${ownerChannel.id}` : 'the chosen channel';
    notes.push(unconfirmed
      ? `The copy in ${where} of the notice saying that two machines announced generation ${g} was not posted: can't confirm that the notice is in the owner's DMs`
      : `The copy in ${where} of the notice saying that two machines announced generation ${g} was not posted: the notice is not in the owner's DMs`);
    return 'failed';
  };

  const pinNote = (cause: string, postedNow: boolean) => notes.push(postedNow
    ? `Posted, but not pinned (${cause}); ${PIN_LATER}`
    : `The notice for ${machine} is in the owner's DMs but not pinned (${cause}); ${PIN_LATER}`);

  // NB24 decision 6 step 3: another machine announced this generation.
  const tieStep = async (read: DmRead, ownPosted: string | null): Promise<Answer> => {
    const atG = read.found.filter(n => n.generation === g);
    const named = new Set(machinesAt(read.found, g));
    if (ownPosted !== null) named.add(machine);
    const foundTie = atG.find(n => n.machine === machine && n.tie) ?? null;
    const foundOrdinary = atG.find(n => n.machine === machine && !n.tie) ?? null;
    let ordinary = ownPosted !== null
      ? { messageId: ownPosted, pinned: read.found.find(n => n.messageId === ownPosted)?.pinned ?? false, postedNow: true }
      : foundOrdinary ? { messageId: foundOrdinary.messageId, pinned: foundOrdinary.pinned, postedNow: false } : null;
    const others = sortedMachines([...named].filter(m => m !== machine));
    let tie = foundTie ? { messageId: foundTie.messageId, pinned: foundTie.pinned, postedNow: false } : null;
    let create: TieCreate | null = null;
    if (!tie) {
      const post = await postInPlace({ kind: 'dm' }, { embeds: [noticeEmbed(notice, others)] }, hashNonce(JSON.stringify(['main', g, machine, 'tie'])), deadline);
      if (!post.ok) {
        if (!post.sent) create = { kind: 'refused', cause: unsentCause(post.failure) };
        else if (post.failure.timeout || post.failure.unconfirmed) create = { kind: 'unconfirmed', cause: post.failure.cause };
        else create = { kind: 'refused', cause: `Discord refused it: ${discordWords(post.failure)}` };
      } else {
        const returned = post.channelId === post.askedChannel ? post.notice ?? null : null;
        if (returned && returned.generation === g && returned.machine === machine && returned.tie) {
          tie = { messageId: post.messageId, pinned: false, postedNow: true };
          named.add(machine);
        } else {
          if (returned && returned.generation === g) for (const m of namesOf(returned)) named.add(m);
          if (ordinary === null && returned && returned.generation === g && returned.machine === machine && !returned.tie) {
            ordinary = { messageId: post.messageId, pinned: false, postedNow: false };
          }
          create = returned && returned.generation === g && returned.machine !== machine
            ? { kind: 'other', other: returned.machine }
            : { kind: 'refused', cause: ANOTHER_MESSAGE };
        }
      }
    }

    let pinned = false;
    let lastPinFailure: { cause: string; postedNow: boolean } | null = null;
    for (const own of [tie, ordinary]) {
      if (pinned || own === null) continue;
      if (own.pinned) { pinned = true; continue; }
      const failure = await pinMessage(read.channel, own.messageId, deadline);
      if (failure === null) pinned = true;
      else lastPinFailure = { cause: unsentCause(failure), postedNow: own.postedNow };
    }
    if (pinned) {
      await unpinMessages(read.channel, read.pinned.filter(n => n.generation < g).map(n => n.messageId), deadline);
    } else if (lastPinFailure) {
      pinNote(lastPinFailure.cause, lastPinFailure.postedNow);
    }
    if (tie === null && ordinary !== null && create !== null) {
      notes.push(create.kind === 'unconfirmed'
        ? `can't confirm whether the notice saying that two machines announced generation ${g} was posted: ${create.cause}`
        : `The notice saying that two machines announced generation ${g} was not posted (${create.kind === 'other' ? ANOTHER_MESSAGE : create.cause}); the next switch-notice call for generation ${g} tries again`);
    }
    const channel: ChannelOutcome = tie !== null
      ? await copyStep(ownerChannel, notice, others, repeat, deadline, notes)
      : tieCopySkipped(create?.kind === 'unconfirmed');

    const postedNow = ownPosted !== null || tie?.postedNow === true;
    const there = ordinary !== null || tie !== null;
    const unconfirmed = create?.kind === 'unconfirmed';
    const clause = (end: string): string => {
      if (postedNow) return `The notice for ${machine} was posted.`;
      if (there) return `The notice for ${machine} was already posted.`;
      if (create?.kind === 'other') return `Discord answered with the notice of ${create.other} instead of posting one for ${machine}${end}`;
      if (create?.kind === 'unconfirmed') return `Whether the notice for ${machine} was posted can't be confirmed (${create.cause})${end}`;
      return `The notice for ${machine} was not posted (${create?.cause ?? ANOTHER_MESSAGE})${end}`;
    };
    return tieAnswer(sortedMachines(named), clause, {
      posted: postedNow ? true : unconfirmed ? null : false,
      present: there ? true : unconfirmed ? null : false,
      pinned,
      channel,
    });
  };

  // Step 4's pin of the notice just posted, then the unpin of older generations (today's).
  const pinPosted = async (channel: string, messageId: string, older: DmRead['pinned']): Promise<boolean> => {
    const failure = await pinMessage(channel, messageId, deadline);
    if (failure) {
      pinNote(unsentCause(failure), true);
      return false;
    }
    await unpinMessages(channel, older.filter(n => n.generation < g).map(n => n.messageId), deadline);
    return true;
  };

  if (existing.ok && existing.best && existing.best.generation >= g) {
    const best = existing.best;
    if (best.generation === g && othersAt(existing.found)) return tieStep(existing, null);
    if (!best.pinned) await pinMessage(existing.channel, best.messageId, deadline);
    notes.push(`A switch notice of generation ${best.generation} (${best.machine}) is already posted; this one was not posted.`);
    return done(false, best.generation > g ? { newer: { generation: best.generation, machines: machinesAt(existing.found, best.generation) } } : {});
  }

  if (Date.now() >= deadline) return lapsedAnswer(SWITCH_LAPSED);
  const post = await postInPlace({ kind: 'dm' }, { embeds: [noticeEmbed(notice)] }, hashNonce(JSON.stringify(['main', g, machine])), deadline);
  if (!post.ok) {
    if (!post.sent) return { status: 502, body: { success: false, error: SWITCH_NOT_SENT(unsentCause(post.failure)) } };
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
  const returned = post.notice ?? null;
  if (returned && returned.generation === g && returned.machine !== machine) {
    const named = sortedMachines([...(existing.ok ? machinesAt(existing.found, g) : []), ...namesOf(returned)]);
    return tieAnswer(named, end => `Discord answered with the notice of ${returned.machine} instead of posting one for ${machine}${end}`,
      { posted: false, present: false, pinned: false, channel: tieCopySkipped(false) });
  }
  if (!returned || returned.generation !== g || returned.machine !== machine || returned.tie) {
    return { status: 502, body: { success: false, error: SWITCH_REFUSED(ANOTHER_MESSAGE) } };
  }

  // Decision 8: the DM read again before any pin, so two machines that posted at once find each other.
  const again = await readNoticesIn({ kind: 'dm' }, deadline);
  if (!again.ok) {
    notes.push(`Posted, but whether another machine also announced generation ${g} can't be confirmed: the notices could not be read again (${unsentCause(again.failure)})`);
    const pinned = await pinPosted(post.channelId, post.messageId, existing.ok ? existing.pinned : []);
    return done(true, { pinned, tieChecked: false });
  }
  if (again.best && again.best.generation > g) {
    const newer = { generation: again.best.generation, machines: machinesAt(again.found, again.best.generation) };
    notes.push(`Posted, but a switch notice of generation ${newer.generation} (${machineList(newer.machines)}) is already in the owner's DMs`);
    const pinned = await pinPosted(post.channelId, post.messageId, again.pinned);
    return done(true, { pinned, newer });
  }
  if (othersAt(again.found)) return tieStep(again, post.messageId);
  const pinned = await pinPosted(post.channelId, post.messageId, again.pinned);
  return done(true, { pinned });
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
    if (state === 'running') {
      const gate = restoreGate();
      if (gate.state !== 'clear') {
        res.status(409).json({ success: false, error: gateWriteText(gate) });
        return;
      }
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
    // A FolderSyncError leaves the new state in the file: the bot follows the file, then the route answers 500.
    let unconfirmed: string | null = null;
    try {
      writeMaintenanceFile(state, text);
    } catch (error) {
      if (!(error instanceof FolderSyncError)) {
        const cause = error instanceof Error ? error.message : String(error);
        console.error(`[Maintenance] The maintenance state could not be saved: ${cause}`);
        res.status(500).json({ success: false, error: `The maintenance state could not be saved: ${cause}` });
        return;
      }
      unconfirmed = writeErrorText('The maintenance state', error);
      console.error(`[Maintenance] ${unconfirmed}`);
    }
    const answer = (fields: Record<string, unknown>) => {
      if (unconfirmed) res.status(500).json({ success: false, state, ...fields, error: unconfirmed });
      else res.json({ success: true, state, ...fields });
    };
    if (state === 'maintenance') {
      answer({ ...(await botManager.enterMaintenance(text)) });
      return;
    }
    if (before.state === 'running' && botManager.isServingNormally()) {
      answer({ restarting: false, note: 'The bot is already running.' });
      return;
    }
    console.log('[Maintenance] Leaving maintenance: asking the bot process to save what it holds and restart');
    answer({ ...(await botManager.leaveMaintenance()) });
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
    const answer = await postOwnerMessage({ text, key }, managedTiming.notifyMs);
    res.status(answer.status).json(answer.body);
  });

  // Contract 5: the switch notice, posted only for a generation a database holds.
  router.post('/switch-notice', async (req: Request, res: Response) => {
    const parsed = switchBody(req.body);
    if (!parsed) {
      res.status(400).json({ success: false, error: 'machine must be 1 to 256 characters, generation a whole number of at least 1, date an ISO 8601 UTC time ending in Z, and repeat, when given, true or false' });
      return;
    }
    if (resolveDataBackend() !== 'postgres') {
      res.status(409).json({ success: false, error: FILE_BOT });
      return;
    }
    const deadline = Date.now() + managedTiming.switchMs;
    const answer = await inLine('switch', deadline, SWITCH_BUSY, () => switchNotice(parsed.notice, parsed.repeat, deadline));
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

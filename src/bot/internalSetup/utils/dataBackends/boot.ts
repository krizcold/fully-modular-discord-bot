// Data-backend boot + dispatch gates. initDataBackendLayer() runs BEFORE
// fleet init so the readiness driver exists when the first lease lands; the
// driver stays HELD until the store-identity verdict clears, so no ownership
// claim can touch a database that turns out to be the wrong one.

import { Guild, MessageFlags } from 'discord.js';
import { DataBackendKind, loadCredentials, resolveDataBackend } from '../../../../utils/envLoader';
import { PostgresBackend, SCHEMA_VERSION } from './postgresBackend';
import { initWorkingSet } from './workingSet';
import type { DataUnavailableCause } from './workingSet';
import { initDataReadiness, getDataReadiness, DataReadinessDriver } from './dataReadiness';
import { evaluateRecognitionGuard, verifyStoreIdentity, readFileMarker, GuardVerdict } from './recognitionGuard';
import { setGuildDataBackend, isClosedForExit, closeGuildWrites, noteGuildDataServing } from '../dataManager';
import { getConfigProperty } from '../configManager';
import { ACK_MS, sweepLateWrites } from './replyGate';
import { saveMark, type SaveMark } from './scopeRecord';
import { ledgerOf, runAdmitted } from './writeLedger';

// Startup barrier bound = the acceptance window: past it something is wrong
// enough that holding clientReady longer helps nobody.
const STARTUP_BARRIER_BOUND_MS = 300_000;
const IDENTITY_RETRY_MS = 5_000;

export interface DataBootStatus {
  mode: DataBackendKind;
  state: 'file' | 'starting' | 'serving' | 'refused';
  refusalReason: string | null;
}

let bootStatus: DataBootStatus = { mode: 'file', state: 'file', refusalReason: null };

export function getDataBootStatus(): DataBootStatus {
  return bootStatus.state === 'refused' ? bootStatus : { ...bootStatus, refusalReason: null };
}

/**
 * Best-effort guildId extraction from a Discord.js event payload. Null when
 * the event has no guild context (DMs, clientReady, etc.) - those pass gates
 * unchanged. Covers {guildId} on Message/Channel/Interaction, {guild:{id}} on
 * GuildMember/Role/GuildBan, voiceStateUpdate's first arg, a MessageReaction's
 * message, a ThreadMember's thread, a PollAnswer's poll, and a Guild itself;
 * no other id is read. The tier gate reads it; the data gate and the metrics
 * read eventGuildId.
 */
export function extractGuildId(args: any[]): string | null {
  return findGuildId(args)?.id ?? null;
}

/**
 * The guild the data gate and the event metrics read: a Guild payload's id is
 * none (guildCreate, guildDelete and the like pass the data gate, and a
 * guildDelete must not record the departed guild again after metricsCleanup).
 */
export function eventGuildId(args: any[]): string | null {
  const found = findGuildId(args);
  return found && !found.fromGuild ? found.id : null;
}

function findGuildId(args: any[]): { id: string; fromGuild: boolean } | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    const direct = (arg as any).guildId;
    if (typeof direct === 'string' && direct) return { id: direct, fromGuild: false };
    const nested = (arg as any).guild?.id;
    if (typeof nested === 'string' && nested) return { id: nested, fromGuild: false };
    const carried = (arg as any).message?.guildId ?? (arg as any).thread?.guildId
      ?? (arg as any).poll?.message?.guildId ?? (arg as any).poll?.channel?.guildId;
    if (typeof carried === 'string' && carried) return { id: carried, fromGuild: false };
    if (arg instanceof Guild && typeof arg.id === 'string' && arg.id) return { id: arg.id, fromGuild: true };
  }
  return null;
}

const SETTING_FIX = 'Gates stay closed; fix DATA_BACKEND/DATA_BACKEND_URL in the web UI env editor';

function refuse(reason: string, mode: DataBackendKind = bootStatus.mode, fix = SETTING_FIX): void {
  bootStatus = { ...bootStatus, mode, state: 'refused', refusalReason: reason };
  closeGuildWrites();
  console.error(`[Data] REFUSING to serve: ${reason}`);
  console.error(`[Data] ${fix}`);
}

/** Called once at boot, before fleet init. Never throws; file mode is a no-op. */
export function initDataBackendLayer(): void {
  let verdict: GuardVerdict;
  try {
    verdict = evaluateRecognitionGuard();
  } catch (error) {
    // An invalid DATA_BACKEND value must refuse (gates closed, web UI up for
    // the fix), never crash-loop the process.
    refuse(error instanceof Error ? error.message : String(error));
    return;
  }
  if (verdict.state === 'refused') {
    refuse(verdict.reason);
    return;
  }
  if (verdict.live === 'file') {
    bootStatus = { ...bootStatus, mode: 'file', state: 'file' };
    return;
  }
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  if (!url) {
    refuse('the live data backend is postgres but DATA_BACKEND_URL is not set', 'postgres');
    return;
  }
  startPostgresRuntime(url);
}

/** The parent's web UI reader follows the store this child serves. */
function reportStore(url: string): void {
  if (!process.send) return;
  try {
    process.send({ type: 'data:store', data: { url } }, () => { /* a closed channel is the parent gone */ });
  } catch { /* the parent reads the database /data/.env names */ }
}

function startPostgresRuntime(url: string): void {
  const backend = new PostgresBackend({ url });
  backend.start();
  reportStore(url);
  bootStatus = { ...bootStatus, mode: 'postgres', state: 'starting' };
  const ws = initWorkingSet(backend);
  setGuildDataBackend(backend);
  void verifyIdentityLoop(url, backend, initDataReadiness(backend, ws, { held: true }));
}

async function verifyIdentityLoop(url: string, backend: PostgresBackend, driver: DataReadinessDriver): Promise<void> {
  // A database of another schema version still carries its store id, so the identity check alone would pass it; a
  // wrong store whose provisioning keeps failing is refused by the identity check, so the two run side by side.
  const run = { schema: 'pending' as 'pending' | 'provisioned' | 'stopped', done: false };
  const provisioning = backend.provisionVerdict().then(verdict => {
    if (verdict.state === 'mismatch') {
      if (run.done) return;
      run.done = true;
      refuse(`the database holds schema version ${verdict.found}, and this bot reads only version ${SCHEMA_VERSION}`, 'postgres',
        'Gates stay closed; point DATA_BACKEND_URL at a database of this bot\'s schema version in the web UI env editor');
      return;
    }
    run.schema = verdict.state;
  });
  const ended = () => run.done || run.schema === 'stopped';
  let identityOk = false;
  let logged = false;
  for (;;) {
    if (ended()) return;
    let askedWhilePending = false;
    if (!identityOk) {
      askedWhilePending = run.schema === 'pending';
      try {
        const verdict = await verifyStoreIdentity(url, run.schema === 'provisioned');
        if (!verdict.ok) {
          // A store still provisioning carries no identity yet (a store
          // mid-restore): waited on like an unreachable one, never refused.
          if (!verdict.pending && !run.done) {
            run.done = true;
            refuse(verdict.reason, 'postgres');
            return;
          }
        } else if (readFileMarker()?.storeId) {
          // Only once the marker holds the store id (minted by the backend's
          // own provisioning): hydration cannot proceed any earlier anyway, and
          // adopting it now makes a later URL swap detectable from the very
          // next boot.
          identityOk = true;
        }
      } catch { /* unreachable; fall through to the retry sleep */ }
      if (ended()) return;
    }
    if (identityOk && run.schema === 'provisioned') {
      run.done = true;
      driver.release();
      bootStatus = { ...bootStatus, state: 'serving' };
      noteGuildDataServing();
      console.log('[Data] Postgres store identity verified; serving');
      return;
    }
    if (!logged) {
      console.warn('[Data] Waiting on the data backend to verify store identity; gates stay closed');
      logged = true;
    }
    // Provisioning passed during that check, so the store id can be adopted now.
    if (!identityOk && askedWhilePending && run.schema === 'provisioned') continue;
    const retry = new Promise<void>(resolve => {
      const t = setTimeout(resolve, IDENTITY_RETRY_MS);
      t.unref();
    });
    await (run.schema === 'pending' ? Promise.race([retry, provisioning]) : retry);
  }
}

/**
 * Startup barrier: holds clientReady dispatch (module fan-out + internal
 * files) until the initial lease set is hydrated, bounded. On timeout the
 * fan-out proceeds and every skipped guild is logged by id - never a silent
 * default-valued sweep.
 */
export async function awaitDataStartupBarrier(): Promise<void> {
  const readiness = getDataReadiness();
  if (!readiness) return;
  const outcome = await readiness.awaitInitialHydration(STARTUP_BARRIER_BOUND_MS);
  if (outcome === 'timeout') {
    const skipped = readiness.unreadyGuilds();
    console.warn(`[Data] Startup barrier timed out after ${STARTUP_BARRIER_BOUND_MS / 1000}s; proceeding with ${skipped.length} owned guild(s) not hydrated`);
    for (const guildId of skipped) {
      console.warn(`[Data] Startup proceeding without guild ${guildId} (working set not ready)`);
    }
  }
}

/** The dispatch gate's answer for a guild action (R1-J2): admit, or the cause that holds it. */
export type GateCause = 'admit' | HoldCause;
export type HoldCause = 'stopping' | 'refused' | 'moved' | 'not-served' | 'loading';
const FINAL_CAUSES = new Set<GateCause>(['stopping', 'refused', 'moved']);
const HOLD_POLL_MS = 50;
/** A panel action's or a console invoke's hold, which no Discord deadline bounds: 2.5 s, as the data route waits. */
export const ENTRY_WAIT_MS = 2500;

/**
 * One reading of the gate for a guild action (notes/BT.md, "R1-J2 design sheet (L0): final"). Every hold reads it
 * afresh at each poll. since is the hold's start.
 */
export function gateCauseNow(guildId: string, since: number): GateCause {
  if (isClosedForExit()) return 'stopping';
  if (bootStatus.state === 'refused') return 'refused';
  const readiness = getDataReadiness();
  if (!readiness || resolveDataBackend() === 'file') return 'admit';
  return readiness.causeOf(guildId, since);
}

/**
 * Holds a guild action until the guild takes writes, a final cause, or deadlineAt (a performance.now() time), where
 * one more reading decides. Admitted, it carries the mark its handler's confirmSaved counts from.
 */
export async function admitGuildAction(guildId: string, deadlineAt: number): Promise<{ cause: 'admit'; mark: SaveMark } | { cause: HoldCause; mark: null }> {
  const since = performance.now();
  for (;;) {
    const cause = gateCauseNow(guildId, since);
    if (cause === 'admit') return { cause, mark: saveMark() };
    const left = deadlineAt - performance.now();
    if (FINAL_CAUSES.has(cause) || left <= 0) return { cause, mark: null };
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(HOLD_POLL_MS, left)));
  }
}

const LOADING_TEXT = "This server's data is still loading, try again in a moment.";
const CAUSE_TEXTS: Record<Exclude<HoldCause, 'loading'>, string> = {
  stopping: 'The bot is stopping; please try again in a moment.',
  refused: "This bot's data storage is currently unavailable; please contact the server operator.",
  moved: "Another bot process took over this server's data; please try again in a moment.",
  'not-served': "This server's data is not served by this bot process right now; please try again in a moment.",
};

/** The member's and the web panel's text for a held action; the loading notice is operator-editable in config.json. */
export function gateCauseText(cause: HoldCause): string {
  return cause === 'loading' ? noticeText('outageNotice.dataLoading', LOADING_TEXT) : CAUSE_TEXTS[cause];
}

/** The console invoke's text for a held action, in its own style. */
export function gateConsoleText(cause: HoldCause, guildId: string): string {
  switch (cause) {
    case 'stopping': return 'the bot is stopping; try again in a moment';
    case 'refused': return "the bot's data storage is unavailable; contact the server operator";
    case 'moved': return `another bot process took over guild ${guildId}'s data; try again in a moment`;
    case 'not-served': return `guild ${guildId}'s data is not served by this bot process right now; try again in a moment`;
    default: return `guild ${guildId}'s data is still loading; try again in a moment`;
  }
}

// One hold per interaction: the internal dispatcher and every module listener await the same one, which sends its
// one refusal. An admitted interaction keeps its admission mark for runAsAdmitted.
const interactionHolds = new WeakMap<object, Promise<GateCause>>();
const admissions = new WeakMap<object, SaveMark>();

function holdInteraction(interaction: any, guildId: string): Promise<GateCause> {
  let hold = interactionHolds.get(interaction);
  if (!hold) {
    hold = (async () => {
      // Counted from the emit, the deadline the reply gate acknowledges by; with no ledger, from now.
      const openedAt = ledgerOf(interaction)?.openedAt ?? performance.now();
      const held = await admitGuildAction(guildId, openedAt + ACK_MS);
      if (held.cause === 'admit') admissions.set(interaction, held.mark);
      else await politeReject(interaction, gateCauseText(held.cause));
      return held.cause;
    })();
    interactionHolds.set(interaction, hold);
  }
  return hold;
}

/** Runs a gated listener's handler from its interaction's admission, so its confirmSaved counts from there. */
export function runAsAdmitted<T>(args: any[], fn: () => T): T {
  const mark = admissions.get(args[0] as object);
  return mark ? runAdmitted(mark, fn) : fn();
}

/**
 * The internal dispatcher's listener (clientInitializer.ts): the gate, the dispatch from the admission, then the reply
 * gate's sweep of the interaction, which the listener does not wait on.
 */
export async function dispatchGated(eventName: string, args: any[], dispatch: (...args: any[]) => Promise<void>): Promise<void> {
  if (!(await gateEventDispatch(eventName, args, () => void dispatch(...args)))) return;
  await runAsAdmitted(args, () => dispatch(...args));
  if (eventName === 'interactionCreate') void sweepLateWrites(args[0]);
}

/**
 * Shared dispatch gate. True = dispatch now. An interaction meets its one hold and, refused, one polite ephemeral
 * reply with the cause - the gate NEVER acks/defers on a handler's behalf. Non-interaction events buffer for replay
 * (or drop when the shard is not leased here and no set is held for the guild; a held frozen or fenced set dispatches
 * them); file-mode guilds pass them through, and so do events whose guild comes
 * from a Guild payload (guildCreate, guildDelete and the like), which only the tier gate reads.
 */
export async function gateEventDispatch(eventName: string, args: any[], replay: () => void): Promise<boolean> {
  if (eventName === 'clientReady') {
    await awaitDataStartupBarrier();
    return true;
  }
  const guildId = eventGuildId(args);
  if (!guildId) return true;
  const first = args[0];
  if (first && typeof first.isRepliable === 'function') return (await holdInteraction(first, guildId)) === 'admit';
  // Unresolvable backend configuration: guild-scoped dispatch stays closed.
  if (bootStatus.state === 'refused') return false;
  const readiness = getDataReadiness();
  if (!readiness || resolveDataBackend() === 'file') return true;
  return readiness.admitEvent(guildId, replay);
}

/**
 * The operator data route's gate (ipcDataHandler): the interaction wait, with the route's own texts. Panel actions
 * and the console invoke hold through admitGuildAction.
 */
export async function awaitGuildDataReady(guildId: string): Promise<boolean> {
  if (bootStatus.state === 'refused') return false;
  const readiness = getDataReadiness();
  if (!readiness || resolveDataBackend() === 'file') return true;
  return readiness.admitInteraction(guildId);
}

/** Config-backed notice text, resolved at reply time so edits apply without restart. */
function noticeText(property: string, fallback: string): string {
  const value = getConfigProperty<string>(property);
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/** User-visible text for a refused write; the database-unreachable notice is operator-editable in config.json. */
export function dataUnavailableMessage(causeKey: DataUnavailableCause): string {
  if (causeKey === 'node-stopping') return 'The bot is restarting, so your change was not saved. Please try again in a moment.';
  if (causeKey === 'storage-failing') return "The bot cannot write to its disk right now, so your change was not saved. Please try again later or contact support.";
  if (causeKey === 'database-backlog') return "The bot's database is behind on saving changes, so your change was not saved. Please try again in a moment.";
  return causeKey === 'guild-fenced'
    ? "Another bot process took over this server's data; please try again in a moment."
    : noticeText('outageNotice.databaseUnreachable', "The bot's database is currently unreachable, so your change was not saved. Please try again later or contact support.");
}

async function politeReject(interaction: any, content: string): Promise<void> {
  try {
    if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
      if (typeof interaction.respond === 'function') await interaction.respond([]).catch(() => { /* expired */ });
      return;
    }
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => { /* expired or already handled */ });
    }
  } catch { /* the gate must never throw into dispatch */ }
}

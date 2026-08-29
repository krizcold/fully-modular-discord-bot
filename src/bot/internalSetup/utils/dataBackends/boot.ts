// Data-backend boot + dispatch gates. initDataBackendLayer() runs BEFORE
// fleet init so the readiness driver exists when the first lease lands; the
// driver stays HELD until the store-identity verdict clears, so no ownership
// claim can touch a database that turns out to be the wrong one.

import { MessageFlags } from 'discord.js';
import { connect } from 'net';
import { DataBackendKind, loadCredentials, setFleetDataBackend, upsertCredentials } from '../../../../utils/envLoader';
import { PostgresBackend } from './postgresBackend';
import { initWorkingSet, getWorkingSet } from './workingSet';
import { initDataReadiness, getDataReadiness, DataReadinessDriver } from './dataReadiness';
import { forceRouteDefault, routeFor, applyRouteOverrides } from './routeResolver';
import { evaluateRecognitionGuard, verifyStoreIdentity, readFileMarker, writeFileMarker, GuardVerdict } from './recognitionGuard';
import { listGuilds } from './fileBackend';
import { setGuildDataBackend, getGuildDataBackend } from '../dataManager';
import { getConfigProperty } from '../configManager';

function hasLocalGuildData(): boolean {
  return listGuilds().length > 0;
}

// Startup barrier bound = the acceptance window: past it something is wrong
// enough that holding clientReady longer helps nobody.
const STARTUP_BARRIER_BOUND_MS = 300_000;
const IDENTITY_RETRY_MS = 5_000;

export interface DataBootStatus {
  mode: DataBackendKind;
  state: 'file' | 'starting' | 'serving' | 'refused';
  banner: string | null;
  refusalReason: string | null;
}

let bootStatus: DataBootStatus = { mode: 'file', state: 'file', banner: null, refusalReason: null };

export function getDataBootStatus(): DataBootStatus {
  return bootStatus;
}

/**
 * Best-effort guildId extraction from a Discord.js event payload. Null when
 * the event has no guild context (DMs, clientReady, etc.) - those pass gates
 * unchanged. Covers {guildId} on Message/Channel/Interaction, {guild:{id}} on
 * GuildMember/Role/GuildBan, and voiceStateUpdate's first arg.
 */
export function extractGuildId(args: any[]): string | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    const direct = (arg as any).guildId;
    if (typeof direct === 'string' && direct) return direct;
    const nested = (arg as any).guild?.id;
    if (typeof nested === 'string' && nested) return nested;
  }
  return null;
}

function refuse(reason: string): void {
  bootStatus = { ...bootStatus, state: 'refused', refusalReason: reason };
  console.error(`[Data] REFUSING to serve: ${reason}`);
  console.error('[Data] Gates stay closed; fix DATA_BACKEND/DATA_BACKEND_URL in the web UI env editor or run the backend transformation');
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
  const live = verdict.live;
  if (verdict.state === 'transformation-required') {
    forceRouteDefault(live);
    const banner = `data lives in ${live}; run the backend transformation from the Fleet tab, or set DATA_BACKEND back to ${live}`;
    bootStatus = { ...bootStatus, banner };
    console.warn(`[Data] Transformation required: ${banner}`);
  }
  if (live === 'file') {
    bootStatus = { ...bootStatus, mode: 'file', state: 'file' };
    return;
  }
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  if (!url) {
    refuse('the live data backend is postgres but DATA_BACKEND_URL is not set');
    return;
  }
  startPostgresRuntime(url);
}

let activeUrl: string | null = null;

/** Make a prepared backend the live runtime; the caller owns identity verification. */
function installRuntime(url: string, backend: PostgresBackend): DataReadinessDriver {
  activeUrl = url;
  bootStatus = { ...bootStatus, mode: 'postgres', state: 'starting' };
  const ws = initWorkingSet(backend);
  setGuildDataBackend(backend);
  return initDataReadiness(backend, ws, { held: true });
}

function startPostgresRuntime(url: string): void {
  const backend = new PostgresBackend({ url });
  backend.start();
  void verifyIdentityLoop(url, installRuntime(url, backend));
}

const PICK_CONNECT_TIMEOUT_MS = 4_000;

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(PICK_CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Pick which delivered form this node can actually DIAL (F1): the container
 * form connects only from the sidecar's own host, and the public form cannot
 * hairpin from there. A TCP connect, not a DNS lookup, is the test - wildcard
 * resolvers (ISP NXDOMAIN redirection behind docker's embedded DNS) make bare
 * names "resolve" everywhere, which would strand a remote worker on an
 * undialable pick. When BOTH forms are dark the database itself is down and
 * the probe proves nothing about vantage, so the pick sticks with whatever
 * this node used before rather than migrating on noise. A wrong pick is still
 * caught by store-identity verification, never served.
 */
export async function pickDeliveredUrl(url: string, publicUrl: string, previous?: string): Promise<string> {
  if (!publicUrl || publicUrl === url) return url;
  try {
    const local = new URL(url);
    if (await tcpReachable(local.hostname, Number(local.port) || 5432)) return url;
    const pub = new URL(publicUrl);
    if (await tcpReachable(pub.hostname, Number(pub.port) || 5432)) return publicUrl;
    return previous === publicUrl ? publicUrl : url;
  } catch {
    return publicUrl;
  }
}

/**
 * Co-worker apply of the master-delivered backend (register reply, re-sent on
 * every reconnect). Reports `changed` when the effective backend or URL changed
 * (the caller refreshes and re-sends its capabilities) and `recycled` when the
 * postgres runtime was actually rebuilt (the caller must re-mirror its lease
 * into the fresh readiness driver; the two are NOT the same condition, because
 * an unchanged delivery can still resolve to a different reachable form).
 * Ordering per the spec: adopt -> persist env -> marker -> (re)start runtime,
 * gates stay closed until the new runtime's identity verifies.
 * keepPrevious leaves the outgoing pool open for a caller that shares it with
 * its control store and is about to restart anyway.
 */
export async function applyDeliveredBackend(
  info: { backend: DataBackendKind; url?: string; publicUrl?: string; transformationId?: string; routes?: { guildId: string; backend: DataBackendKind }[] } | undefined,
  opts?: { keepPrevious?: boolean },
): Promise<{ changed: boolean; recycled: boolean }> {
  const backend = info?.backend ?? 'file';
  const publicUrl = (info?.publicUrl || '').trim();
  const localUrl = (info?.url || '').trim();
  const previousUrl = (loadCredentials().DATA_BACKEND_URL || '').trim();
  // Mid-transformation deliveries carry the url with backend 'file' too, so
  // the pick keys on the url's presence, not on the backend.
  const url = localUrl ? await pickDeliveredUrl(localUrl, publicUrl, previousUrl) : localUrl;
  const creds = loadCredentials();
  const envBackend = (creds.DATA_BACKEND || 'file').trim() || 'file';
  const envUrl = (creds.DATA_BACKEND_URL || '').trim();
  const envPublicUrl = (creds.DATA_BACKEND_PUBLIC_URL || '').trim();
  const envLocalUrl = (creds.DATA_BACKEND_LOCAL_URL || '').trim();
  const changed = backend !== envBackend
    || (backend === 'postgres' && (url !== envUrl || publicUrl !== envPublicUrl || localUrl !== envLocalUrl));

  setFleetDataBackend(backend === 'postgres' ? { backend, url } : { backend });

  if (changed) {
    const patch: Record<string, string> = { DATA_BACKEND: backend };
    if (backend === 'postgres') {
      patch.DATA_BACKEND_URL = url;
      // Both delivered forms verbatim, so this node can re-deliver the pair if
      // it ever becomes master (the picked url alone loses the container form
      // on remote nodes). Always written: an empty value clears a stale form
      // left from a primary whose replication was since disabled (upsert
      // cannot delete).
      patch.DATA_BACKEND_LOCAL_URL = localUrl;
      patch.DATA_BACKEND_PUBLIC_URL = publicUrl;
    }
    const result = upsertCredentials(patch);
    if (!result.success) {
      console.warn('[Data] Could not persist the delivered backend to /data/.env; applied in-memory only:', result.error);
    }
  }

  const marker = readFileMarker();
  if (info?.transformationId) {
    // Mid-window delivery: adopt the routing map, and make sure the postgres
    // runtime exists even while the serving default is file (converted or
    // converting guilds need it). A delivered backend that differs from the
    // local marker is the flip instruction this node missed while offline.
    applyRouteOverrides(info.routes ?? []);
    if (marker && marker.live !== backend) {
      applyBackendFlip(backend);
    } else if (url && activeUrl === null) {
      startPostgresRuntime(url);
    }
  } else if (marker && marker.live !== backend && !hasLocalGuildData()) {
    // Stale local marker with no local guild data: the master's delivered
    // backend wins and the node rewrites its own marker (guard step 5).
    writeFileMarker({ live: backend, storeId: null, flippedAt: Date.now(), transformationId: null });
    forceRouteDefault(null);
  }

  if (backend === 'postgres') {
    if (!url) {
      refuse('the master delivered a postgres backend without a URL');
      return { changed, recycled: false };
    }
    if (activeUrl === url) return { changed, recycled: false };
    if (activeUrl !== null) {
      console.warn('[Data] Delivered backend URL changed; recycling the postgres runtime and carrying unflushed writes to the new database');
      return { changed, recycled: await recyclePostgresRuntime(url, opts?.keepPrevious === true) };
    }
    startPostgresRuntime(url);
  }
  return { changed, recycled: false };
}

export function getActiveBackendUrl(): string | null {
  return activeUrl;
}

/** Worker-side lazy runtime construction from a control-channel-delivered URL (C5). */
export function ensureRuntimeWith(url: string): void {
  if (activeUrl === null && url) startPostgresRuntime(url);
}

/**
 * Master-side pre-transformation ensure: the destination (or source) postgres
 * runtime must be up before any guild converts or any route flips postgres.
 */
export function ensureTransformationRuntime(): { ok: boolean; error?: string } {
  if (bootStatus.state === 'refused') return { ok: false, error: bootStatus.refusalReason || 'data layer refused' };
  if (activeUrl !== null) return { ok: true };
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  if (!url) return { ok: false, error: 'DATA_BACKEND_URL is not set' };
  startPostgresRuntime(url);
  return { ok: true };
}

/**
 * The node's BACKEND_FLIP duty: swap the resolver default, clear the routing
 * map, write our own marker naming the destination. The postgres runtime is
 * left running either way (a file flip still retires postgres rows next).
 */
export function applyBackendFlip(dest: DataBackendKind): void {
  const marker = readFileMarker();
  setFleetDataBackend(dest === 'postgres'
    ? { backend: dest, url: activeUrl ?? (loadCredentials().DATA_BACKEND_URL || '').trim() }
    : { backend: dest });
  forceRouteDefault(null);
  applyRouteOverrides(null);
  writeFileMarker({
    live: dest,
    storeId: dest === 'postgres' ? (marker?.storeId ?? null) : null,
    flippedAt: Date.now(),
    transformationId: null,
  });
  bootStatus = { mode: dest, state: dest === 'postgres' ? 'serving' : 'file', banner: null, refusalReason: null };
  console.log(`[Data] Backend flipped: every guild now routes to ${dest}`);
}

/** Bounded identity retries for a drain: a just-promoted database can be seconds late to answer. */
const DRAIN_VERIFY_ATTEMPTS = 10;
const DRAIN_VERIFY_RETRY_MS = 3000;
/** Bounded wait for flushes already on the wire, so their keys are visible to the drain again. */
const DRAIN_SETTLE_MS = 15_000;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

/**
 * URL change while serving. The outgoing runtime KEEPS SERVING until the new
 * database has proven its identity and taken every buffered write: installing
 * the cold runtime first would leave the node dropping guild events and
 * rejecting interactions for the whole verification window while its data sat
 * intact in memory. Only when the drain is done does the swap happen, and the
 * outgoing working set is silenced in the same breath - it carries a fence
 * token identical to its successor's, so a surviving retry from it would
 * overwrite live rows with no fence able to tell the two apart.
 * A transfer fences the old primary read-only before all this, so writes
 * accepted meanwhile exist only in that working set; flushing them at the old
 * database would lose every one. Writes that cannot be carried are named.
 * Returns whether the runtime actually changed.
 */
let recycleTarget: string | null = null;
let recycleQueue: Promise<boolean> = Promise.resolve(false);

/**
 * Single-flight per target. The master re-delivers the same backend on EVERY
 * register and the window below is long, so a flapping control socket would
 * otherwise start a second swap over the first one's fresh working set and
 * discard its writes with nothing left to name them. A genuinely different
 * target queues behind the one in flight rather than racing it.
 */
function recyclePostgresRuntime(url: string, keepPrevious: boolean): Promise<boolean> {
  if (recycleTarget === url) return recycleQueue;
  recycleTarget = url;
  recycleQueue = recycleQueue
    .catch(() => false)
    .then(() => runRecycle(url, keepPrevious))
    .finally(() => { if (recycleTarget === url) recycleTarget = null; });
  return recycleQueue;
}

async function runRecycle(url: string, keepPrevious: boolean): Promise<boolean> {
  const oldReadiness = getDataReadiness();
  const oldWs = getWorkingSet();
  const oldBackend = getGuildDataBackend();
  const incoming = new PostgresBackend({ url });
  incoming.start();
  let carried: string[] = [];
  try {
    let verified = false;
    for (let attempt = 0; attempt < DRAIN_VERIFY_ATTEMPTS && !verified; attempt++) {
      try {
        const identity = await verifyStoreIdentity(url);
        if (!identity.ok) {
          console.error(`[Data] The delivered database refused identity verification (${identity.reason}); staying on the current database`);
          await incoming.stop().catch(() => { /* best effort */ });
          return false;
        }
        verified = true;
      } catch {
        if (attempt + 1 < DRAIN_VERIFY_ATTEMPTS) await sleep(DRAIN_VERIFY_RETRY_MS);
      }
    }
    if (!verified) {
      console.error('[Data] The delivered database never answered the identity check; staying on the current database');
      await incoming.stop().catch(() => { /* best effort */ });
      return false;
    }
    if (oldWs) {
      // A flush already on the wire has emptied its dirty set, so it is
      // invisible to the drain until it comes back and re-dirties; waiting for
      // it is what keeps those writes from vanishing between the two runtimes.
      await oldWs.settleInFlight(DRAIN_SETTLE_MS);
      const pending = oldWs.dirtyGuildIds();
      if (pending.length > 0) {
        const fencedBefore = oldWs.fencedRejectionCount();
        oldWs.retargetBackend(incoming);
        const leftover = await oldWs.flushAllDirty();
        carried = leftover;
        const discarded = oldWs.fencedRejectionCount() - fencedBefore;
        if (discarded > 0) {
          console.error(`[Data] ${discarded} of ${pending.length} draining guild(s) had their unflushed writes DISCARDED as fenced during the recycle (candidates: ${pending.join(', ')})`);
        }
        if (leftover.length > 0) {
          console.error(`[Data] ${leftover.length} guild(s) could not drain into the new database and their writes are DROPPED: ${leftover.join(', ')}`);
        }
      }
    }
  } catch (error) {
    console.warn('[Data] Error while recycling the postgres runtime:', error);
    await incoming.stop().catch(() => { /* best effort */ });
    return false;
  }
  // Named once: anything flushAllDirty already reported is not repeated here.
  const stranded = (oldWs?.dirtyGuildIds() ?? []).filter(g => !carried.includes(g));
  if (stranded.length > 0) {
    console.error(`[Data] ${stranded.length} guild(s) still hold writes the old runtime could not place and they are DROPPED at the swap: ${stranded.join(', ')}`);
  }
  oldReadiness?.stop();
  oldWs?.quiesce();
  void verifyIdentityLoop(url, installRuntime(url, incoming));
  // NEVER awaited: pool.end() waits for checked-out clients, and a connection
  // hung against a partitioned host would hold this result back for as long as
  // the OS takes to give up - with the swap already complete, that would strand
  // the caller before it re-mirrors the lease and leave the node serving
  // nothing. A superseded master keeps its pool either way: its control store
  // shares it and it restarts in seconds.
  if (!keepPrevious && oldBackend) void oldBackend.stop().catch(() => { /* best effort */ });
  return true;
}

async function verifyIdentityLoop(url: string, driver: DataReadinessDriver): Promise<void> {
  let logged = false;
  for (;;) {
    try {
      const verdict = await verifyStoreIdentity(url);
      if (!verdict.ok) {
        refuse(verdict.reason);
        return;
      }
      // Release only once the marker holds the store id (minted by the
      // backend's own provisioning): hydration cannot proceed any earlier
      // anyway, and adopting it now makes a later URL swap detectable from
      // the very next boot.
      if (readFileMarker()?.storeId) {
        driver.release();
        bootStatus = { ...bootStatus, state: 'serving' };
        console.log('[Data] Postgres store identity verified; serving');
        return;
      }
    } catch { /* unreachable; fall through to the retry sleep */ }
    if (!logged) {
      console.warn('[Data] Waiting on the data backend to verify store identity; gates stay closed');
      logged = true;
    }
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, IDENTITY_RETRY_MS);
      t.unref();
    });
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

/**
 * Shared dispatch gate (file-routed guilds: passthrough). True = dispatch now.
 * Interactions wait briefly then get one polite ephemeral reply and drop -
 * the gate NEVER acks/defers on a handler's behalf. Non-interaction events
 * buffer for replay (or drop when the shard is not leased here).
 */
export async function gateEventDispatch(eventName: string, args: any[], replay: () => void): Promise<boolean> {
  if (eventName === 'clientReady') {
    await awaitDataStartupBarrier();
    return true;
  }
  const guildId = extractGuildId(args);
  if (!guildId) return true;
  if (bootStatus.state === 'refused') {
    // Unresolvable backend configuration: guild-scoped dispatch stays closed.
    const first = args[0];
    if (first && typeof first.isRepliable === 'function') {
      await politeReject(first, "This bot's data storage is currently unavailable; please contact the server operator.");
    }
    return false;
  }
  const readiness = getDataReadiness();
  if (!readiness || routeFor(guildId) === 'file') return true;
  const first = args[0];
  if (first && typeof first.isRepliable === 'function') {
    if (await readiness.admitInteraction(guildId)) return true;
    await politeReject(first);
    return false;
  }
  return readiness.admitEvent(guildId, replay);
}

/**
 * Synthetic-entry gate (console cmd invoke, webui panel IPC): same wait as an
 * interaction, but the caller renders its own error instead of a Discord reply.
 */
export async function awaitGuildDataReady(guildId: string): Promise<boolean> {
  if (bootStatus.state === 'refused') return false;
  const readiness = getDataReadiness();
  if (!readiness || routeFor(guildId) === 'file') return true;
  return readiness.admitInteraction(guildId);
}

/** Config-backed notice text, resolved at reply time so edits apply without restart. */
function noticeText(property: string, fallback: string): string {
  const value = getConfigProperty<string>(property);
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/** User-visible text for a refused write; the database-unreachable notice is operator-editable in config.json. */
export function dataUnavailableMessage(causeKey: 'database-unreachable' | 'guild-fenced'): string {
  return causeKey === 'guild-fenced'
    ? "This server's data just moved to another bot node; please try again in a moment."
    : noticeText('outageNotice.databaseUnreachable', "The bot's database is currently unreachable, so your change was not saved. Please try again later or contact support.");
}

async function politeReject(interaction: any, content?: string): Promise<void> {
  try {
    if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
      if (typeof interaction.respond === 'function') await interaction.respond([]).catch(() => { /* expired */ });
      return;
    }
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      const text = content ?? noticeText('outageNotice.dataLoading', "This server's data is still loading, try again in a moment.");
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => { /* expired or already handled */ });
    }
  } catch { /* the gate must never throw into dispatch */ }
}

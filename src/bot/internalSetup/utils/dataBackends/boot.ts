// Data-backend boot + dispatch gates. initDataBackendLayer() runs BEFORE
// fleet init so the readiness driver exists when the first lease lands; the
// driver stays HELD until the store-identity verdict clears, so no ownership
// claim can touch a database that turns out to be the wrong one.

import { MessageFlags } from 'discord.js';
import { DataBackendKind, loadCredentials } from '../../../../utils/envLoader';
import { PostgresBackend } from './postgresBackend';
import { initWorkingSet } from './workingSet';
import { initDataReadiness, getDataReadiness, DataReadinessDriver } from './dataReadiness';
import { forceRouteDefault, routeFor } from './routeResolver';
import { evaluateRecognitionGuard, verifyStoreIdentity, GuardVerdict } from './recognitionGuard';
import { setGuildDataBackend } from '../dataManager';

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
  bootStatus = { ...bootStatus, mode: 'postgres', state: 'starting' };
  const backend = new PostgresBackend({ url });
  backend.start();
  const ws = initWorkingSet(backend);
  setGuildDataBackend(backend);
  const driver = initDataReadiness(backend, ws, { held: true });
  void verifyIdentityLoop(url, driver);
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
      driver.release();
      bootStatus = { ...bootStatus, state: 'serving' };
      console.log('[Data] Postgres store identity verified; serving');
      return;
    } catch {
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

/** User-visible text for a refused write (Stage 3 makes this operator-customizable). */
export function dataUnavailableMessage(causeKey: 'database-unreachable' | 'guild-fenced'): string {
  return causeKey === 'guild-fenced'
    ? "This server's data just moved to another bot node; please try again in a moment."
    : "The bot's database is currently unreachable, so your change was not saved. Please try again later or contact support.";
}

async function politeReject(interaction: any, content = "This server's data is still loading, try again in a moment."): Promise<void> {
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

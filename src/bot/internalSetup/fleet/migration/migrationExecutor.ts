// Migration participant (P5): runs on EVERY node, including the master as a
// participant of its own migrations. Handles XFER_PREPARE/DRAIN/COMMIT/ABORT
// idempotently, keyed by migrationId. It owns no policy - the coordinator
// decides; the executor only performs the local data work using the Stage 4
// facade primitives (freeze/flush/hash/graveyard) and the Stage 5 transfer
// channel. leaseRuntime is untouched: the gateway legs reuse its existing
// revoke/applyGrant via the coordinator's grant path.

import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { atomicWriteFileSync } from '../fileControlStore';
import { getNodeId } from '../nodeIdentity';
import { readSuperseded } from '../stepDown';
import { noteGuildsCommittedHere } from '../mirrorEngine';
import {
  deleteGuildNamespace,
  flushGuild,
  freezeGuildWrites,
  sizeOfGuildData,
  unfreezeGuildWrites,
} from '../../utils/dataManager';
import { hashLeg } from '../../utils/dataInterchange';
import { routeFor } from '../../utils/dataBackends/routeResolver';
import { getWorkingSet } from '../../utils/dataBackends/workingSet';
import { TRANSFER_PORT_DEFAULT, TRANSFER_TOKEN_TTL_MS, XFER_MAX_ROUNDS, XFER_DELTA_THRESHOLD_FILES, XFER_DIAL_RETRY_MS, XFER_DIAL_RETRY_WINDOW_MS } from '../constants';
import {
  MSG,
  TransferDirection,
  XferAbortPayload,
  XferCommitPayload,
  XferDrainPayload,
  XferFlushedPayload,
  XferInventoryReply,
  XferInventoryRequest,
  XferPreparePayload,
  XferPreparedPayload,
  XferProgressPayload,
  XferVerifyPayload,
} from '../protocol';
import {
  dialTransfer,
  incomingLegDir,
  TransferReceiver,
  TransferSender,
  TransferServer,
} from './transferChannel';

const INCOMING_DIR = '_incoming';
// Per-guild flush confirmation budget inside a lease-only drain; the master's
// XFER_DRAIN_TIMEOUT_MS (30s) bounds the whole phase above this.
const LEASE_ONLY_FLUSH_MS = 10000;

interface TokenEntry {
  migrationId: string;
  legId: string;
  role: 'source' | 'target';
  expiresAt: number;
  spent: boolean;
}

interface LegRuntime {
  migrationId: string;
  legId: string;
  shardId: number;
  role: 'source' | 'target';
  guilds: string[];
  direction: TransferDirection;
  peerUrl?: string;
  token: string;
  ws: WebSocket | null;
  sender: TransferSender | null;
  receiver: TransferReceiver | null;
  round: number;
  lastRoundFiles: number;
  finalHashDone: boolean;
  aborted: boolean;
  committed: boolean;
  frozen: boolean;
  drainPending: boolean;
  dialTimer: NodeJS.Timeout | null;
}

export interface ExecutorHooks {
  /** Send a fire-and-forget frame to the master (progress/verify). */
  sendToMaster: (type: string, data: any) => void;
  /** Advertised transfer endpoint of THIS node (from TRANSFER_URL); undefined when this node does not advertise. */
  selfTransferUrl: () => string | undefined;
  transferPort: () => number;
}

export class MigrationExecutor {
  private readonly tokens = new Map<string, TokenEntry>(); // token -> ctx
  private readonly legs = new Map<string, LegRuntime>(); // legId -> runtime
  private server: TransferServer | null = null;
  // Term of the active migration, stamped onto outgoing progress/verify so the
  // master's control-server term gate accepts them (split-brain fencing).
  private currentTerm = 0;

  private readonly commitsInFlight = new Set<string>();

  constructor(private readonly hooks: ExecutorHooks) {}

  /** Whether any leg runtime is live or a commit runs on this node (gates the periodic staging resolver). */
  hasActiveLegs(): boolean {
    return this.legs.size > 0 || this.commitsInFlight.size > 0;
  }

  /** Route a control frame from the master. Returns the ack payload (idempotent). */
  async handle(type: string, data: any): Promise<any> {
    switch (type) {
      case MSG.XFER_PREPARE: return this.onPrepare(data as XferPreparePayload);
      case MSG.XFER_DRAIN: return this.onDrain(data as XferDrainPayload);
      case MSG.XFER_COMMIT: return this.onCommit(data as XferCommitPayload);
      case MSG.XFER_ABORT: return this.onAbort(data as XferAbortPayload);
      case MSG.XFER_INVENTORY: return this.onInventory(data as XferInventoryRequest);
      default: return { ok: false, reason: `unknown-xfer:${type}` };
    }
  }

  private ensureServer(): TransferServer {
    if (this.server) return this.server;
    this.server = new TransferServer({
      authorize: token => {
        const entry = this.tokens.get(token);
        if (!entry || entry.spent || Date.now() > entry.expiresAt) return null;
        entry.spent = true;
        return { migrationId: entry.migrationId, legId: entry.legId, role: entry.role };
      },
      onPullConnected: (legId, ws) => {
        const leg = this.legs.get(legId);
        if (!leg || leg.role !== 'source') { ws.close(); return; }
        // The target dialed us (pull): its hello starts the stream. A hello that
        // never arrives leaves this socket idle until the master's stall
        // watchdog aborts the leg; there is no send-anyway fallback here.
        ws.once('message', () => this.attachSender(leg, ws));
        leg.ws = ws;
      },
      onPushConnected: (legId, ws) => {
        const leg = this.legs.get(legId);
        if (!leg || leg.role !== 'target') { ws.close(); return; }
        this.attachReceiver(leg, ws);
      },
    });
    return this.server;
  }

  private async onPrepare(payload: XferPreparePayload): Promise<XferPreparedPayload> {
    // A prepare carries this node's legs only (the coordinator filters per node).
    console.log(`[Migration] Prepare received: ${payload.migrationId} (${payload.legs.map(l => `${l.legId}=${l.role}/${l.direction}`).join(', ')})`);
    this.currentTerm = payload.term;
    let estBytes = 0;
    let freeBytes: number | undefined;
    let needListener = false;
    for (const legInfo of payload.legs) {
      // Lease-only legs never open the transfer channel: register the runtime
      // only (no token, no listener, no staging, no size estimate).
      const leaseOnly = legInfo.direction === 'none';
      // Idempotent: a duplicate prepare re-registers the token but keeps the runtime.
      if (!leaseOnly) {
        this.tokens.set(legInfo.token, {
          migrationId: payload.migrationId,
          legId: legInfo.legId,
          role: legInfo.role,
          expiresAt: Date.now() + TRANSFER_TOKEN_TTL_MS,
          spent: false,
        });
      }
      if (!this.legs.has(legInfo.legId)) {
        this.legs.set(legInfo.legId, {
          migrationId: payload.migrationId,
          legId: legInfo.legId,
          shardId: legInfo.shardId,
          role: legInfo.role,
          guilds: legInfo.guilds,
          direction: legInfo.direction,
          peerUrl: legInfo.peerUrl,
          token: legInfo.token,
          ws: null,
          sender: null,
          receiver: null,
          round: 0,
          lastRoundFiles: 0,
          finalHashDone: false,
          aborted: false,
          committed: false,
          frozen: false,
          drainPending: false,
          dialTimer: null,
        });
      }
      if (leaseOnly) continue;
      if (legInfo.role === 'source') {
        for (const guildId of legInfo.guilds) estBytes += await sizeOfGuildData(guildId);
      }
      // This node listens when it does NOT dial: push -> source dials, so the
      // target listens; pull -> target dials, so the source listens.
      const iDial = (legInfo.direction === 'push' && legInfo.role === 'source')
        || (legInfo.direction === 'pull' && legInfo.role === 'target');
      if (!iDial) needListener = true;
    }
    if (needListener) {
      try {
        await this.ensureServer().start(this.hooks.transferPort());
      } catch (error) {
        return { ok: false, reason: `transfer listener bind failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    // A target reports free bytes (statfs); "unknown" is tolerated by the coordinator.
    if (payload.legs.some(l => l.role === 'target' && l.direction !== 'none')) {
      freeBytes = await statfsFree(DATA_ROOT);
    }

    // Kick off the copy: dialers connect now; listeners wait for the inbound dial.
    for (const legInfo of payload.legs) {
      const leg = this.legs.get(legInfo.legId)!;
      if (leg.direction === 'none') continue;
      const iDial = (leg.direction === 'push' && leg.role === 'source')
        || (leg.direction === 'pull' && leg.role === 'target');
      if (iDial && !leg.ws) this.dialAndStart(leg);
    }
    return { ok: true, estBytes: estBytes || undefined, freeBytes };
  }

  private dialAndStart(leg: LegRuntime, dialDeadline = Date.now() + XFER_DIAL_RETRY_WINDOW_MS): void {
    if (!leg.peerUrl) {
      this.reportProgress(leg, 'no peer url to dial');
      return;
    }
    // The retry window is only consulted from the socket's error handler, so a
    // dial that raises no event at all would never report. Arm the deadline as
    // a timer too: the leg must always end in a connection or a stated failure.
    if (!leg.dialTimer) {
      leg.dialTimer = setTimeout(() => {
        leg.dialTimer = null;
        if (leg.aborted || leg.sender || leg.receiver || !this.legs.has(leg.legId)) return;
        try { leg.ws?.terminate(); } catch { /* already gone */ }
        leg.ws = null;
        this.reportProgress(leg, `dial to ${leg.peerUrl} produced no websocket upgrade within ${XFER_DIAL_RETRY_WINDOW_MS}ms`);
      }, XFER_DIAL_RETRY_WINDOW_MS + XFER_DIAL_RETRY_MS);
      leg.dialTimer.unref?.();
    }
    const ws = dialTransfer(leg.peerUrl, leg.token);
    leg.ws = ws;
    let opened = false;
    ws.on('error', err => {
      if (leg.aborted || !this.legs.has(leg.legId)) return;
      if (!opened && Date.now() < dialDeadline) {
        // The prepare fan-out has no ordering barrier, so the peer's lazy
        // listener may still be binding; re-dial instead of aborting the leg.
        leg.ws = null;
        setTimeout(() => {
          if (!leg.aborted && this.legs.has(leg.legId) && !leg.ws) this.dialAndStart(leg, dialDeadline);
        }, XFER_DIAL_RETRY_MS);
        return;
      }
      this.reportProgress(leg, `dial error: ${err instanceof Error ? err.message : String(err)}`);
    });
    ws.on('open', () => {
      opened = true;
      if (leg.role === 'target') {
        // pull: announce ourselves, then receive.
        try { ws.send(JSON.stringify({ t: 'hello', mode: 'pull' })); } catch { /* closing */ }
        this.attachReceiver(leg, ws);
      } else {
        // push: source dialed target; begin streaming.
        this.attachSender(leg, ws);
      }
    });
  }

  private attachReceiver(leg: LegRuntime, ws: WebSocket): void {
    if (leg.receiver) return;
    this.clearDialTimer(leg);
    leg.ws = ws;
    void this.writeManifest(leg, 'receiving');
    leg.receiver = new TransferReceiver(ws, leg.migrationId, leg.legId, {
      onRound: round => { leg.round = round; this.reportProgress(leg); },
      onFinal: async round => {
        leg.round = round;
        await this.verifyTargetStaging(leg);
      },
      onError: error => this.reportProgress(leg, error instanceof Error ? error.message : String(error)),
    }, leg.guilds);
  }

  private attachSender(leg: LegRuntime, ws: WebSocket): void {
    if (leg.sender) return;
    this.clearDialTimer(leg);
    leg.ws = ws;
    leg.sender = new TransferSender(ws, {
      migrationId: leg.migrationId,
      legId: leg.legId,
      guilds: () => leg.guilds,
    });
    if (leg.drainPending) {
      // A drain already arrived (redistribute drains right after the prepare
      // acks, possibly before the retried dial connected): go straight to the
      // frozen final round - on a fresh sender it ships everything.
      leg.drainPending = false;
      void this.finishDrain(leg);
    } else {
      void this.runCopyRounds(leg);
    }
  }

  // Source copy loop: bulk round 0 then delta rounds until convergence or the
  // max-round backstop. The DRAIN command later drives the frozen final round.
  private async runCopyRounds(leg: LegRuntime): Promise<void> {
    try {
      for (let round = 0; round < XFER_MAX_ROUNDS; round++) {
        if (leg.aborted) return;
        const progress = await leg.sender!.sendRound(round);
        leg.round = round;
        leg.lastRoundFiles = progress.filesSent;
        this.reportProgress(leg, undefined, progress);
        if (round > 0 && progress.filesSent <= XFER_DELTA_THRESHOLD_FILES) break;
      }
      // Converged; wait for the drain command to run the frozen final round.
    } catch (error) {
      this.reportProgress(leg, error instanceof Error ? error.message : String(error));
    }
  }

  private async onDrain(payload: XferDrainPayload): Promise<any> {
    // Ack on receipt, not completion: the final delta round + verify hash can
    // outlast the generic control-ack window on large namespaces, and the
    // DRAINING phase completes on XFER_VERIFY under its own drain timeout.
    // Errors surface through reportProgress like any other leg fault.
    void (async () => {
      for (const legId of payload.legIds) {
        const leg = this.legs.get(legId);
        if (!leg) continue;
        if (leg.role !== 'source') continue;
        try {
          await this.drainSource(leg);
        } catch (error) {
          this.reportProgress(leg, error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return { ok: true, term: payload.term };
  }

  // Source drain: freeze the guilds (facade + .freeze sentinel), flush, ship a
  // final delta round, compute hashes, send XFER_VERIFY {side:'source'}. The
  // bounded event gap started at the coordinator's LEASE_REVOKE; the freeze is
  // the backstop for non-gateway writers during the frozen window.
  private async drainSource(leg: LegRuntime): Promise<void> {
    if (leg.finalHashDone || leg.aborted) return;
    if (leg.direction === 'none') {
      await this.drainSourceLeaseOnly(leg);
      return;
    }
    for (const guildId of leg.guilds) {
      freezeGuildWrites(guildId);
      await writeFreezeSentinel(guildId);
      await flushGuild(guildId);
    }
    leg.frozen = true;
    if (!leg.sender) {
      // The dial retry loop may still be connecting. Skipping the final round
      // here would send a one-sided verify and hang the migration until the
      // drain timeout; defer it to the moment the sender attaches instead.
      leg.drainPending = true;
      return;
    }
    await this.finishDrain(leg);
  }

  // Lease-only drain: the revoke's unload freezes the working sets one guild
  // at a time and nothing orders this drain after it, so each guild is frozen
  // here first (frozen-retained) and only then confirmed durable in the
  // database: no write the confirmation misses is accepted. The master's
  // VERIFYING accepts only ok with zero pending/failed.
  private async drainSourceLeaseOnly(leg: LegRuntime): Promise<void> {
    const ws = getWorkingSet();
    let pendingOps = 0;
    let flushFailures = 0;
    let reason: string | undefined;
    if (ws) {
      for (const g of leg.guilds) ws.freezeRetained(g);
      const outcomes = await Promise.all(leg.guilds.map(g => ws.flushGuildNow(g, LEASE_ONLY_FLUSH_MS)));
      outcomes.forEach((outcome, i) => {
        if (outcome === 'ok') return;
        if (outcome === 'pending') pendingOps += 1;
        else flushFailures += 1;
        if (!reason) reason = `guild ${leg.guilds[i]}: ${outcome}`;
      });
    }
    leg.finalHashDone = true;
    const payload: XferFlushedPayload = {
      migrationId: leg.migrationId,
      legId: leg.legId,
      term: this.currentTerm,
      ok: pendingOps === 0 && flushFailures === 0,
      pendingOps,
      flushFailures,
      ...(reason ? { reason } : {}),
    };
    this.hooks.sendToMaster(MSG.XFER_FLUSHED, payload);
  }

  private async finishDrain(leg: LegRuntime): Promise<void> {
    if (leg.finalHashDone || leg.aborted) return;
    try {
      if (leg.sender) {
        const finalRound = leg.round + 1;
        const progress = await leg.sender.sendRound(finalRound);
        leg.round = finalRound;
        leg.sender.finish(finalRound);
        this.reportProgress(leg, undefined, progress);
      }
      const { legHash, guildHashes } = await hashLeg(leg.guilds);
      leg.finalHashDone = true;
      const verify: XferVerifyPayload = { migrationId: leg.migrationId, legId: leg.legId, side: 'source', hash: legHash, guildHashes };
      this.hooks.sendToMaster(MSG.XFER_VERIFY, { term: this.currentTerm, ...verify });
    } catch (error) {
      this.reportProgress(leg, error instanceof Error ? error.message : String(error));
    }
  }

  // Target: hash the staged bytes on the final round-end and send verify.
  private async verifyTargetStaging(leg: LegRuntime): Promise<void> {
    if (leg.finalHashDone || leg.aborted) return;
    try {
      // Seal the receiver BEFORE hashing: the per-leg transfer is complete at
      // the final round-end, so refuse any further inbound records. This closes
      // the verify/commit TOCTOU - a compromised peer cannot mutate the staged
      // bytes between the verify hash and the commit rename (what gets renamed
      // into the live namespace is exactly what was hashed here).
      await leg.receiver?.close();
      await this.writeManifest(leg, 'verified');
      const { legHash, guildHashes } = await hashStaging(leg.migrationId, leg.legId, leg.guilds);
      leg.finalHashDone = true;
      const verify: XferVerifyPayload = { migrationId: leg.migrationId, legId: leg.legId, side: 'target', hash: legHash, guildHashes };
      this.hooks.sendToMaster(MSG.XFER_VERIFY, { term: this.currentTerm, ...verify });
    } catch (error) {
      this.reportProgress(leg, error instanceof Error ? error.message : String(error));
    }
  }

  // COMMIT is idempotent + retried. TARGET: write commit-intent, then per guild
  // graveyard any stale live dir, rename staging into place, stamp .owner.
  // SOURCE: graveyard each guild (deleteGuildNamespace), drop .freeze, unfreeze.
  private async onCommit(payload: XferCommitPayload): Promise<any> {
    let allDone = true;
    const stuck: string[] = [];
    for (const legId of payload.legIds) {
      // One commit of a leg at a time, never joined: a re-send while one
      // runs (a remote round gives up at 10 s, the retry tick) is answered
      // not done, and the next tick asks again once it has finished.
      if (this.commitsInFlight.has(legId)) { allDone = false; continue; }
      this.commitsInFlight.add(legId);
      try {
        const leg = this.legs.get(legId);
        if (!leg) {
          // No in-memory runtime (crash/restart, or the runtime was released).
          if (payload.sourceCleanup) {
            // This is a SOURCE leg retried against a restarted source: it has no
            // _incoming staging (only targets stage), so commitFromStaging is a
            // no-op here. Run the source graveyard + unfreeze directly from the
            // payload's guild list. Ack ok ONLY when it genuinely completed, so a
            // restarted source cannot false-ack an untouched cleanup (which would
            // leave its originals write-frozen forever while the master records
            // the cleanup done). Idempotent: re-graveyarding an already-gone guild
            // and unfreezing an already-unfrozen guild are both no-ops.
            const left = await commitSourceGuilds(payload.migrationId, legId, payload.guilds ?? []);
            if (left.length > 0) { allDone = false; stuck.push(...left); }
            continue;
          }
          // Target with commit-intent staging on disk is finished idempotently
          // from the staging manifest (also handled by the boot sweep).
          const named = payload.legIds.length === 1 && Array.isArray(payload.guilds)
            ? { guilds: payload.guilds.filter(g => typeof g === 'string' && /^\d+$/.test(g)), shardId: payload.shardId ?? 0 }
            : undefined;
          if (!(await commitFromStaging(payload.migrationId, legId, payload.term, payload.epoch, named))) allDone = false;
          continue;
        }
        if (leg.committed) continue;
        if (leg.direction === 'none') {
          // Lease-only: nothing is staged and nothing is graveyarded. The target
          // takes ownership at hydration after the grant; the source just drops
          // its frozen-retained working sets.
          if (leg.role === 'source') {
            const ws = getWorkingSet();
            for (const guildId of leg.guilds) ws?.evict(guildId);
          }
        } else if (leg.role === 'target') await this.commitTarget(leg, payload.term, payload.epoch);
        else {
          // A guild still live (its graveyard move kept failing): not done,
          // named, and the master's retry, which names the guilds, finishes
          // it with no runtime.
          const left = await this.commitSource(leg);
          if (left.length > 0) { allDone = false; stuck.push(...left); }
        }
        leg.committed = true;
        // Release the runtime so the lazy listener can unbind; a retried commit
        // lands in the no-runtime branch above, which is already idempotent.
        try { leg.ws?.close(); } catch { /* closing */ }
        this.legs.delete(legId);
        this.tokens.delete(leg.token);
      } finally {
        this.commitsInFlight.delete(legId);
      }
    }
    this.maybeReleaseServer();
    return { ok: allDone, term: payload.term, ...(stuck.length > 0 ? { stuckGuilds: stuck } : {}) };
  }

  private commitTarget(leg: LegRuntime, term: number, epoch: number): Promise<void> {
    return oneStagingFinishAtATime(incomingLegDir(leg.migrationId, leg.legId), () => this.commitTargetNow(leg, term, epoch));
  }

  private async commitTargetNow(leg: LegRuntime, term: number, epoch: number): Promise<void> {
    await this.writeManifest(leg, 'commit-intent', { term, epoch });
    const legDir = incomingLegDir(leg.migrationId, leg.legId);
    // What landed leaves the copy this node may hold, which is older: noted
    // once (one manifest write), also when a rename throws, and with the
    // guilds a run before a crash renamed (their staging is gone).
    const landed: string[] = [];
    try {
      for (const guildId of leg.guilds) {
        const staged = path.join(legDir, guildId);
        if (!fs.existsSync(staged)) { landed.push(guildId); continue; }
        const live = path.join(DATA_ROOT, guildId);
        if (fs.existsSync(live)) await deleteGuildNamespace(guildId, `migration-${leg.migrationId}-replaced`);
        await fs.promises.rename(staged, live);
        landed.push(guildId);
        writeOwnerStamp(guildId, { shardId: leg.shardId, term, epoch });
      }
    } finally {
      noteGuildsCommittedHere(landed);
    }
    try { await fs.promises.rm(legDir, { recursive: true, force: true }); } catch { /* best effort */ }
    // Non-recursive: only reaps the migration dir once its last leg is gone.
    try { await fs.promises.rmdir(path.dirname(legDir)); } catch { /* other legs still staged */ }
  }

  // The guilds still live (none once every guild is provably gone); the
  // graveyard-resume marker stays for a crash or a failed move (residueSweep
  // finishes it).
  private commitSource(leg: LegRuntime): Promise<string[]> {
    return commitSourceGuilds(leg.migrationId, leg.legId, leg.guilds);
  }

  // ABORT is idempotent + retried while connected. TARGET: delete staging.
  // SOURCE: drop .freeze, unfreeze, KEEP originals.
  private async onAbort(payload: XferAbortPayload): Promise<any> {
    // A release while a cleanup of its leg still runs here (its ask timed
    // out) leaves everything to that cleanup and is not released yet.
    if (payload.guilds && (payload.legIds ?? []).some(legId => this.commitsInFlight.has(legId))) {
      return { ok: true, term: payload.term, released: false, reason: 'a cleanup of that leg still runs on this node' };
    }
    for (const [legId, leg] of this.legs) {
      if (leg.migrationId !== payload.migrationId) continue;
      leg.aborted = true;
      this.clearDialTimer(leg);
      try { leg.ws?.close(); } catch { /* closing */ }
      await leg.receiver?.close();
      if (leg.direction === 'none') {
        // Lease-only source: no facade freeze or sentinel was taken; the abort
        // rollback re-grant serves the working sets the drain or the revoke's
        // unload froze (frozen-retained) again.
      } else if (leg.role === 'target') {
        try { await fs.promises.rm(incomingLegDir(leg.migrationId, legId), { recursive: true, force: true }); } catch { /* best effort */ }
      } else {
        for (const guildId of leg.guilds) {
          await removeFreezeSentinel(guildId);
          unfreezeGuildWrites(guildId);
        }
      }
      this.legs.delete(legId);
      this.tokens.delete(leg.token);
    }
    // A source's release lifts the freeze its drain took also with no
    // runtime left (a restarted source) and disarms the graveyard resume a
    // failed cleanup armed for those guilds; the originals stay. It is acked
    // released only when neither is left on them.
    let release: { released: boolean; reason?: string } | undefined;
    if (payload.guilds) {
      for (const guildId of payload.guilds) {
        await removeFreezeSentinel(guildId);
        unfreezeGuildWrites(guildId);
      }
      const frozen = payload.guilds.filter(guildId => fs.existsSync(path.join(DATA_ROOT, guildId, '.freeze')));
      const disarmed = await disarmSourceGraveyard(payload.migrationId, payload.guilds);
      release = frozen.length > 0
        ? { released: false, reason: `the freeze sentinel of guild(s) ${frozen.join(', ')} could not be removed` }
        : disarmed ? { released: true } : { released: false, reason: 'its graveyard resume marker could not be rewritten' };
    }
    // Also purge whole-migration staging that has no runtime (crash-restart).
    try { await fs.promises.rm(path.join(DATA_ROOT, INCOMING_DIR, payload.migrationId), { recursive: true, force: true }); } catch { /* best effort */ }
    this.maybeReleaseServer();
    return { ok: true, term: payload.term, ...release };
  }

  private async onInventory(payload?: XferInventoryRequest): Promise<XferInventoryReply> {
    // A held copy's probe (B4f-4 (h)): which of these guilds' folders are
    // still here (a drain's freeze made each, a cleanup moves it to the
    // graveyard), whatever their stamps, and whether a cleanup of them runs
    // (its commit of the leg) or is left for the next boot to finish (an
    // armed graveyard-resume marker naming them).
    if (Array.isArray(payload?.guilds)) {
      const asked = payload!.guilds.map(String).filter(guildId => /^\d+$/.test(guildId));
      const kept = asked.filter(guildId => fs.existsSync(path.join(DATA_ROOT, guildId)));
      const armed = armedSourceGraveyards();
      if (!armed) return { ok: false, guilds: [] };
      const cleanupRunning = (payload!.legIds ?? []).some(legId => this.commitsInFlight.has(legId))
        || asked.some(guildId => armed.has(guildId));
      return { ok: true, probe: true, guilds: kept.map(guildId => ({ guildId, bytes: 0 })), cleanupRunning };
    }
    // Post-P4 inventory reads each locally-owned guild's .owner + size. A
    // superseded side's stale copies (B4f-2: its own stamps below the
    // superseding term) are not its data to move and stay out, or a
    // Redistribute run before their Retire would land them over a newer copy.
    const superseded = readSuperseded();
    const selfNodeId = getNodeId();
    const guilds: XferInventoryReply['guilds'] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(DATA_ROOT).filter(n => /^\d+$/.test(n)); } catch { /* none */ }
    for (const guildId of names) {
      let ownerShardIdAtLastServe: number | undefined;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, guildId, '.owner'), 'utf-8'));
        if (superseded && owner?.nodeId === selfNodeId && Number.isFinite(owner?.term) && Number(owner.term) < superseded.term) continue;
        if (Number.isInteger(owner?.shardId)) ownerShardIdAtLastServe = owner.shardId;
      } catch { /* no manifest */ }
      guilds.push({ guildId, bytes: await sizeOfGuildData(guildId), ownerShardIdAtLastServe });
    }
    return { ok: true, guilds };
  }

  private maybeReleaseServer(): void {
    if (this.legs.size === 0) {
      this.server?.stop();
      this.server = null;
    }
  }

  private clearDialTimer(leg: LegRuntime): void {
    if (!leg.dialTimer) return;
    clearTimeout(leg.dialTimer);
    leg.dialTimer = null;
  }

  private reportProgress(leg: LegRuntime, error?: string, progress?: { filesSent: number; bytesSent: number; deltaFiles: number }): void {
    // A participant used to fail its leg without saying anything locally, which
    // left only the master's generic abort to diagnose from.
    if (error) console.warn(`[Migration] Leg ${leg.legId} fault: ${error}`);
    const payload: XferProgressPayload = {
      migrationId: leg.migrationId,
      legId: leg.legId,
      round: leg.round,
      filesSent: progress?.filesSent ?? 0,
      bytesSent: progress?.bytesSent ?? 0,
      guildsTotal: leg.guilds.length,
      guildsDone: progress ? leg.guilds.length : 0,
      deltaFiles: progress?.deltaFiles ?? leg.lastRoundFiles,
      error,
    };
    this.hooks.sendToMaster(MSG.XFER_PROGRESS, { term: this.currentTerm, ...payload });
  }

  // A commit-intent manifest names the commit's term and epoch, so a boot
  // finishes it locally with the stamps the commit gives.
  private async writeManifest(leg: LegRuntime, phase: 'receiving' | 'verified' | 'commit-intent', commit?: { term: number; epoch: number }): Promise<void> {
    if (leg.role !== 'target') return;
    const legDir = incomingLegDir(leg.migrationId, leg.legId);
    await fs.promises.mkdir(legDir, { recursive: true });
    const manifest = {
      migrationId: leg.migrationId,
      legId: leg.legId,
      sourceNodeId: '',
      shardId: leg.shardId,
      guilds: leg.guilds,
      term: this.currentTerm,
      phase,
      ...(commit ? { commitTerm: commit.term, commitEpoch: commit.epoch } : {}),
    };
    try {
      atomicWriteFileSync(path.join(legDir, '.manifest.json'), JSON.stringify(manifest, null, 2));
    } catch { /* best effort; commit re-writes on retry */ }
  }
}

// ============================================================================
// Free-standing helpers (also used by the boot sweep resolution).
// ============================================================================

// The guilds an armed graveyard-resume marker names: a cleanup of them runs
// now, or the next boot finishes it (a corrupt marker graveyards nothing).
// Null when the markers cannot be read.
function armedSourceGraveyards(): Set<string> | null {
  const armed = new Set<string>();
  const fleetDir = path.join(DATA_ROOT, 'global', 'fleet');
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
  let names: string[] = [];
  try {
    names = fs.readdirSync(fleetDir).filter(name => /^xfer-source-.+\.json$/.test(name));
  } catch (error) {
    return missing(error) ? armed : null;
  }
  for (const name of names) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(fleetDir, name), 'utf-8');
    } catch (error) {
      if (missing(error)) continue;
      return null;
    }
    let parsed: any = null;
    try { parsed = JSON.parse(body); } catch { continue; }
    if (parsed?.phase === 'graveyarding' && Array.isArray(parsed.guilds)) for (const guildId of parsed.guilds) armed.add(String(guildId));
  }
  return armed;
}

// Source graveyard-resume marker path, one per leg (matches residueSweep's
// reader: /data/global/fleet/xfer-source-{id}-{leg}.json): two legs of one
// migration on this source never overwrite or unlink each other's.
function sourceGraveyardMarker(migrationId: string, legId: string): string {
  return path.join(DATA_ROOT, 'global', 'fleet', `xfer-source-${migrationId}-${legId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

// Each marker of the migration keeps only the guilds still to graveyard and
// goes when none is left; true once none names a released guild (a corrupt
// marker graveyards nothing at boot).
async function disarmSourceGraveyard(migrationId: string, guilds: string[]): Promise<boolean> {
  const fleetDir = path.join(DATA_ROOT, 'global', 'fleet');
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
  let names: string[];
  try { names = (await fs.promises.readdir(fleetDir)).filter(name => /^xfer-source-.+\.json$/.test(name)); } catch (error) { return missing(error); }
  let disarmed = true;
  for (const name of names) {
    const marker = path.join(fleetDir, name);
    let body: string;
    try { body = await fs.promises.readFile(marker, 'utf-8'); } catch (error) { if (!missing(error)) disarmed = false; continue; }
    let parsed: any = null;
    try { parsed = JSON.parse(body); } catch { continue; }
    if (parsed?.id !== migrationId || !Array.isArray(parsed?.guilds)) continue;
    const left = parsed.guilds.filter((guildId: unknown) => !guilds.includes(String(guildId)));
    if (left.length === parsed.guilds.length) continue;
    try {
      if (left.length === 0) await fs.promises.unlink(marker);
      else await fs.promises.writeFile(marker, JSON.stringify({ ...parsed, guilds: left }), 'utf-8');
    } catch (error) {
      if (!missing(error)) disarmed = false;
    }
  }
  return disarmed;
}

async function writeFreezeSentinel(guildId: string): Promise<void> {
  const dir = path.join(DATA_ROOT, guildId);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, '.freeze'), String(Date.now()), 'utf-8');
  } catch { /* best effort; the in-memory freeze set is the primary gate */ }
}

async function removeFreezeSentinel(guildId: string): Promise<void> {
  try { await fs.promises.unlink(path.join(DATA_ROOT, guildId, '.freeze')); } catch { /* absent */ }
}

// Direct .owner stamp with an explicit (shardId, term, epoch): the committed
// target owns the data now, whether or not it holds a lease yet (stampOwner
// needs one and would leave the dir unstamped), and the commit's term is the
// stamp's.
function writeOwnerStamp(guildId: string, info: { shardId: number; term: number; epoch: number }): void {
  const dir = path.join(DATA_ROOT, guildId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path.join(dir, '.owner'), JSON.stringify({ guildId, shardId: info.shardId, nodeId: getNodeId(), term: info.term, epoch: info.epoch, updatedAt: Date.now() }, null, 2));
  } catch (error) {
    console.warn(`[Migration] Owner stamp for guild ${guildId} failed:`, error instanceof Error ? error.message : error);
  }
}

// Hash a leg's target STAGING (not the live dir) for the verify compare.
async function hashStaging(migrationId: string, legId: string, guilds: string[]): Promise<{ legHash: string; guildHashes: Record<string, string> }> {
  const { createHash } = await import('crypto');
  const legDir = incomingLegDir(migrationId, legId);
  const guildHashes: Record<string, string> = {};
  for (const guildId of guilds) {
    guildHashes[guildId] = await hashStagedGuild(path.join(legDir, guildId));
  }
  const legHash = createHash('sha256');
  for (const guildId of [...guilds].sort()) legHash.update(guildHashes[guildId]);
  return { legHash: legHash.digest('hex'), guildHashes };
}

// Content hash of a staged guild dir, identical formula to hashNamespace:
// sorted relPath, sha256(concat of relPath\nsize\nfileSha\n).
async function hashStagedGuild(base: string): Promise<string> {
  const { createHash } = await import('crypto');
  const { hashFileStreamed } = await import('../../utils/dataInterchange');
  const files: { relPath: string; size: number; sha256: string }[] = [];
  async function walk(rel: string): Promise<void> {
    const dir = rel ? path.join(base, rel) : base;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.owner' || entry.name === '.freeze' || entry.name.endsWith('.tmp')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) {
        try {
          const { size, sha256 } = await hashFileStreamed(path.join(base, ...childRel.split('/')));
          files.push({ relPath: childRel, size, sha256 });
        } catch { /* file vanished mid-walk */ }
      }
    }
  }
  await walk('');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.relPath, 'utf-8'), Buffer.from(b.relPath, 'utf-8')));
  const hash = createHash('sha256');
  for (const f of files) hash.update(`${f.relPath}\n${f.size}\n${f.sha256}\n`);
  return hash.digest('hex');
}

// One finish of a leg's staging at a time: the executor's commit (live, or
// from staging after a restart) and the master's boot resolver can each reach
// it, and two at once can each see a guild still staged, the later
// graveyarding the dir the earlier just renamed into place. A later caller
// runs after, on what is left.
const stagingCommits = new Map<string, Promise<unknown>>();
const unreadableStaging = new Set<string>();
function oneStagingFinishAtATime<T>(legDir: string, finish: () => Promise<T>): Promise<T> {
  const run = (stagingCommits.get(legDir) ?? Promise.resolve()).then(finish);
  const settled = run.catch(() => undefined);
  stagingCommits.set(legDir, settled);
  void settled.then(() => { if (stagingCommits.get(legDir) === settled) stagingCommits.delete(legDir); });
  return run;
}

// Idempotent commit from staging when there is no live runtime (crash-restart
// commit resolution). Mirrors commitTarget: intent -> per-guild rename + stamp.
export function commitFromStaging(migrationId: string, legId: string, term: number, epoch: number, named?: StagedLeg): Promise<boolean> {
  const legDir = incomingLegDir(migrationId, legId);
  return oneStagingFinishAtATime(legDir, () => finishStaging(legDir, migrationId, term, epoch, named));
}

/** The leg's guilds and shard as the master's commit names them. */
export interface StagedLeg {
  guilds: string[];
  shardId: number;
}

// True once the staging landed, or none is left (a finish already done). A
// manifest that cannot be read names no guilds: the commit's own list,
// sealed and verified before the decision, stands for it; without one,
// staging that holds no guild dir is a finish a crash cut short.
async function finishStaging(legDir: string, migrationId: string, term: number, epoch: number, named?: StagedLeg): Promise<boolean> {
  let manifest: any = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(legDir, '.manifest.json'), 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(legDir)) return true;
  }
  const readable = !!manifest && typeof manifest === 'object' && Array.isArray(manifest.guilds);
  const listed = readable ? [] : stagedGuildsIn(legDir);
  if (listed === null || (!readable && !named && listed.length > 0)) {
    unreadableOnce(legDir, listed === null ? 'it cannot be read' : 'its manifest cannot be read, so it names no guilds to land');
    return false;
  }
  const guilds: string[] = readable ? manifest.guilds : named?.guilds ?? listed;
  if (readable) {
    try {
      manifest.phase = 'commit-intent';
      manifest.commitTerm = term;
      manifest.commitEpoch = epoch;
      atomicWriteFileSync(path.join(legDir, '.manifest.json'), JSON.stringify(manifest, null, 2));
    } catch { /* best effort */ }
  }
  const shardId = readable ? (Number.isInteger(manifest.shardId) ? manifest.shardId : 0) : named?.shardId ?? 0;
  // Staged under an older term, the copy is the master's that prepared it:
  // its stamp keeps that term, so a superseded side's stale-copy reading
  // still retires it.
  const stampTerm = readable && Number.isInteger(manifest.term) && manifest.term > 0 ? Math.min(term, manifest.term) : term;
  const landed: string[] = [];
  try {
    for (const guildId of guilds) {
      const staged = path.join(legDir, guildId);
      if (!fs.existsSync(staged)) { landed.push(guildId); continue; }
      const live = path.join(DATA_ROOT, guildId);
      if (fs.existsSync(live)) await deleteGuildNamespace(guildId, `migration-${migrationId}-replaced`);
      await fs.promises.rename(staged, live);
      landed.push(guildId);
      writeOwnerStamp(guildId, { shardId, term: stampTerm, epoch });
    }
  } finally {
    noteGuildsCommittedHere(landed);
  }
  try { await fs.promises.rm(legDir, { recursive: true, force: true }); } catch { /* best effort */ }
  // Non-recursive: only reaps the migration dir once its last leg is gone.
  try { await fs.promises.rmdir(path.dirname(legDir)); } catch { /* other legs still staged */ }
  unreadableStaging.delete(legDir);
  return true;
}

/** The guild dirs a leg's staging holds; null when it cannot be read. */
function stagedGuildsIn(legDir: string): string[] | null {
  try {
    return fs.readdirSync(legDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => entry.name);
  } catch {
    return null;
  }
}

function unreadableOnce(legDir: string, why: string): void {
  if (unreadableStaging.has(legDir)) return;
  unreadableStaging.add(legDir);
  console.error(`[Migration] Staging ${legDir} cannot be committed: ${why}; the commit is answered not done`);
}

// Source-side graveyard + unfreeze for a leg's guilds, on its live runtime and
// with NO in-memory leg runtime (a RESTARTED source retried at reconnect), with
// its crash-resume marker. Fully idempotent: a guild already
// graveyarded (its /data dir gone) is treated as done, an already-unfrozen guild
// is a no-op. Returns the guilds still live that could not be moved, none when
// every named guild is provably gone/unfrozen (or was already), so the
// coordinator keeps the leg in pendingSourceCleanup, names them and retries.
async function commitSourceGuilds(migrationId: string, legId: string, guilds: string[]): Promise<string[]> {
  if (guilds.length === 0) return []; // nothing to clean up
  // Postgres-routed guilds have no on-disk originals: their cleanup is just
  // dropping any leftover working set, so a restarted source acks ok as a
  // natural no-op. Only file-routed guilds need the graveyard sequence.
  const ws = getWorkingSet();
  const fileGuilds: string[] = [];
  for (const guildId of guilds) {
    if (routeFor(guildId) === 'postgres') ws?.evict(guildId);
    else fileGuilds.push(guildId);
  }
  if (fileGuilds.length === 0) return [];
  const marker = sourceGraveyardMarker(migrationId, legId);
  try {
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    await fs.promises.writeFile(marker, JSON.stringify({ id: migrationId, phase: 'graveyarding', guilds: fileGuilds }), 'utf-8');
  } catch { /* best effort; boot resume only covers a crash after this point */ }
  const stuck: string[] = [];
  for (const guildId of fileGuilds) {
    await removeFreezeSentinel(guildId);
    unfreezeGuildWrites(guildId);
    const live = path.join(DATA_ROOT, guildId);
    const existed = fs.existsSync(live);
    const moved = await deleteGuildNamespace(guildId, `migration-${migrationId}-source-retired`);
    // existed && !moved => the dir is still live (rename kept failing): not done.
    if (existed && !moved) stuck.push(guildId);
  }
  // Only clear the resume marker once every guild is provably handled, so a
  // partial failure is finished by residueSweep.resumeSourceGraveyarding at boot.
  if (stuck.length === 0) { try { await fs.promises.unlink(marker); } catch { /* already gone */ } }
  return stuck;
}

// statfs free bytes; undefined when unsupported (tolerated with a UI warning).
async function statfsFree(dir: string): Promise<number | undefined> {
  try {
    const st = await (fs.promises as any).statfs(dir);
    if (st && Number.isFinite(st.bavail) && Number.isFinite(st.bsize)) return st.bavail * st.bsize;
  } catch { /* older node or unsupported fs */ }
  return undefined;
}

export { TRANSFER_PORT_DEFAULT };

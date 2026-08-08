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
import {
  deleteGuildNamespace,
  flushGuild,
  freezeGuildWrites,
  sizeOfGuildData,
  stampOwner,
  unfreezeGuildWrites,
} from '../../utils/dataManager';
import { hashLeg } from '../../utils/dataInterchange';
import { TRANSFER_PORT_DEFAULT, TRANSFER_TOKEN_TTL_MS, XFER_MAX_ROUNDS, XFER_DELTA_THRESHOLD_FILES, XFER_DIAL_RETRY_MS, XFER_DIAL_RETRY_WINDOW_MS } from '../constants';
import {
  MSG,
  XferAbortPayload,
  XferCommitPayload,
  XferDrainPayload,
  XferInventoryReply,
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
  direction: 'push' | 'pull';
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

  constructor(private readonly hooks: ExecutorHooks) {}

  /** Whether any leg runtime is live on this node (gates the periodic staging resolver). */
  hasActiveLegs(): boolean {
    return this.legs.size > 0;
  }

  /** Route a control frame from the master. Returns the ack payload (idempotent). */
  async handle(type: string, data: any): Promise<any> {
    switch (type) {
      case MSG.XFER_PREPARE: return this.onPrepare(data as XferPreparePayload);
      case MSG.XFER_DRAIN: return this.onDrain(data as XferDrainPayload);
      case MSG.XFER_COMMIT: return this.onCommit(data as XferCommitPayload);
      case MSG.XFER_ABORT: return this.onAbort(data as XferAbortPayload);
      case MSG.XFER_INVENTORY: return this.onInventory();
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
        // The target dialed us (pull): read its hello, then stream.
        ws.once('message', () => this.attachSender(leg, ws));
        // Also start immediately if no hello arrives; a hello is advisory.
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
      // Idempotent: a duplicate prepare re-registers the token but keeps the runtime.
      this.tokens.set(legInfo.token, {
        migrationId: payload.migrationId,
        legId: legInfo.legId,
        role: legInfo.role,
        expiresAt: Date.now() + TRANSFER_TOKEN_TTL_MS,
        spent: false,
      });
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
        });
      }
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
    if (payload.legs.some(l => l.role === 'target')) {
      freeBytes = await statfsFree(DATA_ROOT);
    }

    // Kick off the copy: dialers connect now; listeners wait for the inbound dial.
    for (const legInfo of payload.legs) {
      const leg = this.legs.get(legInfo.legId)!;
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
    for (const legId of payload.legIds) {
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
          const ok = await commitSourceGuilds(payload.migrationId, payload.guilds ?? []);
          if (!ok) allDone = false;
          continue;
        }
        // Target with commit-intent staging on disk is finished idempotently
        // from the staging manifest (also handled by the boot sweep).
        await commitFromStaging(payload.migrationId, legId, payload.term, payload.epoch);
        continue;
      }
      if (leg.committed) continue;
      if (leg.role === 'target') await this.commitTarget(leg, payload.term, payload.epoch);
      else await this.commitSource(leg);
      leg.committed = true;
      // Release the runtime so the lazy listener can unbind; a retried commit
      // lands in the no-runtime branch above, which is already idempotent.
      try { leg.ws?.close(); } catch { /* closing */ }
      this.legs.delete(legId);
      this.tokens.delete(leg.token);
    }
    this.maybeReleaseServer();
    return { ok: allDone, term: payload.term };
  }

  private async commitTarget(leg: LegRuntime, term: number, epoch: number): Promise<void> {
    await this.writeManifest(leg, 'commit-intent');
    const legDir = incomingLegDir(leg.migrationId, leg.legId);
    for (const guildId of leg.guilds) {
      const staged = path.join(legDir, guildId);
      if (!fs.existsSync(staged)) continue;
      const live = path.join(DATA_ROOT, guildId);
      if (fs.existsSync(live)) await deleteGuildNamespace(guildId, `migration-${leg.migrationId}-replaced`);
      await fs.promises.rename(staged, live);
      writeOwnerStamp(guildId, { shardId: leg.shardId, term, epoch });
    }
    try { await fs.promises.rm(legDir, { recursive: true, force: true }); } catch { /* best effort */ }
    // Non-recursive: only reaps the migration dir once its last leg is gone.
    try { await fs.promises.rmdir(path.dirname(legDir)); } catch { /* other legs still staged */ }
  }

  private async commitSource(leg: LegRuntime): Promise<void> {
    // Write the graveyard-resume marker BEFORE graveyarding so a crash mid-loop
    // is finished at boot by residueSweep.resumeSourceGraveyarding (it reads
    // {id, phase:'graveyarding', guilds}). Cleared after the loop completes.
    const marker = sourceGraveyardMarker(leg.migrationId);
    try {
      await fs.promises.mkdir(path.dirname(marker), { recursive: true });
      await fs.promises.writeFile(marker, JSON.stringify({ id: leg.migrationId, phase: 'graveyarding', guilds: leg.guilds }), 'utf-8');
    } catch { /* best effort; boot resume only covers a crash after this point */ }
    for (const guildId of leg.guilds) {
      await removeFreezeSentinel(guildId);
      unfreezeGuildWrites(guildId);
      await deleteGuildNamespace(guildId, `migration-${leg.migrationId}-source-retired`);
    }
    try { await fs.promises.unlink(marker); } catch { /* best effort; already gone or never written */ }
  }

  // ABORT is idempotent + retried while connected. TARGET: delete staging.
  // SOURCE: drop .freeze, unfreeze, KEEP originals.
  private async onAbort(payload: XferAbortPayload): Promise<any> {
    for (const [legId, leg] of this.legs) {
      if (leg.migrationId !== payload.migrationId) continue;
      leg.aborted = true;
      try { leg.ws?.close(); } catch { /* closing */ }
      await leg.receiver?.close();
      if (leg.role === 'target') {
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
    // Also purge whole-migration staging that has no runtime (crash-restart).
    try { await fs.promises.rm(path.join(DATA_ROOT, INCOMING_DIR, payload.migrationId), { recursive: true, force: true }); } catch { /* best effort */ }
    this.maybeReleaseServer();
    return { ok: true, term: payload.term };
  }

  private async onInventory(): Promise<XferInventoryReply> {
    // Post-P4 inventory reads each locally-owned guild's .owner + size.
    const guilds: XferInventoryReply['guilds'] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(DATA_ROOT).filter(n => /^\d+$/.test(n)); } catch { /* none */ }
    for (const guildId of names) {
      let ownerShardIdAtLastServe: number | undefined;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, guildId, '.owner'), 'utf-8'));
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

  private reportProgress(leg: LegRuntime, error?: string, progress?: { filesSent: number; bytesSent: number; deltaFiles: number }): void {
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

  private async writeManifest(leg: LegRuntime, phase: 'receiving' | 'verified' | 'commit-intent'): Promise<void> {
    if (leg.role !== 'target') return;
    const legDir = incomingLegDir(leg.migrationId, leg.legId);
    await fs.promises.mkdir(legDir, { recursive: true });
    const manifest = {
      migrationId: leg.migrationId,
      legId: leg.legId,
      sourceNodeId: '',
      shardId: leg.shardId,
      guilds: leg.guilds,
      phase,
    };
    try {
      await fs.promises.writeFile(path.join(legDir, '.manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    } catch { /* best effort; commit re-writes on retry */ }
  }
}

// ============================================================================
// Free-standing helpers (also used by the boot sweep resolution).
// ============================================================================

// Source graveyard-resume marker path (matches residueSweep's reader:
// /data/global/fleet/xfer-source-{id}.json).
function sourceGraveyardMarker(migrationId: string): string {
  return path.join(DATA_ROOT, 'global', 'fleet', `xfer-source-${migrationId}.json`);
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

// Direct .owner stamp with an explicit (shardId, term, epoch) - the committed
// target owns the data now, distinct from stampOwner's current-node provider.
function writeOwnerStamp(guildId: string, info: { shardId: number; term: number; epoch: number }): void {
  // stampOwner uses the ownerInfoProvider (this node's current identity), which
  // is exactly what the new owner needs; but its shard/epoch may lag the commit,
  // so write the authoritative manifest directly, then let stampOwner no-op.
  const dir = path.join(DATA_ROOT, guildId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Preserve nodeId from the current provider by delegating to stampOwner
    // first (fills nodeId/shardCount), then overwrite shard/term/epoch fields.
  } catch { /* ignore */ }
  stampOwner(guildId);
  try {
    const file = path.join(dir, '.owner');
    const existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
    existing.shardId = info.shardId;
    existing.term = info.term;
    existing.epoch = info.epoch;
    existing.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8');
  } catch { /* stampOwner's manifest stands if the overwrite fails */ }
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

// Idempotent commit from staging when there is no live runtime (crash-restart
// commit resolution). Mirrors commitTarget: intent -> per-guild rename + stamp.
export async function commitFromStaging(migrationId: string, legId: string, term: number, epoch: number): Promise<void> {
  const legDir = incomingLegDir(migrationId, legId);
  let manifest: any = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(legDir, '.manifest.json'), 'utf-8')); } catch { return; }
  try {
    manifest.phase = 'commit-intent';
    fs.writeFileSync(path.join(legDir, '.manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  } catch { /* best effort */ }
  const guilds: string[] = Array.isArray(manifest?.guilds) ? manifest.guilds : [];
  const shardId = Number.isInteger(manifest?.shardId) ? manifest.shardId : 0;
  for (const guildId of guilds) {
    const staged = path.join(legDir, guildId);
    if (!fs.existsSync(staged)) continue;
    const live = path.join(DATA_ROOT, guildId);
    if (fs.existsSync(live)) await deleteGuildNamespace(guildId, `migration-${migrationId}-replaced`);
    await fs.promises.rename(staged, live);
    writeOwnerStamp(guildId, { shardId, term, epoch });
  }
  try { await fs.promises.rm(legDir, { recursive: true, force: true }); } catch { /* best effort */ }
  // Non-recursive: only reaps the migration dir once its last leg is gone.
  try { await fs.promises.rmdir(path.dirname(legDir)); } catch { /* other legs still staged */ }
}

// Source-side graveyard + unfreeze for a leg's guilds when there is NO in-memory
// leg runtime (a RESTARTED source retried at reconnect). Mirrors commitSource's
// sequence and its crash-resume marker, and is fully idempotent: a guild already
// graveyarded (its /data dir gone) is treated as done, an already-unfrozen guild
// is a no-op. Returns true only when every named guild is provably gone/unfrozen
// (or was already), false when a guild still exists live and could not be moved,
// so the coordinator keeps the leg in pendingSourceCleanup and retries.
async function commitSourceGuilds(migrationId: string, guilds: string[]): Promise<boolean> {
  if (guilds.length === 0) return true; // nothing to clean up
  const marker = sourceGraveyardMarker(migrationId);
  try {
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    await fs.promises.writeFile(marker, JSON.stringify({ id: migrationId, phase: 'graveyarding', guilds }), 'utf-8');
  } catch { /* best effort; boot resume only covers a crash after this point */ }
  let allDone = true;
  for (const guildId of guilds) {
    await removeFreezeSentinel(guildId);
    unfreezeGuildWrites(guildId);
    const live = path.join(DATA_ROOT, guildId);
    const existed = fs.existsSync(live);
    const moved = await deleteGuildNamespace(guildId, `migration-${migrationId}-source-retired`);
    // existed && !moved => the dir is still live (rename kept failing): not done.
    if (existed && !moved) allDone = false;
  }
  // Only clear the resume marker once every guild is provably handled, so a
  // partial failure is finished by residueSweep.resumeSourceGraveyarding at boot.
  if (allDone) { try { await fs.promises.unlink(marker); } catch { /* already gone */ } }
  return allDone;
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

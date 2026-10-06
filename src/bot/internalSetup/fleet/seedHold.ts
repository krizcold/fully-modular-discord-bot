// The seed hold (B4f-3, PLAN_REPLICATION 20.20): a file-mode master that
// holds no guild data and finds the fleet's term on the witness, beaconed by a
// backup and by no live master, holds instead of parking. It registers
// designated backups on its control channel (no leases), asks each for the
// copy it holds, and once the operator confirms one it takes the push over
// the transfer channel, verifies it against the backup's hashes, lands it in
// the mirror layout and runs the B4f-2 adopt, pin and seed before the restart
// that mints above every beacon and serves. The hold's other exits: Demote,
// the brand-new-fleet confirmation, FLEET_CONFIRM_TAKEOVER=1 plus a restart.

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { WebSocket } from 'ws';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import {
  FILE_PROMOTE_TERM_MARGIN,
  FLEET_DIR,
  MIRROR_DOC_NAMES,
  PROTOCOL_VERSION,
  SEED_OFFER_REFRESH_MS,
  SEED_OFFER_TIMEOUT_MS,
  SEED_REPORT_WAIT_MS,
  TERM_GUARD_POLL_MS,
  TRANSFER_TOKEN_TTL_MS,
  WITNESS_FRESH_WINDOW_MS,
  WITNESS_RENEW_MS,
  XFER_DIAL_RETRY_WINDOW_MS,
  XFER_STALL_TIMEOUT_MS,
} from './constants';
import { ControlServer } from './controlServer';
import type { PersistedFleetConfig, PersistedTerm } from './controlStore';
import { adoptMirror, clearAdoptMarker, finishAdopt, pinPlacement, pinRecordsText, recordsFault, seedTerm } from './fileFailover';
import { atomicWriteFileSync, renameWithRetry } from './fileControlStore';
import { readHolderSighting } from './holderSighting';
import { incomingLegDir, TransferReceiver, TransferServer } from './migration/transferChannel';
import { MirrorManifest, mirrorDocsDir, mirrorGuildDir, mirrorManifestFile, mirrorRoot, readMirrorManifest } from './mirrorEngine';
import { rawMasterUrls, writeRoleOverride } from './nodeIdentity';
import { MSG, RegisterPayload, RegisterResult, SeedCopyKind, SeedOffer, SeedOfferGuild, SeedOfferReply, SeedReportPayload } from './protocol';
import { _setSeedHold, SeedHoldBackupView, SeedHoldView, SeedPushProgressView } from './state';
import { clearFreshFleetConfirm, hasFreshFleetConfirm } from './stepDown';
import type { FleetWitness, WitnessClaim } from './witness';
import { hashNamespaceAt } from '../utils/dataInterchange';

const isGuildId = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// The seed record: the master's own account of a seed, so a restart finishes
// what the verify committed to and the new master later names the copy spent
// and the copy's source superseded in their register replies.
// ============================================================================

export type SeedPhase = 'push' | 'adopt' | 'pin' | 'seed' | 'done';

export interface SeedRecord {
  seedId: string;
  phase: SeedPhase;
  kind: SeedCopyKind;
  backupNodeId: string;
  backupNodeName: string;
  sourceNodeId: string;
  sourceNodeName: string;
  sourceTerm: number;
  completedAt: number | null;
  /** The highest term known when the seed was confirmed (the copy's source, every beacon): the seed's floor before the margin. */
  floor: number;
  guilds: string[];
  startedAt: number;
  updatedAt: number;
  /** The copy's source has registered and taken the superseded fact. */
  supersededDelivered: boolean;
  /** The backup has registered and been told its mirror copy is spent. */
  copyReleased: boolean;
  /** A live master the hold saw while this seed was stalled after its landing: the seed is not finished over it. */
  liveSeen: { nodeId: string; nodeName: string; term: number; at: number } | null;
}

const PHASES: SeedPhase[] = ['push', 'adopt', 'pin', 'seed', 'done'];
const recordFile = () => dataPath('global', FLEET_DIR, 'seed.json');

/**
 * The record on disk still names this seed. An unreadable file counts as
 * present: a transient fault must not stop a healthy seed or pass for a
 * Demote, which is the one thing that clears the record under a lane.
 */
export function seedRecordOnDisk(seedId: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(recordFile(), 'utf-8')) as { seedId?: unknown }).seedId === seedId;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export function readSeedRecord(): SeedRecord | null {
  const parsed = readJson<SeedRecord>(recordFile());
  if (!parsed || !PHASES.includes(parsed.phase) || typeof parsed.seedId !== 'string' || parsed.seedId === '') return null;
  if (typeof parsed.sourceNodeId !== 'string' || typeof parsed.backupNodeId !== 'string' || !Array.isArray(parsed.guilds)) return null;
  return {
    seedId: parsed.seedId,
    phase: parsed.phase,
    kind: parsed.kind === 'live' ? 'live' : 'mirror',
    backupNodeId: parsed.backupNodeId,
    backupNodeName: typeof parsed.backupNodeName === 'string' ? parsed.backupNodeName : parsed.backupNodeId.slice(0, 8),
    sourceNodeId: parsed.sourceNodeId,
    sourceNodeName: typeof parsed.sourceNodeName === 'string' ? parsed.sourceNodeName : parsed.sourceNodeId.slice(0, 8),
    sourceTerm: Number.isFinite(parsed.sourceTerm) ? Number(parsed.sourceTerm) : 0,
    completedAt: Number.isFinite(parsed.completedAt) ? Number(parsed.completedAt) : null,
    floor: Number.isFinite(parsed.floor) ? Number(parsed.floor) : 0,
    guilds: parsed.guilds.filter(isGuildId),
    startedAt: Number(parsed.startedAt) || 0,
    updatedAt: Number(parsed.updatedAt) || 0,
    supersededDelivered: parsed.supersededDelivered === true,
    copyReleased: parsed.copyReleased === true,
    liveSeen: parsed.liveSeen && typeof parsed.liveSeen.nodeId === 'string' && Number.isFinite(parsed.liveSeen.term)
      ? { nodeId: parsed.liveSeen.nodeId, nodeName: typeof parsed.liveSeen.nodeName === 'string' ? parsed.liveSeen.nodeName : parsed.liveSeen.nodeId.slice(0, 8), term: Number(parsed.liveSeen.term), at: Number(parsed.liveSeen.at) || 0 }
      : null,
  };
}

export function writeSeedRecord(record: SeedRecord): void {
  atomicWriteFileSync(recordFile(), JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2));
}

/**
 * Another node has held the fleet since this seed began: the hold saw it
 * live while the seed stalled, or this node sighted it holding (the rule
 * the B4f-2 promote resume applies). Finishing the seed would stage a
 * takeover from that node.
 */
export function seedSupersededBy(record: SeedRecord, selfNodeId: string): { nodeId: string; nodeName: string; term: number } | null {
  if (record.liveSeen) return record.liveSeen;
  const seen = readHolderSighting();
  return seen && seen.nodeId !== selfNodeId && seen.seenAt >= record.startedAt ? { nodeId: seen.nodeId, nodeName: `node ${seen.nodeId.slice(0, 8)}`, term: seen.term } : null;
}

export function clearSeedRecord(): void {
  fs.rmSync(recordFile(), { force: true });
}

/**
 * A seed short of done ends with this node's master identity (a Demote) or
 * with a seize over it: left on disk, the record would re-run its adopt at a
 * later master boot and put the source's documents and copy back over the
 * fleet served since, and the adopt marker would stop a backup's mirror
 * ticks. What the adopt moved into the live tree stays as this node's
 * residue. Returns the record abandoned, or null when none or done.
 */
export function abandonSeedRecord(): SeedRecord | null {
  const record = readSeedRecord();
  if (!record || record.phase === 'done') return null;
  clearSeedRecord();
  clearAdoptMarker();
  fs.rmSync(mirrorRoot(), { recursive: true, force: true });
  return record;
}

// ============================================================================
// The verdict: when a park on a higher beacon is a seed hold instead.
// ============================================================================

/** The highest-term FRESH claim of another node serving the fleet (a master, or a stand-in). */
export function liveMasterClaim(claims: WitnessClaim[], selfNodeId: string, now: number): WitnessClaim | null {
  let best: WitnessClaim | null = null;
  for (const claim of claims) {
    if (claim.nodeId === selfNodeId) continue;
    if (claim.role !== 'master' && claim.standingInFor === undefined) continue;
    if (now - claim.observedAt > WITNESS_FRESH_WINDOW_MS) continue;
    if (!best || claim.term > best.term) best = claim;
  }
  return best;
}

/**
 * The guild data this node holds: live guild dirs under the data root, or a
 * complete mirror copy of its own (a designated backup switched to master by
 * env: its copy is adopted by Promote, never seeded over). A root that cannot
 * be read holds data as far as the hold is concerned: a stale fork must never
 * hold and be confirmed brand-new on a disk fault.
 */
export function hasGuildData(): boolean {
  if (readMirrorManifest()?.completedAt != null) return true;
  try {
    return fs.readdirSync(DATA_ROOT, { withFileTypes: true }).some(e => e.isDirectory() && isGuildId(e.name));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * A higher beacon on the witness parks a file-mode master boot; it holds to be
 * seeded instead when this node has no guild data to fork and no other node
 * serves the fleet right now. A dead master's last beacon is stale and does
 * not count as serving; a stand-in's does.
 */
export function seedHoldApplies(claims: WitnessClaim[], selfNodeId: string, now: number): boolean {
  return liveMasterClaim(claims, selfNodeId, now) === null && !hasGuildData();
}

// ============================================================================
// The finishing phases, shared by the lane and the boot resume.
// ============================================================================

/**
 * The B4f-2 phases on the landed copy, idempotent on the disk they find:
 * adopt the guild dirs, pin the plan with the source's shards on this node,
 * seed term.json above everything known by the margin, drop the mirror tree,
 * stage the takeover override. The record advances after each, so a restart
 * re-enters at the phase that did not complete.
 */
export async function finishSeed(record: SeedRecord, selfNodeId: string): Promise<void> {
  // A Demote clears the record before it stages its own override
  // (lifecycleActions): a lane whose record is gone writes neither the
  // record back nor an override over the demote's.
  const stillOnDisk = (): void => {
    if (!seedRecordOnDisk(record.seedId)) throw new Error('the seed record was cleared meanwhile (a Demote abandons the seed); the seed stops here');
  };
  if (record.phase === 'adopt') {
    const adopted = await adoptMirror(selfNodeId);
    console.warn(`[Fleet] SEED adopt: ${adopted.adopted} guild(s) taken from ${record.backupNodeName}'s copy, ${adopted.kept} already this node's, ${adopted.graveyarded} live dir(s) graveyarded first, ${adopted.skipped} without a copy`);
    stillOnDisk();
    record.phase = 'pin';
    writeSeedRecord(record);
  }
  if (record.phase === 'pin') {
    const pinned = await pinPlacement(selfNodeId, record.sourceNodeId, true);
    console.warn(`[Fleet] SEED pin: shard(s) [${pinned.movedShards.join(', ')}] of ${record.sourceNodeName} pinned to this node${pinned.removed.length > 0 ? `; stale records removed: ${pinned.removed.join(', ')}` : ''}${pinRecordsText(pinned)}`);
    repointPinnedConfig();
    stillOnDisk();
    record.phase = 'seed';
    writeSeedRecord(record);
  }
  if (record.phase === 'seed') {
    const term = seedTerm(record.sourceNodeId, record.floor + FILE_PROMOTE_TERM_MARGIN);
    console.warn(`[Fleet] SEED term: term.json holds ${term} under ${record.sourceNodeName}'s id; the boot mints ${term + 1}`);
    finishAdopt();
    // The override goes before the record says done: a restart between the
    // two re-runs this phase, which rewrites both.
    stillOnDisk();
    writeRoleOverride({ role: 'master', takeover: true, setAt: Date.now(), setBy: 'webui-seed' });
    record.phase = 'done';
    writeSeedRecord(record);
    // The seed answered the hold; a brand-new-fleet confirm left behind
    // would release a later hold of this node on its first check.
    clearFreshFleetConfirm();
  }
}

/**
 * The pinned fleet config is the dead master's: its master list names that
 * master's address, and the stored list owns the topology, so the backup
 * would be pushed back to it at the first register. This node's own
 * addresses go first (its advertised URL, then its env list) and the
 * revision moves, so the push lands. With no address known the list stays,
 * which is right when this machine reuses the old master's name.
 */
function repointPinnedConfig(): void {
  const own = [(process.env.FLEET_PUBLIC_URL || '').trim(), ...rawMasterUrls()].filter(url => url !== '');
  if (own.length === 0) {
    console.warn('[Fleet] SEED pin: this node advertises no address (FLEET_PUBLIC_URL, MASTER_URLS), so the pinned master list stays the old master\'s; a backup dialing that address finds this node only if this machine reuses it');
    return;
  }
  const file = dataPath('global', FLEET_DIR, 'fleet-config.json');
  const config = readJson<PersistedFleetConfig>(file);
  if (!config || !Array.isArray(config.masterCandidates)) return;
  const rest = config.masterCandidates.filter(url => !own.includes(url));
  const candidates = [...own.filter((url, i) => own.indexOf(url) === i), ...rest];
  if (candidates.join('|') === config.masterCandidates.join('|')) return;
  atomicWriteFileSync(file, JSON.stringify({ ...config, masterCandidates: candidates, revision: (Number(config.revision) || 0) + 1, updatedAt: Date.now() }, null, 2));
  console.warn(`[Fleet] SEED pin: the master list now leads with this node (${own.join(' | ')}); revision ${(Number(config.revision) || 0) + 1}`);
}

/**
 * term.json floored at the fleet's highest beaconed term under this node, so
 * the boot mints above it: the brand-new release and the seize (a master in
 * file mode below the backups' echo would step down on their fresh beacons
 * within seconds). A row already at or above it, under any node, stays.
 */
export function floorTermAbove(selfNodeId: string, term: number): void {
  const file = dataPath('global', FLEET_DIR, 'term.json');
  const current = readJson<PersistedTerm>(file);
  if (current && Number.isFinite(current.term) && current.term >= term) return;
  atomicWriteFileSync(file, JSON.stringify({ term, nodeId: selfNodeId, updatedAt: Date.now() }, null, 2));
}

let interruptedNote: string | null = null;

/**
 * At a master boot, before the fence: a seed that got past its verify is
 * finished (the boot then runs as the staged takeover it wrote); one caught
 * before its verify is discarded, and the hold that re-forms says so.
 */
export async function resumeSeed(selfNodeId: string, seize = false): Promise<void> {
  const record = readSeedRecord();
  if (!record) return;
  if (record.phase === 'push') {
    fs.rmSync(path.join(DATA_ROOT, '_incoming', record.seedId), { recursive: true, force: true });
    fs.rmSync(mirrorRoot(), { recursive: true, force: true });
    clearSeedRecord();
    interruptedNote = `A seed from ${record.backupNodeName}'s copy was interrupted by a restart before it verified; nothing was adopted. Confirm it again.`;
    console.warn(`[Fleet] Seed ${record.seedId} from ${record.backupNodeName} was interrupted before its verify; its staging is discarded`);
    return;
  }
  if (record.phase === 'done') return;
  const seen = seize ? null : seedSupersededBy(record, selfNodeId);
  if (seen) {
    console.error(`[Fleet] Seed ${record.seedId} from ${record.backupNodeName} is not resumed: ${seen.nodeName} has held the fleet at term ${seen.term} since it began, and finishing it would stage a takeover from that node; the fence parks this boot`);
    return;
  }
  console.warn(`[Fleet] Resuming seed ${record.seedId} from ${record.backupNodeName} at phase ${record.phase}`);
  await finishSeed(record, selfNodeId);
}

/** Child to parent: the seed is adopted and the takeover override staged; restart me as the seeded master. */
function requestSeededRestart(): void {
  if (!process.send) return;
  try { process.send({ type: 'fleet:seeded' }); } catch { /* the hold keeps the view; the operator can restart by hand */ }
}

// ============================================================================
// The hold runtime.
// ============================================================================

export interface SeedHoldOptions {
  selfNodeId: string;
  selfNodeName: string;
  appVersion: string;
  controlPort: number;
  secret: string;
  transferPort: number;
  /** This node's advertised transfer endpoint (TRANSFER_URL); null when unset, which blocks the confirm. */
  transferUrl: string | null;
  /** This node's advertised control endpoint (FLEET_PUBLIC_URL), for the text that tells the operator where to point the backup. */
  controlUrl: string | null;
  localTerm: number;
  claims: WitnessClaim[];
  witness: FleetWitness | null;
  pushStatus: () => void;
  /** The fence's terminal park, for a live master appearing while the hold stands. */
  park: (live: WitnessClaim) => Promise<never>;
}

interface BackupEntry {
  nodeId: string;
  nodeName: string;
  connected: boolean;
  offer: SeedOffer | null;
  offerReason: string | null;
  offerAt: number | null;
  offerPending: boolean;
}

interface SeedLane {
  record: SeedRecord;
  token: string;
  tokenSpent: boolean;
  expiresAt: number;
  transfer: TransferServer;
  receiver: TransferReceiver | null;
  ws: WebSocket | null;
  phase: SeedPushProgressView['phase'];
  round: number;
  filesSent: number;
  bytesSent: number;
  finalLanded: boolean;
  sourceHashes: Record<string, string> | null;
  verifying: boolean;
  failed: boolean;
  /** Set when the finishing phases threw after the copy landed: the record resumes them at the next boot. */
  stalled: string | null;
  dialTimer: NodeJS.Timeout | null;
  reportTimer: NodeJS.Timeout | null;
  /** The last transfer frame, report or heartbeat from the backup. */
  lastActivityAt: number;
  stallTimer: NodeJS.Timeout | null;
}

function sanitizeOffer(raw: unknown): SeedOffer | null {
  const offer = raw as SeedOffer;
  if (!offer || typeof offer !== 'object') return null;
  if (offer.kind !== 'mirror' && offer.kind !== 'live') return null;
  if (typeof offer.sourceNodeId !== 'string' || offer.sourceNodeId === '') return null;
  if (!Array.isArray(offer.guilds) || !offer.documents || typeof offer.documents !== 'object') return null;
  const guilds: SeedOfferGuild[] = [];
  const seen = new Set<string>();
  let partialCount = 0;
  let totalBytes = 0;
  for (const g of offer.guilds) {
    if (!g || !isGuildId(g.guildId) || seen.has(g.guildId)) return null;
    if (g.hash !== null && typeof g.hash !== 'string') return null;
    const bytes = Number.isFinite(g.bytes) && g.bytes >= 0 ? Number(g.bytes) : 0;
    seen.add(g.guildId);
    // A live offer hashes nothing up front (the hashes come with the push's
    // final report); only a mirror's null hash is a partial copy.
    if (g.hash === null && offer.kind === 'mirror') partialCount += 1;
    totalBytes += bytes;
    guilds.push({ guildId: g.guildId, hash: g.hash, bytes });
  }
  const documents: Record<string, string> = {};
  for (const name of MIRROR_DOC_NAMES) {
    const body = (offer.documents as Record<string, unknown>)[name];
    if (typeof body === 'string') documents[name] = body;
  }
  if (documents['leases.json'] === undefined || documents['fleet-config.json'] === undefined) return null;
  return {
    kind: offer.kind,
    sourceNodeId: offer.sourceNodeId,
    sourceNodeName: typeof offer.sourceNodeName === 'string' && offer.sourceNodeName !== '' ? offer.sourceNodeName : offer.sourceNodeId.slice(0, 8),
    sourceTerm: Number.isFinite(offer.sourceTerm) && offer.sourceTerm >= 0 ? Number(offer.sourceTerm) : 0,
    completedAt: Number.isFinite(offer.completedAt) ? Number(offer.completedAt) : null,
    ageMs: Number.isFinite(offer.ageMs) ? Math.max(0, Number(offer.ageMs)) : null,
    guilds,
    partialCount,
    totalBytes,
    documents,
  };
}

/**
 * Why an offer's migration records cannot be carried over, judged as the
 * backup judges its copy before offering it: one on a build without that
 * judgement would leave the pin refusing them after the adopt, which
 * cannot be undone. Null when they can or the copy has none.
 */
export function offerRecordsRefusal(offer: SeedOffer): string | null {
  const body = offer.documents['migrations.json'];
  const fault = body === undefined ? null : recordsFault(body, offer.documents['leases.json'] ?? '');
  if (fault === null) return null;
  const what = fault === 'parse' ? 'do not parse' : fault === 'together' ? 'do not hold together' : 'were listed with another plan than its leases.json';
  return `the migration records of its copy (migrations.json) ${what}, so ${offer.sourceNodeName}'s holds, owed cleanups and running migration cannot be carried over; update it to this master's build, which judges its copy before offering it`;
}

export interface SeedConfirmResult {
  success: boolean;
  needsConfirm?: boolean;
  error?: string;
}

class SeedHoldRuntime {
  private readonly backups = new Map<string, BackupEntry>();
  private server: ControlServer | null = null;
  /** The term the hold's channel answers with, fixed for the hold: every registered backup's term fence rests on it. */
  private readonly serverTerm: number;
  /** The highest term any beacon has shown, followed while the hold stands: the seed's floor. */
  private beaconMax: number;
  private beaconedBy: string | null = null;
  private lane: SeedLane | null = null;
  private lastError: string | null = null;
  private lastPublished: string | null = null;
  private readonly since = Date.now();
  private stopped = false;
  /** Parked or released: the view is cleared and nothing publishes it again (a socket close after the stop would). */
  private closed = false;

  constructor(private readonly opts: SeedHoldOptions) {
    let max = opts.localTerm;
    for (const claim of opts.claims) {
      if (claim.nodeId !== opts.selfNodeId && claim.term > max) {
        max = claim.term;
        this.beaconedBy = claim.nodeName;
      }
    }
    this.beaconMax = max;
    this.serverTerm = max;
  }

  async run(): Promise<'released'> {
    await this.startServer();
    this.publish(true);
    let lastRead = Date.now();
    for (;;) {
      if (this.stopped) {
        // The seed is done and the restart asked for: nothing left to judge.
        await sleep(TERM_GUARD_POLL_MS);
        continue;
      }
      if (hasFreshFleetConfirm()) {
        const released = this.lane ? null : await this.release();
        if (released) return released;
        if (this.lane) {
          // A seed is running (or was confirmed while the release read the
          // witness): the confirm answers nothing here, and left on disk it
          // would release the next hold of this node on its first check.
          clearFreshFleetConfirm();
          console.warn('[Fleet] Seed hold: a brand-new-fleet confirmation arrived while a seed runs; cleared, the seed decides');
        }
      }
      if (this.opts.witness && Date.now() - lastRead >= WITNESS_RENEW_MS) {
        lastRead = Date.now();
        let claims: WitnessClaim[] | null = null;
        try { claims = await this.opts.witness.readClaims(); } catch { claims = null; }
        if (claims) {
          this.noteBeacons(claims);
          const live = liveMasterClaim(claims, this.opts.selfNodeId, Date.now());
          // A master alive after all ends the hold: the fleet is served, and
          // this node must not seed itself beside it. A seed already landing
          // (adopting, restarting) is left to the fence of the boot it stages,
          // which parks a staged takeover on a fresh foreign master beacon.
          if (live && (!this.lane || this.lane.phase === 'dialing' || this.lane.phase === 'copying' || this.lane.phase === 'verifying' || this.lane.stalled !== null)) {
            await this.parkOnLive(live);
          }
        }
      }
      for (const entry of this.backups.values()) {
        if (entry.connected && !entry.offerPending && (entry.offerAt === null || Date.now() - entry.offerAt >= SEED_OFFER_REFRESH_MS)) void this.askOffer(entry.nodeId);
      }
      this.publish();
      await sleep(TERM_GUARD_POLL_MS);
    }
  }

  private async startServer(): Promise<void> {
    const server = new ControlServer({
      getTerm: () => this.serverTerm,
      getNodeId: () => this.opts.selfNodeId,
      getNodeName: () => this.opts.selfNodeName,
      getSeedHold: () => true,
      onRegister: (payload: RegisterPayload): RegisterResult => this.onRegister(payload),
      afterRegister: nodeId => void this.askOffer(nodeId),
      onHeartbeat: nodeId => {
        const entry = this.backups.get(nodeId);
        if (entry) entry.connected = true;
        if (this.lane && this.lane.record.backupNodeId === nodeId) this.lane.lastActivityAt = Date.now();
      },
      onGuildNotice: () => { /* no shards are held here */ },
      onLeaseRenew: () => ({ ok: false, term: this.serverTerm, epoch: 0, reason: 'seed-hold' }),
      onDisconnect: nodeId => {
        const entry = this.backups.get(nodeId);
        if (entry) entry.connected = false;
        this.publish();
      },
      // The backup keeps its copy and its view says why: a mirror listing from
      // here reads as held, not refused, and a sync pull as unavailable.
      onSyncRequest: (_nodeId, type) => Promise.reject(new Error(type === MSG.MIRROR_LIST || type === MSG.MIRROR_READ
        ? 'mirror-seed-hold: this master holds to be seeded and copies nothing yet'
        : 'seed-hold: this master serves no sync while it holds to be seeded')),
      onSeedReport: (nodeId, data) => this.onReport(nodeId, data as SeedReportPayload),
    });
    for (;;) {
      try {
        await server.start(this.opts.controlPort, this.opts.secret);
        break;
      } catch (error) {
        // A predecessor process may still hold the port; the hold is patient.
        console.warn(`[Fleet] Seed hold: control port ${this.opts.controlPort} not yet bindable (${error instanceof Error ? error.message : error}); retrying`);
        await sleep(TERM_GUARD_POLL_MS);
      }
    }
    this.server = server;
  }

  private stopServer(): void {
    try { this.server?.stop(); } catch { /* closing */ }
    this.server = null;
  }

  private onRegister(payload: RegisterPayload): RegisterResult {
    const refuse = (reason: string): RegisterResult => {
      console.warn(`[Fleet] Seed hold refused registration of ${payload?.nodeName ?? payload?.nodeId ?? '?'}: ${reason}`);
      return { accepted: false, term: this.serverTerm, reason };
    };
    if (!payload || typeof payload.nodeId !== 'string' || payload.nodeId.length === 0) return refuse('invalid-register-payload');
    if (payload.protocolVersion !== PROTOCOL_VERSION) return refuse(`protocol-version-mismatch (master ${PROTOCOL_VERSION})`);
    if (payload.appVersion !== this.opts.appVersion) return refuse(`app-version-mismatch (master ${this.opts.appVersion})`);
    if (payload.nodeId === this.opts.selfNodeId) return refuse('node-id-collision-with-master');
    if (payload.capabilities?.backupMaster !== true) return refuse('seed-hold: this master holds to be seeded from a designated backup and registers designated backups only (BOT_NODE_ROLE=backup-master)');
    // The reply carries no backend, which a co-worker reads as file mode and
    // persists; a postgres fleet's backup has nothing this hold could adopt.
    if (payload.capabilities?.dataBackend !== 'file') return refuse('seed-hold: this master seeds file-mode guild data and registers file-mode backups only');
    // Every build reports the same app and protocol versions, so the seed's
    // own flag is what tells a backup that can answer from one that cannot.
    if (payload.capabilities?.seedSource !== true) return refuse('seed-hold: this backup runs a build without the seed of a new master; update it to the master\'s build, then it offers its copy here');
    const entry: BackupEntry = this.backups.get(payload.nodeId) ?? { nodeId: payload.nodeId, nodeName: payload.nodeName || payload.nodeId, connected: true, offer: null, offerReason: null, offerAt: null, offerPending: false };
    entry.nodeName = payload.nodeName || payload.nodeId;
    entry.connected = true;
    // Asked again on every registration: the copy may have changed meanwhile.
    entry.offerAt = null;
    this.backups.set(payload.nodeId, entry);
    console.log(`[Fleet] Seed hold: backup ${entry.nodeName} (${payload.nodeId}) registered; asking what copy it holds`);
    this.publish();
    return { accepted: true, term: this.serverTerm, seedHold: true };
  }

  private async askOffer(nodeId: string): Promise<void> {
    const entry = this.backups.get(nodeId);
    if (!entry || entry.offerPending || !entry.connected || !this.server) return;
    entry.offerPending = true;
    try {
      const reply = await this.server.request(nodeId, MSG.SEED_OFFER, { term: this.serverTerm }, SEED_OFFER_TIMEOUT_MS) as SeedOfferReply;
      const offer = reply && reply.ok !== false ? sanitizeOffer(reply.offer) : null;
      const unfit = offer ? offerRecordsRefusal(offer) : null;
      entry.offer = unfit === null ? offer : null;
      entry.offerReason = unfit ?? (offer ? null : typeof reply?.reason === 'string' ? reply.reason : reply?.offer ? 'its offer was malformed' : 'no copy offered');
    } catch (error) {
      entry.offer = null;
      entry.offerReason = `its offer could not be read: ${error instanceof Error ? error.message : error}`;
    }
    entry.offerAt = Date.now();
    entry.offerPending = false;
    this.publish();
  }

  /** The operator's confirm from the Fleet tab (IPC fleet:seed). */
  confirm(nodeId: string, confirmed: boolean): SeedConfirmResult {
    if (this.stopped) return { success: false, error: 'the seed is done; this node is restarting as master' };
    if (this.closed) return { success: false, error: 'the hold has ended (this node parked on a live master, or the brand-new fleet was confirmed)' };
    if (this.lane && !this.lane.failed) return { success: false, error: `a seed from ${this.lane.record.backupNodeName} is already running (${this.lane.phase})` };
    const entry = this.backups.get(nodeId);
    if (!entry) return { success: false, error: 'that backup has not registered here' };
    if (!entry.connected) return { success: false, error: `${entry.nodeName} is not connected to this node now` };
    if (!entry.offer) return { success: false, error: `${entry.nodeName} offers no copy${entry.offerReason ? `: ${entry.offerReason}` : ''}` };
    if (this.opts.transferUrl === null) return { success: false, error: 'TRANSFER_URL is not set on this node; the backup pushes the copy to that address, so set it and restart this bot before confirming a seed' };
    const offer = entry.offer;
    if (!confirmed) {
      const mb = (offer.totalBytes / 1048576).toFixed(1);
      const what = offer.kind === 'mirror'
        ? `copy of ${offer.sourceNodeName}'s guild data (term ${offer.sourceTerm}), last complete ${offer.ageMs === null ? 'at an unknown time' : `${Math.round((offer.ageMs + Math.max(0, Date.now() - (entry.offerAt ?? Date.now()))) / 1000)}s ago`}`
        : `own guild data from its mastership at term ${offer.sourceTerm} (live, as it stands now)`;
      const partial = offer.partialCount > 0 ? `; ${offer.partialCount} guild(s) are partial, their copy mixing files from before and after that point` : '';
      return {
        success: false,
        needsConfirm: true,
        error: `Seed this master from ${entry.nodeName}'s ${what} (${offer.guilds.length} guild(s), ${mb} MB${partial})? Everything the old master wrote after that point is LOST. This machine adopts the copy as the fleet's guild data, pins the shard plan to itself, mints a term above every beacon and restarts as master; ${entry.nodeName} then ${offer.kind === 'mirror' ? 'drops the copy and mirrors this master' : 'retires its old copies from its Fleet tab and, if the pinned fleet config (its own, carried with the copy) designates it as a backup, mirrors this master; otherwise designate it from this master\'s Fleet tab first'}.`,
      };
    }
    void this.startLane(entry, offer);
    return { success: true };
  }

  private async startLane(entry: BackupEntry, offer: SeedOffer): Promise<void> {
    const now = Date.now();
    const seedId = `seed-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
    const token = randomBytes(24).toString('hex');
    const guilds = offer.guilds.map(g => g.guildId);
    const record: SeedRecord = {
      seedId,
      phase: 'push',
      kind: offer.kind,
      backupNodeId: entry.nodeId,
      backupNodeName: entry.nodeName,
      sourceNodeId: offer.sourceNodeId,
      sourceNodeName: offer.sourceNodeName,
      sourceTerm: offer.sourceTerm,
      completedAt: offer.completedAt,
      floor: Math.max(offer.sourceTerm, this.beaconMax),
      guilds,
      startedAt: now,
      updatedAt: now,
      supersededDelivered: false,
      copyReleased: false,
      liveSeen: null,
    };
    const lane: SeedLane = {
      record, token, tokenSpent: false, expiresAt: now + TRANSFER_TOKEN_TTL_MS,
      transfer: new TransferServer({
        authorize: provided => {
          if (provided !== token || lane.tokenSpent || Date.now() > lane.expiresAt) return null;
          lane.tokenSpent = true;
          return { migrationId: seedId, legId: 'copy', role: 'target' };
        },
        onPushConnected: (_legId, ws) => this.attachReceiver(lane, ws),
      }),
      receiver: null, ws: null, phase: 'dialing', round: 0, filesSent: 0, bytesSent: 0,
      finalLanded: false, sourceHashes: null, verifying: false, failed: false, stalled: null, dialTimer: null, reportTimer: null,
      lastActivityAt: now, stallTimer: null,
    };
    this.lane = lane;
    this.lastError = null;
    try {
      // The documents land first, in the mirror layout the adopt reads, so a
      // seed resumed after a crash past its verify has them.
      fs.rmSync(mirrorRoot(), { recursive: true, force: true });
      fs.mkdirSync(mirrorDocsDir(), { recursive: true });
      for (const [name, body] of Object.entries(offer.documents)) atomicWriteFileSync(path.join(mirrorDocsDir(), name), body);
      writeSeedRecord(record);
      // A lane that just failed may still be releasing the port.
      for (let attempt = 0; ; attempt++) {
        try {
          await lane.transfer.start(this.opts.transferPort);
          break;
        } catch (error) {
          lane.transfer.stop();
          if (attempt >= 10) throw error;
          await sleep(500);
        }
      }
    } catch (error) {
      this.failLane(lane, `the transfer listener could not start on port ${this.opts.transferPort}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    lane.dialTimer = setTimeout(() => {
      if (!lane.receiver && !lane.failed) this.failLane(lane, `${entry.nodeName} did not dial this node's transfer endpoint (${this.opts.transferUrl}) within ${Math.round(XFER_DIAL_RETRY_WINDOW_MS / 1000)}s; check that the address reaches this machine's port ${this.opts.transferPort}`);
    }, XFER_DIAL_RETRY_WINDOW_MS + 5000);
    lane.dialTimer.unref();
    console.warn(`[Fleet] SEED started: ${entry.nodeName} pushes its ${offer.kind} copy of ${offer.sourceNodeName}'s guild data (${guilds.length} guild(s)) to ${this.opts.transferUrl}`);
    this.publish(true);
    if (!this.server) {
      this.failLane(lane, 'the control channel is down');
      return;
    }
    try {
      // The backup reads its copy again before it answers, the offer's work.
      const ack = await this.server.request(entry.nodeId, MSG.SEED_PUSH, { term: this.serverTerm, seedId, token, peerUrl: this.opts.transferUrl, kind: offer.kind, guilds }, SEED_OFFER_TIMEOUT_MS);
      if (!ack || ack.ok !== true) this.failLane(lane, `${entry.nodeName} refused the push: ${ack?.reason ?? 'no reason given'}`);
    } catch (error) {
      this.failLane(lane, `${entry.nodeName} did not answer the push request: ${error instanceof Error ? error.message : error}`);
    }
  }

  private attachReceiver(lane: SeedLane, ws: WebSocket): void {
    if (lane.receiver || lane.failed) {
      ws.close();
      return;
    }
    if (lane.dialTimer) clearTimeout(lane.dialTimer);
    lane.dialTimer = null;
    lane.ws = ws;
    lane.phase = 'copying';
    // A backup gone silent (asleep, powered off, cut off) closes nothing, so
    // the lane fails on silence instead: no transfer frame, report or heartbeat.
    lane.lastActivityAt = Date.now();
    ws.on('message', () => { lane.lastActivityAt = Date.now(); });
    lane.stallTimer = setInterval(() => {
      if (lane.failed || lane.finalLanded) {
        if (lane.stallTimer) clearInterval(lane.stallTimer);
        lane.stallTimer = null;
        return;
      }
      if (Date.now() - lane.lastActivityAt > XFER_STALL_TIMEOUT_MS) this.failLane(lane, `${lane.record.backupNodeName} went silent for ${Math.round(XFER_STALL_TIMEOUT_MS / 1000)}s while copying (no transfer, report or heartbeat: asleep, powered off or cut off from this node); nothing was adopted`);
    }, Math.min(XFER_STALL_TIMEOUT_MS, 10000));
    lane.stallTimer.unref();
    lane.receiver = new TransferReceiver(ws, lane.record.seedId, 'copy', {
      onRound: round => {
        lane.round = Math.max(lane.round, round);
        this.publish();
      },
      onFinal: round => {
        lane.round = Math.max(lane.round, round);
        lane.finalLanded = true;
        void this.maybeVerify(lane);
      },
      onError: error => this.failLane(lane, `receiving the copy failed: ${error instanceof Error ? error.message : error}`),
      onClose: () => {
        if (!lane.finalLanded && !lane.failed) this.failLane(lane, `${lane.record.backupNodeName} closed the transfer before its final round`);
      },
    }, lane.record.guilds);
    this.publish(true);
  }

  private onReport(nodeId: string, data: SeedReportPayload): void {
    const lane = this.lane;
    if (!lane || lane.failed || nodeId !== lane.record.backupNodeId || !data || data.seedId !== lane.record.seedId) return;
    lane.lastActivityAt = Date.now();
    if (Number.isFinite(data.round)) lane.round = Math.max(lane.round, Number(data.round));
    if (Number.isFinite(data.filesSent)) lane.filesSent = Number(data.filesSent);
    if (Number.isFinite(data.bytesSent)) lane.bytesSent = Number(data.bytesSent);
    if (typeof data.error === 'string' && data.error !== '') {
      this.failLane(lane, `${lane.record.backupNodeName} reports: ${data.error}`);
      return;
    }
    if (data.final && data.final.guildHashes && typeof data.final.guildHashes === 'object') {
      const hashes: Record<string, string> = {};
      for (const [guildId, hash] of Object.entries(data.final.guildHashes)) {
        if (isGuildId(guildId) && typeof hash === 'string') hashes[guildId] = hash;
      }
      lane.sourceHashes = hashes;
      void this.maybeVerify(lane);
    }
    this.publish();
  }

  private async maybeVerify(lane: SeedLane): Promise<void> {
    if (lane.failed || lane.verifying || !lane.finalLanded) return;
    if (!lane.sourceHashes) {
      if (!lane.reportTimer) {
        lane.reportTimer = setTimeout(() => {
          if (!lane.sourceHashes && !lane.failed) this.failLane(lane, `${lane.record.backupNodeName} sent no hashes after its final round`);
        }, SEED_REPORT_WAIT_MS);
        lane.reportTimer.unref();
      }
      return;
    }
    lane.verifying = true;
    if (lane.reportTimer) clearTimeout(lane.reportTimer);
    lane.reportTimer = null;
    lane.phase = 'verifying';
    this.publish(true);
    // Sealed before hashing, so what is adopted is exactly what was hashed.
    await lane.receiver?.close();
    if (lane.failed) return;
    const legDir = incomingLegDir(lane.record.seedId, 'copy');
    const mismatched: string[] = [];
    try {
      for (const guildId of lane.record.guilds) {
        const have = (await hashNamespaceAt(path.join(legDir, guildId))).namespaceHash;
        if (lane.sourceHashes[guildId] !== have) mismatched.push(guildId);
      }
    } catch (error) {
      this.failLane(lane, `hashing the staged copy failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (lane.failed) return;
    if (mismatched.length > 0) {
      this.failLane(lane, `the staged copy of ${mismatched.length} guild(s) did not match ${lane.record.backupNodeName}'s hashes (${mismatched.slice(0, 5).join(', ')}${mismatched.length > 5 ? ', ...' : ''}); nothing was adopted`);
      return;
    }
    // The landing runs synchronously, so nothing interleaves it; a failure
    // here still fails the lane (the record says push, so a boot discards it).
    try {
      for (const guildId of lane.record.guilds) {
        const staged = path.join(legDir, guildId);
        const dest = mirrorGuildDir(guildId);
        fs.rmSync(dest, { recursive: true, force: true });
        if (fs.existsSync(staged)) renameWithRetry(staged, dest);
        else fs.mkdirSync(dest, { recursive: true });
      }
      const manifest: MirrorManifest = {
        sourceNodeId: lane.record.sourceNodeId,
        sourceNodeName: lane.record.sourceNodeName,
        sourceTerm: lane.record.sourceTerm,
        revision: null,
        listedAt: Date.now(),
        completedAt: lane.record.completedAt ?? Date.now(),
        guilds: Object.fromEntries(lane.record.guilds.map(guildId => [guildId, { hash: lane.sourceHashes![guildId], files: {} }])),
        frozen: [],
        documents: {},
      };
      atomicWriteFileSync(mirrorManifestFile(), JSON.stringify(manifest, null, 2));
      fs.rmSync(path.join(DATA_ROOT, '_incoming', lane.record.seedId), { recursive: true, force: true });
    } catch (error) {
      this.failLane(lane, `landing the copy failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    // The point of no return: from here a late report or a live master
    // cannot undo the copy (failLane ignores this phase), and the record
    // resumes the phases at the next boot, whatever stops them now.
    lane.record.phase = 'adopt';
    writeSeedRecord(lane.record);
    lane.phase = 'adopting';
    this.publish(true);
    lane.transfer.stop();
    try {
      await finishSeed(lane.record, this.opts.selfNodeId);
    } catch (error) {
      // Only a Demote clears the record under a running lane: its restart ends
      // this boot as a co-worker, and nothing resumes.
      lane.stalled = !seedRecordOnDisk(lane.record.seedId)
        ? `the copy landed but a Demote of this node abandoned the seed at phase ${lane.record.phase}; the demote's restart ends this boot as a co-worker (what the adopt moved into the live tree stays as residue)`
        : `the copy landed but its adopt stopped at phase ${lane.record.phase}: ${error instanceof Error ? error.message : error}. Restart this bot to finish it (the seed record resumes there), or demote this node.`;
      console.error(`[Fleet] SEED stalled: ${lane.stalled}`);
      this.publish(true);
      return;
    }
    lane.phase = 'restarting';
    this.stopped = true;
    this.stopServer();
    console.warn(`[Fleet] SEED DONE: ${lane.record.guilds.length} guild(s) adopted from ${lane.record.backupNodeName}'s copy of ${lane.record.sourceNodeName}; restarting as master`);
    this.publish(true);
    requestSeededRestart();
  }

  private failLane(lane: SeedLane, reason: string): void {
    if (lane.failed) return;
    if (lane.phase === 'adopting' || lane.phase === 'restarting') {
      console.warn(`[Fleet] Seed ${lane.record.seedId}: ${reason}; the copy has verified and landed, so the seed goes on`);
      return;
    }
    lane.failed = true;
    if (lane.dialTimer) clearTimeout(lane.dialTimer);
    if (lane.reportTimer) clearTimeout(lane.reportTimer);
    if (lane.stallTimer) clearInterval(lane.stallTimer);
    void lane.receiver?.close();
    try { lane.ws?.terminate(); } catch { /* closing */ }
    lane.transfer.stop();
    // Told, the backup's push view says failed and why instead of sent forever.
    if (this.server?.isConnected(lane.record.backupNodeId)) {
      this.server.request(lane.record.backupNodeId, MSG.SEED_ABORT, { term: this.serverTerm, seedId: lane.record.seedId, reason }, SEED_OFFER_TIMEOUT_MS).catch(() => undefined);
    }
    fs.rmSync(path.join(DATA_ROOT, '_incoming', lane.record.seedId), { recursive: true, force: true });
    fs.rmSync(mirrorRoot(), { recursive: true, force: true });
    const onDisk = readSeedRecord();
    if (onDisk && onDisk.seedId === lane.record.seedId && onDisk.phase === 'push') clearSeedRecord();
    this.lastError = `${reason} (${new Date().toISOString().slice(11, 19)} UTC)`;
    if (this.lane === lane) this.lane = null;
    console.error(`[Fleet] SEED FAILED: ${reason}`);
    this.publish(true);
  }

  private noteBeacons(claims: WitnessClaim[]): void {
    for (const claim of claims) {
      if (claim.nodeId !== this.opts.selfNodeId && claim.term > this.beaconMax) {
        this.beaconMax = claim.term;
        this.beaconedBy = claim.nodeName;
      }
    }
  }

  /** A master alive after all ends the hold: the fleet is served, and this node must not seed itself beside it. */
  private async parkOnLive(live: WitnessClaim): Promise<void> {
    if (this.lane && this.lane.stalled !== null) {
      // Landed and stalled: the record stays and names that master, so the
      // next boot parks on it instead of finishing a takeover from it.
      const seedId = this.lane.record.seedId;
      try {
        const onDisk = readSeedRecord();
        if (onDisk && onDisk.seedId === seedId && onDisk.phase !== 'done') writeSeedRecord({ ...onDisk, liveSeen: { nodeId: live.nodeId, nodeName: live.nodeName, term: live.term, at: Date.now() } });
      } catch (error) {
        console.error(`[Fleet] Seed ${seedId}: marking the live master on the record failed (${error instanceof Error ? error.message : error}); the next boot judges it by this node's holder sighting`);
      }
      console.warn(`[Fleet] Seed ${seedId}: ${live.nodeName} beacons as a live master at term ${live.term} while the seed is stalled after its landing; the channel closes and the record stays, marked, so the next boot parks instead of finishing it`);
    } else if (this.lane) {
      this.failLane(this.lane, `${live.nodeName} beacons as a live master at term ${live.term}; the seed is abandoned`);
    }
    // A confirm written while this hold stood answers nothing now.
    clearFreshFleetConfirm();
    this.closed = true;
    this.stopServer();
    _setSeedHold(null);
    await this.opts.park(live);
  }

  private async release(): Promise<'released' | null> {
    // The operator confirmed a brand-new fleet. The witness is read again
    // first: the confirm is honoured within seconds and the loop's reads
    // are further apart, so a master returning in between beacons the term
    // this boot must floor above, or is live and parks the hold instead.
    if (this.opts.witness) {
      let claims: WitnessClaim[] | null = null;
      try { claims = await this.opts.witness.readClaims(); } catch { claims = null; }
      if (claims) {
        this.noteBeacons(claims);
        const live = liveMasterClaim(claims, this.opts.selfNodeId, Date.now());
        if (live) {
          console.warn(`[Fleet] Brand-new fleet confirmed, but ${live.nodeName} beacons as a live master at term ${live.term}; the confirm is cleared and the hold parks`);
          await this.parkOnLive(live);
          return null;
        }
      }
    }
    // A seed confirmed while the witness was read decides instead.
    if (this.lane) return null;
    // This boot mints above every beacon, so the fleet's term never moves
    // backwards on the witness.
    floorTermAbove(this.opts.selfNodeId, this.beaconMax);
    clearFreshFleetConfirm();
    this.closed = true;
    this.stopServer();
    _setSeedHold(null);
    this.opts.pushStatus();
    console.warn(`[Fleet] Brand-new fleet confirmed; the seed hold releases and this boot mints above term ${this.beaconMax}`);
    return 'released';
  }

  private buildView(): SeedHoldView {
    const backups: SeedHoldBackupView[] = [...this.backups.values()].map(entry => ({
      nodeId: entry.nodeId,
      nodeName: entry.nodeName,
      connected: entry.connected,
      offer: entry.offer
        ? {
            kind: entry.offer.kind,
            sourceNodeId: entry.offer.sourceNodeId,
            sourceNodeName: entry.offer.sourceNodeName,
            sourceTerm: entry.offer.sourceTerm,
            completedAt: entry.offer.completedAt,
            /** The age as of the offer, plus the time since: the view carries no clock values the reader has to interpret. */
            ageMs: entry.offer.ageMs === null ? null : entry.offer.ageMs + Math.max(0, Date.now() - (entry.offerAt ?? Date.now())),
            guildCount: entry.offer.guilds.length,
            partialCount: entry.offer.partialCount,
            totalBytes: entry.offer.totalBytes,
          }
        : null,
      offerReason: entry.offerReason,
      offerAt: entry.offerAt,
    }));
    const lane = this.lane;
    const push: SeedPushProgressView | null = lane && !lane.failed
      ? { seedId: lane.record.seedId, backupNodeId: lane.record.backupNodeId, backupNodeName: lane.record.backupNodeName, phase: lane.phase, round: lane.round, filesSent: lane.filesSent, bytesSent: lane.bytesSent, startedAt: lane.record.startedAt, stalled: lane.stalled }
      : null;
    return {
      since: this.since,
      holdTerm: this.beaconMax,
      beaconedBy: this.beaconedBy,
      transferUrl: this.opts.transferUrl,
      controlUrl: this.opts.controlUrl,
      controlPort: this.opts.controlPort,
      backups,
      push,
      lastError: this.lastError,
      interrupted: interruptedNote,
    };
  }

  private publish(force = false): void {
    if (this.closed) return;
    const view = this.buildView();
    _setSeedHold(view);
    // The age moves every call; pushed on a change of anything else.
    const key = JSON.stringify({ ...view, backups: view.backups.map(b => ({ ...b, offer: b.offer ? { ...b.offer, ageMs: null } : null })) });
    if (!force && key === this.lastPublished) return;
    this.lastPublished = key;
    this.opts.pushStatus();
  }
}

let active: SeedHoldRuntime | null = null;

/** Runs the hold; returns only on the brand-new-fleet release, every other exit is a restart. */
export async function runSeedHold(opts: SeedHoldOptions): Promise<'released'> {
  const runtime = new SeedHoldRuntime(opts);
  active = runtime;
  console.error(`[Fleet] SEED HOLD: this master holds no guild data while the witness shows the fleet at term ${opts.claims.reduce((max, c) => (c.nodeId !== opts.selfNodeId ? Math.max(max, c.term) : max), opts.localTerm)} and no live master; it will not mint a term and serve empty while a backup may hold the real data. Point the designated backup at this machine so it registers here and offers its copy, then confirm the seed on the Fleet tab; or demote this node; or confirm a brand-new fleet there if no backup anywhere holds data for this bot.`);
  try {
    return await runtime.run();
  } finally {
    if (active === runtime) active = null;
  }
}

/** The operator's confirm (IPC fleet:seed): {nodeId, confirm}. */
export function confirmSeed(nodeId: string, confirmed: boolean): SeedConfirmResult {
  if (!active) return { success: false, error: 'this node is not holding to be seeded' };
  if (typeof nodeId !== 'string' || nodeId === '') return { success: false, error: 'no backup named' };
  return active.confirm(nodeId, confirmed);
}

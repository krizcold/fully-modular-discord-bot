// File-mode failover (B4f-2, PLAN_REPLICATION 20.20): the designated backup
// adopts the copy of the dead master's guild data it holds, pins the
// placement to itself and seeds the term its boot mints past; a superseded
// side retires the stale copies it kept. Shared by the webui parent's promote
// engine (the phases) and the bot child (the retire reading). Every step is
// idempotent on the disk it finds, so a parent restart re-enters it.

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR, MIRROR_DOC_NAMES, PLACEMENT_DOC_NAMES } from './constants';
import type { MigrationRecord, PersistedAssignment, PersistedFleetConfig, PersistedMigrations, PersistedPlan, PersistedRegistry, PersistedTerm, RedistributeProposal } from './controlStore';
import { migrationsHoldTogether } from './controlStore';
import { atomicWriteFileSync, renameWithRetry } from './fileControlStore';
import { adoptMarkerFile, mirrorDocsDir, mirrorGuildDir, mirrorRoot, readMirrorManifest } from './mirrorEngine';
import { guildIdToShardId } from './placement';

const GRAVEYARD_DIRNAME = '_graveyard';
/**
 * Records a past mastership of the backup may have left; none describes the
 * fleet being adopted. The moved-to-postgres sentinel is one: left by a
 * postgres mastership, it would have the master boot export the old database
 * back over the pinned documents before the fence.
 */
const STALE_MASTER_RECORDS = ['reshard-pending.json', 'redistribute-proposal.json', 'transformation.json', 'control-store-moved.json'];
export const STALE_COPY_REASON = 'superseded-stale-copy';

export interface AdoptMarker {
  nodeId: string;
  sourceNodeId: string;
  guilds: string[];
  startedAt: number;
}

export interface AdoptOutcome {
  adopted: number;
  kept: number;
  graveyarded: number;
  skipped: number;
}

export interface PinOutcome {
  movedShards: number[];
  removed: string[];
  recordsCarried: boolean;
  /** Shards a move decided onto the old master had not yet granted: their newest copy went with it. */
  lostShards: number[];
  /** Those of them with an older copy a node still owes the cleanup of, held for the operator's choice. */
  heldShards: number[];
  /** Those of them a redistribute was placing there, not held: the nodes it was moving their guilds from keep them (released), named in releasedOn. */
  releasedShards: number[];
  releasedOn: string[];
  /** The old master's reshard pause went on here. */
  pauseCarried: boolean;
  /** Its redistribute proposal went on here, with the pause or alone (a Resume's grants still landing). */
  proposalCarried: boolean;
  /** The copy's proposal could not be read or parsed: the pause, or the Resume's landing, went on without it. */
  proposalUnreadable: boolean;
}

const isGuildId = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readMirrorDoc<T>(name: typeof MIRROR_DOC_NAMES[number]): T | null {
  return readJson<T>(path.join(mirrorDocsDir(), name));
}

/** A mirrored document's text; null when the copy has none. */
function readMirrorText(name: typeof MIRROR_DOC_NAMES[number]): string | null {
  try {
    return fs.readFileSync(path.join(mirrorDocsDir(), name), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readAdoptMarker(): AdoptMarker | null {
  const parsed = readJson<AdoptMarker>(adoptMarkerFile());
  if (!parsed || typeof parsed.nodeId !== 'string' || typeof parsed.sourceNodeId !== 'string' || !Array.isArray(parsed.guilds)) return null;
  return { nodeId: parsed.nodeId, sourceNodeId: parsed.sourceNodeId, guilds: parsed.guilds.filter(isGuildId), startedAt: Number(parsed.startedAt) || 0 };
}

/** The adopt has begun renaming (its commit-intent marker is on disk). */
export function adoptStarted(): boolean {
  return fs.existsSync(adoptMarkerFile());
}

/** An abandoned adopt (cancelled, or dismissed as superseded) hands the tree back to the mirror engine. */
export function clearAdoptMarker(): void {
  fs.rmSync(adoptMarkerFile(), { force: true });
}

/**
 * A live guild dir's .owner stamp: the node it names and the term it was
 * stamped under; null when it carries none (the boot sweep adopts such a dir
 * as this node's), 'unreadable' when the manifest exists but does not parse.
 */
export function readOwnerStamp(guildDir: string): { nodeId: string; term: number } | null | 'unreadable' {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(guildDir, '.owner'), 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.nodeId !== 'string' || parsed.nodeId === '') return 'unreadable';
    return { nodeId: parsed.nodeId, term: Number.isFinite(parsed.term) ? Number(parsed.term) : 0 };
  } catch {
    return 'unreadable';
  }
}

export function readOwnerNodeId(guildDir: string): string | null | 'unreadable' {
  const stamp = readOwnerStamp(guildDir);
  return stamp === null || stamp === 'unreadable' ? stamp : stamp.nodeId;
}

function writeOwnerStamp(guildId: string, nodeId: string, plan: PersistedPlan | null): void {
  const shardCount = plan && Number.isInteger(plan.shardCount) && plan.shardCount > 0 ? plan.shardCount : 1;
  const manifest = {
    guildId,
    shardId: guildIdToShardId(guildId, shardCount),
    nodeId,
    term: plan && Number.isInteger(plan.term) ? plan.term : 0,
    epoch: plan && Number.isInteger(plan.epoch) ? plan.epoch : 0,
    updatedAt: Date.now(),
  };
  atomicWriteFileSync(path.join(DATA_ROOT, guildId, '.owner'), JSON.stringify(manifest, null, 2));
}

/** The file backend's graveyard layout ({guildId}-{ms} plus .graveyard.json), so Restore finds the entry. */
async function graveyardLiveDir(guildId: string, reason: string): Promise<void> {
  const graveyardRoot = path.join(DATA_ROOT, GRAVEYARD_DIRNAME);
  fs.mkdirSync(graveyardRoot, { recursive: true });
  const dest = path.join(graveyardRoot, `${guildId}-${Date.now()}`);
  renameWithRetry(path.join(DATA_ROOT, guildId), dest);
  atomicWriteFileSync(path.join(dest, '.graveyard.json'), JSON.stringify({ guildId, reason, ts: Date.now() }, null, 2));
}

/**
 * The adopt phase: every guild the copy holds is renamed into the live tree
 * and stamped as this node's. A live dir of the same guild goes to the
 * graveyard first, whoever owns it (the migration commit's rule): on a
 * consistent fleet a live dir for a guild the master owned is residue (a
 * dismissed adopt, pre-fleet data, an old copy of a shard this node lost),
 * and the copy is the fleet's data. Idempotent: a guild whose mirror dir is
 * gone and whose live dir is this node's (or unstamped) was adopted already.
 */
export async function adoptMirror(selfNodeId: string): Promise<AdoptOutcome> {
  let marker = readAdoptMarker();
  if (!marker) {
    const manifest = readMirrorManifest();
    if (!manifest || manifest.completedAt === null) throw new Error('the copy of the master\'s guild data is gone or was never complete; nothing to adopt');
    if (manifest.sourceNodeId === null) throw new Error('the copy names no source master');
    marker = { nodeId: selfNodeId, sourceNodeId: manifest.sourceNodeId, guilds: Object.keys(manifest.guilds).filter(isGuildId).sort(), startedAt: Date.now() };
    atomicWriteFileSync(adoptMarkerFile(), JSON.stringify(marker, null, 2));
  }
  const plan = readMirrorDoc<PersistedPlan>('leases.json');
  const outcome: AdoptOutcome = { adopted: 0, kept: 0, graveyarded: 0, skipped: 0 };
  for (const guildId of marker.guilds) {
    const src = mirrorGuildDir(guildId);
    const dest = path.join(DATA_ROOT, guildId);
    const srcExists = fs.existsSync(src);
    const destExists = fs.existsSync(dest);
    if (!srcExists) {
      if (!destExists) {
        outcome.skipped += 1;
        continue;
      }
      const owner = readOwnerNodeId(dest);
      if (owner === null) writeOwnerStamp(guildId, selfNodeId, plan);
      if (owner === null || owner === selfNodeId) outcome.kept += 1;
      else outcome.skipped += 1;
      continue;
    }
    if (destExists) {
      const owner = readOwnerNodeId(dest);
      const by = owner === null ? 'unstamped' : owner === 'unreadable' ? 'unreadable-owner' : owner === selfNodeId ? 'own-residue' : `owned-by-${owner.slice(0, 8)}`;
      await graveyardLiveDir(guildId, `adopt-replaced-${by}`);
      outcome.graveyarded += 1;
    }
    renameWithRetry(src, dest);
    writeOwnerStamp(guildId, selfNodeId, plan);
    outcome.adopted += 1;
  }
  return outcome;
}

const DECIDED_STATES: ReadonlySet<string> = new Set(['COMMITTING', 'GRANTING']);

/** The fingerprint of a plan document's text: the master's listed migration records name the plan they describe by it. */
export function planFingerprint(planText: string): string {
  return createHash('sha256').update(planText, 'utf-8').digest('hex');
}

/** Migration records listed with another plan than this one (a copy's set torn across two passes); records naming none are a node's own. */
export function recordsOfAnotherPlan(records: { planSha256?: unknown } | null, planText: string): boolean {
  return typeof records?.planSha256 === 'string' && records.planSha256 !== planFingerprint(planText);
}

/** What keeps migration records from being carried over by an adopt: they do not parse, do not hold together, or were listed with another plan than the leases.json beside them; null when they can. */
export function recordsFault(body: string, planText: string): 'parse' | 'together' | 'torn' | null {
  let records: { planSha256?: unknown } | null = null;
  try {
    records = JSON.parse(body) as { planSha256?: unknown } | null;
  } catch { /* judged below */ }
  if (records === null || typeof records !== 'object') return 'parse';
  if (!migrationsHoldTogether(records as PersistedMigrations)) return 'together';
  if (recordsOfAnotherPlan(records, planText)) return 'torn';
  return null;
}

/** Why the copy's migration records cannot be carried over, judged before the adopt (which cannot be undone); null when they can or the copy has none. */
export function copyRecordsRefusal(): string | null {
  const body = readMirrorText('migrations.json');
  if (body === null) return null;
  const name = readMirrorManifest()?.sourceNodeName ?? 'the master';
  const after = `so ${name}'s holds, owed cleanups and running migration cannot be carried over; the copy is whole again after a complete pass while ${name} serves`;
  const fault = recordsFault(body, readMirrorText('leases.json') ?? '');
  if (fault === 'parse') return `this node's copy of ${name}'s migration records (migrations.json) does not parse, ${after}`;
  if (fault === 'together') return `this node's copy of ${name}'s migration records (migrations.json) does not hold together, ${after}`;
  if (fault === 'torn') return `this node's copy of ${name}'s documents is torn across two passes (its migration records were listed with another plan than its leases.json), ${after}`;
  return null;
}

/**
 * The copy's migration records made this node's after an adopt, which made
 * the old master's guild data this node's. The old master's part in a move
 * passes to this node where that copy stands for it: the originals of a move
 * out of it (their cleanup graveyards the copy, a release keeps it, an
 * abort's rollback grants this node), unless the move committed onto this
 * node (a cleanup here would graveyard what it brought), and a move into it
 * settled, granted or not yet decided (an abort here has no staging to
 * drop). A move into it decided and not yet granted lost its target with it
 * (the copy holds no staging): marked as a Declare Lost marks it, its shard
 * left unplaced as its drain left it, and the older copies a node still owes
 * the cleanup of held for the operator's choice. A retire of the old master
 * has nothing left to move once its shards are pinned here: the legs it had
 * not run go, and one short of its current leg's commit decision ends there,
 * that leg aborted (the new master delivers the abort to its nodes) with its
 * shard on this node (resumed, a leg from this node to itself could never
 * pass its precheck).
 */
function adoptRecords(body: string, planText: string, plan: PersistedPlan, selfNodeId: string, sourceNodeId: string | null, sourceName: string, adoptedHere: (guildId: string) => boolean): { records: PersistedMigrations; lost: Set<number>; keep: Set<number>; held: number[]; released: { shardId: number; nodeId: string }[] } {
  let parsed: (Partial<PersistedMigrations> & { planSha256?: unknown }) | null;
  try {
    parsed = JSON.parse(body) as (Partial<PersistedMigrations> & { planSha256?: unknown }) | null;
  } catch {
    throw new Error('the copy\'s migration records (migrations.json) do not parse, so the old master\'s holds, owed cleanups and running migration cannot go on here');
  }
  if (recordsOfAnotherPlan(parsed, planText)) {
    throw new Error('the copy\'s migration records were listed with another plan than its leases.json (a pass torn by a restart of this node), so the old master\'s holds, owed cleanups and running migration cannot go on here');
  }
  if (parsed === null || typeof parsed !== 'object' || !migrationsHoldTogether(parsed as PersistedMigrations)) {
    throw new Error('the copy\'s migration records (migrations.json) do not hold together, so the old master\'s holds, owed cleanups and running migration cannot go on here');
  }
  let active = parsed?.active ?? null;
  const history = Array.isArray(parsed?.history) ? parsed!.history! : [];
  const at = Date.now();
  const lost = new Set<number>();
  const keep = new Set<number>();
  let ended: MigrationRecord | null = null;
  const records = [active, ...history].filter((rec): rec is MigrationRecord => !!rec && Array.isArray(rec.legs));
  if (sourceNodeId !== null) {
    const onSource = new Set<number>();
    for (const a of plan.assignments) if (a?.nodeId === sourceNodeId && Array.isArray(a.leases)) for (const l of a.leases) if (l) onSource.add(l.shardId);
    for (const rec of records) {
      const live = rec === active;
      const idx = rec.currentLegIndex ?? 0;
      const retireOfSource = live && rec.kind === 'retire' && rec.legs.every(l => l.sourceNodeId === sourceNodeId);
      if (retireOfSource && rec.legs.length > idx + 1) rec.legs = rec.legs.slice(0, idx + 1);
      const passed = new Set<string>();
      rec.legs.forEach((leg, index) => {
        const state = !live ? leg.legState ?? rec.state
          : rec.kind !== 'retire' ? rec.state
            : index < idx ? leg.legState ?? 'DONE' : index === idx ? leg.legState ?? 'PREPARING' : 'PREPARING';
        const decided = DECIDED_STATES.has(state);
        // A grant that landed put the shard on the old master in the copy's plan.
        const granted = state === 'GRANTING' && onSource.has(leg.shardId);
        if (leg.sourceNodeId === sourceNodeId) {
          if (leg.targetNodeId !== selfNodeId || !(decided || state === 'DONE')) {
            leg.sourceNodeId = selfNodeId;
            passed.add(leg.legId);
          }
        } else if (leg.targetNodeId === sourceNodeId) {
          if (decided && !granted) {
            if (leg.targetLostAt === undefined) leg.targetLostAt = at;
            lost.add(leg.shardId);
            // As a Declare Lost of the old master would: a commit under way
            // never cleans this leg's source, so its originals are owed as a
            // cleanup (held for the operator's choice, a redistribute's
            // released), which lifts its drain's freeze.
            if (state === 'COMMITTING' && leg.direction !== 'none') {
              const notes = rec.pendingSourceCleanup ?? (rec.pendingSourceCleanup = []);
              const owe = (nodeId: string): void => {
                let entry = notes.find(e => e.nodeId === nodeId);
                if (!entry) notes.push(entry = { nodeId, legIds: [] });
                if (!entry.legIds.includes(leg.legId)) entry.legIds.push(leg.legId);
              };
              owe(leg.sourceNodeId);
              // What the old master's commit had landed came with the copy
              // adopted here: when every guild of the leg did, the choice
              // offers this node's copy too.
              if (rec.kind !== 'redistribute' && leg.guilds.length > 0 && leg.guilds.every(adoptedHere)) owe(selfNodeId);
            }
          } else if (leg.sourceNodeId !== selfNodeId || granted) leg.targetNodeId = selfNodeId;
        }
      });
      const notes = rec.pendingSourceCleanup ?? [];
      const owed = notes.find(e => e.nodeId === sourceNodeId);
      const moving = owed ? owed.legIds.filter(id => passed.has(id)) : [];
      if (owed && moving.length > 0) {
        owed.legIds = owed.legIds.filter(id => !passed.has(id));
        let mine = notes.find(e => e.nodeId === selfNodeId);
        if (!mine) notes.push(mine = { nodeId: selfNodeId, legIds: [] });
        for (const id of moving) if (!mine.legIds.includes(id)) mine.legIds.push(id);
        rec.pendingSourceCleanup = notes.filter(e => e.legIds.length > 0);
      }
      const current = rec.legs[idx];
      const currentState = current?.legState ?? 'PREPARING';
      if (retireOfSource && current && currentState !== 'DONE' && !DECIDED_STATES.has(currentState)) {
        current.legState = 'ABORTED';
        current.error = rec.error = 'the old master went before this leg\'s commit decision; its shard stays with the node that took over its data';
        rec.state = 'ABORTED';
        rec.updatedAt = at;
        rec.abortUndelivered = [...new Set([current.sourceNodeId, current.targetNodeId])];
        keep.add(current.shardId);
        ended = rec;
      }
    }
  }
  if (ended) {
    history.push(ended);
    active = null;
  }
  const held = new Set<number>();
  const released: { shardId: number; nodeId: string }[] = [];
  for (const rec of records) {
    if (rec.shardCount !== undefined && rec.shardCount !== plan.shardCount) continue;
    for (const entry of rec.pendingSourceCleanup ?? []) {
      for (const legId of entry.legIds) {
        const leg = rec.legs.find(l => l.legId === legId);
        if (!leg || !lost.has(leg.shardId) || leg.direction === 'none' || leg.sourceLostAt !== undefined) continue;
        // A redistribute's leg into the old master is released instead.
        if (rec.kind === 'redistribute' && leg.targetLostAt !== undefined) {
          released.push({ shardId: leg.shardId, nodeId: entry.nodeId });
          continue;
        }
        if (!leg.heldForChoice) leg.heldForChoice = { lostNodeName: sourceName, at };
        held.add(leg.shardId);
      }
    }
  }
  return { records: { active, history, updatedAt: at }, lost, keep, held: [...held].sort((a, b) => a - b), released };
}

/**
 * The pin phase: the mirrored placement documents become this node's, with
 * every shard the dead master held reassigned to this node, so the master
 * this boot becomes grants none of them to a returning stale copy. Records a
 * past mastership of this node may have left in the fleet dir are removed:
 * a reshard marker would pause the boot. The migration records are the
 * copy's after an adopt (carryRecords), so the old master's holds, owed
 * cleanups and running migration go on here, and so do its reshard pause
 * and redistribute proposal; a planned transfer, which hands over only
 * once they are settled, keeps none.
 */
export async function pinPlacement(selfNodeId: string, sourceNodeId: string | null, carryRecords: boolean): Promise<PinOutcome> {
  const plan = readMirrorDoc<PersistedPlan>('leases.json');
  const config = readMirrorDoc<PersistedFleetConfig>('fleet-config.json');
  const registry = readMirrorDoc<PersistedRegistry>('registry.json');
  if (!plan || !Array.isArray(plan.assignments) || !config || !Array.isArray(config.masterCandidates)) {
    throw new Error('the copy carries no usable placement documents (leases.json, fleet-config.json), so the plan cannot be pinned; the Backup copy line says whether the copy was complete');
  }
  const recordsBody = carryRecords ? readMirrorText('migrations.json') : null;
  const listedName = (nodeId: string | null): string | undefined => (registry && Array.isArray(registry.nodes) ? registry.nodes.find(n => n?.nodeId === nodeId)?.nodeName : undefined);
  const sourceName = listedName(sourceNodeId) ?? sourceNodeId?.slice(0, 8) ?? 'the old master';
  // The guilds the adopt brought here (its marker stays until finishAdopt).
  const adopted = new Set(readAdoptMarker()?.guilds ?? []);
  const adoptedHere = (guildId: string): boolean => adopted.has(guildId) && fs.existsSync(dataPath(guildId));
  const carried = recordsBody === null ? null : adoptRecords(recordsBody, readMirrorText('leases.json') ?? '', plan, selfNodeId, sourceNodeId, sourceName, adoptedHere);
  const lost = carried?.lost ?? new Set<number>();
  // The old master's reshard pause goes on here, and its redistribute
  // proposal with the pause or alone (a Resume's grants still landing, which
  // the boot fences again for their owners), both read as its store reads
  // them: an unreadable marker still pauses, a proposal that cannot be read
  // or parsed is none.
  const marker = carryRecords ? readPauseMarker() : null;
  let stored: RedistributeProposal | null = null;
  let proposalUnreadable = false;
  if (carryRecords) {
    try {
      const text = readMirrorText('redistribute-proposal.json');
      if (text !== null) stored = proposalOf(text);
      proposalUnreadable = text !== null && stored === null;
    } catch {
      proposalUnreadable = true;
    }
  }
  const self: PersistedAssignment = { nodeId: selfNodeId, leases: [] };
  const others: PersistedAssignment[] = [];
  const movedShards: number[] = [];
  for (const assignment of plan.assignments) {
    if (!assignment || typeof assignment.nodeId !== 'string' || !Array.isArray(assignment.leases)) continue;
    const leases = assignment.leases.filter(lease => !(lease && lost.has(lease.shardId)));
    if (assignment.nodeId === selfNodeId || assignment.nodeId === sourceNodeId) {
      for (const lease of leases) {
        self.leases.push(lease);
        if (assignment.nodeId === sourceNodeId) movedShards.push(lease.shardId);
      }
      continue;
    }
    others.push(leases.length === assignment.leases.length ? assignment : { ...assignment, leases });
  }
  // An ended retire's leg may have drained its shard off every lease.
  for (const shardId of carried?.keep ?? []) {
    if ([...self.leases, ...others.flatMap(a => a.leases)].some(l => l?.shardId === shardId)) continue;
    self.leases.push({ leaseId: randomUUID(), shardId, identifyDelayMs: 0 });
    movedShards.push(shardId);
  }
  movedShards.sort((a, b) => a - b);
  const pinned: PersistedPlan = { ...plan, assignments: self.leases.length > 0 ? [...others, self] : others, updatedAt: Date.now() };
  const fleetFile = (name: string): string => dataPath('global', FLEET_DIR, name);
  atomicWriteFileSync(fleetFile('leases.json'), JSON.stringify(pinned, null, 2));
  if (registry && Array.isArray(registry.nodes)) atomicWriteFileSync(fleetFile('registry.json'), JSON.stringify(registry, null, 2));
  atomicWriteFileSync(fleetFile('fleet-config.json'), JSON.stringify(config, null, 2));
  const removed: string[] = [];
  for (const name of carried ? STALE_MASTER_RECORDS : [...STALE_MASTER_RECORDS, 'migrations.json']) {
    try {
      fs.unlinkSync(fleetFile(name));
      removed.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (carried) atomicWriteFileSync(fleetFile('migrations.json'), JSON.stringify(carried.records, null, 2));
  if (marker !== null) atomicWriteFileSync(fleetFile('reshard-pending.json'), marker);
  if (stored) {
    // Its shards of the old master were pinned here with the rest; one lost
    // with it has no owner left to fence it for.
    const proposal: Record<number, string> = {};
    for (const [shardKey, owner] of Object.entries(stored.proposal)) {
      if (typeof owner !== 'string' || lost.has(Number(shardKey))) continue;
      proposal[Number(shardKey)] = owner === sourceNodeId ? selfNodeId : owner;
    }
    atomicWriteFileSync(fleetFile('redistribute-proposal.json'), JSON.stringify({ proposal, updatedAt: Date.now() }, null, 2));
  }
  const released = (carried?.released ?? []).filter(r => !(carried?.held ?? []).includes(r.shardId));
  return {
    movedShards, removed, recordsCarried: carried !== null, lostShards: [...lost].sort((a, b) => a - b), heldShards: carried?.held ?? [],
    releasedShards: [...new Set(released.map(r => r.shardId))].sort((a, b) => a - b),
    releasedOn: [...new Set(released.map(r => listedName(r.nodeId) ?? r.nodeId.slice(0, 8)))],
    pauseCarried: marker !== null, proposalCarried: stored !== null, proposalUnreadable,
  };
}

/** A redistribute proposal's text as one; null when it does not parse to one. */
function proposalOf(text: string): RedistributeProposal | null {
  try {
    const parsed = JSON.parse(text) as RedistributeProposal | null;
    return parsed?.proposal && typeof parsed.proposal === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The copy's reshard marker; an unreadable one as an empty one, which a boot reads as malformed and pauses on. */
function readPauseMarker(): string | null {
  try {
    return readMirrorText('reshard-pending.json');
  } catch {
    return '{}';
  }
}

/** What the pin did with the migration records, for the lane's log line. */
export function pinRecordsText(outcome: PinOutcome): string {
  if (!outcome.recordsCarried) return '';
  const held = outcome.heldShards.length > 0 ? `; shard(s) [${outcome.heldShards.join(', ')}] wait on the operator's choice on the Fleet tab (restore a surviving copy or start empty)` : '';
  const lost = outcome.lostShards.length > 0 ? `; shard(s) [${outcome.lostShards.join(', ')}] were moving onto the old master, whose copy of them went with it${held}` : '';
  const placeAgain = outcome.lostShards.filter(id => !outcome.heldShards.includes(id));
  // Outside a pause no Redistribute places them again.
  const holders = outcome.releasedOn.join(' and ');
  const released = outcome.releasedShards.length > 0
    ? `; shard(s) [${outcome.releasedShards.join(', ')}] are placed as any free shard once ${holders} release${outcome.releasedOn.length === 1 ? 's' : ''} them (Declare a node that never returns Lost), and the guilds the redistribute was moving there start fresh unless the shard lands on this node, whose copy of the old master's data may hold them; their last data otherwise stays with ${holders} (released, unless already cleaned)`
    : '';
  const landing = (outcome.proposalCarried ? '; the last Resume\'s redistribute proposal carried over: its shards not yet granted land on the nodes holding their data as each registers' : '')
    + (outcome.proposalUnreadable ? '; the last Resume\'s redistribute proposal could not be read: its shards not yet granted are placed as any free shard' : '');
  const pause = !outcome.pauseCarried ? released + landing
    : `; the reshard pause carried over${outcome.proposalCarried ? ', Resume granting its redistribute proposal' : ''}`
      + (outcome.proposalUnreadable ? '; its redistribute proposal could not be read: run Redistribute again before Resume' : '')
      + (placeAgain.length > 0 ? `; run Redistribute again before Resume to place shard(s) [${placeAgain.join(', ')}]` : '');
  return `; the migration records carried over${lost}${pause}`;
}

/**
 * The seed phase: term.json carries the fleet's term under the dead master's
 * id, so the boot mints one above it (a file-mode term is per node, and an
 * unseeded backup would mint 1 and park on the dead master's own beacon) and
 * the takeover chain reads the master it supersedes from the row.
 */
export function seedTerm(sourceNodeId: string, floor: number): number {
  const file = dataPath('global', FLEET_DIR, 'term.json');
  const current = readJson<PersistedTerm>(file);
  const pinned = readJson<PersistedPlan>(dataPath('global', FLEET_DIR, 'leases.json'));
  const term = Math.max(floor, current && Number.isFinite(current.term) ? current.term : 0, pinned && Number.isInteger(pinned.term) ? pinned.term : 0);
  atomicWriteFileSync(file, JSON.stringify({ term, nodeId: sourceNodeId, updatedAt: Date.now() }, null, 2));
  return term;
}

/**
 * The planned transfer's handover (B4f-4): the mirror tick stops under an
 * adopt marker naming no guild (a transfer adopts nothing: the retire moved
 * the live data), so the master's documents written next are what the pin
 * reads.
 */
export function holdMirrorForTransfer(selfNodeId: string, sourceNodeId: string): void {
  if (fs.existsSync(adoptMarkerFile())) return;
  fs.mkdirSync(mirrorRoot(), { recursive: true });
  const marker: AdoptMarker = { nodeId: selfNodeId, sourceNodeId, guilds: [], startedAt: Date.now() };
  atomicWriteFileSync(adoptMarkerFile(), JSON.stringify(marker, null, 2));
}

/** A handover that was refused hands the copy back to the mirror tick (the transfer's hold names no guild; an adopt's marker is left). */
export function releaseTransferHold(): void {
  const marker = readAdoptMarker();
  if (marker && marker.guilds.length === 0) clearAdoptMarker();
}

/** The master's placement documents as its control store held them at the handover, under the mirror layout the pin reads. */
export function writeHandoverDocuments(documents: { name: string; body: string }[]): void {
  const bodies = PLACEMENT_DOC_NAMES.map(name => {
    const doc = Array.isArray(documents) ? documents.find(d => d && d.name === name && typeof d.body === 'string') : undefined;
    if (!doc) throw new Error(`the handover carried no ${name}`);
    JSON.parse(doc.body);
    return { name, body: doc.body };
  });
  fs.mkdirSync(mirrorDocsDir(), { recursive: true });
  for (const { name, body } of bodies) atomicWriteFileSync(path.join(mirrorDocsDir(), name), body);
}

/** The copy's placement documents are what the pin needs, from a copy of that master (a transfer whose handover answer never came goes on with them, B4f-4). */
export function mirrorPlacementUsable(sourceNodeId: string): boolean {
  if (readMirrorManifest()?.sourceNodeId !== sourceNodeId) return false;
  const plan = readMirrorDoc<PersistedPlan>('leases.json');
  const config = readMirrorDoc<PersistedFleetConfig>('fleet-config.json');
  return !!plan && Array.isArray(plan.assignments) && !!config && Array.isArray(config.masterCandidates);
}

/** The term the seed phase writes over this floor (the term.json already here may stand above it); the boot mints one above. */
export function plannedSeedTerm(floor: number): number {
  const current = readJson<PersistedTerm>(dataPath('global', FLEET_DIR, 'term.json'));
  return Math.max(floor, current && Number.isFinite(current.term) ? current.term : 0);
}

/** The copy is spent: the mirror tree (marker, manifest, documents, staging) goes before the master boot. */
export function finishAdopt(): void {
  fs.rmSync(mirrorRoot(), { recursive: true, force: true });
}

/**
 * The retire reading of a superseded side in file mode (B4f-2): a live guild
 * dir this node stamped under a term BELOW the superseding one is a copy from
 * before the fleet moved on. A dir the new fleet wrote here carries the new
 * master's term (a migration target's commit stamps it; a first write under a
 * new lease does); an UNSTAMPED dir is of unknown provenance (a quiet guild
 * never written since its grant, pre-fleet data) and is left alone, as are
 * dirs another node owns (the boot sweep's business) and a held shard's dirs.
 */
export function isStaleCopy(guildId: string, selfNodeId: string, heldShardIds: ReadonlySet<number>, shardCount: number | null, beforeTerm: number): boolean {
  if (!isGuildId(guildId)) return false;
  const dir = path.join(DATA_ROOT, guildId);
  if (!fs.existsSync(dir)) return false;
  const stamp = readOwnerStamp(dir);
  if (stamp === null || stamp === 'unreadable' || stamp.nodeId !== selfNodeId || stamp.term >= beforeTerm) return false;
  if (shardCount !== null && shardCount > 0 && heldShardIds.has(guildIdToShardId(guildId, shardCount))) return false;
  return true;
}

export function listStaleCopies(selfNodeId: string, heldShardIds: ReadonlySet<number>, shardCount: number | null, beforeTerm: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(DATA_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(e => e.isDirectory() && isStaleCopy(e.name, selfNodeId, heldShardIds, shardCount, beforeTerm)).map(e => e.name).sort();
}

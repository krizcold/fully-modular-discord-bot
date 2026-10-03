// File-mode failover (B4f-2, PLAN_REPLICATION 20.20): the designated backup
// adopts the copy of the dead master's guild data it holds, pins the
// placement to itself and seeds the term its boot mints past; a superseded
// side retires the stale copies it kept. Shared by the webui parent's promote
// engine (the phases) and the bot child (the retire reading). Every step is
// idempotent on the disk it finds, so a parent restart re-enters it.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT, dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR, MIRROR_DOC_NAMES } from './constants';
import type { PersistedAssignment, PersistedFleetConfig, PersistedPlan, PersistedRegistry, PersistedTerm } from './controlStore';
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
const STALE_MASTER_RECORDS = ['migrations.json', 'reshard-pending.json', 'redistribute-proposal.json', 'transformation.json', 'control-store-moved.json'];
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

/**
 * The pin phase: the mirrored placement documents become this node's, with
 * every shard the dead master held reassigned to this node, so the master
 * this boot becomes grants none of them to a returning stale copy. Records a
 * past mastership of this node may have left in the fleet dir are removed:
 * a reshard marker would pause the boot and a migration record would resume
 * a migration of a fleet this node no longer coordinates.
 */
export async function pinPlacement(selfNodeId: string, sourceNodeId: string | null): Promise<PinOutcome> {
  const plan = readMirrorDoc<PersistedPlan>('leases.json');
  const config = readMirrorDoc<PersistedFleetConfig>('fleet-config.json');
  const registry = readMirrorDoc<PersistedRegistry>('registry.json');
  if (!plan || !Array.isArray(plan.assignments) || !config || !Array.isArray(config.masterCandidates)) {
    throw new Error('the copy carries no usable placement documents (leases.json, fleet-config.json), so the plan cannot be pinned; the Backup copy line says whether the copy was complete');
  }
  const self: PersistedAssignment = { nodeId: selfNodeId, leases: [] };
  const others: PersistedAssignment[] = [];
  const movedShards: number[] = [];
  for (const assignment of plan.assignments) {
    if (!assignment || typeof assignment.nodeId !== 'string' || !Array.isArray(assignment.leases)) continue;
    if (assignment.nodeId === selfNodeId || assignment.nodeId === sourceNodeId) {
      for (const lease of assignment.leases) {
        self.leases.push(lease);
        if (assignment.nodeId === sourceNodeId) movedShards.push(lease.shardId);
      }
      continue;
    }
    others.push(assignment);
  }
  movedShards.sort((a, b) => a - b);
  const pinned: PersistedPlan = { ...plan, assignments: self.leases.length > 0 ? [...others, self] : others, updatedAt: Date.now() };
  const fleetFile = (name: string): string => dataPath('global', FLEET_DIR, name);
  atomicWriteFileSync(fleetFile('leases.json'), JSON.stringify(pinned, null, 2));
  if (registry && Array.isArray(registry.nodes)) atomicWriteFileSync(fleetFile('registry.json'), JSON.stringify(registry, null, 2));
  atomicWriteFileSync(fleetFile('fleet-config.json'), JSON.stringify(config, null, 2));
  const removed: string[] = [];
  for (const name of STALE_MASTER_RECORDS) {
    try {
      fs.unlinkSync(fleetFile(name));
      removed.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { movedShards, removed };
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
  const bodies = MIRROR_DOC_NAMES.map(name => {
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

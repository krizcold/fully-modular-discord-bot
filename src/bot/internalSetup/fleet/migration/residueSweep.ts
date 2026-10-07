// Boot ownership sweep (Phase 3 / P4). Runs from initFleet before any ingest
// login: adopts pre-existing guild dirs (stamp-if-missing), quarantines foreign
// residue to the graveyard (a cloned data volume is made safe here), cleans
// orphaned *.tmp files, and finishes any commit-intent migration staging.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT } from '../../../../utils/dataRoot';
import { graveyardGuildDir } from '../../utils/dataBackends/fileBackend';
import { deleteGuildNamespace, listGuilds, stampOwner } from '../../utils/dataManager';
import { atomicWriteFileSync } from '../fileControlStore';
import { graveyardLiveDir } from '../fileFailover';
import { getNodeId } from '../nodeIdentity';
import { commitFromStaging } from './migrationExecutor';

const INCOMING_DIR = '_incoming';
const DELETING_PREFIX = '.deleting-';
// The commit-intent legs a boot landed before any ask (a file, so neither
// staging pass reads it as a migration).
const BOOT_LANDED_FILE = '.boot-landed.json';
const ORPHAN_TMP_MAX_AGE_MS = 60 * 60 * 1000; // 1h

interface OwnerManifest {
  guildId: string;
  shardId: number;
  nodeId: string;
  term: number;
  epoch: number;
  updatedAt: number;
}

function readOwner(guildId: string): OwnerManifest | null {
  try {
    const raw = fs.readFileSync(path.join(DATA_ROOT, guildId, '.owner'), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.nodeId === 'string') return parsed as OwnerManifest;
  } catch { /* missing or unreadable */ }
  return null;
}

/**
 * The core boot sweep. `selfNodeId` is this node's stable id. `nodeIdFreshlyGenerated`
 * is true when node.json was missing/unparseable this boot and a new id was minted:
 * in that case an owner-nodeId mismatch means THIS node forgot its identity (a
 * partial restore, a cleared fleet dir, a torn node.json), NOT a foreign clone,
 * so pre-existing owned-looking data is adopted (re-stamped) rather than graveyarded.
 */
export async function runResidueSweep(selfNodeId: string, nodeIdFreshlyGenerated = false): Promise<void> {
  for (const guildId of listGuilds()) {
    const owner = readOwner(guildId);
    if (!owner) {
      // No manifest: adopt this dir under the current node (pre-P4 standalone
      // data, or a fresh dir whose stamp did not land before a crash).
      stampOwner(guildId);
      continue;
    }
    if (owner.nodeId !== selfNodeId) {
      if (nodeIdFreshlyGenerated) {
        // Node identity was regenerated this boot (node.json lost/corrupt while
        // guild dirs survived). Every .owner carries the OLD id, so a mismatch
        // here is self-identity loss, not a foreign clone. Adopt the data under
        // the new id instead of mass-quarantining it. Be conservative: when in
        // doubt, keep the data.
        console.warn(
          `[Fleet] Node identity was regenerated this boot; /data/${guildId}/.owner ` +
          `carries a previous id (${owner.nodeId}). Adopting pre-existing guild data under ${selfNodeId} ` +
          `rather than quarantining it.`,
        );
        stampOwner(guildId);
        continue;
      }
      // Foreign residue: another live node's data on this disk (cloned volume,
      // stale migration source), and this node's identity was LOADED (not
      // regenerated), so the mismatch is genuine. Quarantine it rather than serve it:
      // the dir itself, whatever the guild's route (a guild now on postgres keeps its rows).
      console.warn(
        `[Fleet] FOREIGN RESIDUE detected: /data/${guildId}/.owner belongs to node ${owner.nodeId}, ` +
        `not this node (${selfNodeId}).\n` +
        `[Fleet] Moving /data/${guildId} to the graveyard so it is never served here.\n` +
        `[Fleet] If this box was cloned from another node's data volume, that is expected; ` +
        `the original owner still holds this guild.`,
      );
      await graveyardGuildDir(guildId, 'foreign-residue');
    }
  }

  await cleanOrphanTmp(DATA_ROOT);
  await disposeIncoming();
}

// Delete *.tmp files (from an interrupted atomic write) older than 1h. Recurses
// the whole data tree; a young tmp may be an in-flight write and is left alone.
async function cleanOrphanTmp(dir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - ORPHAN_TMP_MAX_AGE_MS;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanOrphanTmp(full);
    } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(full);
          console.log(`[Fleet] Removed orphaned temp file: ${full}`);
        }
      } catch { /* vanished mid-sweep */ }
    }
  }
}

// _incoming staging disposition. The only self-contained (no-master) crash rule
// from PLAN_P5 is: a leg in commit-intent finishes its renames locally
// (idempotent), with the commit's term and epoch its manifest names, as the
// executor's commit does. Other staging, and a commit-intent leg naming
// neither, is left for the P5 coordinator to resolve against the master (ask
// -> aborted/unknown delete, committing finish, else kept); it is never
// deleted here so a still-live migration keeps its data.
async function disposeIncoming(): Promise<void> {
  const incomingRoot = path.join(DATA_ROOT, INCOMING_DIR);
  let migrations: fs.Dirent[];
  try {
    migrations = await fs.promises.readdir(incomingRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const mig of migrations) {
    if (!mig.isDirectory() || mig.name.startsWith(DELETING_PREFIX)) continue;
    let legs: fs.Dirent[];
    try { legs = await fs.promises.readdir(path.join(incomingRoot, mig.name), { withFileTypes: true }); } catch { continue; }
    for (const leg of legs) {
      if (!leg.isDirectory()) continue;
      let manifest: any = null;
      try {
        manifest = JSON.parse(await fs.promises.readFile(path.join(incomingRoot, mig.name, leg.name, '.manifest.json'), 'utf-8'));
      } catch { /* no manifest */ }
      if (manifest?.phase !== 'commit-intent' || !Number.isInteger(manifest.commitTerm) || !Number.isInteger(manifest.commitEpoch)) continue;
      noteBootLanded(mig.name, leg.name, path.join(incomingRoot, mig.name, leg.name), manifest);
      try {
        if (await commitFromStaging(mig.name, leg.name, manifest.commitTerm, manifest.commitEpoch)) {
          console.log(`[Fleet] Finished commit-intent staging for migration ${mig.name} leg ${leg.name}`);
        }
      } catch (error) {
        console.warn(`[Fleet] Commit-intent staging for migration ${mig.name} leg ${leg.name} not finished at boot (its master's verdict or the next boot finishes it):`, error instanceof Error ? error.message : error);
      }
    }
  }
}

interface BootLanded {
  migrationId: string;
  legId: string;
  guilds: string[];
  term: number;
  epoch: number;
}

const isGuildId = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

function readBootLanded(): BootLanded[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, INCOMING_DIR, BOOT_LANDED_FILE), 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((n: any) => typeof n?.migrationId === 'string' && typeof n.legId === 'string'
      && Array.isArray(n.guilds) && n.guilds.every(isGuildId) && Number.isInteger(n.term) && Number.isInteger(n.epoch)) : [];
  } catch {
    return [];
  }
}

function writeBootLanded(list: BootLanded[]): void {
  const file = path.join(DATA_ROOT, INCOMING_DIR, BOOT_LANDED_FILE);
  if (list.length === 0) fs.rmSync(file, { force: true });
  else atomicWriteFileSync(file, JSON.stringify(list, null, 2));
}

// Noted before it lands, so a crash in between still has it checked.
function noteBootLanded(migrationId: string, legId: string, legDir: string, manifest: any): void {
  try {
    const noted = readBootLanded();
    if (noted.some(n => n.migrationId === migrationId && n.legId === legId)) return;
    const guilds: string[] = Array.isArray(manifest.guilds) ? manifest.guilds.filter(isGuildId)
      : fs.readdirSync(legDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && isGuildId(entry.name)).map(entry => entry.name);
    writeBootLanded([...noted, { migrationId, legId, guilds, term: manifest.commitTerm, epoch: manifest.commitEpoch }]);
  } catch (error) {
    console.warn(`[Fleet] Commit-intent staging ${migrationId}/${legId} could not be noted before it lands, so its master's verdict is not checked:`, error instanceof Error ? error.message : error);
  }
}

// A leg the boot landed is asked about as staging is. A committing verdict
// naming it aborted (its target was Declared Lost, its shard freed) moves
// each of its guilds still as the boot left it (this node's stamp of that
// commit) to the graveyard, but one whose shard this node serves now (the
// freed shard placed here) stays; one naming it pending asks again; any
// other ends the check (no other verdict says this leg must not land).
// No verdict asks again on the next pass.
async function checkBootLanded(
  queryMaster: (migrationId: string, stagedTerm: number) => Promise<MigrationDisposition>,
  busy: () => boolean,
  servedHere: (guildId: string) => boolean,
): Promise<void> {
  const noted = readBootLanded();
  if (noted.length === 0) return;
  const selfNodeId = getNodeId();
  const left: BootLanded[] = [];
  for (const landed of noted) {
    let disposition: MigrationDisposition;
    try {
      disposition = await queryMaster(landed.migrationId, landed.term);
    } catch {
      left.push(landed);
      continue;
    }
    const own = disposition.verdict === 'committing' ? disposition.legs?.[landed.legId] : undefined;
    if (own === 'pending' || (own === 'aborted' && busy())) {
      left.push(landed);
      continue;
    }
    if (own !== 'aborted') continue;
    let moved = 0;
    let served = 0;
    let failed = false;
    for (const guildId of landed.guilds) {
      const owner = readOwner(guildId);
      if (!owner || owner.nodeId !== selfNodeId || owner.epoch !== landed.epoch) continue;
      if (servedHere(guildId)) {
        served += 1;
        continue;
      }
      try {
        await graveyardLiveDir(guildId, `migration-${landed.migrationId}-not-landing`);
        moved += 1;
      } catch {
        failed = true;
      }
    }
    if (failed) left.push(landed);
    console.warn(`[Fleet] Commit-intent staging of migration ${landed.migrationId} leg ${landed.legId} landed at this node's boot, but the master says it must not land (its target was declared lost or the leg aborted): ${moved} guild(s) moved to the graveyard${served > 0 ? `, ${served} kept as this node now serves their shard` : ''}${failed ? '; the rest are retried on the next pass' : ''}`);
  }
  writeBootLanded(left);
}

/** How the master answers a node's boot query about a migration it still stages. */
export type MigrationDisposition =
  | { verdict: 'aborted' | 'unknown' }
  | { verdict: 'committing'; term: number; epoch: number; legs?: Record<string, 'aborted' | 'pending'> };

/**
 * The verdict in a master's answer to a co-worker's ask; null (the staging is
 * kept) without one. An aborted or unknown from a master below the staging's
 * own term speaks for an older fleet (a superseded master still taking
 * registers), so it keeps the staging too.
 */
export function dispositionFromReply(reply: any, stagedTerm = 0): MigrationDisposition | null {
  const disposition = reply?.ok === true ? reply.disposition : null;
  if (disposition?.verdict === 'aborted' || disposition?.verdict === 'unknown') {
    return Number(reply.term) >= stagedTerm ? { verdict: disposition.verdict } : null;
  }
  if (disposition?.verdict === 'committing' && Number.isInteger(disposition.term) && Number.isInteger(disposition.epoch)) {
    const legs: Record<string, 'aborted' | 'pending'> = {};
    for (const [legId, own] of Object.entries(disposition.legs && typeof disposition.legs === 'object' ? disposition.legs : {})) {
      if (own === 'aborted' || own === 'pending') legs[legId] = own;
    }
    return { verdict: 'committing', term: disposition.term, epoch: disposition.epoch, ...(Object.keys(legs).length > 0 ? { legs } : {}) };
  }
  return null;
}

/**
 * Node-side crash recovery for _incoming staging that is NOT commit-intent
 * (those were already finished locally by disposeIncoming). For each staged
 * migration/leg the master is queried after register:
 *   - aborted/unknown -> delete the staging (safe: the master no longer wants it).
 *   - committing -> finish the renames from the intact staging (the master
 *     decided commit; the target's data is the product), but for the legs
 *     it names: an aborted one is deleted, one before its own decision kept.
 *   - no verdict (query rejects: no master answers, or the migration runs
 *     before its commit decision) -> keep it and ask again on the next pass.
 *     Never deleted on a timer: a master waiting in COMMITTING on this node
 *     commits the staging whenever the node returns.
 * `queryMaster(migrationId, stagedTerm)` resolves the disposition or rejects
 * without one; stagedTerm is the highest term the staging's manifests carry.
 * `busy()` says migration work is live on this node: a deletion waits for the
 * next pass then.
 */
export async function resolveIncomingWithMaster(
  queryMaster: (migrationId: string, stagedTerm: number) => Promise<MigrationDisposition>,
  busy: () => boolean = () => false,
  servedHere: (guildId: string) => boolean = () => false,
): Promise<void> {
  const incomingRoot = path.join(DATA_ROOT, INCOMING_DIR);
  let migrations: fs.Dirent[];
  try {
    migrations = await fs.promises.readdir(incomingRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const mig of migrations) {
    if (!mig.isDirectory()) continue;
    const migDir = path.join(incomingRoot, mig.name);
    if (mig.name.startsWith(DELETING_PREFIX)) {
      try { await fs.promises.rm(migDir, { recursive: true, force: true }); } catch { /* best effort */ }
      continue;
    }
    let legs: fs.Dirent[];
    try { legs = await fs.promises.readdir(migDir, { withFileTypes: true }); } catch { continue; }
    let stagedTerm = 0;
    for (const leg of legs) {
      if (!leg.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(migDir, leg.name, '.manifest.json'), 'utf-8'));
        if (Number.isInteger(manifest?.term)) stagedTerm = Math.max(stagedTerm, manifest.term);
      } catch { /* no manifest */ }
    }
    let disposition: MigrationDisposition | null = null;
    try {
      disposition = await queryMaster(mig.name, stagedTerm);
    } catch {
      continue;
    }
    if (disposition.verdict !== 'committing') {
      // Moved aside in the same tick as the live-work check: a prepare
      // re-running a leg under this id (a resumed retire) stages afresh
      // instead of into a tree being removed.
      if (busy()) continue;
      const doomed = path.join(incomingRoot, `${DELETING_PREFIX}${mig.name}`);
      try { fs.renameSync(migDir, doomed); } catch { continue; }
      try { await fs.promises.rm(doomed, { recursive: true, force: true }); } catch { /* best effort; the next pass finishes it */ }
      console.log(`[Fleet] Deleted migration staging ${mig.name} (master verdict: ${disposition.verdict})`);
      continue;
    }
    // committing: finish each leg's renames from its intact staging. A leg
    // the verdict names did not reach its own commit: an aborted one (a
    // retire slice whose abort is still owed here) goes, one before its
    // decision is kept.
    let finished = 0;
    for (const leg of legs) {
      if (!leg.isDirectory()) continue;
      const own = disposition.legs?.[leg.name];
      if (own === 'pending') continue;
      if (own === 'aborted') {
        if (busy()) continue;
        const doomed = path.join(incomingRoot, `${DELETING_PREFIX}${mig.name}-${leg.name}`);
        try { fs.renameSync(path.join(migDir, leg.name), doomed); } catch { continue; }
        try { await fs.promises.rm(doomed, { recursive: true, force: true }); } catch { /* best effort; the next pass finishes it */ }
        console.log(`[Fleet] Deleted migration staging ${mig.name}/${leg.name} (master verdict: that leg aborted)`);
        continue;
      }
      if (await commitFromStaging(mig.name, leg.name, disposition.term, disposition.epoch)) finished += 1;
    }
    // Reap the migration dir when nothing is left (a DONE migration keeps the
    // committing verdict while in history; an empty dir must not log forever).
    try { await fs.promises.rmdir(migDir); } catch { /* not empty or already gone */ }
    if (finished > 0) console.log(`[Fleet] Resumed commit for migration staging ${mig.name} (master verdict: committing)`);
  }
  await checkBootLanded(queryMaster, busy, servedHere);
}

/**
 * Source-side graveyard resume: a source that crashed mid-graveyarding wrote
 * /data/global/fleet/xfer-source-{id}-{leg}.json {id, phase:'graveyarding',
 * guilds} before starting. At boot finish graveyarding those guilds, then
 * remove the marker.
 */
export async function resumeSourceGraveyarding(): Promise<void> {
  const fleetDir = path.join(DATA_ROOT, 'global', 'fleet');
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(fleetDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^xfer-source-.+\.json$/.test(entry.name)) continue;
    const marker = path.join(fleetDir, entry.name);
    let parsed: any = null;
    try { parsed = JSON.parse(await fs.promises.readFile(marker, 'utf-8')); } catch { /* corrupt */ }
    if (parsed?.phase === 'graveyarding' && Array.isArray(parsed.guilds)) {
      for (const guildId of parsed.guilds) {
        try { await deleteGuildNamespace(String(guildId), `migration-${parsed.id ?? 'unknown'}-source-retired`); } catch { /* best effort */ }
      }
    }
    try { await fs.promises.unlink(marker); } catch { /* best effort */ }
  }
}

/**
 * Owned namespaces for registry reconstruction (disaster path; P1 consumes it
 * opportunistically only).
 */
export function listOwnedNamespaces(): { guildId: string; shardId: number; epoch: number }[] {
  const result: { guildId: string; shardId: number; epoch: number }[] = [];
  for (const guildId of listGuilds()) {
    const owner = readOwner(guildId);
    if (owner) result.push({ guildId, shardId: owner.shardId, epoch: owner.epoch });
  }
  return result;
}

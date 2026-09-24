// Node-local fleet-config cache (PLAN_REPLICATION 20.7, stage B2). The master
// owns the stored copy; every node persists the last push here so a reboot
// during a master outage still knows the full candidate list. Precedence: a
// runtime value owns its key once one exists; the env seed fills the gap only
// until then.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import { rawMasterUrls, resolveMasterUrls, stripSelfUrl } from './nodeIdentity';
import type { BackupDesignation, FleetConfigPayload } from './protocol';

const cacheFile = () => dataPath('global', FLEET_DIR, 'config-cache.json');

export function readFleetConfigCache(): FleetConfigPayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'));
    if (!Number.isFinite(parsed?.revision) || !Array.isArray(parsed?.masterCandidates)) return null;
    return {
      revision: Number(parsed.revision),
      masterCandidates: parsed.masterCandidates.filter((u: unknown) => typeof u === 'string'),
      backupDesignations: Array.isArray(parsed.backupDesignations)
        ? parsed.backupDesignations
          .filter((d: any) => typeof d?.nodeId === 'string' && Number.isFinite(d?.priority))
          .map((d: any) => (d.mode === 'active' ? { nodeId: d.nodeId, priority: d.priority, mode: 'active' as const } : { nodeId: d.nodeId, priority: d.priority }))
        : [],
      ...(typeof parsed.witnessChannelId === 'string' && parsed.witnessChannelId !== ''
        ? { witnessChannelId: parsed.witnessChannelId }
        : {}),
      ...(parsed.hadBackup === true ? { hadBackup: true } : {}),
    };
  } catch {
    return null;
  }
}

export function writeFleetConfigCache(config: FleetConfigPayload): void {
  atomicWriteFileSync(cacheFile(), JSON.stringify(config, null, 2));
}

/**
 * Once a backup has been designated the fleet REMEMBERS it, and neither a
 * Declare Lost nor a withdrawn designation forgets it (RULED 2026-09-16): on a
 * master carrying no MASTER_URLS the designation list is the empty-store
 * hold's only evidence, so dropping the last entry would let a wiped master
 * start fresh while the backup it just forgot still held the only copy. The
 * memory survives a lost volume through the node-local cache, and only a
 * confirmed brand-new fleet starts without it, because that boot seeds a
 * fresh config.
 */
export function rememberBackups<T extends { backupDesignations: BackupDesignation[]; hadBackup?: boolean }>(config: T): T {
  return config.hadBackup !== true && config.backupDesignations.length > 0 ? { ...config, hadBackup: true } : config;
}

/**
 * The empty-store hold's evidence that other nodes exist (20.14): master
 * candidates provably not this node, else the designated backups, else the
 * memory that a backup has existed. selfUrlKnown (FLEET_PUBLIC_URL set) makes
 * the self-filter exact; without it (a hand deployment where the manager
 * injects nothing) a lone entry may well be this node's own advertised URL,
 * while two or more entries always include at least one foreign node. A
 * designation is checked on its own, never behind the URL list, because a
 * manager-deployed master often carries no MASTER_URLS at all (the workers
 * dial it), which would otherwise read as a fleet of one.
 */
export function emptyStoreHoldEvidence(cached: FleetConfigPayload | null, envUrls: string[], selfNodeId: string, selfUrlKnown: boolean): string[] {
  // The runtime list owns the topology once it exists (20.7); env seeds it.
  const fleetWide = cached?.masterCandidates?.length ? cached.masterCandidates : envUrls;
  const foreign = selfUrlKnown ? stripSelfUrl(fleetWide) : (fleetWide.length > 1 ? fleetWide : []);
  if (foreign.length > 0) return foreign;
  const designated = (cached?.backupDesignations ?? []).filter(d => d.nodeId !== selfNodeId);
  if (designated.length > 0) return designated.map(d => `node ${d.nodeId.slice(0, 8)}`);
  return cached?.hadBackup === true ? ['a backup this fleet designated before'] : [];
}

/** The dial list a node acts on: the runtime copy once one exists, else the env seed. */
export function effectiveMasterUrls(): { urls: string[]; source: 'runtime' | 'env' } {
  const cached = readFleetConfigCache();
  if (cached && cached.masterCandidates.length > 0) {
    // The stored list is fleet-wide (the master included); self-filtering
    // happens here, at dial time, exactly like the env path.
    const urls = stripSelfUrl(cached.masterCandidates);
    if (urls.length > 0) return { urls, source: 'runtime' };
  }
  return { urls: resolveMasterUrls(), source: 'env' };
}

/** The list the other nodes dial (the runtime document's, else the env seed), this node included. */
export function fleetMasterCandidates(): string[] {
  const cached = readFleetConfigCache();
  return cached && cached.masterCandidates.length > 0 ? cached.masterCandidates : rawMasterUrls();
}

/** Where each value in force came from (20.7): the runtime document, the env seed, or the default of an unset key. */
export interface FleetConfigSources {
  masterCandidates: 'runtime' | 'env';
  witnessChannelId: 'runtime' | 'default';
  backupDesignations: 'runtime' | 'none';
}

export interface FleetConfigView {
  revision: number;
  masterCandidates: string[];
  backupDesignations: BackupDesignation[];
  witnessChannelId?: string;
  sources: FleetConfigSources;
}

/** The sources of a runtime document's values: an empty stored list leaves the env seed in force (effectiveMasterUrls). */
export function fleetConfigSources(config: { masterCandidates: string[]; backupDesignations: unknown[]; witnessChannelId?: string }): FleetConfigSources {
  return {
    masterCandidates: config.masterCandidates.length > 0 ? 'runtime' : 'env',
    witnessChannelId: config.witnessChannelId !== undefined ? 'runtime' : 'default',
    backupDesignations: config.backupDesignations.length > 0 ? 'runtime' : 'none',
  };
}

/**
 * The view of a stored document, on the master and on every copy alike: an
 * empty stored list shows the env seed it leaves in force, UNFILTERED, because
 * the view stands for the fleet-wide document (which carries the master's own
 * URL) and seeds the editor; the per-node self-filter applies at dial time.
 */
export function fleetConfigViewOf(config: { revision: number; masterCandidates: string[]; backupDesignations: BackupDesignation[]; witnessChannelId?: string }): FleetConfigView {
  const sources = fleetConfigSources(config);
  return {
    revision: config.revision,
    masterCandidates: sources.masterCandidates === 'runtime' ? config.masterCandidates : rawMasterUrls(),
    backupDesignations: config.backupDesignations,
    ...(config.witnessChannelId !== undefined ? { witnessChannelId: config.witnessChannelId } : {}),
    sources,
  };
}

/** Fleet-state view of the config in force on this node (workers and pre-init reads). */
export function effectiveFleetConfigView(): FleetConfigView {
  const cached = readFleetConfigCache();
  if (cached) return fleetConfigViewOf(cached);
  return { revision: 0, masterCandidates: rawMasterUrls(), backupDesignations: [], sources: { masterCandidates: 'env', witnessChannelId: 'default', backupDesignations: 'none' } };
}

/**
 * Candidate-list validation shared by the webui save and the IPC apply: a
 * non-empty, deduplicated list of ws:// or wss:// URLs (bounded so a paste
 * accident cannot balloon every node's dial cycle).
 */
export function validateMasterCandidates(input: unknown): { ok: true; urls: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: 'masterCandidates must be a non-empty list of URLs' };
  if (input.length > 16) return { ok: false, error: 'masterCandidates is capped at 16 entries' };
  const urls: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'masterCandidates entries must be non-empty strings' };
    const url = raw.trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, error: `not a valid URL: ${url}` }; }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return { ok: false, error: `master candidates must be ws:// or wss:// URLs: ${url}` };
    if (!urls.includes(url)) urls.push(url);
  }
  return { ok: true, urls };
}

/** Witness beacon channel id: a Discord snowflake, or empty for the owner DM default. */
export function validateWitnessChannelId(input: unknown): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== 'string') return { ok: false, error: 'witnessChannelId must be a string' };
  const value = input.trim();
  if (value === '') return { ok: true, value: undefined };
  if (!/^\d{15,21}$/.test(value)) return { ok: false, error: 'witnessChannelId must be a Discord channel id (or empty for the owner DM default)' };
  return { ok: true, value };
}

/**
 * The backup order (PLAN_REPLICATION 20.9, 20.19 F9): the list order IS the
 * priority, renumbered 1..n on save. Only nodes this master knows (registered
 * now, or already designated) may be listed, each once. An empty list is
 * allowed: the next register of a backup-master designates it again.
 */
export function validateBackupDesignations(input: unknown, known: Set<string>, activeCapable?: (nodeId: string) => boolean): { ok: true; designations: BackupDesignation[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'backupDesignations must be a list' };
  if (input.length > 16) return { ok: false, error: 'backupDesignations is capped at 16 entries' };
  const ids: string[] = [];
  const active = new Set<string>();
  for (const raw of input) {
    const nodeId = typeof raw === 'string' ? raw.trim() : typeof raw?.nodeId === 'string' ? raw.nodeId.trim() : '';
    if (nodeId === '') return { ok: false, error: 'backupDesignations entries must name a node id' };
    if (!known.has(nodeId)) return { ok: false, error: `node ${nodeId.slice(0, 8)} is not known to this master` };
    if (ids.includes(nodeId)) return { ok: false, error: `node ${nodeId.slice(0, 8)} is listed twice` };
    // The master owns the ENABLE, never the consent: it may not put a node into a
    // mode that node's own capability declines (20.5, B6 map F7).
    if (typeof raw !== 'string' && raw?.mode === 'active') {
      if (activeCapable && !activeCapable(nodeId)) {
        return { ok: false, error: `node ${nodeId.slice(0, 8)} does not declare active mode, so it cannot be enabled for it here` };
      }
      active.add(nodeId);
    }
    ids.push(nodeId);
  }
  return { ok: true, designations: ids.map((nodeId, index) => (active.has(nodeId) ? { nodeId, priority: index + 1, mode: 'active' as const } : { nodeId, priority: index + 1 })) };
}

/** Priorities are 1..n in order; a removal closes the gap. The mode rides along: it is the master's own enable, not a function of the order. */
export function renumberDesignations(list: BackupDesignation[]): BackupDesignation[] {
  return [...list].sort((a, b) => a.priority - b.priority).map((d, index) => (d.mode === 'active' ? { nodeId: d.nodeId, priority: index + 1, mode: 'active' as const } : { nodeId: d.nodeId, priority: index + 1 }));
}

/** Drop an entry's active enable, keeping everything else (a node that withdrew its consent). */
export function forcePassive(list: BackupDesignation[], nodeId: string): BackupDesignation[] {
  return list.map(d => (d.nodeId === nodeId ? { nodeId: d.nodeId, priority: d.priority } : d));
}

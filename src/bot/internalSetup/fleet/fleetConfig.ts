// Node-local fleet-config cache (PLAN_REPLICATION 20.7, stage B2). The master
// owns the stored copy; every node persists the last push here so a reboot
// during a master outage still knows the full candidate list. Precedence: a
// runtime value owns its key once one exists; the env seed fills the gap only
// until then.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import { resolveMasterUrls, stripSelfUrl } from './nodeIdentity';
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
    };
  } catch {
    return null;
  }
}

export function writeFleetConfigCache(config: FleetConfigPayload): void {
  atomicWriteFileSync(cacheFile(), JSON.stringify(config, null, 2));
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

/** Fleet-state view of the config in force on this node (workers and pre-init reads). */
export function effectiveFleetConfigView(): { revision: number; masterCandidates: string[]; backupDesignations: BackupDesignation[]; witnessChannelId?: string; source: 'runtime' | 'env' } {
  const cached = readFleetConfigCache();
  if (cached) {
    return {
      revision: cached.revision,
      masterCandidates: cached.masterCandidates,
      backupDesignations: cached.backupDesignations,
      ...(cached.witnessChannelId !== undefined ? { witnessChannelId: cached.witnessChannelId } : {}),
      source: 'runtime',
    };
  }
  return { revision: 0, masterCandidates: resolveMasterUrls(), backupDesignations: [], source: 'env' };
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

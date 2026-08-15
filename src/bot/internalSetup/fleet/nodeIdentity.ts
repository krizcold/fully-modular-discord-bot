// Node identity and role resolution. The nodeId is generated once and
// persisted to /data/global/fleet/node.json so a node keeps its identity
// across restarts (the registry keys on it).

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import type { NodeRole } from './protocol';

/**
 * Role override (PLAN_STANDBY 3.3): written only by the promote/demote paths,
 * survives container recreate (data volume), wins over every env signal. The
 * takeover/chainTakeover flags are ONE-SHOT: consumed right after a successful
 * term acquisition so a later unrelated restart never re-triggers them.
 */
export interface RoleOverride {
  role: NodeRole;
  /** Skip the boot takeover guard (explicit operator/policy intent). */
  takeover?: boolean;
  /** Promotion over a dead master: auto-Declare-Lost it after the hold-down. */
  chainTakeover?: boolean;
  setAt: number;
  setBy: 'webui-promote' | 'webui-demote' | 'auto-promote';
}

const ROLE_OVERRIDE_BASENAME = 'role-override.json';

function roleOverrideFile(): string {
  return dataPath('global', FLEET_DIR, ROLE_OVERRIDE_BASENAME);
}

let cachedOverride: RoleOverride | null | undefined;

/** Cached per process: a role change always goes through a bot restart. */
export function readRoleOverride(): RoleOverride | null {
  if (cachedOverride !== undefined) return cachedOverride;
  try {
    const parsed = JSON.parse(fs.readFileSync(roleOverrideFile(), 'utf-8'));
    if (parsed && (parsed.role === 'master' || parsed.role === 'co-worker')) {
      cachedOverride = {
        role: parsed.role,
        ...(parsed.takeover === true ? { takeover: true } : {}),
        ...(parsed.chainTakeover === true ? { chainTakeover: true } : {}),
        setAt: Number(parsed.setAt) || 0,
        setBy: parsed.setBy === 'webui-demote' || parsed.setBy === 'auto-promote' ? parsed.setBy : 'webui-promote',
      };
      return cachedOverride;
    }
  } catch { /* absent or unreadable = no override */ }
  cachedOverride = null;
  return null;
}

/** Written by the webui parent (promote/demote) and the auto-promote path. */
export function writeRoleOverride(override: RoleOverride): void {
  atomicWriteFileSync(roleOverrideFile(), JSON.stringify(override, null, 2));
  cachedOverride = undefined;
}

export function clearRoleOverride(): void {
  try { fs.unlinkSync(roleOverrideFile()); } catch { /* already absent */ }
  cachedOverride = undefined;
}

/** One-shot consumption of the takeover flags after a successful term acquire; the role itself stays. */
export function consumeTakeoverFlags(): void {
  const override = readRoleOverride();
  if (!override || (!override.takeover && !override.chainTakeover)) return;
  writeRoleOverride({ role: override.role, setAt: override.setAt, setBy: override.setBy });
}

/**
 * Role resolution: the override file wins; else explicit BOT_NODE_ROLE; else a
 * configured master candidate list means co-worker; else master (standalone
 * when no control channel is configured).
 */
export function resolveNodeRole(): NodeRole {
  const override = readRoleOverride();
  if (override) return override.role;
  return resolveEnvRole();
}

/** The role env alone would resolve to (override ignored); demotion of an env co-worker just clears the override. */
export function resolveEnvRole(): NodeRole {
  const explicit = (process.env.BOT_NODE_ROLE || '').trim().toLowerCase();
  if (explicit === 'master') return 'master';
  // backup-master is a designated co-worker: protocol role co-worker, backup
  // designation carried separately (isBackupMaster).
  if (explicit === 'co-worker' || explicit === 'backup-master') return 'co-worker';
  // Only the legacy single MASTER_URL infers co-worker. MASTER_URLS is the
  // fleet-wide candidate list carried by EVERY node, the master included, so
  // it can never imply a role; nodes using it must set BOT_NODE_ROLE.
  if ((process.env.MASTER_URL || '').trim() !== '') return 'co-worker';
  return 'master';
}

/** Cross-process staleness fix: the webui PARENT must re-read after the bot CHILD wrote the override (auto-promotion). */
export function invalidateRoleOverrideCache(): void {
  cachedOverride = undefined;
}

/** Standalone = today's single box: a master with no control channel configured. */
export function isStandalone(): boolean {
  return resolveNodeRole() === 'master' && (process.env.CONTROL_SECRET || '').trim() === '';
}

/**
 * Master candidate list (PLAN_STANDBY 3.4): MASTER_URLS (ordered,
 * comma-separated) with MASTER_URL as the single-entry fallback. A candidate
 * equal to this node's own advertised control route is skipped so a promoted
 * or demoted node never dials itself.
 */
export function resolveMasterUrls(): string[] {
  const raw = (process.env.MASTER_URLS || '').trim();
  const list = raw !== ''
    ? raw.split(',').map(s => s.trim()).filter(s => s !== '')
    : [(process.env.MASTER_URL || '').trim()].filter(s => s !== '');
  const self = normalizeUrl((process.env.FLEET_PUBLIC_URL || '').trim());
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of list) {
    const key = normalizeUrl(url);
    if (key === '' || key === self || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/** True when this co-worker is the designated backup master (BOT_NODE_ROLE=backup-master, or the low-level FLEET_BACKUP_MASTER=1 flag). */
export function isBackupMaster(): boolean {
  return (process.env.BOT_NODE_ROLE || '').trim().toLowerCase() === 'backup-master'
    || (process.env.FLEET_BACKUP_MASTER || '').trim() === '1';
}

/** True when the designated backup is set to promote itself (FLEET_AUTO_PROMOTE=1). */
export function isAutoPromoteEnabled(): boolean {
  return isBackupMaster() && (process.env.FLEET_AUTO_PROMOTE || '').trim() === '1';
}

export function getNodeName(): string {
  return (process.env.NODE_NAME || '').trim() || os.hostname();
}

let cachedNodeId: string | null = null;
// True once getNodeId minted a fresh id this boot (node.json was missing or
// unparseable), false once a valid id was loaded from disk. Consumed by the
// residue sweep to tell "this node forgot who it was" apart from a genuine
// foreign/cloned volume, so a regenerated id never mass-graveyards owned data.
let nodeIdWasGenerated = false;

export function getNodeId(): string {
  if (cachedNodeId) return cachedNodeId;
  const file = dataPath('global', FLEET_DIR, 'node.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed.nodeId === 'string' && parsed.nodeId.length > 0) {
      cachedNodeId = parsed.nodeId;
      nodeIdWasGenerated = false;
      return cachedNodeId!;
    }
  } catch { /* first boot */ }
  const nodeId = randomUUID();
  nodeIdWasGenerated = true;
  atomicWriteFileSync(file, JSON.stringify({ nodeId, createdAt: Date.now() }, null, 2));
  cachedNodeId = nodeId;
  return nodeId;
}

/** True when getNodeId minted a fresh id this boot (node.json was missing/unparseable). */
export function wasNodeIdFreshlyGenerated(): boolean {
  return nodeIdWasGenerated;
}

let cachedAppVersion: string | null = null;

export function getAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const pkgPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
    cachedAppVersion = String(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '0.0.0');
  } catch {
    cachedAppVersion = '0.0.0';
  }
  return cachedAppVersion;
}

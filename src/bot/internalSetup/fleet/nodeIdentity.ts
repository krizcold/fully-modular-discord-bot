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
 * Role resolution: explicit BOT_NODE_ROLE wins; else MASTER_URL present means
 * co-worker; else master (standalone when no control channel is configured).
 */
export function resolveNodeRole(): NodeRole {
  const explicit = (process.env.BOT_NODE_ROLE || '').trim().toLowerCase();
  if (explicit === 'master') return 'master';
  if (explicit === 'co-worker') return 'co-worker';
  if ((process.env.MASTER_URL || '').trim() !== '') return 'co-worker';
  return 'master';
}

/** Standalone = today's single box: a master with no control channel configured. */
export function isStandalone(): boolean {
  return resolveNodeRole() === 'master' && (process.env.CONTROL_SECRET || '').trim() === '';
}

export function getNodeName(): string {
  return (process.env.NODE_NAME || '').trim() || os.hostname();
}

let cachedNodeId: string | null = null;

export function getNodeId(): string {
  if (cachedNodeId) return cachedNodeId;
  const file = dataPath('global', FLEET_DIR, 'node.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed.nodeId === 'string' && parsed.nodeId.length > 0) {
      cachedNodeId = parsed.nodeId;
      return cachedNodeId!;
    }
  } catch { /* first boot */ }
  const nodeId = randomUUID();
  atomicWriteFileSync(file, JSON.stringify({ nodeId, createdAt: Date.now() }, null, 2));
  cachedNodeId = nodeId;
  return nodeId;
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

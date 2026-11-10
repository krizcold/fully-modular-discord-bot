// Node identity. The nodeId is generated once and persisted to
// /data/global/fleet/node.json so a node keeps its identity across restarts.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from '../utils/atomicWrite';
import { FolderSyncError } from '../utils/folderChain';

export { getNodeName } from './nodeName';

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
  try {
    atomicWriteFileSync(file, JSON.stringify({ nodeId, createdAt: Date.now() }, null, 2));
  } catch (error) {
    if (error instanceof FolderSyncError) cachedNodeId = nodeId;
    throw error;
  }
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

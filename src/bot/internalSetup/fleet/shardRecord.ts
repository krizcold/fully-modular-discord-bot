// /data/global/fleet/shards.json: the shards this machine served at its last Postgres boot (NB4 decision 22), which a
// maintenance boot connects instead of every shard of Discord's count, and the shards the last completed release kept
// for this machine, which the next boot take reads.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from '../utils/atomicWrite';
import { FolderSyncError, logFolderSyncError } from '../utils/folderChain';

export interface ShardRecord {
  shardCount: number;
  shardIds: number[];
  processId: string;
  at: string;
  keptAtStop?: number[];
}

export function shardRecordPath(): string {
  return dataPath('global', FLEET_DIR, 'shards.json');
}

/** Temp file, fsync, rename, folder chain; throws when the write fails, and logs when only the folder chain failed. */
export function writeShardRecord(record: ShardRecord): void {
  try {
    atomicWriteFileSync(shardRecordPath(), JSON.stringify(record, null, 2));
  } catch (error) {
    if (!(error instanceof FolderSyncError)) throw error;
    logFolderSyncError('[Shards] The shard record', error);
  }
}

/** The record, or null when there is none or it cannot be read. */
export function readShardRecord(): ShardRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(shardRecordPath(), 'utf-8'));
    const ids = parsed?.shardIds;
    if (!Number.isInteger(parsed?.shardCount) || parsed.shardCount <= 0 || !Array.isArray(ids)) return null;
    const inRange = (id: unknown): boolean => Number.isInteger(id) && (id as number) >= 0 && (id as number) < parsed.shardCount;
    if (!ids.every(inRange)) return null;
    const kept = parsed.keptAtStop;
    return {
      shardCount: parsed.shardCount, shardIds: ids, processId: String(parsed.processId ?? ''), at: String(parsed.at ?? ''),
      ...(Array.isArray(kept) && kept.every(inRange) ? { keptAtStop: kept } : {}),
    };
  } catch {
    return null;
  }
}

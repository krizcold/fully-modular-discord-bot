/**
 * IPC Data Handler - the webui parent's write-through-owner and read hops
 * (spec 6.3). The parent never writes a postgres-routed guild itself: every
 * guild data op lands here, is applied locally when this node owns the guild,
 * and is otherwise forwarded by the master to the owning worker over the
 * control channel. Operator writes are durability-immediate (flushed before
 * the ok), so 'ok' means committed and 'pending' means accepted-but-retrying.
 */

import {
  deleteData,
  deleteGuildNamespace,
  flushGuildOutcome,
  isGuildWriteFrozen,
  listGuildDataFiles,
  readGuildDocRaw,
  saveData,
} from './dataManager';
import { DataBackendUnavailableError } from './dataBackends/workingSet';
import { awaitGuildDataReady } from './dataBackends/boot';
import { getFleetState } from '../fleet/state';
import { guildIdToShardId } from '../fleet/placement';
import type { DataReadReply, DataWriteReply } from '../fleet/protocol';

export interface GuildDataWriteRequest {
  guildId: string;
  module: string;
  /** Ignored for delete-namespace. */
  filename: string;
  op: 'write' | 'delete' | 'delete-namespace';
  /** Raw JSON text, 2-space pretty like the facade writes. */
  contentJson?: string;
}

export interface GuildDataReadRequest {
  guildId: string;
  module: string;
  /** No filename = list the module's files. */
  filename?: string;
}

/**
 * Master-only forwarder to the owning worker (registered by fleet bootstrap,
 * which stamps the wire term; module-level so a fleet re-init keeps the
 * latest hop).
 */
export type DataOpForwarder = (kind: 'write' | 'read', request: GuildDataWriteRequest | GuildDataReadRequest) => Promise<DataWriteReply | DataReadReply>;
let forwarder: DataOpForwarder | null = null;
export function setDataOpForwarder(cb: DataOpForwarder | null): void {
  forwarder = cb;
}

function validSegment(value: string, allowSubpath: boolean): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  if (value.includes('\\') || value.includes('..') || value.startsWith('/')) return false;
  if (!allowSubpath && value.includes('/')) return false;
  return true;
}

function validateWrite(req: GuildDataWriteRequest): string | null {
  if (!/^\d+$/.test(req.guildId ?? '')) return 'invalid guildId';
  if (req.op !== 'write' && req.op !== 'delete' && req.op !== 'delete-namespace') return 'invalid op';
  if (req.op === 'delete-namespace') return null;
  if (!validSegment(req.module, false)) return 'invalid module';
  if (!validSegment(req.filename, true)) return 'invalid filename';
  if (req.op === 'write' && typeof req.contentJson !== 'string') return 'contentJson is required';
  return null;
}

/** True when this node serves the guild itself (standalone counts as local). */
function servedLocally(guildId: string): boolean {
  const fleet = getFleetState();
  if (!fleet.initialized || fleet.standalone || fleet.shardCount <= 0) return true;
  const shardId = guildIdToShardId(guildId, fleet.shardCount);
  return fleet.leases.some(l => l.shardId === shardId);
}

/**
 * Owner-side apply (identical on master and worker): freeze check, facade
 * write so coalescing/metrics/fencing engage, then a bounded durability flush.
 */
export async function applyOperatorDataWrite(req: GuildDataWriteRequest): Promise<DataWriteReply> {
  const invalid = validateWrite(req);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  const { guildId, module, filename, op } = req;
  if (isGuildWriteFrozen(guildId)) return { ok: false, code: 'frozen' };
  if (!(await awaitGuildDataReady(guildId))) {
    return { ok: false, code: 'backend-unavailable', error: 'guild data is not ready' };
  }
  try {
    if (op === 'delete-namespace') {
      const moved = await deleteGuildNamespace(guildId, 'webui-operator-delete');
      if (!moved) return { ok: false, code: 'io-error', error: 'guild data delete failed; nothing was removed' };
      return { ok: true };
    }
    const options = module ? { guildId, category: module } : { guildId };
    if (op === 'delete') {
      deleteData(filename, options);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.contentJson!);
      } catch {
        return { ok: false, code: 'invalid', error: 'contentJson is not valid JSON' };
      }
      if (!saveData(filename, options, parsed)) {
        // The facade already surfaced the reason (frozen counts, not-ready);
        // the operator-visible truth is that the write was not accepted.
        return { ok: false, code: 'backend-unavailable', error: 'write not accepted' };
      }
    }
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) {
      return { ok: false, code: 'backend-unavailable', error: error.message };
    }
    return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
  }
  const outcome = await flushGuildOutcome(guildId, 8000);
  if (outcome === 'ok') return { ok: true };
  if (outcome === 'pending') return { ok: true, pending: true };
  if (outcome === 'deposed') return { ok: false, code: 'not-owner', error: 'guild ownership moved mid-write' };
  return { ok: false, code: 'backend-unavailable', error: 'flush did not complete' };
}

export async function applyOperatorDataRead(req: GuildDataReadRequest): Promise<DataReadReply> {
  if (!/^\d+$/.test(req.guildId ?? '')) return { ok: false, code: 'invalid', error: 'invalid guildId' };
  if (req.module !== '' && !validSegment(req.module, false)) return { ok: false, code: 'invalid', error: 'invalid module' };
  if (req.filename !== undefined && !validSegment(req.filename, true)) return { ok: false, code: 'invalid', error: 'invalid filename' };
  if (!(await awaitGuildDataReady(req.guildId))) {
    return { ok: false, code: 'backend-unavailable', error: 'guild data is not ready' };
  }
  try {
    if (req.filename === undefined) {
      return { ok: true, files: listGuildDataFiles(req.guildId, req.module || undefined) };
    }
    const raw = readGuildDocRaw(req.guildId, req.module, req.filename);
    return raw === null ? { ok: true } : { ok: true, contentJson: raw };
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) {
      return { ok: false, code: 'backend-unavailable', error: error.message };
    }
    return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleGuildWrite(req: GuildDataWriteRequest): Promise<DataWriteReply> {
  const invalid = validateWrite(req);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  if (servedLocally(req.guildId)) return applyOperatorDataWrite(req);
  const fleet = getFleetState();
  if (fleet.role === 'master' && forwarder) {
    return forwarder('write', req) as Promise<DataWriteReply>;
  }
  return { ok: false, code: 'not-owner', error: 'this node does not serve this guild' };
}

async function handleGuildRead(req: GuildDataReadRequest): Promise<DataReadReply> {
  if (!/^\d+$/.test(req.guildId ?? '')) return { ok: false, code: 'invalid', error: 'invalid guildId' };
  if (servedLocally(req.guildId)) return applyOperatorDataRead(req);
  const fleet = getFleetState();
  if (fleet.role === 'master' && forwarder) {
    return forwarder('read', req) as Promise<DataReadReply>;
  }
  return { ok: false, code: 'not-owner', error: 'this node does not serve this guild' };
}

export function setupDataIPCHandlers(): void {
  if (!process.send) {
    console.warn('[IPCDataHandler] process.send not available - guild data IPC not registered');
    return;
  }
  console.log('[IPCDataHandler] Setting up IPC handlers for guild data ops');

  process.on('message', async (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message as { type?: string; requestId?: string; data?: any };
    if ((type !== 'data:guild-write' && type !== 'data:guild-read') || !requestId) return;
    try {
      const response = type === 'data:guild-write'
        ? await handleGuildWrite((data || {}) as GuildDataWriteRequest)
        : await handleGuildRead((data || {}) as GuildDataReadRequest);
      process.send!({ requestId, data: response });
    } catch (error) {
      process.send!({ requestId, data: { ok: false, code: 'io-error', error: error instanceof Error ? error.message : 'Unknown error' } });
    }
  });
}

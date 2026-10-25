import { guildIdToShardId } from './placement';
import { ControlNotSentError } from './controlServer';
import { MSG } from './protocol';
import type { DataReadReply, DataWriteReply } from './protocol';
import type { GuildDataReadRequest, GuildDataWriteRequest } from '../utils/ipcDataHandler';

export interface DataOpForwardDeps {
  shardCount: number;
  term: number;
  ownerOf(shardId: number): { nodeId: string } | undefined;
  nodeOf(nodeId: string): { connected: boolean; isSelf?: boolean } | undefined;
  request(nodeId: string, type: string, data: any): Promise<any>;
  applyWrite(req: GuildDataWriteRequest): Promise<DataWriteReply>;
  applyRead(req: GuildDataReadRequest): Promise<DataReadReply>;
}

/** Route an operator data op to the guild's owning node; a self-owned guild applies locally. */
export async function forwardDataOp(
  deps: DataOpForwardDeps,
  kind: 'write' | 'read',
  req: GuildDataWriteRequest | GuildDataReadRequest,
): Promise<DataWriteReply | DataReadReply> {
  const shardId = guildIdToShardId(req.guildId, deps.shardCount);
  const owner = deps.ownerOf(shardId);
  if (!owner) return { ok: false, code: 'shard-unassigned', error: `shard ${shardId} is unassigned` };
  const node = deps.nodeOf(owner.nodeId);
  if (!node || (!node.connected && !node.isSelf)) {
    return { ok: false, code: 'owner-disconnected', error: 'owning instance is not connected' };
  }
  if (node.isSelf) {
    return kind === 'write'
      ? deps.applyWrite(req as GuildDataWriteRequest)
      : deps.applyRead(req as GuildDataReadRequest);
  }
  const type = kind === 'write' ? MSG.DATA_WRITE : MSG.DATA_READ;
  try {
    const reply = await deps.request(owner.nodeId, type, { term: deps.term, ...req, ...(kind === 'write' ? { origin: 'webui-operator' } : {}) });
    return reply ?? { ok: false, code: 'owner-no-answer', error: 'empty reply from the owning instance' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ControlNotSentError) return { ok: false, code: 'owner-disconnected', error: message };
    return { ok: false, code: 'owner-no-answer', error: message };
  }
}

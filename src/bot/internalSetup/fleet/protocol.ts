// Fleet control-channel message definitions. The wire schema is the existing
// fork-IPC envelope: requests are {type, requestId, data}; responses echo
// {requestId, data} (acks additionally carry their message name as type).
// Every post-register message carries the sender's term so lower terms can be
// rejected everywhere (split-brain fencing).

export type NodeRole = 'master' | 'co-worker';

export interface ControlEnvelope {
  type?: string;
  requestId?: string;
  data?: any;
}

export const MSG = {
  REGISTER: 'control:register',
  LEASE_GRANT: 'control:lease:grant',
  LEASE_ACK: 'control:lease:ack',
  LEASE_REVOKE: 'control:lease:revoke',
  HEARTBEAT: 'control:heartbeat',
  GUILD_NOTICE: 'control:guild:notice',
} as const;

export interface NodeCapabilities {
  shardCapacity: number;
  dataBackend: string;
}

export interface RegisterPayload {
  nodeId: string;
  nodeName: string;
  protocolVersion: number;
  appVersion: string;
  capabilities: NodeCapabilities;
}

export interface RegisterResult {
  accepted: boolean;
  term: number;
  reason?: string;
}

export interface LeaseInfo {
  leaseId: string;
  shardId: number;
  identifyDelayMs: number;
}

export interface LeaseGrantPayload {
  term: number;
  epoch: number;
  shardCount: number;
  leases: LeaseInfo[];
}

export interface LeaseRevokePayload {
  term: number;
  leaseIds: string[];
  reason: string;
}

export interface LeaseAckPayload {
  ok: boolean;
  term: number;
  reason?: string;
}

export interface ShardStatusEntry {
  shardId: number;
  status: string;
  guildCount: number;
}

export interface LoadSample {
  cpuPct: number;
  rssMb: number;
  loopLagMs: number;
}

export interface HeartbeatPayload {
  term: number;
  seq: number;
  shards: ShardStatusEntry[];
  guilds: string[];
  metrics: { totals: any; topKGuilds: any[] };
  load: LoadSample;
}

export interface GuildNoticePayload {
  guildId: string;
  shardId: number;
  kind: 'create' | 'delete';
}

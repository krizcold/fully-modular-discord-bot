// Fleet control-channel message definitions. The wire schema is the existing
// fork-IPC envelope: requests are {type, requestId, data}; responses echo
// {requestId, data} (acks additionally carry their message name as type).
// Every post-register message carries the sender's term so lower terms can be
// rejected everywhere (split-brain fencing).
//
// Secrecy: repos.json GitHub tokens and module API credentials cross the wire
// only inside SYNC_READ replies on this already-CONTROL_SECRET-authenticated
// channel. Deployments crossing untrusted networks must use wss://
// (FLEET_PUBLIC_URL behind TLS) - the same trust posture as lease/secret
// traffic.

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
  LEASE_RENEW: 'control:lease:renew',
  /** Reply payload name only; the wire reply is {requestId, data}. */
  LEASE_RENEWED: 'control:lease:renewed',
  /** Worker -> master: hand back leases it cannot serve (hydration failure or lost ownership claim). */
  LEASE_DECLINE: 'control:lease:decline',
  NODE_DRAIN: 'control:node:drain',
  HEARTBEAT: 'control:heartbeat',
  GUILD_NOTICE: 'control:guild:notice',
  SYNC_STATE: 'control:sync:state',
  SYNC_FILES: 'control:sync:files',
  SYNC_MODULE_BEGIN: 'control:sync:module:begin',
  SYNC_READ: 'control:sync:read',
  SYNC_REPORT: 'control:sync:report',
  // Migration (P5). PREPARE/DRAIN/COMMIT/ABORT flow master -> participant
  // (request/ack). PROGRESS/VERIFY flow participant -> master (PROGRESS is
  // fire-and-forget; VERIFY is fire-and-forget too, coordinator-driven).
  // INVENTORY (redistribute) is master -> node request/reply.
  XFER_PREPARE: 'control:xfer:prepare',
  XFER_PREPARED: 'control:xfer:prepared',
  XFER_PROGRESS: 'control:xfer:progress',
  XFER_DRAIN: 'control:xfer:drain',
  XFER_VERIFY: 'control:xfer:verify',
  XFER_COMMIT: 'control:xfer:commit',
  XFER_ABORT: 'control:xfer:abort',
  XFER_INVENTORY: 'control:xfer:inventory',
  /** Lease-only legs: source -> master drain confirmation replacing the dual-hash verify. */
  XFER_FLUSHED: 'control:xfer:flushed',
  // Data backend. TRANSFORM_GUILD/BACKEND_FLIP flow master -> owner
  // (request/ack). DATA_WRITE/DATA_READ are master -> owning node
  // request/reply (the webui write-through-owner hop and its symmetric read).
  // CAPABILITY_REFRESH flows worker -> master after a runtime backend apply.
  TRANSFORM_GUILD: 'control:transform:guild',
  BACKEND_FLIP: 'control:backend:flip',
  DATA_WRITE: 'control:data:write',
  DATA_READ: 'control:data:read',
  CAPABILITY_REFRESH: 'control:capability:refresh',
} as const;

export interface NodeCapabilities {
  shardCapacity: number;
  /** Declarations only ever send a real backend; 'unknown' is recorded registry-side for a register payload with no capabilities (never a guessed backend). */
  dataBackend: 'file' | 'postgres' | 'unknown';
  /** Advertised transfer endpoint (ws://host:port) when TRANSFER_URL is set; direction-by-reachability uses it. */
  transferUrl?: string;
}

export interface RegisterPayload {
  nodeId: string;
  nodeName: string;
  protocolVersion: number;
  appVersion: string;
  capabilities: NodeCapabilities;
  /** Worker's cached lease summary, reconciled by the master on every (re)register; null when no lease is held. */
  heldLeases?: { term: number; epoch: number; shardCount: number;
                 leases: { leaseId: string; shardId: number }[] } | null;
}

export interface RegisterResult {
  accepted: boolean;
  term: number;
  reason?: string;
  budget?: BudgetInfo | null;
  /** Master's data-backend decision, re-delivered on every reconnect; absent = file mode. Refusals carry nothing. */
  dataBackend?: DataBackendInfo;
}

/** Backend decision + routing map handed to workers in the register reply. */
export interface DataBackendInfo {
  backend: 'file' | 'postgres';
  /** Connection string; only when backend is postgres. */
  url?: string;
  /** Active transformation, if any. */
  transformationId?: string;
  /** Per-guild routing overrides while a transformation is active. */
  routes?: { guildId: string; backend: 'file' | 'postgres' }[];
}

export interface BudgetInfo {
  total: number;
  /** Live remaining minus local debits since the last fetch. */
  remaining: number;
  resetAfterMs: number;
  fetchedAgoMs: number;
  /** True when the last /gateway/bot fetch failed. */
  stale: boolean;
  /** True when /gateway/bot has never succeeded; the numeric fields are placeholders. */
  unavailable?: true;
  backoffs: { nodeId: string; nodeName: string; crashCount: number; nextPermitInMs: number }[];
}

export interface LeaseRenewPayload {
  term: number;
  leaseIds: string[];
}

export interface LeaseRenewedPayload {
  ok: boolean;
  term: number;
  epoch: number;
  reason?: string; // 'lease-mismatch' | 'stale-term'
  budget?: BudgetInfo | null;
}

export interface NodeDrainPayload {
  term: number;
  reason: string;
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

export interface LeaseDeclinePayload {
  term: number;
  leaseIds: string[];
  reason: 'hydration-timeout' | 'deposed-at-hydration';
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
  /** shardCount of the sender's current lease; absent when no lease is held. Adoption requires it to match the registry's. */
  shardCount?: number;
  shards: ShardStatusEntry[];
  guilds: string[];
  metrics: { totals: any; topKGuilds: any[] };
  load: LoadSample;
  /** Last fully-applied sync revision (co-worker only). */
  syncAppliedRevision?: number;
  /** False while the last reconcile ended degraded (co-worker only). */
  syncOk?: boolean;
}

export interface GuildNoticePayload {
  guildId: string;
  shardId: number;
  kind: 'create' | 'delete';
}

export type SyncFileScope = 'appstore' | 'config' | 'settings' | 'globaldata';

export interface SyncModuleEntry {
  name: string;
  version: string;
  commit?: string;
  contentHash: string;
  enabled: boolean;
}

/** Small, hashes-only manifest; secrets never appear here. */
export interface SyncManifest {
  revision: number;
  appVersion: string;
  modules: SyncModuleEntry[];
  appstoreHash: string;
  configHash: string;
  settingsHash: string;
  globalDataHash: string;
}

export interface SyncStatePayload {
  term: number;
  manifest: SyncManifest;
}

export interface SyncFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface SyncFilesRequest {
  term: number;
  scope: SyncFileScope;
}

export interface SyncFilesReply {
  revision: number;
  files: SyncFileEntry[];
}

export interface SyncModuleBeginRequest {
  term: number;
  name: string;
}

export interface SyncModuleBeginReply {
  revision: number;
  name: string;
  version: string;
  commit?: string;
  contentHash: string;
  files: SyncFileEntry[];
}

export interface SyncReadRequest {
  term: number;
  scope: 'module' | SyncFileScope;
  module?: string;
  path: string;
  offset: number;
}

export interface SyncReadReply {
  dataB64: string;
  eof: boolean;
}

export interface SyncReportPayload {
  term: number;
  appliedRevision: number;
  ok: boolean;
  degraded?: string[];
}

// ============================================================================
// MIGRATION (P5)
// ============================================================================

export type MigrationKind = 'move' | 'swap' | 'retire' | 'redistribute';
/** 'none' = lease-only leg (both endpoints postgres-routed); the transfer channel is never opened. */
export type TransferDirection = 'push' | 'pull' | 'none';
export type TransferRole = 'source' | 'target';

/** One transfer leg's per-participant instruction inside a prepare. */
export interface XferPrepareLeg {
  legId: string;
  shardId: number;
  role: TransferRole;
  /** Peer's transfer endpoint when this side must dial; absent when this side listens. */
  peerUrl?: string;
  token: string;
  direction: TransferDirection;
  guilds: string[];
}

export interface XferPreparePayload {
  migrationId: string;
  kind: MigrationKind;
  legs: XferPrepareLeg[];
  term: number;
  epoch: number;
}

export interface XferPreparedPayload {
  ok: boolean;
  /** Source ack: sum of sizeOfGuildData over the leg's guilds. */
  estBytes?: number;
  /** Target ack: statfs free bytes, or undefined when unknown (tolerated with a UI warning). */
  freeBytes?: number;
  reason?: string;
}

export interface XferProgressPayload {
  migrationId: string;
  legId: string;
  round: number;
  filesSent: number;
  bytesSent: number;
  guildsTotal: number;
  guildsDone: number;
  deltaFiles: number;
  error?: string;
}

export interface XferDrainPayload {
  migrationId: string;
  term: number;
  legIds: string[];
}

export interface XferVerifyPayload {
  migrationId: string;
  legId: string;
  side: TransferRole;
  hash: string;
  guildHashes: Record<string, string>;
}

/** Lease-only legs: drain confirmation replaces the dual-hash verify. */
export interface XferFlushedPayload {
  migrationId: string;
  legId: string;
  term: number;
  ok: boolean;
  pendingOps: number;
  flushFailures: number;
  reason?: string;
}

export interface XferCommitPayload {
  migrationId: string;
  term: number;
  epoch: number;
  legIds: string[];
  /**
   * Source-side cleanup marker + the leg's guilds, threaded so a RESTARTED
   * source (empty in-memory legs Map, no _incoming staging) can still graveyard
   * its originals + unfreeze from the payload. The commit acks ok only when that
   * source cleanup genuinely completed. Absent for target commits.
   */
  sourceCleanup?: boolean;
  guilds?: string[];
}

export interface XferAbortPayload {
  migrationId: string;
  term: number;
  reason: string;
}

/** Redistribute inventory request/reply (post-reshard placement). */
export interface XferInventoryRequest {
  term: number;
}

export interface XferInventoryGuild {
  guildId: string;
  bytes: number;
  ownerShardIdAtLastServe?: number;
}

export interface XferInventoryReply {
  ok: boolean;
  guilds: XferInventoryGuild[];
}

// ============================================================================
// DATA BACKEND
// ============================================================================

export interface TransformGuildPayload {
  transformationId: string;
  term: number;
  guildId: string;
  direction: 'file-to-postgres' | 'postgres-to-file';
}

export interface TransformGuildAckPayload {
  ok: boolean;
  namespaceHash?: string;
  reason?: string;
}

export interface BackendFlipPayload {
  backend: 'file' | 'postgres';
  transformationId: string;
  term: number;
}

export interface BackendFlipAckPayload {
  ok: boolean;
}

/** Webui write-through-owner hop (master -> owning node). */
export interface DataWriteRequest {
  term: number;
  guildId: string;
  module: string;
  /** Ignored for delete-namespace. */
  filename: string;
  op: 'write' | 'delete' | 'delete-namespace';
  /** Raw JSON text; write op only. */
  contentJson?: string;
  origin: 'webui-operator';
}

export interface DataWriteReply {
  ok: boolean;
  code?: 'frozen' | 'not-owner' | 'owner-unreachable' | 'stale-term' | 'backend-unavailable' | 'bot-down' | 'invalid' | 'io-error';
  error?: string;
  /** Accepted, flush still retrying. */
  pending?: boolean;
}

/** Symmetric read hop; no filename = list the module's files. */
export interface DataReadRequest {
  term: number;
  guildId: string;
  module: string;
  filename?: string;
}

export interface DataReadReply {
  ok: boolean;
  /** Raw JSON text of the requested file; absent for a listing. */
  contentJson?: string;
  /** Listing when no filename was requested. */
  files?: string[];
  code?: 'frozen' | 'not-owner' | 'owner-unreachable' | 'stale-term' | 'backend-unavailable' | 'bot-down' | 'invalid' | 'io-error';
  error?: string;
}

/** Worker -> master after a runtime backend apply; the master updates the registry entry and persists. */
export interface CapabilityRefreshPayload {
  term: number;
  capabilities: NodeCapabilities;
}

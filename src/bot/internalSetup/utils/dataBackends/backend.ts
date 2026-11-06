// Backend contract for guild data storage. Two permanent implementations sit
// behind it: FileBackend (the bot's own disk) and PostgresBackend (a
// database). The module-facing dataManager facade
// stays synchronous; these async surfaces are driven by the Working Set /
// coalescing layer and by interchange tooling, never by modules directly.

export interface DocKey {
  /** DataOptions.category; '' = guild namespace root. */
  module: string;
  /** May contain '/' subpaths ('archive/2024.json'); never a leading '/'. */
  filename: string;
}

export interface GuildFlushBatch {
  /** doc = raw JSON text, byte-identical to what the facade stringified. */
  upserts: { key: DocKey; doc: string }[];
  deletes: DocKey[];
  appends: { key: DocKey; chunk: string }[];
  /** The batch's own id, written on the guild's ownership row in the batch's transaction (NB13 decision 1). */
  flushId?: string;
  /** Set by flushGuild just before it sends COMMIT. */
  commitSent?: boolean;
}

export interface FenceToken {
  nodeId: string;
  /** The claim this process holds on the guild's shard (smdb_data.shard_claims); null when it holds none. */
  claim: number | null;
  /** This boot's process id, which the shard's claim row names. */
  processId: string | null;
  shardId: number;
  shardCount: number;
}

export interface GuildOwner {
  nodeId: string;
  claim: number;
}

export type FlushOutcome =
  | { ok: true }
  | { ok: false; reason: 'deposed'; currentOwner?: GuildOwner }
  | { ok: false; reason: 'unavailable'; detail?: string; code?: string; commitUnanswered?: boolean };

/** What a check of a flush whose COMMIT got no answer found (NB13 decision 4). */
export type FlushFate =
  | { fate: 'landed' }
  | { fate: 'not-landed' }
  | { fate: 'deposed'; landed: true | null; currentOwner?: GuildOwner }
  | { fate: 'unknown'; detail: string; code?: string };

export type HydrationOutcome =
  | { ok: true; docs: { key: DocKey; doc: string }[]; appendKeys: DocKey[] }
  | { ok: false; reason: 'deposed'; currentOwner?: GuildOwner }
  | { ok: false; reason: 'unavailable' };

/** A refusal read just before COMMIT: the maintenance gate, the exit drain, or less than 2 s left. */
export type RestoreStop = 'maintenance' | 'node-stopping' | 'out-of-time';

/**
 * 'refused': the database answered with an error, so nothing changed. 'unavailable': it did not answer or ended the
 * connection before COMMIT was sent (timedOut: the call's own bound passed). 'unknown': COMMIT got no answer.
 */
export type RetireOutcome =
  | { ok: true; moved: number }
  | { ok: false; reason: 'deposed' | 'unavailable' | 'out-of-time' | 'unknown' | 'refused' | 'no-claim'; detail?: string; timedOut?: boolean };

export type RestoreOutcome =
  | { ok: true; moved: number; retiredAt: number; reason: string }
  | { ok: false; reason: 'deposed'; currentOwner?: GuildOwner }
  | { ok: false; reason: 'refused'; detail: string; code?: string }
  | { ok: false; reason: 'live-rows'; retiredAt: number }
  | { ok: false; reason: 'no-entry' | 'schema-mismatch' | 'not-provisioned' | 'no-claim' | 'maintenance' | 'node-stopping' | 'out-of-time' | 'unavailable' | 'unknown'; detail?: string; retiredAt?: number; timedOut?: boolean };

export interface DataBackend {
  readonly kind: 'file' | 'postgres';
  /** Never throws; async connect + probe loop where applicable. */
  start(): void;
  stop(): Promise<void>;
  connectionState(): { state: 'connecting' | 'ready' | 'outage'; outageSinceMs?: number };
  /** Claim-then-read in one transaction; the claim is the ownership stamp. */
  hydrateGuild(guildId: string, token: FenceToken): Promise<HydrationOutcome>;
  /** A kept working set asked for again: its guild re-stamped for the token only while the stamp still names this node ('kept'), else 'lost'; null when the store cannot be read. */
  reclaimGuild(guildId: string, token: FenceToken): Promise<'kept' | 'lost' | null>;
  flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome>;
  /** Whether the flush with this id landed, read once no transaction of the guild can still commit; changes nothing. */
  resolveFlush(guildId: string, flushId: string, sentClaim: number, token: FenceToken): Promise<FlushFate>;
  /** deadline: a process.hrtime.bigint() reading; no statement is sent past it. */
  retireGuild(guildId: string, reason: string, token: FenceToken, deadline?: bigint | null): Promise<RetireOutcome>;
  /** retiredAt null: the guild's newest batch. beforeCommit is read after the move, just before COMMIT. */
  restoreGuild(guildId: string, retiredAt: number | null, token: FenceToken, beforeCommit: () => RestoreStop | null, deadline: bigint): Promise<RestoreOutcome>;
  loadDoc(guildId: string, key: DocKey): Promise<string | null>;
  /** Catalog-wide listing; tooling/webui only (the sync facade answers the owned set). */
  listGuilds(): Promise<string[]>;
  listOwnedGuilds(shardIds: number[], shardCount: number): Promise<string[]>;
  /** Top-level .json names only, non-recursive (file-mode listing parity). */
  listGuildFiles(guildId: string, module?: string): Promise<string[]>;
  guildFileExists(guildId: string, key: DocKey): Promise<boolean>;
  onAlert(cb: (event: 'outage' | 'recovered' | 'deposed', detail: string) => void): void;
}

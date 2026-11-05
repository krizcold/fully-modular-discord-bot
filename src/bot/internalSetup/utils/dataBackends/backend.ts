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

export type RetireOutcome =
  | { ok: true; moved: number }
  | { ok: false; reason: 'deposed' | 'unavailable' };

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
  retireGuild(guildId: string, reason: string, token: FenceToken): Promise<RetireOutcome>;
  restoreGuild(guildId: string, retiredAt: number, token: FenceToken): Promise<{ ok: true; moved: number } | { ok: false; reason: string }>;
  loadDoc(guildId: string, key: DocKey): Promise<string | null>;
  /** Catalog-wide listing; tooling/webui only (the sync facade answers the owned set). */
  listGuilds(): Promise<string[]>;
  listOwnedGuilds(shardIds: number[], shardCount: number): Promise<string[]>;
  /** Top-level .json names only, non-recursive (file-mode listing parity). */
  listGuildFiles(guildId: string, module?: string): Promise<string[]>;
  guildFileExists(guildId: string, key: DocKey): Promise<boolean>;
  onAlert(cb: (event: 'outage' | 'recovered' | 'deposed', detail: string) => void): void;
}

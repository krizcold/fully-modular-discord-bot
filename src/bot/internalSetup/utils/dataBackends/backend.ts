// Backend contract for guild data storage. Two permanent implementations sit
// behind it: FileBackend (per-node disk, shared-nothing) and PostgresBackend
// (central database, stateless workers). The module-facing dataManager facade
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
}

export interface FenceToken {
  nodeId: string;
  term: number;
  epoch: number;
  shardId: number;
  shardCount: number;
}

export type FlushOutcome =
  | { ok: true }
  | { ok: false; reason: 'deposed'; currentOwner?: { nodeId: string; term: number; epoch: number } }
  | { ok: false; reason: 'unavailable' };

export type HydrationOutcome =
  | { ok: true; docs: { key: DocKey; doc: string }[]; appendKeys: DocKey[] }
  | { ok: false; reason: 'deposed'; currentOwner?: { nodeId: string; term: number; epoch: number } }
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
  flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome>;
  retireGuild(guildId: string, reason: string, token: FenceToken): Promise<RetireOutcome>;
  restoreGuild(guildId: string, retiredAt: number, token: FenceToken): Promise<{ ok: true; moved: number } | { ok: false; reason: string }>;
  loadDoc(guildId: string, key: DocKey): Promise<string | null>;
  /** Catalog-wide listing; tooling/webui only (the sync facade answers the owned set). */
  listGuilds(): Promise<string[]>;
  listOwnedGuilds(shardIds: number[], shardCount: number): Promise<string[]>;
  /** Top-level .json names only, non-recursive (file-mode listing parity). */
  listGuildFiles(guildId: string, module?: string): Promise<string[]>;
  guildFileExists(guildId: string, key: DocKey): Promise<boolean>;
  sizeOfGuildData(guildId: string): Promise<number>;
  healthy(): boolean;
  onAlert(cb: (event: 'outage' | 'recovered' | 'deposed', detail: string) => void): void;
}

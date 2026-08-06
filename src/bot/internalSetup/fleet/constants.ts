// Single source of truth for every fleet constant; imported by every fleet consumer.

export const PROTOCOL_VERSION = 2;

/** Heartbeat cadence (worker -> master, and the master's self-sample into its own registry). */
export const HEARTBEAT_MS = 5000;

/** How often the master refreshes the full guild list via REST (per-shard totals, including unassigned shards). */
export const GUILD_TOTALS_REFRESH_MS = 120000;

/** Master -> worker keepalive ping cadence; any inbound master frame renews the worker's lease clock. */
export const LEASE_RENEW_MS = 15000;

/**
 * Local-monotonic lease TTL: no master contact for this long means the lease
 * is expired and gateway sessions are destroyed. No absolute timestamps cross
 * the wire, so clock skew between machines cannot corrupt lease validity.
 */
export const LEASE_TTL_MS = 45000;

/** A node whose last heartbeat is older than this reads as late. */
export const HEALTH_LATE_MS = HEARTBEAT_MS * 2.5;

/** A node silent past this is confirmed down (its lease TTL has expired with it). */
export const HEALTH_DOWN_MS = LEASE_TTL_MS;

/** Fleet-mode masters wait this long at boot for surviving workers to redial before the first placement (Part 5 flow 1). */
export const REGISTER_GRACE_MS = 10000;

/**
 * Recovery-boot hold-down on FREE-pool distribution. Covers the worst case
 * for a pre-restart holder that never re-registers: the lease TTL, plus the
 * worker's checkTtl poll granularity (HEARTBEAT_MS), plus slack for the
 * async session destroy. Holders that DO reach the master either re-register
 * and heartbeat within the window (claims adopted) or are refused and expire
 * their cached lease immediately, so waiting this long from server start
 * rules out double-grants.
 */
export const RECOVERY_HOLDDOWN_MS = LEASE_TTL_MS + HEARTBEAT_MS + 5000;

/** Per-bucket identify spacing the master serializes grants with. */
export const IDENTIFY_SPACING_MS = 5500;

/** Co-worker dial-out reconnect ladder; the last entry repeats forever. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export const CONTROL_PORT_DEFAULT = 3928;

/** Timeout for request/response exchanges (register, grant, revoke) on the control channel. */
export const CONTROL_ACK_TIMEOUT_MS = 10000;

/** Timeout for the /gateway/bot fetch at plan time; a fallback keeps boot alive offline. */
export const GATEWAY_INFO_TIMEOUT_MS = 5000;

/** How often the master refreshes session_start_limit from /gateway/bot (also refreshed after charged grant rounds). */
export const BUDGET_REFRESH_MS = 300000;

/** Identify-budget reserve the master never grants into (fraction of the daily total). */
export const BUDGET_RESERVE_PCT = 0.05;

/** Re-registers within this window count toward crash-loop detection. */
export const CRASH_LOOP_WINDOW_MS = 600000;

/** Re-register count in the window at which identify permits start backing off. */
export const CRASH_LOOP_THRESHOLD = 3;

/** First crash-loop identify backoff; doubles per further re-register. */
export const IDENTIFY_BACKOFF_BASE_MS = 30000;

/** Crash-loop identify backoff ceiling. */
export const IDENTIFY_BACKOFF_MAX_MS = 900000;

/** Cap on the persisted node-loss event ring (and the refused-registrations ring). */
export const LOSS_LOG_CAP = 20;

/** Directory under /data/global/ holding the embedded control store. */
export const FLEET_DIR = 'fleet';

/** Master sync backstop: rehash-and-bump plus re-push to behind workers on this cadence. */
export const SYNC_RECONCILE_MS = 15000;

/** Debounce on syncAuthority.bump() so rapid mutations coalesce into one manifest recompute. */
export const SYNC_BUMP_DEBOUNCE_MS = 500;

/** Raw bytes per SYNC_READ chunk (b64-encoded on the wire; one frame in flight per worker). */
export const SYNC_CHUNK_BYTES = 262144;

/** Sanity cap on any single synced file. */
export const SYNC_MAX_FILE_BYTES = 67108864;

/** Worker-side download staging directory under /data/global/fleet/. */
export const SYNC_STAGING_DIRNAME = 'sync-staging';

// ============================================================================
// MIGRATION (P5): node-to-node data transfer + cutover under commit barriers.
// ============================================================================

/** Default transfer-channel listen port (CONTROL_PORT_DEFAULT + 1). */
export const TRANSFER_PORT_DEFAULT = CONTROL_PORT_DEFAULT + 1;

/** Single-use transfer token lifetime after prepare; a stale token cannot dial. */
export const TRANSFER_TOKEN_TTL_MS = 120000;

/** How long the master waits for a prepare ack from a participant. */
export const XFER_PREPARE_TIMEOUT_MS = 15000;

/** Pre-open dial failures re-dial on this cadence (the peer's lazy listener may still be binding). */
export const XFER_DIAL_RETRY_MS = 500;

/** Give up re-dialing a leg's peer after this window and report the dial error. */
export const XFER_DIAL_RETRY_WINDOW_MS = 10000;

/** No progress from a leg for this long during copy = stall -> abort. */
export const XFER_STALL_TIMEOUT_MS = 60000;

/** How long the master waits for both verify frames after issuing drain. */
export const XFER_DRAIN_TIMEOUT_MS = 30000;

/** Commit is idempotent and retried on this cadence until every participant acks. */
export const XFER_COMMIT_RETRY_MS = 10000;

/** A copy round shipping this few changed files is the last (converged) round. */
export const XFER_DELTA_THRESHOLD_FILES = 25;

/** Hard cap on copy rounds before forcing the drain (convergence backstop). */
export const XFER_MAX_ROUNDS = 10;

/** Sender pauses while the socket's bufferedAmount exceeds this (backpressure). */
export const XFER_HIGH_WATER_BYTES = 8388608;

/** File records above this size are chunked (offset/totalSize framing). */
export const XFER_CHUNK_BYTES = 33554432;

/** Required target free space = estBytes * this + a fixed cushion. */
export const SPACE_MARGIN = 1.5;

/** Fixed free-space cushion above the margin-scaled estimate. */
export const SPACE_CUSHION_BYTES = 104857600;

/** _incoming staging retained this long when the master is unreachable at boot, then swept. */
export const INCOMING_RETENTION_MS = 86400000;

/** Cap on the persisted finished-migration history ring. */
export const MIGRATION_HISTORY_CAP = 10;

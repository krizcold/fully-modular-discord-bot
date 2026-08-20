// Single source of truth for every fleet constant; imported by every fleet consumer.

export const PROTOCOL_VERSION = 3;

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

/**
 * Identify-ledger cooldown after a declined lease (hydration-timeout), so a
 * shard the node cannot hydrate is not re-granted to it every renew tick,
 * burning an IDENTIFY per cycle. Deposed-at-hydration declines skip it: that
 * shard belongs elsewhere and placement should proceed immediately.
 */
export const DECLINE_COOLDOWN_MS = 60_000;

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

// ============================================================================
// WARM STANDBY (PLAN_STANDBY): term liveness, takeover guard, auto-promotion.
// ============================================================================

/**
 * Fleet-mode master on the postgres control store stamps the term row on this
 * cadence. The stamp is the master's own lease: a fenced stamp (0 rows) means
 * a newer master owns the schema, and a stamp that cannot be written counts
 * toward the self-fence.
 */
export const TERM_STAMP_MS = LEASE_RENEW_MS;

/**
 * Boot takeover guard: a foreign term row that does not ADVANCE for this long
 * of local observation reads as a dead master and may be taken over. Freshness
 * is observed (row changed between reads), never compared against the local
 * clock, so cross-machine clock skew cannot corrupt the verdict.
 */
export const TERM_TAKEOVER_STALE_MS = 90_000;

/** Guard re-check cadence while holding on a possibly-live foreign master. */
export const TERM_GUARD_POLL_MS = 5000;

/**
 * Master self-fence: stamping failing for this long while a registered
 * auto-promote backup's control connection is down expires the master exactly
 * like a worker's lease TTL - under those conditions the backup WILL promote,
 * and a fenced-but-serving master would fight its sessions.
 */
export const MASTER_SELF_FENCE_MS = 90_000;

/**
 * Auto-promotion: the designated backup self-promotes when the term row has
 * not advanced for this long (observed over its own reads) AND its control
 * connection to the master is down. Strictly greater than both the guard
 * staleness and the self-fence threshold so the old master is provably
 * dead or self-fenced before the backup pulls the trigger.
 */
export const AUTO_PROMOTE_STALE_MS = 120_000;

/**
 * Self-fence arming: the auto backup must be CONTINUOUSLY disconnected this
 * long, and its disconnect must be concurrent with the store silence, before
 * the fence can latch. A routine WS blip (proxy reload, backup redeploy) can
 * never latch it, and a backup that died long before the outage cannot arm it.
 */
export const BACKUP_DOWN_CONFIRM_MS = 30_000;

/**
 * A staged auto-promotion override older than this at boot is VOID: its
 * evidence is stale (the restart it expected never happened) and acting on it
 * could depose a healthy master days later.
 */
export const AUTO_PROMOTE_OVERRIDE_MAX_AGE_MS = 600_000;

/**
 * Promote-the-pair (PLAN_REPLICATION Stage 3, ruling R3): the RPO an operator
 * accepts when a standby becomes the fleet database. Read ONLY in the pair
 * lane, where every channel reports the primary gone and the age of the last
 * replayed transaction is the data that dies with it. The role-only lanes
 * never move the database, so the age is not consulted there at all - gating
 * on "still streaming AND stale" was the first design and is backwards, since
 * that combination is the master-process-death case the backup exists for.
 * Above this the manual promote comes back asking for an explicit confirm; the
 * auto lane never confirms, so it aborts and rolls back. An unknown age
 * (nothing replayed since the standby started) does not gate.
 */
export const REPLICA_LAG_PROMOTE_MAX_MS = 60_000;

/** Bounded wait for a standby to apply already-received WAL before promoting. */
export const REPLICA_CATCHUP_WAIT_MS = 15_000;

/** Poll cadence inside that wait. */
export const REPLICA_CATCHUP_POLL_MS = 1000;

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

/**
 * Abort a transfer dial whose websocket upgrade never answers. Without it a
 * handshake that stalls behind a reverse proxy raises no event at all, so the
 * leg dies silently until the stall watchdog fires a minute later.
 */
export const XFER_DIAL_HANDSHAKE_MS = 8000;

/** Give up re-dialing a leg's peer after this window and report the dial error. */
export const XFER_DIAL_RETRY_WINDOW_MS = 25000;

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

/** Cadence of the post-boot _incoming re-resolution (boot-retained staging is not stuck until the next reboot). */
export const INCOMING_RESOLVE_INTERVAL_MS = 3600000;

/** Cap on the persisted finished-migration history ring. */
export const MIGRATION_HISTORY_CAP = 10;

// ============================================================================
// BACKEND TRANSFORMATION (spec 3.2): per-guild convert-verify-flip.
// ============================================================================

/** Per-guild convert (or retire-source) window: freeze, export, staged import, hash, commit. */
export const TRANSFORM_GUILD_TIMEOUT_MS = 600000;

/** Statement timeout on the dedicated staging connection (its transaction spans export + hash + commit). */
export const TRANSFORM_STAGING_STATEMENT_TIMEOUT_MS = 600000;

/** How long the master waits for each BACKEND_FLIP ack. */
export const TRANSFORM_FLIP_TIMEOUT_MS = 30000;

/** Bounded wait for the destination store's first liveness probe at PLANNING. */
export const TRANSFORM_DEST_PROBE_WAIT_MS = 5000;

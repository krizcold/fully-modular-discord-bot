// Single source of truth for every fleet constant; imported by every fleet consumer.

export const PROTOCOL_VERSION = 1;

/** Heartbeat cadence (worker -> master, and the master's self-sample into its own registry). */
export const HEARTBEAT_MS = 5000;

/** Master -> worker keepalive ping cadence; any inbound master frame renews the worker's lease clock. */
export const LEASE_RENEW_MS = 15000;

/**
 * Local-monotonic lease TTL: no master contact for this long means the lease
 * is expired and gateway sessions are destroyed. No absolute timestamps cross
 * the wire, so clock skew between machines cannot corrupt lease validity.
 */
export const LEASE_TTL_MS = 45000;

/** Per-bucket identify spacing the master serializes grants with. */
export const IDENTIFY_SPACING_MS = 5500;

/** Co-worker dial-out reconnect ladder; the last entry repeats forever. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export const CONTROL_PORT_DEFAULT = 3928;

/** Timeout for request/response exchanges (register, grant, revoke) on the control channel. */
export const CONTROL_ACK_TIMEOUT_MS = 10000;

/** Timeout for the /gateway/bot fetch at plan time; a fallback keeps boot alive offline. */
export const GATEWAY_INFO_TIMEOUT_MS = 5000;

/** Default declared shard capacity when a node does not say otherwise. */
export const DEFAULT_SHARD_CAPACITY = 4;

/** Directory under /data/global/ holding the embedded control store. */
export const FLEET_DIR = 'fleet';

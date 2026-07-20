// Single source of truth for every metrics constant; imported by every metrics consumer.

/** Sampler tick interval (CPU/RAM/event-loop sample + live WS push). */
export const SAMPLE_MS = 5000;

/** Ring buffer length: 720 samples at 5s = 1 hour of live series. */
export const RING_LEN = 720;

/** Disk walk interval (per-guild + global data folder sizes). */
export const DISK_WALK_MS = 60000;

/** Persistence flush interval for counter totals. */
export const FLUSH_MS = 300000;

/** Max distinct labels per (guild, module); overflow folds into __other__. */
export const LABEL_CAP = 64;

/** Documented heuristic for the per-guild RAM cache estimate. */
export const BYTES_PER_CACHE_OBJECT = 512;

/** Label buckets. */
export const OTHER_LABEL = '__other__';
export const UNTAGGED_MODULE = '__untagged__';
export const GLOBAL_GUILD_KEY = 'global';

/** Module namespace used for persisted metrics data (non-numeric, safe with the listGuilds filter). */
export const METRICS_NAMESPACE = 'metrics';
export const TOTALS_FILENAME = 'totals.json';

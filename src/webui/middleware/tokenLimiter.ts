import type { Express, Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

export interface TokenLimiterOptions {
  capacity: number;
  refillMs: number;
  maxKeys?: number;
  idleMs?: number;
  label: string;
  skip?: (req: Request) => boolean;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  blockLogged: boolean;
}

// Token bucket per client IP. The key map is bounded (oldest bucket dropped first), and a blocked key logs once
// until its bucket refills, so a flood can grow neither memory nor the container log.
export function createTokenLimiter(options: TokenLimiterOptions): RequestHandler & { size(): number } {
  const { capacity, refillMs, label } = options;
  const maxKeys = options.maxKeys ?? 10000;
  const idleMs = options.idleMs ?? 5 * 60 * 1000;
  const buckets = new Map<string, Bucket>();
  const perMinute = Math.round(60000 / refillMs);

  function bucketFor(key: string, now: number): Bucket {
    let bucket = buckets.get(key);
    if (bucket) {
      buckets.delete(key);
      buckets.set(key, bucket);
      return bucket;
    }
    for (const [old, b] of buckets) {
      if (buckets.size < maxKeys && now - b.lastRefill <= idleMs) break;
      buckets.delete(old);
    }
    bucket = { tokens: capacity, lastRefill: now, blockLogged: false };
    buckets.set(key, bucket);
    return bucket;
  }

  const handler = ((req, res, next) => {
    if (options.skip?.(req)) return next();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = bucketFor(key, now);
    const elapsed = now - bucket.lastRefill;
    const add = Math.floor(elapsed / refillMs);
    if (add > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + add);
      bucket.lastRefill = now - (elapsed % refillMs);
    }
    if (bucket.tokens > 0) {
      bucket.tokens--;
      if (bucket.tokens === capacity - 1) bucket.blockLogged = false;
      res.setHeader('RateLimit-Limit', perMinute);
      res.setHeader('RateLimit-Remaining', bucket.tokens);
      res.setHeader('RateLimit-Reset', Math.ceil(now / 1000) + 1);
      return next();
    }
    const retryAfter = Math.max(1, Math.ceil((refillMs - (now - bucket.lastRefill)) / 1000));
    if (!bucket.blockLogged) {
      bucket.blockLogged = true;
      console.log(`[RateLimit] ${label} blocked ${key.slice(0, 64)}; further requests from it are not logged until it recovers`);
    }
    res.setHeader('RateLimit-Limit', perMinute);
    res.setHeader('RateLimit-Remaining', 0);
    res.setHeader('RateLimit-Reset', Math.ceil(now / 1000) + retryAfter);
    res.setHeader('Retry-After', retryAfter);
    res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
  }) as RequestHandler & { size(): number };
  handler.size = () => buckets.size;
  return handler;
}

// Every proxy in front of the app (Caddy, the auth gateway) sits on a private or loopback address, so req.ip is the
// first public address: each client gets its own bucket, and a client cannot pick its key from a public socket.
export const TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export function mountRateLimits(app: Express): void {
  // Token bucket: bursts of 10, then 120 requests a minute per client.
  const apiLimiter = createTokenLimiter({
    label: 'api',
    capacity: 10,
    refillMs: 500,
    skip: req => req.path === '/api/health',
  });
  // The gateway lets these through without the admin login; a page load fetches several assets at once.
  const publicLimiter = createTokenLimiter({ label: 'public', capacity: 60, refillMs: 250 });

  // Stricter rate limiting for sensitive operations
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 requests per 15 minutes
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please wait' }
  });

  // Apply rate limiting to API routes
  app.use('/api/', apiLimiter);
  app.use('/api/setup/credentials', authLimiter);
  app.use(['/guild', '/auth', '/assets'], publicLimiter);
}

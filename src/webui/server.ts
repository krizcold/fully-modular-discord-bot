// src/webui/server.ts

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import passport from 'passport';
import * as path from 'path';
import { BotManager } from './botManager';
import { createControlRoutes } from './routes/control';
import { createSetupRoutes } from './routes/setup';
import { createConfigRoutes } from './routes/config';
import { createAppStoreRoutes } from './routes/appstore';
import { createPanelRoutes } from './routes/panels';
import { createGuildPanelRoutes } from './routes/guildPanels';
import { createGuildSubscriptionRoutes } from './routes/guildSubscriptions';
import { createUpdateRouter } from './routes/update';
import { createDevModulesRoutes } from './routes/devmodules';
import { createUsageRoutes } from './routes/usage';
import { createFleetRoutes } from './routes/fleet';
import { requireAuth } from './middleware/auth';
import { configureOAuth, isGuildWebUIEnabled } from './auth/oauthConfig';
import { requireGuildWebUIEnabled } from './auth/oauthMiddleware';
import { getSessionMiddleware } from './auth/sessionManager';
import oauthRoutes from './auth/oauthRoutes';
import { getPaymentRegistry } from '../bot/internalSetup/utils/payment/paymentRegistry';

export async function createServer(botManager: BotManager): Promise<Express> {
  const app = express();

  // Trust proxy - required for nginxhashlock reverse proxy
  // This allows express-rate-limit to correctly identify client IPs from X-Forwarded-For header
  app.set('trust proxy', 1);

  // Session middleware + Passport are ALWAYS installed so that Guild Web-UI
  // credentials can be added / removed at runtime via the Credentials panel
  // without restarting the bot. Routes that depend on OAuth use
  // requireGuildWebUIEnabled to gate per-request.
  const sessionConfig = await getSessionMiddleware();
  app.use(session(sessionConfig));
  app.use(passport.initialize());
  app.use(passport.session());

  // Configure OAuth strategy. Idempotent no-op when disabled / creds missing;
  // can be re-invoked later via reconfigureOAuth() from the credentials save path.
  configureOAuth();

  if (isGuildWebUIEnabled()) {
    console.log('[Server] Guild Web-UI enabled at boot');
  } else {
    console.log('[Server] Guild Web-UI disabled at boot; routes are mounted but gated and will 503 until enabled');
  }

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // Required for React with Babel
          "https://unpkg.com"
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    xFrameOptions: { action: 'deny' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  }));

  // Additional security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  // CORS configuration - Disable CORS since auth is via query parameter
  // This prevents CSRF attacks from malicious origins
  app.use(cors({
    origin: false, // Disable CORS entirely
    credentials: false
  }));

  // Payment provider webhooks. MUST be mounted before express.json() so the
  // raw body bytes survive intact - HMAC signature verification (Stripe,
  // Lemon Squeezy, PayPal) checks against the exact transmitted payload, and
  // any JSON re-serialisation breaks the signature. Public endpoint by
  // design: providers send webhooks unauthenticated and prove identity via
  // their per-provider signature scheme inside `handleWebhook`. Body is
  // capped at 1MB which is well above any provider's webhook payload size.
  app.post(
    '/webhook/:providerId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req: Request, res: Response) => {
      const providerId = req.params.providerId;
      try {
        const provider = getPaymentRegistry().get(providerId);
        if (!provider || !provider.handleWebhook) {
          return res.status(404).json({ error: `Unknown provider or no webhook handler: ${providerId}` });
        }
        // Flatten headers to a string-only map; providers pick out the
        // header(s) they care about (Stripe-Signature, X-Signature, etc.).
        const headerMap: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headerMap[k] = v;
          else if (Array.isArray(v)) headerMap[k] = v.join(',');
        }
        const signature =
          headerMap['stripe-signature']
          || headerMap['x-signature']
          || headerMap['paypal-transmission-sig']
          || '';
        await provider.handleWebhook(req.body as Buffer, signature, headerMap);
        res.json({ received: true });
      } catch (err: any) {
        // Return 400 so the provider retries (their delivery system handles
        // backoff). Log full context server-side.
        console.error(`[Webhook] ${providerId} failed:`, err);
        res.status(400).json({ error: err?.message || 'Webhook handling failed' });
      }
    },
  );

  // Request body size limits to prevent DoS
  app.use(express.json({ limit: '10kb' })); // Strict limit for most requests
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));

  // Token bucket rate limiter with burst capacity
  // - Bucket capacity: 10 tokens (allows burst of 10 rapid requests)
  // - Refill rate: 1 token per 500ms (120 requests/minute sustained)
  // - When bucket is empty, requests are rejected until tokens refill
  const tokenBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  const BUCKET_CAPACITY = 10;       // Max burst size
  const REFILL_RATE = 500;          // ms per token (1 token every 500ms = 120/min)
  const SUSTAINED_RATE = 120;       // requests per minute (for headers)

  function getClientKey(req: express.Request): string {
    // Use IP address as key, falling back to 'unknown'
    return (req.ip || req.socket.remoteAddress || 'unknown');
  }

  function consumeToken(key: string): { allowed: boolean; tokensRemaining: number; retryAfter: number } {
    const now = Date.now();
    let bucket = tokenBuckets.get(key);

    if (!bucket) {
      // New client gets a full bucket
      bucket = { tokens: BUCKET_CAPACITY, lastRefill: now };
      tokenBuckets.set(key, bucket);
    }

    // Calculate tokens to add based on time elapsed
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(elapsed / REFILL_RATE);

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now - (elapsed % REFILL_RATE); // Keep remainder for partial token
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return { allowed: true, tokensRemaining: bucket.tokens, retryAfter: 0 };
    } else {
      // Calculate time until next token
      const timeUntilNextToken = REFILL_RATE - (now - bucket.lastRefill);
      return { allowed: false, tokensRemaining: 0, retryAfter: Math.ceil(timeUntilNextToken / 1000) };
    }
  }

  // Cleanup old buckets periodically (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    for (const [key, bucket] of tokenBuckets.entries()) {
      if (now - bucket.lastRefill > maxAge) {
        tokenBuckets.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  const apiLimiter: express.RequestHandler = (req, res, next) => {
    // Skip health checks
    if (req.path === '/api/health') {
      return next();
    }

    const key = getClientKey(req);
    const result = consumeToken(key);

    console.log(`[RateLimit] ${req.method} ${req.path} | Key: ${key} | Tokens: ${result.tokensRemaining} | Allowed: ${result.allowed}`);

    // Set standard rate limit headers
    res.setHeader('RateLimit-Limit', SUSTAINED_RATE);
    res.setHeader('RateLimit-Remaining', result.tokensRemaining);
    res.setHeader('RateLimit-Reset', Math.ceil(Date.now() / 1000) + (result.retryAfter || 1));

    if (result.allowed) {
      next();
    } else {
      console.log(`[RateLimit] BLOCKED: ${key} - retry after ${result.retryAfter}s`);
      res.setHeader('Retry-After', result.retryAfter);
      res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
    }
  };

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

  // Cache control for API responses
  app.use('/api/', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Request logging
  app.use((req: Request, res: Response, next) => {
    console.log(`[WebUI] ${req.method} ${req.path}`);
    next();
  });

  // Health check (authenticated to prevent information disclosure)
  app.get('/api/health', requireAuth, (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      bot: botManager.getStatus()
    });
  });

  // OAuth + Guild API routes are mounted UNCONDITIONALLY. Each router is
  // gated by requireGuildWebUIEnabled, which checks state at request time.
  // This lets the Credentials panel enable / disable Guild Web-UI without
  // requiring a bot restart.
  app.use('/auth', requireGuildWebUIEnabled, oauthRoutes);
  app.use('/guild/api/panels', requireGuildWebUIEnabled, createGuildPanelRoutes(botManager));
  app.use('/guild/api/subscriptions', requireGuildWebUIEnabled, createGuildSubscriptionRoutes());
  console.log('[Server] Auth + Guild API routes mounted (request-time gated by ENABLE_GUILD_WEBUI)');

  // Owner API Routes (requireAuth - protected by AUTH_HASH via nginx)
  // NGINX handles primary auth, Express validates as defense in depth
  app.use('/api/bot', requireAuth, createControlRoutes(botManager));
  app.use('/api/setup', requireAuth, createSetupRoutes());
  app.use('/api/config', requireAuth, createConfigRoutes());
  app.use('/api/appstore', requireAuth, createAppStoreRoutes(botManager));
  app.use('/api/panels', requireAuth, createPanelRoutes(botManager));
  app.use('/api/update', requireAuth, createUpdateRouter(botManager));
  app.use('/api/devmodules', requireAuth, createDevModulesRoutes(botManager));
  app.use('/api/usage', requireAuth, createUsageRoutes(botManager));
  app.use('/api/fleet', requireAuth, createFleetRoutes(botManager));

  // Serve static frontend files (protected by auth)
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, {
    setHeaders: (res) => {
      // Add security headers to static files
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  }));

  // Root route (protected by auth for defense-in-depth)
  app.get('/', requireAuth, (req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Guild Web-UI routes (NO requireAuth - accessible via nginx
  // ALLOWED_PATHS: "/guild"). The wildcard `/guild/*` serves the same SPA
  // shell so deep links like /guild/{id}/subscription work after a full
  // page reload (used by Stripe return URLs and refresh-restores-state
  // browser behaviour). Both must be registered before the auth-gated
  // catch-all below.
  const guildHtmlHandler = (req: Request, res: Response) => {
    if (!isGuildWebUIEnabled()) {
      res.status(503).send(
        '<!DOCTYPE html><html><head><title>Guild Web-UI Disabled</title>' +
        '<style>body{font-family:system-ui;max-width:600px;margin:100px auto;padding:20px;text-align:center;}' +
        'h1{color:#FAA61A;}p{color:#999;line-height:1.6;}</style></head><body>' +
        '<h1>🔒 Guild Web-UI Disabled</h1>' +
        '<p>Guild Web-UI is not currently enabled on this bot.</p>' +
        '<p>To enable it, go to the <strong>Credentials</strong> tab in the main Web-UI and configure OAuth settings.</p>' +
        '<p><a href="/" style="color:#5865F2;text-decoration:none;">← Back to Main Web-UI</a></p>' +
        '</body></html>'
      );
      return;
    }
    res.sendFile(path.join(publicDir, 'guild.html'));
  };
  app.get('/guild', guildHtmlHandler);
  app.get('/guild/*', guildHtmlHandler);

  // Catch-all for SPA routing (protected by auth)
  // MUST be last to not interfere with specific routes
  app.get('*', requireAuth, (req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Error handling - Sanitized to prevent information disclosure
  app.use((err: Error, req: Request, res: Response, next: any) => {
    // Log full error server-side with context
    console.error('[WebUI] Error:', {
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      path: req.path,
      method: req.method,
      ip: req.ip
    });

    // Return minimal info to client
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(500).json({
      error: 'An error occurred',
      // Only show error details in development
      ...(isProduction ? {} : { message: err.message })
    });
  });

  return app;
}

// src/webui/server.ts

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { mountRateLimits, TRUST_PROXY } from './middleware/tokenLimiter';
import session from 'express-session';
import passport from 'passport';
import * as path from 'path';
import { BotManager } from './botManager';
import { createControlRoutes } from './routes/control';
import { createSetupRoutes } from './routes/setup';
import { createConfigRoutes } from './routes/config';
import { createAppStoreRoutes } from './routes/appstore';
import { createPanelRoutes } from './routes/panels';
import { createCommandRoutes } from './routes/commands';
import { createGuildPanelRoutes } from './routes/guildPanels';
import { createGuildSubscriptionRoutes } from './routes/guildSubscriptions';
import { createUpdateRouter } from './routes/update';
import { createDevModulesRoutes } from './routes/devmodules';
import { createUsageRoutes } from './routes/usage';
import { createFleetRoutes } from './routes/fleet';
import { createManagedRoutes } from './routes/managed';
import { createGraveyardRoutes } from './routes/graveyard';
import { requireAuth } from './middleware/auth';
import { adminPageFallback, pathGuard, pathMiss } from './middleware/pathGuard';
import { configureOAuth, isGuildWebUIEnabled } from './auth/oauthConfig';
import { requireGuildWebUIEnabled } from './auth/oauthMiddleware';
import { getSessionMiddleware } from './auth/sessionManager';
import oauthRoutes from './auth/oauthRoutes';
import { getPaymentRegistry } from '../bot/internalSetup/utils/payment/paymentRegistry';
import { setAccessLogDispatcher, fireAccessLog } from './utils/accessLog';

export async function createServer(botManager: BotManager): Promise<Express> {
  const app = express();

  // Wire the access-log dispatcher so the request/OAuth hooks can report new
  // sessions to the bot child (no-op unless security.accessLog is enabled).
  setAccessLogDispatcher((info) => botManager.postAccessLog(info));

  // Trust only private and loopback hops, so the rate limits key on the client's own address.
  app.set('trust proxy', TRUST_PROXY);

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

  // Before every route: refuses the raw path forms middleware/pathGuard.ts lists, which a gateway could read as
  // another segment, prefix or extension.
  app.use(pathGuard);

  // CORS configuration - Disable CORS entirely. The web UI is not authenticated by the
  // bot itself (auth lives at the deployment boundary), so no cross-origin requests are
  // expected; this also blocks CSRF from malicious origins.
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

  mountRateLimits(app);

  // Cache control for API responses
  app.use('/api/', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Request logging
  app.use((req: Request, res: Response, next) => {
    console.log(`[WebUI] ${req.method} ${req.path.slice(0, 200)}`);
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

  // Owner API Routes. Auth is enforced at the deployment boundary (AppShield /
  // Authelia when managed, or the localhost bind when standalone); requireAuth passes.
  app.use('/api/bot', requireAuth, createControlRoutes(botManager));
  app.use('/api/setup', requireAuth, createSetupRoutes());
  app.use('/api/config', requireAuth, createConfigRoutes(botManager));
  app.use('/api/appstore', requireAuth, createAppStoreRoutes(botManager));
  app.use('/api/panels', requireAuth, createPanelRoutes(botManager));
  app.use('/api/commands', requireAuth, createCommandRoutes(botManager));
  app.use('/api/update', requireAuth, createUpdateRouter(botManager));
  app.use('/api/devmodules', requireAuth, createDevModulesRoutes(botManager));
  app.use('/api/usage', requireAuth, createUsageRoutes(botManager));
  app.use('/api/fleet', requireAuth, createFleetRoutes(botManager));
  app.use('/api/data/graveyard', requireAuth, createGraveyardRoutes(botManager));

  // Manager-facing surface. NOT requireAuth:
  // this one carries its own per-instance token check, because it is reached
  // container-to-container over the shared docker network and so never passes
  // the boundary gateway that authenticates every route above.
  app.use('/api/managed', createManagedRoutes());

  // Serve static frontend files. The admin page's files need the gateway's login; the member page's own files
  // under /assets/ are reachable without it (requireAuth passes; auth lives at the deployment boundary).
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, {
    setHeaders: (res) => {
      // Add security headers to static files
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  }));

  // Root route (requireAuth passes; auth enforced at the deployment boundary)
  app.get('/', requireAuth, (req: Request, res: Response) => {
    // First page load of a new admin session -> access-log event (once per session).
    const sess = req.session as (typeof req.session & { accessLogged?: boolean }) | undefined;
    if (sess && !sess.accessLogged) {
      sess.accessLogged = true;
      fireAccessLog({ uiKind: 'admin', ip: req.ip || '', userAgent: String(req.headers['user-agent'] || ''), when: Date.now() });
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Guild Web-UI routes (NO requireAuth: the gateway lets /guild, /auth and the
  // member page's files under /assets/ through without the admin login). The wildcard `/guild/*` serves the same SPA
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

  // The gateway lets /auth and /assets/ through without the admin login: a path there that nothing answered gets 404.
  app.use(['/auth', '/assets'], pathMiss);

  // Catch-all for SPA routing (requireAuth passes; auth at the boundary). The admin page's tabs are plain paths, so
  // only a plain path gets it: any other form, which a gateway may have read as a public path, gets 404.
  // MUST be last to not interfere with specific routes
  app.get('*', requireAuth, adminPageFallback(publicDir));

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

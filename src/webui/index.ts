// src/webui/index.ts

import { createServer as createHTTPServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { BotManager } from './botManager';
import { createServer } from './server';
import { WebSocketManager } from './websocketManager';
import { getInstallQueue } from './utils/installQueue';
import { setNotificationIPCDispatcher } from '../bot/internalSetup/utils/premiumNotifications';

/**
 * Tell the bot manager this bot's web UI is now serving, so the manager keeps
 * the Open button disabled until the UI is actually reachable after a (re)start.
 * Fire-and-forget with a couple of retries; a standalone bot (no manager env)
 * skips it, and a lost ping just leaves Open gated until the next start (safe).
 */
function reportWebUiReady(attempt = 1): void {
  const base = (process.env.BOT_MANAGER_INTERNAL_URL || '').trim();
  const botId = (process.env.BOT_ID || '').trim();
  const token = (process.env.BOT_MANAGER_UPDATE_TOKEN || '').trim();
  if (!base || !botId || !token) return; // standalone (no manager) - nothing to report
  let url: URL;
  try {
    url = new URL(`${base.replace(/\/$/, '')}/api/bots/${botId}/webui-ready`);
  } catch {
    return;
  }
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  let settled = false;
  const retry = () => {
    if (settled) return;
    settled = true;
    if (attempt < 3) setTimeout(() => reportWebUiReady(attempt + 1), 3000);
  };
  const req = doRequest(
    url,
    { method: 'POST', headers: { 'X-Bot-Token': token, 'Content-Length': 0 }, timeout: 5000 },
    res => {
      res.resume();
      if ((res.statusCode || 0) >= 500) retry();
      else settled = true;
    },
  );
  req.on('error', () => retry());
  req.on('timeout', () => req.destroy());
  req.end();
}

export async function startWebUI(botManager: BotManager): Promise<void> {
  console.log('[WebUI] Starting web interface...');

  // TODO (dev mode): generate src/webui/public/build-info.js with
  // { version, buildId: "dev", buildDate: now } so the header badge shows
  // something other than "Development" when running outside Docker.

  const app = await createServer(botManager);
  const PORT = parseInt(process.env.WEBUI_PORT || '8080', 10);
  const HOST = '0.0.0.0';

  // Create HTTP server for WebSocket upgrade support
  const httpServer = createHTTPServer(app);

  // Initialize WebSocket manager
  const wsManager = new WebSocketManager(httpServer);
  botManager.setWebSocketManager(wsManager);

  // Wire install/uninstall queue events → WebSocket broadcasts
  const installQueue = getInstallQueue();
  installQueue.setBotManager(botManager);

  // PremiumManager (running in this process too) needs a way to deliver
  // notifications via the bot. Register a thin IPC bridge; PremiumManager
  // will call `dispatchPremiumNotification(...)` and not care about routing.
  setNotificationIPCDispatcher((guildId, kind, payload) =>
    botManager.dispatchNotification(guildId, kind, payload)
  );
  const queueEventMap: Record<string, 'queued' | 'started' | 'completed' | 'failed' | 'cancelled'> = {
    enqueued: 'queued',
    started: 'started',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled'
  };
  for (const [internalEvent, suffix] of Object.entries(queueEventMap)) {
    installQueue.on(internalEvent, (job: any) => {
      const channel = `appstore:${job.kind}:${suffix}` as const;
      wsManager.broadcast(channel as any, job);
    });
  }

  // Set up graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.log(`[WebUI] Received ${signal}, shutting down gracefully...`);

    // Close WebSocket connections
    wsManager.close();

    // Shutdown bot if running
    if (botManager.isRunning()) {
      await botManager.shutdown(false);
    }

    // Close HTTP server
    httpServer.close(() => {
      console.log('[WebUI] Server closed');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      console.error('[WebUI] Forced shutdown after timeout');
      process.exit(1);
    }, 10000); // 10 second timeout
  };

  // Register shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const isDevelopment = process.env.NODE_ENV === 'development';

  return new Promise((resolve) => {
    httpServer.listen(PORT, HOST, () => {
      console.log(`[WebUI] Server running on ${HOST}:${PORT}`);
      console.log(`[WebUI] WebSocket available on ws://${HOST}:${PORT}/ws`);
      if (isDevelopment) {
        console.log(`[WebUI] Access URL: http://localhost:${PORT}/`);
        console.log(`[WebUI] Development mode - no auth required`);
      } else {
        console.log(`[WebUI] Access URL: http://localhost:${PORT}/?hash=\${AUTH_HASH}`);
      }
      reportWebUiReady();
      resolve();
    });
  });
}

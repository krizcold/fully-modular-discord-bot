// src/webui/index.ts

import { createServer as createHTTPServer } from 'http';
import { BotManager } from './botManager';
import { createServer } from './server';
import { WebSocketManager } from './websocketManager';

export async function startWebUI(botManager: BotManager): Promise<void> {
  console.log('[WebUI] Starting web interface...');

  const app = await createServer(botManager);
  const PORT = parseInt(process.env.WEBUI_PORT || '8080', 10);
  const HOST = '0.0.0.0';

  // Create HTTP server for WebSocket upgrade support
  const httpServer = createHTTPServer(app);

  // Initialize WebSocket manager
  const wsManager = new WebSocketManager(httpServer);
  botManager.setWebSocketManager(wsManager);

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
      resolve();
    });
  });
}

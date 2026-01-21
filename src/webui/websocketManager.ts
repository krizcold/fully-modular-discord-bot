// WebSocket Manager - Handles real-time client connections and broadcasts

import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import * as url from 'url';

/**
 * WebSocket event types for bot status and control
 */
export type WSEvent =
  | 'bot:status'
  | 'bot:log'
  | 'bot:startup'
  | 'bot:shutdown'
  | 'bot:crash'
  | 'connection:authenticated'
  | 'panel:updated';

/**
 * Bot status data structure
 */
export interface BotStatusData {
  running: boolean;
  uptime: number;
  processId?: number;
  crashed: boolean;
}

/**
 * Bot log event data
 */
export interface BotLogData {
  line: string;
  timestamp: string;
}

/**
 * Bot crash event data
 */
export interface BotCrashData {
  code: number | null;
  signal: string | null;
  logs: string[];
}

/**
 * Bot shutdown event data
 */
export interface BotShutdownData {
  signal: string;
  emergency: boolean;
}

/**
 * Connection authenticated event data
 */
export interface ConnectionAuthData {
  message: string;
}

/**
 * Panel updated event data (for real-time panel updates)
 */
export interface PanelUpdatedData {
  panelId: string;
  guildId: string | null;
  sessionId: string | null;
  panel: any; // Serialized panel response
  timestamp: string;
}

/**
 * Union type for all WebSocket event data
 */
export type WSEventData =
  | BotStatusData
  | BotLogData
  | BotCrashData
  | BotShutdownData
  | ConnectionAuthData
  | PanelUpdatedData;

/**
 * WebSocket message structure sent to clients
 */
export interface WSMessage {
  type: WSEvent;
  data: WSEventData;
  timestamp: string;
  sequence: number;
}

/**
 * WebSocket Manager - Manages WebSocket connections and broadcasts
 *
 * Features:
 * - Authenticated connections with timing-safe comparison
 * - Rate limiting (5 connections per IP per minute, 100 max total)
 * - Heartbeat mechanism to detect stale connections
 * - Automatic cleanup of dead clients
 * - Sequence numbers for gap detection
 * - Graceful shutdown support
 */
export class WebSocketManager {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private clientHeartbeats: Map<WebSocket, NodeJS.Timeout> = new Map();
  private connectionAttempts: Map<string, number[]> = new Map();
  private sequenceNumber: number = 0;

  // Security constants
  private readonly MAX_CLIENTS = 100;
  private readonly MAX_CONNECTIONS_PER_IP = 5;
  private readonly RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
  private readonly CLEANUP_INTERVAL_MS = 300000; // 5 minutes

  /**
   * Creates a new WebSocket manager
   * @param server - HTTP server instance for WebSocket upgrade
   */
  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws'
    });

    this.setupServer();

    // Start periodic cleanup of old rate limit attempts
    setInterval(() => this.cleanupOldAttempts(), this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Set up WebSocket server event handlers
   */
  private setupServer(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const ip = req.socket.remoteAddress || 'unknown';
      console.log(`[WebSocket] New connection from ${ip}`);

      // Check max clients limit
      if (this.clients.size >= this.MAX_CLIENTS) {
        console.warn('[WebSocket] Max clients reached, rejecting connection');
        ws.close(1008, 'Server full');
        return;
      }

      // Check rate limit
      if (!this.checkRateLimit(ip)) {
        console.warn(`[WebSocket] Rate limit exceeded for ${ip}`);
        ws.close(1008, 'Rate limit exceeded');
        return;
      }

      // Authenticate WebSocket connection
      const query = url.parse(req.url || '', true).query;
      const hash = query.hash as string;

      // Validate auth hash
      if (!this.validateAuth(hash)) {
        console.warn(`[WebSocket] Unauthorized connection attempt from ${ip}`);
        ws.close(1008, 'Unauthorized');
        return;
      }

      // Add to clients
      this.clients.add(ws);
      console.log(`[WebSocket] Client authenticated. Total clients: ${this.clients.size}`);

      // Send authentication confirmation
      this.sendToClient(ws, 'connection:authenticated', {
        message: 'Connected to bot manager WebSocket'
      });

      // Set up heartbeat mechanism
      this.setupHeartbeat(ws);

      // Handle client disconnect
      ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
        this.cleanupClient(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('[WebSocket] Client error:', error);
        this.cleanupClient(ws);
      });

      // Handle pong responses (for heartbeat)
      ws.on('pong', () => {
        // Client is alive, reset will be handled in heartbeat check
      });
    });

    console.log('[WebSocket] Server initialized on /ws');
  }

  /**
   * Validate authentication hash using timing-safe comparison
   * @param hash - The hash provided by the client
   * @returns true if authentication is valid, false otherwise
   */
  private validateAuth(hash: string | undefined): boolean {
    // Development mode: Skip auth entirely
    if (process.env.NODE_ENV === 'development') {
      return true;
    }

    const AUTH_HASH = process.env.AUTH_HASH;

    if (!AUTH_HASH || AUTH_HASH.trim() === '') {
      console.error('[WebSocket] AUTH_HASH not configured - rejecting connection');
      return false;
    }

    if (!hash || hash.trim() === '') {
      console.warn('[WebSocket] No hash provided in connection attempt');
      return false;
    }

    try {
      const hashBuffer = Buffer.from(createHash('sha256').update(hash).digest('hex'));
      const authBuffer = Buffer.from(createHash('sha256').update(AUTH_HASH).digest('hex'));
      return timingSafeEqual(hashBuffer, authBuffer);
    } catch (error) {
      console.error('[WebSocket] Error during authentication:', error);
      return false;
    }
  }

  /**
   * Check if IP address has exceeded rate limit
   * @param ip - The IP address to check
   * @returns true if within rate limit, false if exceeded
   */
  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const attempts = this.connectionAttempts.get(ip) || [];

    // Filter attempts within the rate limit window
    const recentAttempts = attempts.filter(time => now - time < this.RATE_LIMIT_WINDOW_MS);

    if (recentAttempts.length >= this.MAX_CONNECTIONS_PER_IP) {
      return false;
    }

    // Add current attempt
    recentAttempts.push(now);
    this.connectionAttempts.set(ip, recentAttempts);
    return true;
  }

  /**
   * Set up heartbeat mechanism for a client
   * @param ws - The WebSocket client
   */
  private setupHeartbeat(ws: WebSocket): void {
    let isAlive = true;

    // Set pong handler to mark client as alive
    ws.on('pong', () => {
      isAlive = true;
    });

    // Set up periodic ping
    const heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        console.log('[WebSocket] Client failed heartbeat, terminating');
        this.cleanupClient(ws);
        ws.terminate();
        return;
      }

      isAlive = false;
      try {
        ws.ping();
      } catch (error) {
        console.error('[WebSocket] Error sending ping:', error);
        this.cleanupClient(ws);
      }
    }, this.HEARTBEAT_INTERVAL_MS);

    // Store interval for cleanup
    this.clientHeartbeats.set(ws, heartbeatInterval);
  }

  /**
   * Clean up client resources
   * @param ws - The WebSocket client to clean up
   */
  private cleanupClient(ws: WebSocket): void {
    // Remove from clients set
    this.clients.delete(ws);

    // Clear heartbeat interval
    const heartbeatInterval = this.clientHeartbeats.get(ws);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      this.clientHeartbeats.delete(ws);
    }

    console.log(`[WebSocket] Client cleaned up. Total clients: ${this.clients.size}`);
  }

  /**
   * Clean up old rate limit attempts
   */
  private cleanupOldAttempts(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [ip, attempts] of this.connectionAttempts.entries()) {
      const recentAttempts = attempts.filter(time => now - time < this.RATE_LIMIT_WINDOW_MS);

      if (recentAttempts.length === 0) {
        this.connectionAttempts.delete(ip);
        cleanedCount++;
      } else {
        this.connectionAttempts.set(ip, recentAttempts);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[WebSocket] Cleaned up ${cleanedCount} old rate limit entries`);
    }
  }

  /**
   * Send message to a specific client
   * @param ws - WebSocket client to send to
   * @param type - Event type
   * @param data - Event data payload
   */
  private sendToClient(ws: WebSocket, type: WSEvent, data: WSEventData): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        const message: WSMessage = {
          type,
          data,
          timestamp: new Date().toISOString(),
          sequence: ++this.sequenceNumber
        };
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('[WebSocket] Error sending to client:', error);
        this.cleanupClient(ws);
      }
    }
  }

  /**
   * Broadcast event to all connected clients
   * @param type - Event type to broadcast
   * @param data - Event data payload
   *
   * Features:
   * - Serializes message once for efficiency
   * - Adds sequence number for gap detection
   * - Automatically cleans up dead clients
   * - Reduces log noise for high-frequency events
   */
  public broadcast(type: WSEvent, data: WSEventData): void {
    const message: WSMessage = {
      type,
      data,
      timestamp: new Date().toISOString(),
      sequence: ++this.sequenceNumber
    };

    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    const deadClients: WebSocket[] = [];

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(messageStr);
          sentCount++;
        } catch (error) {
          console.error('[WebSocket] Failed to send to client:', error);
          deadClients.push(client);
        }
      } else {
        // Mark non-open clients for removal
        deadClients.push(client);
      }
    });

    // Clean up dead clients
    deadClients.forEach(client => {
      this.cleanupClient(client);
      try {
        client.terminate();
      } catch (error) {
        // Ignore termination errors
      }
    });

    // Only log non-log events to reduce noise
    if (type !== 'bot:log') {
      console.log(`[WebSocket] Broadcasted ${type} to ${sentCount} clients (seq: ${message.sequence})`);
    }
  }

  /**
   * Get the number of currently connected clients
   * @returns Number of active WebSocket connections
   */
  public getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all connections and shut down WebSocket server
   *
   * Performs graceful shutdown:
   * 1. Cleans up all client heartbeat intervals
   * 2. Sends close message to all clients
   * 3. Terminates WebSocket server
   *
   * This method should be called during application shutdown.
   */
  public close(): void {
    console.log('[WebSocket] Closing all connections...');

    // Clean up all clients and their heartbeat intervals
    this.clients.forEach((client) => {
      this.cleanupClient(client);
      try {
        client.close(1000, 'Server shutting down');
      } catch (error) {
        console.error('[WebSocket] Error closing client:', error);
      }
    });

    // Close the WebSocket server
    this.wss.close();
    console.log('[WebSocket] Server closed');
  }
}

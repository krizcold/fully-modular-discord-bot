// WebSocket connection manager with auto-reconnect

class WebSocketClient {
  constructor() {
    this.ws = null;
    this.listeners = new Map(); // type -> Set of callbacks
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 2000;
    this.maxReconnectDelay = 60000; // Max 60 seconds
    this.maxListenersPerEvent = 100; // Prevent memory leak
    this.isManualClose = false;
    this.connected = false;
  }

  /**
   * Connect to WebSocket server
   */
  connect() {
    // Extract auth hash from URL
    const urlParams = new URLSearchParams(window.location.search);
    const authHash = urlParams.get('hash');

    // Determine WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl;

    // If hash is present, use it (production mode via nginx proxy)
    // If no hash, connect without it (development mode - server skips auth)
    if (authHash && authHash.trim() !== '') {
      wsUrl = `${protocol}//${window.location.host}/ws?hash=${encodeURIComponent(authHash)}`;
    } else {
      // Development mode: connect without hash (server will skip auth check)
      console.log('[WebSocket] No auth hash - connecting in development mode');
      wsUrl = `${protocol}//${window.location.host}/ws`;
    }

    console.log('[WebSocket] Connecting...');

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.emit('_connection', { connected: true });
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('[WebSocket] Message:', message.type);
          this.emit(message.type, message.data);
        } catch (err) {
          console.error('[WebSocket] Failed to parse message:', err);
        }
      };

      this.ws.onclose = (event) => {
        console.log('[WebSocket] Disconnected:', event.code, event.reason);
        this.connected = false;
        this.emit('_connection', { connected: false });

        // Attempt reconnect unless manually closed
        if (!this.isManualClose && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          // Exponential backoff: 2^attempts * base delay, capped at max
          const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            this.maxReconnectDelay
          );
          console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          setTimeout(() => this.connect(), delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('[WebSocket] Max reconnection attempts reached');
          this.emit('_connection', {
            connected: false,
            error: 'Max reconnection attempts reached'
          });
        }
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
      };

    } catch (err) {
      console.error('[WebSocket] Connection failed:', err);
    }
  }

  /**
   * Manually close connection
   */
  close() {
    this.isManualClose = true;
    if (this.ws) {
      this.ws.close();
    }
  }

  /**
   * Subscribe to WebSocket event
   * @param {string} type - Event type (e.g., 'bot:status', 'bot:log')
   * @param {Function} callback - Callback function to handle event data
   * @returns {Function} - Unsubscribe function
   */
  on(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }

    const callbacks = this.listeners.get(type);

    // Check max listeners to prevent memory leak
    if (callbacks.size >= this.maxListenersPerEvent) {
      console.error(`[WebSocket] Max listeners (${this.maxListenersPerEvent}) exceeded for event: ${type}`);
      // Return no-op unsubscribe function
      return () => {};
    }

    callbacks.add(callback);

    // Return unsubscribe function
    return () => {
      callbacks.delete(callback);
      // Clean up empty Sets to prevent memory leak
      if (callbacks.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  /**
   * Emit event to all listeners
   */
  emit(type, data) {
    const callbacks = this.listeners.get(type);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`[WebSocket] Error in ${type} listener:`, err);
        }
      });
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

// Create global WebSocket client instance
const wsClient = new WebSocketClient();

// Auto-connect when script loads
wsClient.connect();

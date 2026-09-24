import { Client, ClientConfig, Pool } from 'pg';

/**
 * A pg client for one connect, a few queries and an end. pg emits 'error' on
 * an unexpected socket end after connect, OUTSIDE the promise of the call that
 * fails, and an unlistened 'error' event ends the process (B7-F20). The
 * awaited connect or query still reports the failure; the listener only keeps
 * it from becoming a crash.
 */
export function shortLivedClient(config: ClientConfig): Client {
  const client = new Client(config);
  client.on('error', error => {
    console.warn('[Postgres] Connection error on a short-lived client:', error instanceof Error ? error.message : String(error));
  });
  return client;
}

/**
 * Every client a pool hands out keeps a listener for its whole life. pg-pool
 * removes its own idle listener while a client is checked out, so a socket
 * ending under a held client (a transaction, a term stamp) would otherwise
 * emit an unlistened 'error' and end the process; the pool's own error event
 * covers idle clients only.
 */
export function guardPoolClients(pool: Pool, label: string): void {
  pool.on('connect', client => {
    client.on('error', error => {
      console.warn(`[Postgres] Connection error on ${label}:`, error instanceof Error ? error.message : String(error));
    });
  });
}

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { endPool } from '../helpers/endPool';

// An integration test's afterAll ends its pool through endPool, so a client
// left checked out cannot hold the file past Stryker's budget for a pass B run
// (mutation/README.md).
describe('ending a pool in an afterAll', () => {
  it('waits for the pool to end, and no longer than its bound when a client holds it', { timeout: 5_000 }, async () => {
    let ended = false;
    await endPool({ end: async () => { ended = true; } } as unknown as Pool, 60_000);
    expect(ended).toBe(true);
    const start = Date.now();
    await endPool({ end: () => new Promise(() => {}) } as unknown as Pool, 200);
    expect(Date.now() - start).toBeLessThan(2_000);
    await endPool(undefined);
  });

  it('is bounded against a real pool whose client is still checked out', { timeout: 5_000 }, async () => {
    const pool = new Pool();
    const held = { release: () => {} };
    // pg-pool's end() waits for every client it holds: one stands in for a client never released.
    (pool as unknown as { _clients: unknown[] })._clients.push(held);
    const start = Date.now();
    await endPool(pool, 200);
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

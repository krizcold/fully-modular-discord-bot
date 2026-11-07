import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

describe('NB9 E12: the claims pool guards its clients', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a checked-out client error once instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', claimTimings(30));
    const pool = (store as unknown as { pool: EventEmitter }).pool;
    const client = new EventEmitter();
    pool.emit('connect', client);
    expect(() => client.emit('error', new Error('socket ended'))).not.toThrow();
    const lines = warn.mock.calls.filter(call => String(call[0]).startsWith('[Postgres] Connection error on the claims pool'));
    expect(lines).toEqual([['[Postgres] Connection error on the claims pool:', 'socket ended']]);
    await store.end();
  });
});

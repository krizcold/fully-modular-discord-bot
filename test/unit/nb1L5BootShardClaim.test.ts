import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ backend: null as any }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  getDataBootStatus: () => ({ mode: 'postgres', state: 'serving', refusalReason: null }),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => ({
  ...(await importOriginal<object>()),
  getGuildDataBackend: () => h.backend,
}));

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { resolveBootClaim } from '../../src/bot/internalSetup/fleet/shardBoot';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a failed shard claim', () => {
  it('logs the retry for the operator and takes the claim on the next try', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    h.backend = Object.create(PostgresBackend.prototype);
    h.backend.takeClaim = async () => {
      calls++;
      if (calls === 1) throw new Error('connection reset');
      return { outcome: 'claimed', claim: 7 };
    };
    let claim: number | null | undefined;
    const pending = resolveBootClaim().then(c => { claim = c; });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(claim).toBe(7);
    expect(errors).toHaveBeenCalledWith('[Shards] Could not take a shard claim from the database; retrying in 5 s:', 'connection reset');
  });
});

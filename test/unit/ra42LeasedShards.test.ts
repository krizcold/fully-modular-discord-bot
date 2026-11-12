import { describe, expect, it } from 'vitest';
import { DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';

describe('the lease membership answer', () => {
  it('is null before any lease is set', () => {
    const driver = new DataReadinessDriver({} as any, {} as any, { held: true });
    try {
      expect(driver.leaseSet()).toBe(false);
      expect(driver.leasedShards()).toBeNull();
    } finally {
      driver.stop();
    }
  });
});

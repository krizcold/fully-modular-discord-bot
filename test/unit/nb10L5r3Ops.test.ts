import { describe, expect, it } from 'vitest';

// NB10 L5 refuted survivor (sharedOps.ts): registeredOps() lists the shared ops in their registration order, the
// global settings save of a module after the other premium ops and before the Dummy provider's ops.

import { DUMMY_METHODS, PREMIUM_METHODS, registeredOps } from '../../src/bot/internalSetup/utils/sharedOps';

describe('registeredOps', () => {
  it('lists premium.setGlobalModuleConfig once, after premium.cancelMigration and before the dummy ops', () => {
    const expected = [
      'global.write', 'payment.webhook', 'payment.oauthCallback',
      ...PREMIUM_METHODS.filter(m => m !== 'setGlobalModuleConfig').map(m => `premium.${m}`),
      'premium.setGlobalModuleConfig',
      ...DUMMY_METHODS.map(m => `dummy.${m}`),
    ];
    const ops = registeredOps();
    expect(ops).toEqual(expected);
    expect(ops.filter(o => o === 'premium.setGlobalModuleConfig')).toHaveLength(1);
    expect(ops.indexOf('premium.setGlobalModuleConfig')).toBe(ops.indexOf('premium.cancelMigration') + 1);
  });
});

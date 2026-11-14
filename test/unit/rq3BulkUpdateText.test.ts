import { describe, expect, it } from 'vitest';
import { describeBulkModuleUpdate, type BulkModuleUpdateResult } from '../../src/updater';

function result(over: Partial<BulkModuleUpdateResult>): BulkModuleUpdateResult {
  return {
    success: false,
    totalAttempted: 0,
    totalUpdated: 0,
    updated: [],
    failed: [],
    checkErrors: [],
    skipped: [],
    ...over,
  };
}

describe('describeBulkModuleUpdate names what failed', () => {
  it('lists every failed module with its error, comma separated', () => {
    const text = describeBulkModuleUpdate(result({
      totalAttempted: 2,
      failed: [
        { moduleName: 'alpha', error: 'download refused' },
        { moduleName: 'beta', error: 'disk full' },
      ],
    }));
    expect(text).toBe('Updated 0 module(s); failed: alpha (download refused), beta (disk full)');
  });

  it('tells an unconfirmed failure by its own text only, and a plain failure only in the failed list', () => {
    const text = describeBulkModuleUpdate(result({
      totalAttempted: 2,
      failed: [
        { moduleName: 'alpha', error: 'download refused' },
        { moduleName: 'gamma', error: "Can't confirm gamma was updated.", unconfirmed: true },
      ],
    }));
    expect(text).toBe("Updated 0 module(s); failed: alpha (download refused). Can't confirm gamma was updated.");
  });

  it('adds no can\'t confirm tail when no failure is unconfirmed', () => {
    const text = describeBulkModuleUpdate(result({
      totalAttempted: 1,
      failed: [{ moduleName: 'alpha', error: 'download refused' }],
    }));
    expect(text).toBe('Updated 0 module(s); failed: alpha (download refused)');
  });

  it('joins the parts with "; " and the unconfirmed texts with a space', () => {
    const text = describeBulkModuleUpdate(result({
      totalAttempted: 3,
      totalUpdated: 1,
      updated: [{ moduleName: 'delta', oldVersion: '1.0.0', newVersion: '1.1.0' }],
      failed: [
        { moduleName: 'gamma', error: "Can't confirm gamma was updated.", unconfirmed: true },
        { moduleName: 'eps', error: "Can't confirm eps was updated.", unconfirmed: true },
      ],
      skipped: [{ moduleName: 'zeta', reason: 'pinned' }],
    }));
    expect(text).toBe("Updated 1 module(s); not updated: zeta (pinned). Can't confirm gamma was updated. Can't confirm eps was updated.");
  });

  it('joins the parts with "; " when nothing is unconfirmed', () => {
    const text = describeBulkModuleUpdate(result({
      totalAttempted: 1,
      skipped: [{ moduleName: 'zeta', reason: 'pinned' }],
    }), 'the bot restarts');
    expect(text).toBe('Updated 0 module(s); not updated: zeta (pinned); the bot restarts');
  });
});

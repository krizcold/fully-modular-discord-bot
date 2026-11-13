import { afterEach, expect, it, vi } from 'vitest';

// The first consumeToken after the module loads must prune; this file never resets the handler before it runs.
import { consumeToken, _bucketCount, _resetPanelHandler } from '../../src/bot/internalSetup/utils/ipcPanelHandler';

afterEach(() => {
  _resetPanelHandler();
  vi.useRealTimers();
});

it('the first call after load prunes, so a bucket idle past the cleanup age is gone a prune later', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_700_000_000_000);
  expect(consumeToken('idle')).toBe(true);
  vi.setSystemTime(1_700_000_000_000 + 300_001);
  expect(consumeToken('fresh')).toBe(true);
  expect(_bucketCount()).toBe(1);
});

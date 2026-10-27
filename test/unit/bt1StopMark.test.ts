import { describe, expect, it } from 'vitest';

import { isStopping, stopHandler } from '../../src/bot/internalSetup/utils/dataManager';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';

// BT1C-3's begun stop, before the exit drain. Its own file: a begun stop is permanent for the process.
describe('the shutdown handler', () => {
  it('marks the stop before its first step and runs once, so the held and pending texts switch from that moment', async () => {
    const lost = 'The bot is restarting and could not confirm your change was saved; it may be lost. Please check once it is back.';
    const lostInFull = 'The bot is restarting and could not confirm your change was saved in full; it may be lost. Please check once it is back.';
    const seen: unknown[] = [];
    const handler = stopHandler(async () => {
      seen.push(isStopping(), truthText('held', false), truthText('pending', true));
    });
    expect(isStopping()).toBe(false);
    expect(truthText('held', false)).toContain('the bot keeps retrying');
    expect(truthText('pending', false)).toContain('check again in a moment');
    await Promise.all([handler(), handler()]);
    expect(seen).toEqual([true, lost, lostInFull]);
    expect(isStopping()).toBe(true);
  });
});

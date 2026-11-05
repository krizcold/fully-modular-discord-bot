import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB4 decision 16: a shard restart withdrawn when the claims lapse leaves no trace of itself, so the leave's own
// restart request later reads as the leave's, also once no web UI process runs to restart this one.

const h = vi.hoisted(() => ({ stops: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    stopProcess: () => { h.stops += 1; },
    saveHeldWrites: async () => ({ unsavedGuilds: 0, unsavedFiles: 0 }),
  };
});

import {
  _resetMaintenance,
  _setMaintenanceSender,
  leaveRestartAsked,
  noteClaimsLapsed,
  restartForShards,
  startLeave,
} from '../../src/bot/internalSetup/utils/maintenance';

const sent: any[] = [];
const realSend = process.send;
beforeEach(() => {
  (process as { send?: unknown }).send = undefined;
  sent.length = 0;
  h.stops = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  (process as { send?: unknown }).send = realSend;
  _resetMaintenance();
  _setMaintenanceSender(null);
  vi.restoreAllMocks();
});

describe('a shard restart withdrawn by the claims lapse', () => {
  it("leaves the leave's later stop reading as the leave's own restart request", async () => {
    _setMaintenanceSender(message => { sent.push(message); });
    expect(restartForShards('take shard 3', () => null)).toBe(true);
    expect(leaveRestartAsked()).toBe(false);
    noteClaimsLapsed(1);
    expect(leaveRestartAsked()).toBe(false);
    _setMaintenanceSender(null);
    startLeave('The hook says running');
    await vi.waitFor(() => expect(h.stops).toBe(1));
    expect(leaveRestartAsked()).toBe(true);
    expect(sent.filter(m => m.type === 'control:restart-bot')).toEqual([{ type: 'control:restart-bot', data: { reason: 'take shard 3' } }]);
  });
});

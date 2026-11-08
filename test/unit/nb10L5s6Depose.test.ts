import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation survivor of dummyProvider.ts (decisions 12 and 20): only the bot process's Dummy cache is stopped by a
// deposition; the web UI's provider is not, so a call to it after another process took the data files is not refused
// with the bot's deposed text.

import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { checkWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { reopenSharedWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { freshWriterLock } from '../helpers/nb10Rig';
import { clearGlobal, settleQueue } from './nb10PremiumRig';

const OTHER = 5455;
const role = process.env.BOT_PROCESS_ROLE;
const made: DummyProvider[] = [];

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.BOT_PROCESS_ROLE;
  await settleQueue();
  clearGlobal();
  freshWriterLock('webui', new Set([process.pid, OTHER]));
});

afterEach(async () => {
  for (const p of made.splice(0)) p.dispose();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  takeWriterLock();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  reopenSharedWrites();
  await settleQueue();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the web UI deposed', () => {
  it("its Dummy provider is not stopped: a cancel of an unknown subscription answers without the deposed refusal", async () => {
    expect(takeWriterLock()).toMatchObject({ kind: 'taken' });
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
    expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
    const dummy = new DummyProvider();
    made.push(dummy);
    // NB6 decision 71 (sheet 3149-3150): a cancel with no record throws T25 before any change.
    await expect(dummy.cancelSubscription('dummy_1')).rejects.toThrow("Dummy subscription 'dummy_1' not found.");
  });
});

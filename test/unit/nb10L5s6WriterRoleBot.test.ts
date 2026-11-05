import fs from 'fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// NB10: the bot process is started with BOT_PROCESS_ROLE=bot and names itself a bot process in the writer lock. The
// variable is set before writerLock.ts loads, since the role is read once at load.
vi.hoisted(() => {
  process.env.BOT_PROCESS_ROLE = 'bot';
});

import { releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath, writerRole } from '../../src/bot/internalSetup/utils/writerLock';

afterEach(() => {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
});

afterAll(() => {
  delete process.env.BOT_PROCESS_ROLE;
});

describe('the writer role of a process started with BOT_PROCESS_ROLE=bot', () => {
  it('is the bot, and the lock file it takes names a bot process', () => {
    expect(writerRole()).toBe('bot');
    expect(takeWriterLock().kind).toBe('taken');
    const holder = JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'));
    expect(holder.pid).toBe(process.pid);
    expect(holder.role).toBe('bot');
  });
});

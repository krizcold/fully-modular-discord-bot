import fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath, writerRole } from '../../src/bot/internalSetup/utils/writerLock';

// NB10: a process started without BOT_PROCESS_ROLE=bot (the web UI) names itself the web UI in the writer lock.

afterEach(() => {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
});

describe('the writer role of a process started without BOT_PROCESS_ROLE', () => {
  it('is the web UI, and the lock file it takes names the web UI', () => {
    expect(process.env.BOT_PROCESS_ROLE).toBeUndefined();
    expect(writerRole()).toBe('webui');
    expect(takeWriterLock().kind).toBe('taken');
    const holder = JSON.parse(fs.readFileSync(writerLockPath(), 'utf8'));
    expect(holder.pid).toBe(process.pid);
    expect(holder.role).toBe('webui');
  });
});

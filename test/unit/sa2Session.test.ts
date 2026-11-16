import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

import { dataPath } from '../../src/utils/dataRoot';
import { dropPendingForGuild, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { resetFolderSyncFailureForTests } from '../../src/bot/internalSetup/utils/folderChain';
import { FileSessionStore, sessionSaveOutcome } from '../../src/webui/auth/fileSessionStore';
import { setBackendKind } from '../helpers/backendKind';

let n = 0;

beforeEach(() => {
  setBackendKind('file');
  resetFolderSyncFailureForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
  resetFolderSyncFailureForTests();
  setBackendKind(null);
});

describe('a session save whose queued write is dropped before it lands', () => {
  it('calls back with an error, notes refused, and leaves no session file', async () => {
    const folder = `sa2-sessions-${process.pid}-${++n}`;
    const dir = dataPath(folder);
    fs.mkdirSync(dir, { recursive: true });
    const store = new FileSessionStore({ dir, sweepIntervalMs: 60 * 60 * 1000, confirmMs: 2000 });
    store.stop();
    const file = path.join(dir, 'sid-sa2.json');
    let failed = 0;
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      const name = String(p);
      if (flags === 'w' && name.startsWith(`${file}.`) && name.endsWith('.tmp')) {
        failed += 1;
        setImmediate(() => dropPendingForGuild(folder));
        throw Object.assign(new Error('sa2 disk fault'), { code: 'EIO' });
      }
      return realOpen(p, flags, mode);
    }) as typeof fs.promises.open);
    const s = { cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000) } } as any;
    const started = performance.now();
    const error = await new Promise<unknown>(resolve => store.set('sid-sa2', s, e => resolve(e)));
    expect(performance.now() - started).toBeLessThan(1500);
    expect(failed).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('[FileSessionStore] Session file op not kept (unavailable)');
    expect(sessionSaveOutcome(s)).toBe('refused');
    expect(fs.existsSync(file)).toBe(false);
  });
});

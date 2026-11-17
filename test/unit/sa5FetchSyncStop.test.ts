import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// folderChain reads the platform once at load: it loads here as on Linux, where production runs and folders are synced.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

const h = vi.hoisted(() => ({ duringRead: null as null | (() => void), reads: 0 }));

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    rowBackend: () => ({
      sharedRead: async () => {
        h.reads++;
        const run = h.duringRead;
        h.duringRead = null;
        run?.();
        return { kind: 'read', rows: [] };
      },
    }),
  };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => {} }));

import { noteFolderSyncFailure, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { fetchModule } from '../../src/bot/internalSetup/utils/sharedModules';

const made: string[] = [];
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-fetch-'));
  made.push(dir);
  return path.join(dir, 'alpha');
};

afterEach(() => {
  h.duringRead = null;
  h.reads = 0;
});

afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

describe('sa5: a module fetch whose folder sync is refused', () => {
  it('fails with the folder sync cause and asks for a restart when a folder sync failed while the rows were read', async () => {
    const into = fresh();
    const failed = path.join(path.dirname(into), 'elsewhere');
    h.duringRead = () => noteFolderSyncFailure(failed, 'EIO');
    const answer = await fetchModule('alpha', into);
    expect(h.reads).toBe(1);
    expect(answer).toEqual({ ok: false, cause: syncWords('earlier', failed, 'EIO').why, restart: true });
  });
});

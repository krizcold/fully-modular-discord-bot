import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// An App Store key stored in its own transaction (decision 53): its mirror file takes a best-effort sync of its own
// folder, so a folder chain that would fail does not turn a written mirror into a failed one.

const h = vi.hoisted(() => ({ failChainOf: null as string | null }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/folderChain')>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      if (h.failChainOf !== null && path.resolve(dir) === h.failChainOf) {
        return { failed: true, kind: 'sync', dir: h.failChainOf, errno: 'EIO', error: Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }) };
      }
      return real.syncFolderChainSync(dir);
    },
  };
});

import fs from 'fs';
import { landStoreDoc, mirrorPathOf, shaOf, _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

afterEach(() => {
  h.failChainOf = null;
  _resetRowQueue();
  vi.restoreAllMocks();
});

describe('the mirror of a store key landed by a publish', () => {
  it('writes the file and its store record entry when the chain above its folder would fail', () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    const key = 'global/appstore/sa12mirror/mod/manifest.json';
    const file = mirrorPathOf(key);
    h.failChainOf = path.resolve(path.dirname(file));
    const body = Buffer.from('{"name":"sa12","version":"1.0.1"}');
    const sha = shaOf(body);
    landStoreDoc(key, body, sha, 'main-sa12');
    expect(fs.readFileSync(file, 'utf8')).toBe(body.toString('utf8'));
    const record = readStoreRecord();
    expect(record.ok && record.record.docs[key]).toEqual({ sha, stamp: null, main: 'main-sa12' });
    expect(errors).toEqual([]);
  });
});

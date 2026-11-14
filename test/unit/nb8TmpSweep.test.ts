import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanOrphanTmpFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

// NB8 test 19: the orphan temp file sweep leaves /data/_snapshots to the backups.

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the orphan temp file sweep', () => {
  it('leaves an old .tmp under /data/_snapshots and still removes one in a guild folder', async () => {
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    const kept = dataPath('_snapshots', `.taking-${Date.now()}-1`, '868200000000000001', 'm', 'a.json.tmp');
    const removed = dataPath('868200000000000002', 'm', 'b.json.tmp');
    for (const p of [kept, removed]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, old, old);
    }
    await cleanOrphanTmpFiles();
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(removed)).toBe(false);
  });
});

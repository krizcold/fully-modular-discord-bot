import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { cleanOrphanTmpFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

describe('fileBackend removes orphaned temp files', () => {
  it('deletes a *.tmp older than an hour and keeps a young one and other files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-tmp-'));
    try {
      const dir = path.join(root, '123', 'mod');
      fs.mkdirSync(dir, { recursive: true });
      const old = path.join(dir, 'a.json.1.2.0.tmp');
      const young = path.join(dir, 'b.json.1.2.1.tmp');
      const doc = path.join(dir, 'a.json');
      for (const f of [old, young, doc]) fs.writeFileSync(f, '{}');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
      fs.utimesSync(doc, twoHoursAgo, twoHoursAgo);
      await cleanOrphanTmpFiles(root);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(young)).toBe(true);
      expect(fs.existsSync(doc)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

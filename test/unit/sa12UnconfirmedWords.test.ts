import { describe, expect, it } from 'vitest';

import { unconfirmedWords } from '../../src/bot/internalSetup/utils/writerLock';

// The line a deposition and the web UI log for a cancelled write whose bytes are in place but whose folder sync failed.

describe('unconfirmedWords for a write whose folder sync failed', () => {
  it('names a whole file in place and the sync the disk did not confirm, with the errno', () => {
    expect(unconfirmedWords({ path: '/data/global/a.json', errno: 'EIO', cut: false, what: 'whole', kind: 'sync', dir: '/data/global' }))
      .toBe("[Data] Can't confirm whether /data/global/a.json is saved (EIO): the file is in place whole, but the disk did not confirm the sync of /data/global (EIO)");
  });

  it('names lines in the file and synced, also when what is not given', () => {
    const lines = "[Data] Can't confirm whether /data/global/a.jsonl is saved (EIO): its lines are in the file and synced, but the disk did not confirm the sync of /data/global (EIO)";
    expect(unconfirmedWords({ path: '/data/global/a.jsonl', errno: 'EIO', cut: false, what: 'lines', kind: 'sync', dir: '/data/global' })).toBe(lines);
    expect(unconfirmedWords({ path: '/data/global/a.jsonl', errno: 'EIO', cut: false, kind: 'sync', dir: '/data/global' })).toBe(lines);
  });

  it('says no error code in both places when the errno is unknown', () => {
    expect(unconfirmedWords({ path: '/data/global/a.json', errno: null, cut: false, what: 'whole', kind: 'open', dir: '/data/global' }))
      .toBe("[Data] Can't confirm whether /data/global/a.json is saved (no error code): the file is in place whole, but /data/global could not be opened for its sync (no error code)");
  });
});

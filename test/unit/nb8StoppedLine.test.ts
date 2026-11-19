// NB8 decision 70 with B6 as L2 amends it: stoppedDuringRestoreLine's restart words for each disk record state.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ boot: null as string | null, files: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => ({
  ...(await orig<object>()),
  bootId: () => disk.boot,
  diskRecord: () => (disk.files.length === 0 ? null : { files: disk.files, record: null }),
  containerPath: (p: string) => `/data/_snapshots/${p.split(/[\\/]/).pop()}`,
}));

import { stoppedDuringRestoreLine } from '../../src/webui/backups/restoreState';

const HEAD = '[Backup] Restore of b1: the bot stopped during the restore and was not started again; the restore starts it when it finishes; if the restore stops part way, the bot starts once ';

describe('stoppedDuringRestoreLine', () => {
  beforeEach(() => { disk.boot = null; disk.files = []; });

  it('names the container restart when no disk record stands', () => {
    expect(stoppedDuringRestoreLine('b1')).toBe(`${HEAD}a restart of the bot's container has finished the restore`);
  });

  it('names the machine restart when this boot wrote the record', () => {
    disk.boot = 'boot-1';
    disk.files = ['disk-error-boot-1.json'];
    expect(stoppedDuringRestoreLine('b1')).toBe(`${HEAD}a restart of the machine the bot runs on (a restart of the bot's container is not enough after a disk error) has finished the restore`);
  });

  it('with the boot id unknown, one record is deleted before the container restart', () => {
    disk.files = ['disk-error-unknown.json'];
    expect(stoppedDuringRestoreLine('b1')).toBe(`${HEAD}/data/_snapshots/disk-error-unknown.json is deleted and a restart of the bot's container has finished the restore (the web panel cannot read the machine's boot id)`);
  });

  it('with the boot id unknown, two records are deleted before the container restart', () => {
    disk.files = ['disk-error-unknown.json', 'disk-error-boot-1.json'];
    expect(stoppedDuringRestoreLine('b1')).toBe(`${HEAD}/data/_snapshots/disk-error-unknown.json and /data/_snapshots/disk-error-boot-1.json are deleted and a restart of the bot's container has finished the restore (the web panel cannot read the machine's boot id)`);
  });
});

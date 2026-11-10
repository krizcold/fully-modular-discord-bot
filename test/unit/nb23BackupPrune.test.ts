import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB23 (sheets/NB6.md:1533-1534, 2260-2261, 2958): the prune of cache/backups. A folder older than 30 days (by the
// time in its name) is deleted unless it is its module's newest backup of a version, an orphan, or a folder of a
// module whose apply is open or running; folders whose name is not one the apply gives are never touched. The pass
// runs the prune at most once an hour.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { BACKUP_KEEP_MS, pruneBackups } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const OLD = NOW - 40 * DAY;
const OLDER = NOW - 50 * DAY;
const RECENT = NOW - 10 * DAY;

beforeEach(() => rig.setup());
afterEach(() => rig.teardown());

function folder(name: string): string {
  const dir = path.join(rig.state.backups, name);
  rig.writeTree(dir, { 'module.json': `{"name":"${name}"}` });
  return dir;
}

function setApplying(module: string): void {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  read.record.modules[module] = {
    sha: 'absent', stamp: null, files: {}, main: null, built: null, failedSha: null, retryAt: null,
    applying: { from: 'absent', to: 'x', backup: null, displaced: 'backups', tag: null, version: null, updatedBy: null },
  };
  writeStoreRecord(read.record);
}

describe('what the prune keeps', () => {
  it('keeps 30 days', () => {
    expect(BACKUP_KEEP_MS).toBe(30 * DAY);
  });

  it('deletes old -failed and -interrupted copies and old backups that are not the newest; keeps the newest backup, orphans and recent folders', () => {
    folder(`m-${OLDER}`);
    folder(`m-${OLD}`);
    folder(`m-${OLDER}-failed`);
    folder(`m-${OLD}-interrupted-1`);
    folder(`m-${OLDER}-orphan`);
    folder(`m-${RECENT}-failed`);
    folder(`my-mod-${OLDER}-failed`);
    folder(`my-mod-${OLDER}`);
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${OLD}`, `m-${OLDER}-orphan`, `m-${RECENT}-failed`].sort());
    expect(rig.backupsOf('my-mod')).toEqual([`my-mod-${OLDER}`]);
  });

  it('the newest backup of a module is kept however old, and a recent one makes an older one deletable', () => {
    folder(`m-${OLDER}`);
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${OLDER}`]);
    folder(`m-${RECENT}`);
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${RECENT}`]);
  });

  it('a suffixed name from freePath counts by the time in its name', () => {
    folder(`m-${OLDER}`);
    folder(`m-${OLD}-1`);
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${OLD}-1`]);
  });

  it('nothing of a module whose apply is open is touched', () => {
    folder(`m-${OLDER}`);
    folder(`m-${OLD}`);
    folder(`m-${OLDER}-failed`);
    setApplying('m');
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${OLD}`, `m-${OLDER}`, `m-${OLDER}-failed`].sort());
  });

  it('nothing is touched while the store record cannot be read', () => {
    folder(`m-${OLDER}-failed`);
    fs.mkdirSync(path.dirname(path.join(rig.state.backups, '..', '.shared-mirror.json')), { recursive: true });
    fs.writeFileSync(path.join(rig.state.backups, '..', '.shared-mirror.json'), '{not json');
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${OLDER}-failed`]);
  });

  it('a name the apply does not give, and a file, are left alone', () => {
    folder(`notes`);
    folder(`m-12345-failed`);
    fs.writeFileSync(path.join(rig.state.backups, `m-${OLDER}-failed.txt`), 'x');
    pruneBackups(NOW);
    expect(fs.readdirSync(rig.state.backups).sort()).toEqual([`m-${OLDER}-failed.txt`, 'm-12345-failed', 'notes'].sort());
  });

  it('logs each folder it deleted', () => {
    const dir = folder(`m-${OLDER}-failed`);
    pruneBackups(NOW);
    expect(rig.state.lines).toContain(`[Shared] Deleted the module backup ${dir}: it was older than 30 days and not the newest backup of m`);
  });
});

describe('the pass runs the prune', () => {
  it('at its module step, then not again within the hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    folder(`m-${OLDER}-failed`);
    await rig.pass();
    expect(rig.backupsOf('m')).toEqual([]);
    folder(`m-${OLD}-failed`);
    vi.setSystemTime(NOW + 30 * 60_000);
    await rig.pass();
    expect(rig.backupsOf('m')).toEqual([`m-${OLD}-failed`]);
    vi.setSystemTime(NOW + 61 * 60_000);
    await rig.pass();
    expect(rig.backupsOf('m')).toEqual([]);
    expect(fakeLoader.loads).toEqual([]);
  });
});

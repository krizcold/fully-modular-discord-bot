import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The prune of cache/backups (NB23): the names it reads, the newest backup whatever order the disk lists names in,
// the 30-day edge, the hour between two prunes of the pass, and a prune that throws.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig } from '../helpers/nb6ApplyRig';
import { BACKUP_KEEP_MS, pruneBackups } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const OLD = NOW - 40 * DAY;
const OLDER = NOW - 50 * DAY;
const HOUR = 60 * 60_000;

beforeEach(() => rig.setup());
afterEach(() => rig.teardown());

function folder(name: string): string {
  const dir = path.join(rig.state.backups, name);
  rig.writeTree(dir, { 'module.json': `{"name":"${name}"}`, 'sub/index.js': 'exports.v = 1;\n' });
  return dir;
}

describe('the names the prune reads', () => {
  it('a copy suffix of two digits counts by the time in its name', () => {
    folder(`m-${OLDER}`);
    folder(`m-${OLD}-failed-12`);
    folder(`m-${OLD}-12`);
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${OLD}-12`]);
  });

  it('a name with a line break before a backup name is not one the apply gives, and is left alone', () => {
    const real = fs.readdirSync;
    const removed: string[] = [];
    const odd = `notes\nm-${OLDER}-failed`;
    fs.mkdirSync(rig.state.backups, { recursive: true });
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
      if (path.resolve(String(dir)) === path.resolve(rig.state.backups)) return [{ name: odd, isDirectory: () => true, isFile: () => false }];
      return (real as any)(dir, options);
    }) as typeof fs.readdirSync);
    const realRm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target).startsWith(rig.state.backups)) {
        removed.push(String(target));
        return;
      }
      return realRm(target, options);
    }) as typeof fs.rmSync);
    pruneBackups(NOW);
    expect(removed).toEqual([]);
    expect(rig.state.lines.filter(l => l.startsWith('[Shared] Deleted the module backup'))).toEqual([]);
  });
});

describe('the newest backup of a module', () => {
  it('is kept whatever order the disk lists the names in, and the older one is deleted with its files', () => {
    const newest = folder(`m-${OLD}`);
    const older = folder(`m-${OLDER}`);
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
      const out = (real as any)(dir, options);
      return path.resolve(String(dir)) === path.resolve(rig.state.backups) ? [...out].sort((a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? 1 : -1)) : out;
    }) as typeof fs.readdirSync);
    pruneBackups(NOW);
    vi.mocked(fs.readdirSync).mockRestore();
    expect(rig.backupsOf('m')).toEqual([`m-${OLD}`]);
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(path.join(newest, 'sub', 'index.js'))).toBe(true);
    expect(rig.state.lines).toContain(`[Shared] Deleted the module backup ${older}: it was older than 30 days and not the newest backup of m`);
  });
});

describe('the 30-day edge', () => {
  it('a folder exactly 30 days old is kept, one a millisecond older is deleted', () => {
    folder(`m-${NOW - BACKUP_KEEP_MS}-failed`);
    folder(`m-${NOW - BACKUP_KEEP_MS - 1}-interrupted`);
    pruneBackups(NOW);
    expect(rig.backupsOf('m')).toEqual([`m-${NOW - BACKUP_KEEP_MS}-failed`]);
  });
});

describe('the pass runs the prune', () => {
  it('again once a whole hour has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    folder(`m-${OLDER}-failed`);
    await rig.pass();
    expect(rig.backupsOf('m')).toEqual([]);
    folder(`m-${OLD}-failed`);
    vi.setSystemTime(NOW + HOUR - 1);
    await rig.pass();
    expect(rig.backupsOf('m')).toEqual([`m-${OLD}-failed`]);
    vi.setSystemTime(NOW + HOUR);
    await rig.pass();
    expect(rig.backupsOf('m')).toEqual([]);
  });

  it('a prune that throws is logged, and the pass goes on', async () => {
    fs.mkdirSync(path.dirname(rig.state.backups), { recursive: true });
    fs.writeFileSync(rig.state.backups, 'not a folder');
    await rig.pass();
    const line = rig.state.lines.find(l => l.startsWith('[Shared] Could not prune the module backups ('));
    expect(line).toBeDefined();
    expect(line).toContain(rig.state.backups);
    expect(line!.endsWith('); the pass tries again in an hour')).toBe(true);
    fs.rmSync(rig.state.backups, { force: true });
  });
});

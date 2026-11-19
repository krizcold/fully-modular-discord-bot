import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LATEST_NAMED_TIME,
  compareSnapshotNames,
  formatSnapshotName,
  parseSnapshotName,
  parseWorkName,
  preRestoreFolderName,
  restoreFolderName,
  takingFolderName,
  type SnapshotKind,
} from '../../src/bot/internalSetup/utils/backups/snapshotNames';

// NB8 test 3: snapshot and work folder names (decision 2, decisions 22 and 69 for the work folders' times).

const kind = fc.constantFrom<SnapshotKind>('hourly', 'daily', 'pre-restore');
const time = fc.integer({ min: 0, max: LATEST_NAMED_TIME });

describe('snapshot names', () => {
  it('writes the UTC time with ":" and "." as "-"', () => {
    expect(formatSnapshotName('hourly', Date.UTC(2026, 10, 1, 4, 0, 0, 123))).toBe('hourly-2026-11-01T04-00-00-123Z');
    expect(formatSnapshotName('pre-restore', Date.UTC(2026, 10, 1, 4, 0, 0, 0))).toBe('pre-restore-2026-11-01T04-00-00-000Z');
  });

  it('parses back the kind and time it was formatted with', () => {
    fc.assert(
      fc.property(kind, time, (k, t) => {
        expect(parseSnapshotName(formatSnapshotName(k, t))).toEqual({ kind: k, time: t });
      }),
    );
  });

  it.each([
    'weekly-2026-11-01T04-00-00-123Z',
    'hourly-2026-11-01T04:00:00.123Z',
    'hourly-2026-02-30T04-00-00-000Z',
    'hourly-2026-11-01T24-00-00-000Z',
    'hourly-2026-11-01T04-00-00-12Z',
    'hourly-2026-11-01T04-00-00-123Z-x',
    'hourly-',
    'hourly',
    'pre-restore',
    'daily-+12026-11-01T04-00-00-123Z',
    '.restore-2026-11-01T04-00-00-123Z',
    'state.json',
    '',
  ])('%j parses to null', name => {
    expect(parseSnapshotName(name)).toBeNull();
  });

  it('parses only the names it formats', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), kind.chain(k => fc.string().map(s => `${k}-${s}`))), name => {
        const parsed = parseSnapshotName(name);
        if (parsed) expect(formatSnapshotName(parsed.kind, parsed.time)).toBe(name);
      }),
    );
  });

  it('sorts names by their time, whatever their kind', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(kind, time), { maxLength: 20 }), pairs => {
        const sorted = pairs.map(([k, t]) => formatSnapshotName(k, t)).sort(compareSnapshotNames);
        const times = sorted.map(n => parseSnapshotName(n)!.time);
        expect(times).toEqual([...times].sort((a, b) => a - b));
      }),
    );
  });

  it('sorts a name that does not parse after every one that does', () => {
    const names = ['zzz', formatSnapshotName('daily', Date.UTC(2026, 0, 1)), 'aaa', formatSnapshotName('hourly', Date.UTC(2025, 0, 1))];
    expect(names.sort(compareSnapshotNames)).toEqual(['hourly-2025-01-01T00-00-00-000Z', 'daily-2026-01-01T00-00-00-000Z', 'aaa', 'zzz']);
  });
});

describe('work folder names', () => {
  it('reads back the time of a restore, pre-restore and taking folder, and the pid of a taking one', () => {
    fc.assert(
      fc.property(time, fc.integer({ min: 1, max: 4194304 }), (t, pid) => {
        expect(parseWorkName(restoreFolderName(t))).toEqual({ work: 'restore', time: t });
        expect(parseWorkName(preRestoreFolderName(t))).toEqual({ work: 'pre-restore', time: t });
        expect(parseWorkName(takingFolderName(t, pid))).toEqual({ work: 'taking', time: t, pid });
      }),
    );
  });

  it('reads the snapshot name of a test and a delete folder', () => {
    expect(parseWorkName('.test-hourly-2026-11-01T04-00-00-000Z')).toEqual({ work: 'test', name: 'hourly-2026-11-01T04-00-00-000Z' });
    expect(parseWorkName('.delete-daily-2026-11-01T04-00-00-000Z')).toEqual({ work: 'delete', name: 'daily-2026-11-01T04-00-00-000Z' });
  });

  it.each(['.restore-x', '.restore-2026-11-01T04:00:00.000Z', '.taking-2026-11-01T04-00-00-000Z', '.taking-2026-11-01T04-00-00-000Z-0', '.test-', '.other-x', 'hourly-2026-11-01T04-00-00-000Z'])(
    '%j is no work folder',
    name => {
      expect(parseWorkName(name)).toBeNull();
    },
  );
});

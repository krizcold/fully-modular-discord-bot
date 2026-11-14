import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_STAGES, isOpenStage, readRestoreJournal, restoreJournalPath } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { listSnapshots, pruneVerdict, readSnapshot, restoreLeftovers, type SnapshotEntry } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { formatSnapshotName, restoreFolderName, type SnapshotKind } from '../../src/bot/internalSetup/utils/backups/snapshotNames';
import { dataPath } from '../../src/utils/dataRoot';
import { prune } from '../../src/webui/backups/scheduler';
import { _resetRestoreStateForTests, setRestoreOp } from '../../src/webui/backups/restoreState';
import { defaultState, writeRestoreJournal } from '../../src/webui/backups/state';

// NB8 test 4: the keeps (decision 7), the .restore-<t> leftovers (decision 69), the listing (decision 6) and the
// journal read the prune and the gates make (decisions 26, 46).

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 13, 12, 30, 0, 0);

function entry(kind: SnapshotKind, ago: number, state: 'complete' | 'damaged' = 'complete'): SnapshotEntry {
  const time = NOW - ago;
  const name = formatSnapshotName(kind, time);
  return state === 'complete'
    ? { name, kind, time, state, manifest: { format: 1, name } as any }
    : { name, kind, time, state, cause: 'ENOENT' };
}

function odd(name: string, state: 'complete' | 'damaged' = 'complete'): SnapshotEntry {
  return state === 'complete'
    ? { name, kind: null, time: null, state, manifest: { format: 1, name } as any }
    : { name, kind: null, time: null, state, cause: 'ENOENT' };
}

const none = { lastPassed: null };

describe('pruneVerdict, one rule each', () => {
  const newest = entry('hourly', 10 * MIN);

  it.each([
    ['an hourly 48 hours old is kept', [entry('hourly', 48 * HOUR), newest], none, []],
    ['an hourly past 48 hours is removed', [entry('hourly', 48 * HOUR + 1), newest], none, [entry('hourly', 48 * HOUR + 1).name]],
    ['a daily 30 days old is kept', [entry('daily', 30 * DAY), newest], none, []],
    ['a daily past 30 days is removed', [entry('daily', 30 * DAY + 1), newest], none, [entry('daily', 30 * DAY + 1).name]],
    ['a daily 3 days old is kept past the hourly keep', [entry('daily', 3 * DAY), newest], none, []],
    ['the newest complete hourly or daily is kept past its keep', [entry('hourly', 50 * HOUR)], none, []],
    ['the newest complete is kept when a newer one is damaged', [entry('daily', 31 * DAY), entry('hourly', 49 * HOUR, 'damaged')], none, []],
    ['the newest passed is kept', [entry('daily', 40 * DAY), newest], { lastPassed: entry('daily', 40 * DAY).name }, []],
    ['the one the running test reads is kept', [entry('hourly', 49 * HOUR), newest], { lastPassed: null, testing: entry('hourly', 49 * HOUR).name }, []],
    ['the one restore.json names is kept', [entry('hourly', 49 * HOUR), newest], { lastPassed: null, restoring: entry('hourly', 49 * HOUR).name }, []],
    ['a pre-restore snapshot is kept at any age', [entry('pre-restore', 400 * DAY), newest], none, []],
    ['a damaged folder is kept', [entry('hourly', 49 * HOUR, 'damaged'), newest], none, []],
    ['a name that does not parse is kept', [odd('my-copy'), odd('hourly-old', 'damaged'), newest], none, []],
    ['state.json unreadable removes nothing', [entry('hourly', 49 * HOUR), newest], { lastPassed: null, stateUnreadable: true }, []],
    ['a name 5 minutes ahead still prunes', [entry('hourly', 49 * HOUR), entry('hourly', -5 * MIN)], none, [entry('hourly', 49 * HOUR).name]],
  ] as const)('%s', (_label, list, protect, remove) => {
    expect(pruneVerdict(list as readonly SnapshotEntry[], NOW, protect)).toEqual({ remove, ahead: null });
  });

  it('removes nothing and names the snapshot when one is dated more than 5 minutes ahead', () => {
    const old = entry('hourly', 49 * HOUR);
    const ahead = entry('hourly', -(5 * MIN + 1));
    const further = entry('daily', -(90 * MIN + 30 * 1000), 'damaged');
    expect(pruneVerdict([old, ahead, further, newest], NOW, none)).toEqual({ remove: [], ahead: { name: further.name, minutes: 90 } });
    expect(pruneVerdict([old, ahead, newest], NOW, none)).toEqual({ remove: [], ahead: { name: ahead.name, minutes: 5 } });
  });
});

describe('pruneVerdict over random lists', () => {
  const item = fc.record({
    kind: fc.constantFrom<SnapshotKind | 'odd'>('hourly', 'daily', 'pre-restore', 'odd'),
    ago: fc.integer({ min: -2 * HOUR, max: 40 * DAY }),
    damaged: fc.boolean(),
    tag: fc.integer({ min: 0, max: 1e6 }),
  });

  it('keeps every protected name, and removes only snapshots past their keep', () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 25 }), fc.array(fc.nat(), { minLength: 3, maxLength: 3 }), fc.boolean(), (items, picks, unreadable) => {
        const byName = new Map<string, SnapshotEntry>();
        for (const it of items) {
          const e = it.kind === 'odd' ? odd(`odd-${it.tag}`, it.damaged ? 'damaged' : 'complete') : entry(it.kind, it.ago, it.damaged ? 'damaged' : 'complete');
          byName.set(e.name, e);
        }
        const list = [...byName.values()];
        const pick = (i: number) => (list.length && picks[i] % 3 ? list[picks[i] % list.length].name : null);
        const protect = { lastPassed: pick(0), testing: pick(1), restoring: pick(2), stateUnreadable: unreadable };
        const { remove, ahead } = pruneVerdict(list, NOW, protect);

        const anyAhead = list.some(e => e.time !== null && e.time - NOW > 5 * MIN);
        expect(ahead !== null).toBe(anyAhead);
        if (anyAhead || unreadable) {
          expect(remove).toEqual([]);
          return;
        }
        const live = list.filter(e => e.state === 'complete' && (e.kind === 'hourly' || e.kind === 'daily'));
        const newestTime = Math.max(...live.map(e => e.time as number));
        const newest = live.find(e => e.time === newestTime)?.name;
        const removed = new Set(remove);
        for (const e of list) {
          const due =
            e.state === 'complete' &&
            ((e.kind === 'hourly' && NOW - (e.time as number) > 48 * HOUR) || (e.kind === 'daily' && NOW - (e.time as number) > 30 * DAY)) &&
            e.name !== newest &&
            ![protect.lastPassed, protect.testing, protect.restoring].includes(e.name);
          expect(removed.has(e.name), e.name).toBe(due);
        }
      }),
    );
  });
});

describe('restoreLeftovers', () => {
  const at = (ago: number) => restoreFolderName(NOW - ago);

  it('removes a .restore-<t> dated 61 minutes ago and keeps one dated 59 minutes ago', () => {
    expect(restoreLeftovers([at(61 * MIN), at(59 * MIN)], NOW)).toEqual([at(61 * MIN)]);
  });

  it('keeps a name whose time does not parse and one dated ahead of the clock', () => {
    expect(restoreLeftovers(['.restore-x', '.restore-2026-11-13T12:00:00.000Z', at(-2 * HOUR)], NOW)).toEqual([]);
  });

  it("keeps the folder a failed journal's leftover names, and removes it when none is named", () => {
    expect(restoreLeftovers([at(2 * HOUR), at(3 * HOUR)], NOW, at(2 * HOUR))).toEqual([at(3 * HOUR)]);
    expect(restoreLeftovers([at(2 * HOUR), at(3 * HOUR)], NOW, null)).toEqual([at(2 * HOUR), at(3 * HOUR)]);
  });

  it('leaves every other name at the top of _snapshots', () => {
    const t = NOW - 3 * HOUR;
    const names = [`.pre-restore-${restoreFolderName(t).slice('.restore-'.length)}`, formatSnapshotName('hourly', t), '.delete-x', 'state.json'];
    expect(restoreLeftovers(names, NOW)).toEqual([]);
  });
});

describe('listSnapshots', () => {
  const root = dataPath('_snapshots');
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function folder(name: string, manifest?: unknown | string) {
    fs.mkdirSync(path.join(root, name, 'data'), { recursive: true });
    if (manifest !== undefined) {
      fs.writeFileSync(path.join(root, name, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    }
  }

  it('answers an empty list when _snapshots does not exist', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(await listSnapshots()).toEqual([]);
  });

  it('lists complete and damaged folders oldest first, and skips work folders and files', async () => {
    const a = formatSnapshotName('daily', Date.UTC(2026, 10, 1, 4));
    const b = formatSnapshotName('hourly', Date.UTC(2026, 10, 2, 5));
    const c = formatSnapshotName('hourly', Date.UTC(2026, 10, 2, 6));
    const d = formatSnapshotName('hourly', Date.UTC(2026, 10, 2, 7));
    const e = formatSnapshotName('pre-restore', Date.UTC(2026, 10, 2, 8));
    folder(b, { format: 1, name: b, counts: { files: 0 } });
    folder(a, { format: 1, name: a });
    folder(c);
    folder(d, { format: 2, name: d });
    folder(e, '{"format":1,');
    folder('copy-of-a', { format: 1, name: a });
    folder('.taking-2026-11-02T09-00-00-000Z-12');
    folder('.restore-2026-11-02T09-00-00-000Z');
    fs.writeFileSync(path.join(root, 'state.json'), '{}');
    fs.writeFileSync(path.join(root, 'disk-error-b1.json'), '{}');
    const list = await listSnapshots();
    expect(list.map(s => [s.name, s.state, s.state === 'damaged' ? s.cause : s.manifest.name])).toEqual([
      [a, 'complete', a],
      [b, 'complete', b],
      [c, 'damaged', 'ENOENT'],
      [d, 'damaged', 'format 2, which this version cannot read'],
      [e, 'damaged', 'not valid JSON'],
      ['copy-of-a', 'damaged', `it names the backup ${JSON.stringify(a)}`],
    ]);
    expect(list[1]).toMatchObject({ kind: 'hourly', time: Date.UTC(2026, 10, 2, 5) });
    expect(list[5]).toMatchObject({ kind: null, time: null });
  });

  it('reads one folder synchronously', () => {
    const a = formatSnapshotName('daily', Date.UTC(2026, 10, 1, 4));
    folder(a, { format: 1, name: a });
    expect(readSnapshot(a)).toMatchObject({ name: a, kind: 'daily', state: 'complete' });
    expect(readSnapshot('hourly-2026-11-01T04-00-00-000Z')).toMatchObject({ state: 'damaged', cause: 'ENOENT' });
  });
});

describe('readRestoreJournal', () => {
  const file = restoreJournalPath();
  afterEach(() => fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true }));

  function write(body: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }

  const journal = { format: 1, name: 'hourly-2026-11-01T04-00-00-000Z', startedAt: 1, stage: 'staging', staging: '.restore-x', preRestore: 'pre-restore-x' };

  it('answers none with no journal', () => {
    expect(file).toBe(dataPath('_snapshots', 'restore.json'));
    expect(readRestoreJournal()).toEqual({ state: 'none' });
  });

  it('answers the journal it reads, with the fields a later stage adds', () => {
    write({ ...journal, stage: 'failed', leftover: { path: '/data/_snapshots/.restore-x', errno: 'EBUSY' } });
    expect(readRestoreJournal()).toEqual({ state: 'read', journal: { ...journal, stage: 'failed', leftover: { path: '/data/_snapshots/.restore-x', errno: 'EBUSY' } } });
  });

  it.each([
    ['{"format":1,', 'not valid JSON'],
    ['[]', 'not a JSON object'],
    [{ ...journal, format: 2 }, 'format 2, which this version cannot read'],
    [{ ...journal, format: undefined }, 'no format field'],
    [{ ...journal, stage: 'moving' }, 'unknown stage "moving"'],
    [{ ...journal, name: undefined }, 'no name field'],
    [{ ...journal, startedAt: 'x' }, 'startedAt is not a number'],
  ])('answers unreadable for %j', (body, cause) => {
    write(body);
    expect(readRestoreJournal()).toEqual({ state: 'unreadable', cause });
  });

  it('answers unreadable with the errno when the read fails', () => {
    fs.mkdirSync(file, { recursive: true });
    const read = readRestoreJournal();
    expect(read.state).toBe('unreadable');
    expect(read.state === 'unreadable' && /^E[A-Z]+$/.test(read.cause)).toBe(true);
  });

  it('names staging, staged, swapping, placing and stuck as the open stages', () => {
    expect([...OPEN_STAGES]).toEqual(['staging', 'staged', 'swapping', 'placing', 'stuck']);
    expect((['placed', 'done', 'failed'] as const).some(isOpenStage)).toBe(false);
  });
});

describe("the prune's runner (scheduler.ts prune(): decisions 26 and 69)", () => {
  const root = dataPath('_snapshots');
  let logs: string[];

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    _resetRestoreStateForTests();
    logs = [];
    const keep = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(keep);
    vi.spyOn(console, 'warn').mockImplementation(keep);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    _resetRestoreStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function complete(kind: SnapshotKind, ago: number): string {
    const name = formatSnapshotName(kind, NOW - ago);
    fs.mkdirSync(path.join(root, name, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'manifest.json'), JSON.stringify({ format: 1, name }));
    return name;
  }
  const leftover = (ago: number): string => {
    const name = restoreFolderName(NOW - ago);
    fs.mkdirSync(path.join(root, name, 'data'), { recursive: true });
    return name;
  };
  const top = (): string[] => fs.readdirSync(root).sort();

  it("the gate answering running before the second of two removals keeps the second", async () => {
    const first = complete('hourly', 3 * DAY);
    const second = complete('hourly', 3 * DAY - HOUR);
    const newest = complete('hourly', HOUR);
    const real = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: fs.PathLike, o?: fs.RmOptions) => {
      await real(p, o);
      setRestoreOp({ kind: 'restore', name: newest });
    }) as typeof fs.promises.rm);
    await prune(NOW, await listSnapshots(), defaultState());
    expect(top()).toEqual([newest, second].sort());
    expect(logs).toEqual([`[Backup] Removed ${first} (past its keep)`]);
  });

  it('a removal error logs its line and the next prune removes the folder', async () => {
    const old = leftover(61 * MIN);
    const real = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementationOnce((async () => {
      throw Object.assign(new Error('EBUSY: stubbed'), { code: 'EBUSY' });
    }) as typeof fs.promises.rm).mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => real(p, o)) as typeof fs.promises.rm);
    await prune(NOW, [], defaultState());
    expect(top()).toEqual([old]);
    expect(logs).toEqual([`[Backup] Could not remove ${old} (EBUSY); it is tried again at the next prune`]);
    await prune(NOW, [], defaultState());
    expect(top()).toEqual([]);
    expect(logs[1]).toBe(`[Backup] Removed ${old}, a restore's copy that no restore uses (made more than an hour ago)`);
  });

  it("a failed journal's leftover is kept, and the same folder under a done journal is removed", async () => {
    const old = leftover(2 * HOUR);
    const j = { format: 1 as const, name: 'hourly-x', startedAt: 1, staging: old, preRestore: 'pre-restore-x' };
    writeRestoreJournal({ ...j, stage: 'failed', leftover: { path: `/data/_snapshots/${old}`, errno: 'EBUSY' } });
    await prune(NOW, [], defaultState());
    expect(top()).toContain(old);
    writeRestoreJournal({ ...j, stage: 'done' });
    await prune(NOW, [], defaultState());
    expect(top()).toEqual(['restore.json']);
  });
});

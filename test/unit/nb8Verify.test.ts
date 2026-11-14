import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncDirs } from '../../src/bot/internalSetup/utils/backups/fsyncDirs';
import type { Manifest } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { formatSnapshotName } from '../../src/bot/internalSetup/utils/backups/snapshotNames';
import * as verify from '../../src/bot/internalSetup/utils/backups/snapshotVerify';
import { copySnapshot, verifyTree, VERIFY_LIST_MAX } from '../../src/bot/internalSetup/utils/backups/snapshotVerify';
import { folderSyncFailed, noteFolderSyncFailure } from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';

// NB8 test 9: the copy a restore and the daily test make (decisions 9 and 11 step 3, C10), its check against the
// manifest, and fsyncDirs (decisions 28, 35 and 53, N5).

const POSIX = process.platform !== 'win32';
let made: string[] = [];
let stamp = Date.UTC(2026, 10, 13, 4, 0, 0, 0);

afterEach(() => {
  vi.restoreAllMocks();
  for (const p of made) fs.rmSync(p, { recursive: true, force: true });
  made = [];
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const isGuild = (p: string) => /^\d+$/.test(p);

/** A tree: files by POSIX path with their bytes, and folders (every file's parents are added). */
type Tree = { files: Record<string, Buffer>; dirs: string[] };

function manifestOf(name: string, tree: Tree): Manifest {
  const dirs = new Set<string>();
  for (const d of tree.dirs) {
    const parts = d.split('/');
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const f of Object.keys(tree.files)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const files = Object.entries(tree.files)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b), sig: { ino: 0, size: b.length, mtimeMs: 0, ctimeMs: 0 } }));
  const top = [...dirs, ...files.map(f => f.path)];
  return {
    format: 1,
    name,
    kind: 'hourly',
    takenAt: stamp,
    botVersion: 'test',
    counts: {
      files: files.length,
      bytes: files.reduce((s, f) => s + f.size, 0),
      dirs: dirs.size,
      guilds: [...dirs].filter(d => isGuild(d)).length,
      graveyardEntries: top.filter(p => p.startsWith('_graveyard/') && p.split('/').length === 2 && !p.split('/')[1].startsWith('.')).length,
    },
    files,
    dirs: [...dirs].sort(),
  };
}

function writeTree(root: string, manifest: Manifest, tree: Tree): void {
  fs.mkdirSync(root, { recursive: true });
  for (const d of manifest.dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [p, b] of Object.entries(tree.files)) fs.writeFileSync(path.join(root, p), b);
}

/** A complete snapshot under _snapshots, as the take leaves it: manifest.json beside data/. */
function snapshot(tree: Tree): { name: string; manifest: Manifest } {
  stamp += 1000;
  const name = formatSnapshotName('hourly', stamp);
  const folder = dataPath('_snapshots', name);
  made.push(folder);
  const manifest = manifestOf(name, tree);
  writeTree(path.join(folder, 'data'), manifest, tree);
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return { name, manifest };
}

function scratch(): string {
  const p = dataPath('_snapshots', `.test-scratch-${stamp}-${made.length}`);
  made.push(p);
  return path.join(p, 'data');
}

const sample = (): Tree => ({
  files: {
    '123/mod/a.json': Buffer.from('{"a":1}'),
    '123/mod/b.json': Buffer.from(''),
    '_graveyard/456-1700000000000/.graveyard.json': Buffer.from('{"g":1}'),
    'global/premium/p.json': Buffer.from('{"p":2}'),
    'dist/bot/config.json': Buffer.from('{"c":3}'),
  },
  dirs: ['789'],
});

describe('copySnapshot', () => {
  it('copies every manifest file and folder, never as a link, and the copy checks out', async () => {
    const { name, manifest } = snapshot(sample());
    const dest = scratch();
    await copySnapshot(name, dest);
    expect(await verifyTree(dest, manifest)).toEqual({ ok: true });
    const from = fs.statSync(dataPath('_snapshots', name, 'data', '123/mod/a.json'));
    const to = fs.statSync(path.join(dest, '123/mod/a.json'));
    expect(to.ino === from.ino && to.dev === from.dev).toBe(false);
    expect(fs.statSync(path.join(dest, '789')).isDirectory()).toBe(true);
  });

  it('copies only what the manifest lists', async () => {
    const { name, manifest } = snapshot(sample());
    fs.writeFileSync(dataPath('_snapshots', name, 'data', 'stray.json'), 'x');
    const dest = scratch();
    await copySnapshot(name, dest);
    expect(fs.existsSync(path.join(dest, 'stray.json'))).toBe(false);
    expect(await verifyTree(dest, manifest)).toEqual({ ok: true });
  });

  it('throws naming the file when a listed file is gone from the snapshot', async () => {
    const { name } = snapshot(sample());
    fs.rmSync(dataPath('_snapshots', name, 'data', 'global/premium/p.json'));
    const dest = scratch();
    let caught: any = null;
    await copySnapshot(name, dest).catch(e => { caught = e; });
    expect(caught?.code).toBe('ENOENT');
    expect(String(caught?.message)).toContain('p.json');
  });

  it('throws for a damaged snapshot and copies nothing', async () => {
    const { name } = snapshot(sample());
    fs.writeFileSync(dataPath('_snapshots', name, 'manifest.json'), '{');
    const dest = scratch();
    let caught: unknown = null;
    await copySnapshot(name, dest).catch(e => { caught = e; });
    expect(String(caught)).toContain('not valid JSON');
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('stops at the next file once its signal is aborted', async () => {
    const { name } = snapshot(sample());
    const dest = scratch();
    const ac = new AbortController();
    ac.abort();
    let caught: any = null;
    await copySnapshot(name, dest, { signal: ac.signal }).catch(e => { caught = e; });
    expect(caught?.name).toBe('AbortError');
    expect(fs.existsSync(path.join(dest, '123/mod/a.json'))).toBe(false);
  });
});

describe('verifyTree', () => {
  const top = fc.constantFrom('123', '456', '_graveyard', 'global');
  const seg = fc.constantFrom('mod', 'x', 'sub');
  const folder = fc.tuple(top, fc.array(seg, { minLength: 0, maxLength: 2 })).map(([t, d]) => [t, ...d].join('/'));
  const fileName = fc.constantFrom('a.json', 'b.json', 'c.jsonl', '.graveyard.json');
  const filePath = fc.tuple(folder, fileName).map(([d, f]) => `${d}/${f}`);
  const tree = fc
    .record({
      files: fc.dictionary(filePath, fc.uint8Array({ minLength: 0, maxLength: 40 }).map(a => Buffer.from(a)), { minKeys: 1, maxKeys: 8 }),
      empty: fc.array(folder, { maxLength: 3 }),
    })
    .map(({ files, empty }) => ({ files, dirs: empty.map(d => `${d}/e`) }));

  type Change = 'content' | 'size' | 'missing file' | 'missing folder' | 'extra file' | 'extra folder';
  const change = fc.constantFrom<Change>('content', 'size', 'missing file', 'missing folder', 'extra file', 'extra folder');

  /** Makes one change in the copy and answers the difference it must give, or null when the tree has no place for it. */
  function apply(dest: string, m: Manifest, kind: Change, pick: number): { path: string; reason: string } | null {
    const at = <T>(list: T[]) => list[pick % list.length];
    if (kind === 'content') {
      const f = m.files.filter(x => x.size > 0);
      if (!f.length) return null;
      const one = at(f);
      const b = fs.readFileSync(path.join(dest, one.path));
      b[pick % b.length] ^= 0xff;
      fs.writeFileSync(path.join(dest, one.path), b);
      return { path: one.path, reason: 'content' };
    }
    if (kind === 'size') {
      const one = at(m.files);
      fs.appendFileSync(path.join(dest, one.path), 'z');
      return { path: one.path, reason: 'size' };
    }
    if (kind === 'missing file') {
      const one = at(m.files);
      fs.rmSync(path.join(dest, one.path));
      return { path: one.path, reason: 'missing' };
    }
    if (kind === 'missing folder') {
      const leaves = m.dirs.filter(d => !m.dirs.some(o => o.startsWith(d + '/')) && !m.files.some(f => f.path.startsWith(d + '/')));
      if (!leaves.length) return null;
      const one = at(leaves);
      fs.rmdirSync(path.join(dest, one));
      return { path: one, reason: 'missing' };
    }
    const parents = ['', ...m.dirs];
    const parent = at(parents);
    const rel = parent ? `${parent}/zz-extra` : 'zz-extra';
    if (kind === 'extra file') fs.writeFileSync(path.join(dest, rel), 'x');
    else fs.mkdirSync(path.join(dest, rel));
    return { path: rel, reason: 'extra' };
  }

  it('property: an exact copy passes; one change fails with its path and reason', async () => {
    await fc.assert(
      fc.asyncProperty(tree, change, fc.nat(1000), async (t, kind, pick) => {
        const { name, manifest } = snapshot(t);
        const dest = scratch();
        await copySnapshot(name, dest);
        expect(await verifyTree(dest, manifest)).toEqual({ ok: true });
        const want = apply(dest, manifest, kind, pick);
        if (!want) return;
        expect(await verifyTree(dest, manifest)).toEqual({ ok: false, count: 1, differences: [want], counts: [] });
      }),
      { numRuns: 40 },
    );
  });

  it(`lists at most ${VERIFY_LIST_MAX} differences, sorted by path, and counts them all`, async () => {
    const { name, manifest } = snapshot(sample());
    const dest = scratch();
    await copySnapshot(name, dest);
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dest, `extra-${String(i).padStart(2, '0')}`), 'x');
    const answer = await verifyTree(dest, manifest);
    expect(VERIFY_LIST_MAX).toBe(20);
    expect(answer).toMatchObject({ ok: false, count: 25 });
    const listed = (answer as { differences: Array<{ path: string }> }).differences;
    expect(listed).toHaveLength(20);
    expect(listed[0]).toEqual({ path: 'extra-00', reason: 'extra' });
    expect(listed.map(d => d.path)).toEqual([...listed.map(d => d.path)].sort());
  });

  it('an extra folder is one difference, whatever it holds', async () => {
    const { name, manifest } = snapshot(sample());
    const dest = scratch();
    await copySnapshot(name, dest);
    fs.mkdirSync(path.join(dest, '999', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dest, '999', 'deep', 'f.json'), '{}');
    expect(await verifyTree(dest, manifest)).toEqual({ ok: false, count: 1, differences: [{ path: '999', reason: 'extra' }], counts: [] });
  });

  it('a folder where the manifest lists a file is that file missing', async () => {
    const { name, manifest } = snapshot(sample());
    const dest = scratch();
    await copySnapshot(name, dest);
    fs.rmSync(path.join(dest, '123/mod/b.json'));
    fs.mkdirSync(path.join(dest, '123/mod/b.json'));
    expect(await verifyTree(dest, manifest)).toEqual({ ok: false, count: 1, differences: [{ path: '123/mod/b.json', reason: 'missing' }], counts: [] });
  });

  it('a count the manifest records wrongly fails with the recorded and the found count', async () => {
    const { name, manifest } = snapshot(sample());
    const dest = scratch();
    await copySnapshot(name, dest);
    const wrong = { ...manifest, counts: { ...manifest.counts, guilds: manifest.counts.guilds + 1 } };
    expect(manifest.counts).toEqual({ files: 5, bytes: 28, dirs: 9, guilds: 2, graveyardEntries: 1 });
    expect(await verifyTree(dest, wrong)).toEqual({
      ok: false,
      count: 0,
      differences: [],
      counts: [{ key: 'guilds', recorded: 3, found: 2 }],
    });
  });

  // The fix 11b ruling on decision 3: the text for a mismatch in the counts alone.
  const HEAD = 'The copy differs from what was recorded when the backup was taken:';
  it.each([
    ['files', 'files'],
    ['bytes', 'bytes'],
    ['dirs', 'folders'],
    ['guilds', 'guild folders'],
    ['graveyardEntries', 'graveyard entries'],
  ] as const)('the counts text for %s alone names the number of %s', async (key, words) => {
    const { name, manifest } = snapshot(sample());
    const dest = scratch();
    await copySnapshot(name, dest);
    const wrong = { ...manifest, counts: { ...manifest.counts, [key]: manifest.counts[key] + 3 } };
    const answer = await verifyTree(dest, wrong);
    expect(answer.ok).toBe(false);
    const counts = answer.ok ? [] : answer.counts;
    expect(verify.countsDifferText(counts)).toBe(`${HEAD} 1 count differs, first the number of ${words} (${manifest.counts[key]} found, ${manifest.counts[key] + 3} recorded).`);
  });

  it('the counts text for two counts names how many differ and the first in its order', async () => {
    const { name, manifest } = snapshot(sample());
    const dest = scratch();
    await copySnapshot(name, dest);
    const wrong = { ...manifest, counts: { ...manifest.counts, bytes: 30, graveyardEntries: 0 } };
    const answer = await verifyTree(dest, wrong);
    const counts = answer.ok ? [] : answer.counts;
    const text = `${HEAD} 2 counts differ, first the number of bytes (28 found, 30 recorded).`;
    expect(verify.countsDifferText(counts)).toBe(text);
    expect(verify.countsDifferText([...counts].reverse())).toBe(text);
  });

  it('an absent root is every listed entry missing', async () => {
    const { manifest } = snapshot(sample());
    const answer = await verifyTree(path.join(scratch(), 'nowhere'), manifest);
    expect(answer).toMatchObject({ ok: false, count: manifest.files.length + manifest.dirs.length });
  });
});

describe('fsyncDirs', () => {
  it.skipIf(POSIX)('on Windows answers no failure and opens no folder', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    expect(await fsyncDirs([dataPath(), dataPath('nowhere')])).toEqual({ failed: false });
    expect(open).not.toHaveBeenCalled();
  });

  describe.skipIf(!POSIX)('POSIX', () => {
    function folders(): string[] {
      const base = dataPath(`fsd-${Date.now()}-${made.length}`);
      made.push(base);
      const list = ['a', 'b', 'c'].map(n => path.join(base, n));
      for (const p of list) fs.mkdirSync(p, { recursive: true });
      return list;
    }

    it('N: with the flag set answers earlier with its folder and errno and opens nothing', async () => {
      const [a, b] = folders();
      noteFolderSyncFailure('/data/123', 'EIO');
      const open = vi.spyOn(fs.promises, 'open');
      const answer = await fsyncDirs([a, b]);
      expect(answer).toMatchObject({ failed: true, kind: 'earlier', dir: '/data/123', errno: 'EIO' });
      expect(open).not.toHaveBeenCalled();
    });

    it('N: ENOENT on the second path answers open, sets no flag and does not open the third', async () => {
      const [a, b, c] = folders();
      fs.rmdirSync(b);
      const opened: string[] = [];
      const real = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
        opened.push(String(p));
        return real(p, ...rest);
      });
      const answer = await fsyncDirs([a, b, c]);
      expect(answer).toMatchObject({ failed: true, kind: 'open', dir: b, errno: 'ENOENT' });
      expect(folderSyncFailed()).toBe(false);
      expect(opened).toEqual([a, b]);
    });

    it('opens one folder at a time, in the order given, and answers no failure', async () => {
      const [a, b, c] = folders();
      const events: string[] = [];
      const real = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
        const handle = await real(p, ...rest);
        events.push(`open ${path.basename(String(p))}`);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          events.push(`close ${path.basename(String(p))}`);
          return close();
        };
        return handle;
      });
      expect(await fsyncDirs([c, a, b])).toEqual({ failed: false });
      expect(events).toEqual(['open c', 'close c', 'open a', 'close a', 'open b', 'close b']);
    });

    it('a sync error answers sync with that folder, sets the flag and stops', async () => {
      const [a, b, c] = folders();
      const opened: string[] = [];
      const real = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
        const handle = await real(p, ...rest);
        opened.push(String(p));
        if (String(p) === b) handle.sync = async () => { throw Object.assign(new Error('io'), { code: 'EIO' }); };
        return handle;
      });
      const answer = await fsyncDirs([a, b, c]);
      expect(answer).toMatchObject({ failed: true, kind: 'sync', dir: b, errno: 'EIO' });
      expect(folderSyncFailed()).toBe(true);
      expect(opened).toEqual([a, b]);
    });
  });
});

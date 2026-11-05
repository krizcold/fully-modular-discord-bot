import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  dropPendingForGuild,
  enqueueDelete,
  enqueueWrite,
  flushAll,
  guildKeyStored,
  noteGuildDelete,
  noteGuildWrite,
  placeGuildWrite,
  setGuildViewCache,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { useDisk } from '../helpers/caseInsensitiveDisk';
import { REAL_FS } from '../helpers/forwardingFs';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

// NB12 item 2 (wip-redesign/sheets/NB12.md), rule P on the file route: the disk check of a refusal, the removal of a
// folder that holds no key with the temp files no write owns, and what the bot process's view lists.

const real = (fs as any)[REAL_FS] as typeof fs;
let guilds = 9_412_000_000;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
  setGuildViewCache(false);
});

function guild(cache: boolean, files: Record<string, string> = {}, dirs: string[] = []) {
  setGuildViewCache(cache);
  const g = String(++guilds);
  const p = (rel = '') => (rel ? dataPath(g, ...rel.split('/')) : dataPath(g));
  fs.mkdirSync(p(), { recursive: true });
  for (const d of dirs) fs.mkdirSync(p(d), { recursive: true });
  for (const [key, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(p(key)), { recursive: true });
    fs.writeFileSync(p(key), text);
  }
  return { g, p };
}

/** The folders under root the code lists from now on, relative ('' for root), and its lstat count there. */
function counting(root: string) {
  const disk = useDisk('case-sensitive', dataPath());
  return {
    reset: () => disk.reset(),
    listed: () => (disk.calls.get('readdirSync') ?? []).filter(x => x === root || x.startsWith(root + path.sep)).map(x => path.relative(root, x).split(path.sep).join('/')),
    lstats: () => disk.count('lstatSync', root),
  };
}

const holdsNoData = (folder: string) => ({ ok: false, cause: 'io', reason: `the folder ${folder} holds no data but could not be removed` });
const caseOf = (other: string) => ({ ok: false, cause: 'unstorable', reason: `it differs only in letter case from ${other}` });

function ageMs(file: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(file, t, t);
}

describe('a refusal on a cached view is checked against the disk', () => {
  it('a write beside a key whose delete is queued answers io naming the delete, never unstorable', () => {
    const { g, p } = guild(true, { 'm/A.json': '{}' });
    expect(guildKeyStored(g, 'm/A.json')).toBe(true);
    enqueueDelete(p('m/A.json'));
    expect(placeGuildWrite(g, 'm/a.json')).toEqual({ ok: false, cause: 'io', reason: 'a delete of m/A.json is still being written' });
  });

  it('a refusal for a file on disk lists only the colliding entry\'s folder', () => {
    const { g, p } = guild(true, { 'x/A.json': '{}' });
    expect(guildKeyStored(g, 'x/A.json')).toBe(true);
    const c = counting(p());
    expect(placeGuildWrite(g, 'x/a.json')).toEqual(caseOf('x/A.json'));
    expect(c.listed()).toEqual(['x']);
  });

  it('a refusal for a key queued as a write here lists nothing', () => {
    const { g, p } = guild(true);
    enqueueWrite(p('x/A.json'), '{}');
    expect(guildKeyStored(g, 'x/A.json')).toBe(true);
    const c = counting(p());
    expect(placeGuildWrite(g, 'x/a.json')).toEqual(caseOf('x/A.json'));
    expect(c.listed()).toEqual([]);
  });

  it('a refusal for a folder on disk lists its parent once, whatever op is queued at the folder\'s path', () => {
    const { g, p } = guild(true, { 'm/A/x.json': '{}' });
    expect(guildKeyStored(g, 'm/A/x.json')).toBe(true);
    enqueueDelete(p('m/A'));
    const c = counting(p());
    try {
      expect(placeGuildWrite(g, 'm/a')).toEqual(caseOf('m/A'));
      expect(c.listed()).toEqual(['m/A', 'm']);
    } finally {
      dropPendingForGuild(g);
    }
    expect(fs.existsSync(p('m/A/x.json'))).toBe(true);
  });

  it('a colliding key whose folder another process removed is no refusal', () => {
    const { g, p } = guild(true, { 'x/A.json': '{}' });
    expect(guildKeyStored(g, 'x/A.json')).toBe(true);
    real.rmSync(p('x'), { recursive: true });
    expect(placeGuildWrite(g, 'x/a.json')).toEqual({ ok: true });
  });

  it('a file the view holds that is now an empty folder on disk is no refusal', () => {
    const { g, p } = guild(true, { 'x/A': '{}' });
    expect(guildKeyStored(g, 'x/A')).toBe(true);
    real.unlinkSync(p('x/A'));
    real.mkdirSync(p('x/A'));
    expect(placeGuildWrite(g, 'x/A/y.json')).toEqual({ ok: true });
  });
});

describe('a folder in the way that holds no key', () => {
  it('a temp file whose name only holds this pid before another .tmp is not this process\'s, and blocks', () => {
    const { g, p } = guild(false, { [`A/k.${process.pid}.1.tmp.tmp`]: '' });
    expect(placeGuildWrite(g, 'a')).toEqual(holdsNoData('A'));
    expect(fs.existsSync(p(`A/k.${process.pid}.1.tmp.tmp`))).toBe(true);
  });

  it('this process\'s closed temp file is deleted with the folder, and the write is accepted', () => {
    const { g, p } = guild(false, { [`A/w.${process.pid}.7.tmp`]: '' });
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: true });
    expect(fs.existsSync(p('A'))).toBe(false);
  });

  it('another process\'s temp file blocks until it is more than an hour old', () => {
    const { g, p } = guild(false, { 'A/w.tmp': '' });
    const t = Math.floor(Date.now() / 1000) * 1000 - 7_200_000;
    fs.utimesSync(p('A/w.tmp'), t / 1000, t / 1000);
    expect(fs.statSync(p('A/w.tmp')).mtimeMs).toBe(t);
    const now = vi.spyOn(Date, 'now').mockReturnValue(t + 3_600_000);
    expect(placeGuildWrite(g, 'a')).toEqual(holdsNoData('A'));
    expect(fs.existsSync(p('A/w.tmp'))).toBe(true);
    now.mockReturnValue(t + 3_600_001);
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: true });
    expect(fs.existsSync(p('A'))).toBe(false);
  });

  it('a temp file whose stat fails counts as removable', () => {
    const { g, p } = guild(false, { 'A/w.tmp': '' });
    const target = path.resolve(p('A/w.tmp'));
    vi.spyOn(fs, 'statSync').mockImplementation(((q: any, ...rest: any[]) => {
      if (path.resolve(String(q)) === target) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return (real.statSync as any)(q, ...rest);
    }) as any);
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: true });
    expect(fs.existsSync(p('A'))).toBe(false);
  });

  it('a file that is no temp file stays, even an old one with a delete queued', () => {
    const { g, p } = guild(false, { 'a/x.json': '{}' });
    ageMs(p('a/x.json'), 7_200_000);
    enqueueDelete(p('a/x.json'));
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: false, cause: 'io', reason: 'a delete of a/x.json is still being written' });
    expect(fs.existsSync(p('a/x.json'))).toBe(true);
  });

  it('a folder whose listing fails with ENOTDIR at the removal stays and blocks', () => {
    const { g, p } = guild(false, {}, ['A']);
    const target = path.resolve(p('A'));
    vi.spyOn(fs, 'readdirSync').mockImplementation(((q: any, ...rest: any[]) => {
      if (path.resolve(String(q)) === target) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
      return (real.readdirSync as any)(q, ...rest);
    }) as any);
    expect(placeGuildWrite(g, 'a')).toEqual(holdsNoData('A'));
    expect(real.existsSync(p('A'))).toBe(true);
  });

  it('a folder that vanished before its removal counts as removed, with no further listing', () => {
    const { g, p } = guild(false, {}, ['A']);
    const root = path.resolve(p());
    const target = path.resolve(p('A'));
    const calls: string[] = [];
    let first = true;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((q: any, ...rest: any[]) => {
      const abs = path.resolve(String(q));
      if (abs === root || abs.startsWith(root + path.sep)) calls.push(path.relative(root, abs).split(path.sep).join('/'));
      const out = (real.readdirSync as any)(q, ...rest);
      if (abs === target && first) {
        first = false;
        real.rmdirSync(target);
      }
      return out;
    }) as any);
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: true });
    expect(calls).toEqual(['', 'A', 'A']);
  });

  it('a removed folder is not tried again', () => {
    const { g, p } = guild(false, {}, ['A']);
    const c = counting(p());
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: true });
    expect(c.listed()).toEqual(['', 'A', 'A']);
    expect(fs.existsSync(p('A'))).toBe(false);
  });

  it('a removal that fails twice and then lands is accepted on the second read', () => {
    const { g, p } = guild(false, {}, ['A']);
    const target = path.resolve(p('A'));
    let failures = 0;
    vi.spyOn(fs, 'rmdirSync').mockImplementation(((q: any, ...rest: any[]) => {
      if (path.resolve(String(q)) === target && failures < 2) {
        failures += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return (real.rmdirSync as any)(q, ...rest);
    }) as any);
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: true });
    expect(failures).toBe(2);
    expect(fs.existsSync(p('A'))).toBe(false);
  });
});

describe('the bot process\'s view after a folder removal', () => {
  it('a folder removed by the write lists no other folder, and its listing is dropped with every listing below it', () => {
    const { g, p } = guild(true, { 'A/s/w.tmp': '' });
    expect(placeGuildWrite(g, 'a')).toEqual(holdsNoData('A'));
    real.unlinkSync(p('A/s/w.tmp'));
    const c = counting(p());
    expect(placeGuildWrite(g, 'a')).toEqual({ ok: true });
    expect(c.listed()).toEqual(['A', 'A/s']);
    expect(fs.existsSync(p('A'))).toBe(false);

    noteGuildWrite(g, 'A/s/k.json');
    real.mkdirSync(p('A/s'), { recursive: true });
    c.reset();
    expect(placeGuildWrite(g, 'A/s/q.json')).toEqual({ ok: true });
    expect(c.listed()).toEqual(['A', 'A/s']);
  });

  it('a folder a delete emptied is forgotten alone: its parents stay listed, and it is listed again once written', async () => {
    const { g, p } = guild(true, { 'm/a/x.json': '{}', 'm/keep.json': '{}' });
    expect(guildKeyStored(g, 'm/a/x.json')).toBe(true);
    enqueueDelete(p('m/a/x.json'));
    noteGuildDelete(g, 'm/a/x.json');
    await flushAll();
    expect(fs.existsSync(p('m/a'))).toBe(false);
    expect(fs.existsSync(p('m/keep.json'))).toBe(true);

    const c = counting(p());
    expect(placeGuildWrite(g, 'm/z.json')).toEqual({ ok: true });
    expect(c.listed()).toEqual([]);

    noteGuildWrite(g, 'm/a/b.json');
    c.reset();
    expect(placeGuildWrite(g, 'm/a/c.json')).toEqual({ ok: true });
    expect(c.listed()).toEqual(['m/a']);
  });

  it('a folder a delete emptied and another process made again is seen, so a write of its name is refused', async () => {
    const { g, p } = guild(true, { 'm/a/x.json': '{}', 'm/keep.json': '{}' });
    expect(guildKeyStored(g, 'm/a/x.json')).toBe(true);
    enqueueDelete(p('m/a/x.json'));
    noteGuildDelete(g, 'm/a/x.json');
    await flushAll();
    expect(fs.existsSync(p('m/a'))).toBe(false);
    real.mkdirSync(p('m/a'));
    real.writeFileSync(p('m/a/k.json'), '{}');
    expect(placeGuildWrite(g, 'm/a')).toEqual({ ok: false, cause: 'unstorable', reason: 'm/a names a folder that holds other keys' });
    expect(fs.existsSync(p('m/a/k.json'))).toBe(true);
  });

  it('a path whose folder is gone from disk lists nothing, even with an old listing of that folder', () => {
    const { g, p } = guild(true, { 'x/y/Z/w.json': '{}', 'x/y/keep.json': '{}', 'x/q0.json': '{}' });
    expect(guildKeyStored(g, 'x/y/keep.json')).toBe(true);
    real.rmSync(p('x/y'), { recursive: true });
    real.writeFileSync(p('x/q.json'), '{}');
    expect(guildKeyStored(g, 'x/q.json')).toBe(true);
    const c = counting(p());
    expect(placeGuildWrite(g, 'x/y/z')).toEqual({ ok: true });
    expect(c.listed()).toEqual([]);
  });

  it('a folder an accepted write makes is recorded, so the next key in it lists that folder', () => {
    const { g, p } = guild(true, { 'keep/k.json': '{}' });
    expect(guildKeyStored(g, 'keep/k.json')).toBe(true);
    noteGuildWrite(g, 'n/b.json');
    const c = counting(p());
    expect(placeGuildWrite(g, 'n/c.json')).toEqual({ ok: true });
    expect(c.listed()).toEqual(['n']);
  });
});

describe('a delete\'s test of a stored key', () => {
  it('a key the view holds answers stored with no lstat', () => {
    const { g, p } = guild(true, { 'm/k.json': '{}' });
    const c = counting(p());
    expect(guildKeyStored(g, 'm/k.json')).toBe(true);
    expect(c.lstats()).toBe(0);
  });

  it('a key another process wrote after the view was read answers stored', () => {
    const { g, p } = guild(true, { 'm/k.json': '{}' });
    expect(guildKeyStored(g, 'm/k.json')).toBe(true);
    real.writeFileSync(p('m/new.json'), '{}');
    expect(guildKeyStored(g, 'm/new.json')).toBe(true);
    expect(guildKeyStored(g, 'm/other.json')).toBe(false);
  });
});

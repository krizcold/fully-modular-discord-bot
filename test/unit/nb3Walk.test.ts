import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotFromPgRows, walkJsonSource } from '../../src/bot/internalSetup/utils/dataMigration';
import { cleanOrphanTmpFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { root, seedFile, wipeRoot } from '../helpers/migrationRig';

// NB3 decisions 7 and 12: the strict walk of a JSON source.

const G = '555555555555555555';

beforeEach(() => wipeRoot());
afterEach(() => vi.restoreAllMocks());

const key = (i: { guildId: string; module: string; filename: string; retiredAt?: number }) =>
  `${i.guildId}${i.retiredAt === undefined ? '' : `-${i.retiredAt}`}|${i.module}|${i.filename}`;

describe('the walk', () => {
  it('copies documents and append files under their canonical keys, and keeps their bytes', async () => {
    seedFile(`${G}/top.json`, '{"t":1}');
    seedFile(`${G}/mod/a.json`, '﻿{"a":1}\r\n');
    seedFile(`${G}/mod/sub/b.jsonl`, 'line1\nline2\n');
    seedFile(`${G}/mod/empty.json`, '');
    const snap = await walkJsonSource(root);
    expect(snap.items.map(key).sort()).toEqual([`${G}||top.json`, `${G}|mod|a.json`, `${G}|mod|empty.json`, `${G}|mod|sub/b.jsonl`].sort());
    const a = snap.items.find(i => i.filename === 'a.json')!;
    expect(a.bytes.equals(Buffer.from('﻿{"a":1}\r\n', 'utf8'))).toBe(true);
    expect(snap.items.find(i => i.filename === 'sub/b.jsonl')!.kind).toBe('append');
    expect(snap.guilds).toEqual([G]);
  });

  it('fails on an unreadable file, naming the path', async () => {
    seedFile(`${G}/mod/locked.json`, '{}');
    const target = path.join(root, G, 'mod', 'locked.json');
    const real = fs.promises.readFile;
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(target)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as any)(p, ...rest);
    }) as any);
    await expect(walkJsonSource(root)).rejects.toThrow(target);
  });

  it('fails on an unreadable folder, naming the path', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    const target = path.join(root, G, 'mod');
    const real = fs.promises.readdir;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(target)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as any)(p, ...rest);
    }) as any);
    await expect(walkJsonSource(root)).rejects.toThrow(target);
  });

  it('fails on a name that is not valid UTF-8, naming the folder', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    const folder = path.join(root, G, 'mod');
    const real = fs.promises.readdir;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(folder)) return [Buffer.from([0x61, 0xff, 0x2e, 0x6a])];
      return (real as any)(p, ...rest);
    }) as any);
    await expect(walkJsonSource(root)).rejects.toThrow(/not valid UTF-8/);
  });

  it('fails on an entry that is neither a regular file nor a folder', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    const odd = path.join(root, G, 'mod', 'a.json');
    const real = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: any, ...rest: any[]) => {
      const st = await (real as any)(p, ...rest);
      if (path.resolve(String(p)) === path.resolve(odd)) return { ...st, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
      return st;
    }) as any);
    await expect(walkJsonSource(root)).rejects.toThrow(/neither a regular file nor a folder/);
  });

  it('fails on a file whose content is not valid UTF-8, and on U+0000, naming the file', async () => {
    seedFile(`${G}/mod/bad.json`, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
    await expect(walkJsonSource(root)).rejects.toThrow(path.join(root, G, 'mod', 'bad.json'));
    wipeRoot();
    seedFile(`${G}/mod/nul.json`, '{"a":"\u0000"}');
    await expect(walkJsonSource(root)).rejects.toThrow(/U\+0000/);
  });

  it('leaves out and lists .tmp files, a folder name past bigint, a note-only graveyard entry, a bad graveyard child and empty folders', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    seedFile(`${G}/mod/a.json.123.tmp`, 'partial');
    seedFile('99999999999999999999999/mod/x.json', '{}');
    seedFile(`_graveyard/${G}-1700000000000/.graveyard.json`, JSON.stringify({ guildId: G, reason: 'r', ts: 1 }));
    seedFile('_graveyard/not-a-guild/x.json', '{}');
    fs.mkdirSync(path.join(root, G, 'emptyFolder'), { recursive: true });
    fs.mkdirSync(path.join(root, '666666666666666666'), { recursive: true });
    const snap = await walkJsonSource(root);
    expect(snap.items.map(key)).toEqual([`${G}|mod|a.json`]);
    const listed = snap.leftOut.join('\n');
    for (const p of [
      path.join(G, 'mod', 'a.json.123.tmp'), '99999999999999999999999', `${G}-1700000000000`, 'not-a-guild',
      path.join(G, 'emptyFolder'), '666666666666666666',
    ]) expect(listed).toContain(p);
    expect(snap.guilds).toEqual([G]);
  });

  it('copies a graveyard folder with its note and one without (reason ""), retired_at from the folder name', async () => {
    seedFile(`_graveyard/${G}-1700000000001/.graveyard.json`, JSON.stringify({ guildId: G, reason: 'left', ts: 5 }));
    seedFile(`_graveyard/${G}-1700000000001/mod/a.json`, '{"a":1}');
    seedFile(`_graveyard/${G}-1700000000002/mod/b.jsonl`, 'x\n');
    const snap = await walkJsonSource(root);
    expect(snap.graves.sort((a, b) => a.retiredAt - b.retiredAt)).toEqual([
      { guildId: G, retiredAt: 1700000000001, reason: 'left' },
      { guildId: G, retiredAt: 1700000000002, reason: '' },
    ]);
    expect(snap.items.map(key).sort()).toEqual([`${G}-1700000000001|mod|a.json`, `${G}-1700000000002|mod|b.jsonl`]);
    expect(snap.items.every(i => i.grave)).toBe(true);
  });
});

describe('a Postgres source', () => {
  it('a graveyard document named .graveyard.json at a guild root fails a move to JSON, named', () => {
    expect(() => snapshotFromPgRows([], [], [
      { guild_id: G, module: '', filename: '.graveyard.json', kind: 'doc', doc: '{}', retired_at: '17', reason: 'r' },
    ])).toThrow(/\.graveyard\.json/);
  });
});

describe('cleanOrphanTmpFiles', () => {
  it('skips _superseded and .migrate-* folders', async () => {
    const old = Date.now() / 1000 - 7200;
    for (const rel of ['_superseded/20261029T012345678Z-job-xxxxxxxx/a.tmp', '.migrate-1/a.tmp', `${G}/b.tmp`]) {
      seedFile(rel, 'x');
      fs.utimesSync(path.join(root, ...rel.split('/')), old, old);
    }
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await cleanOrphanTmpFiles(root);
    expect(fs.existsSync(path.join(root, '_superseded/20261029T012345678Z-job-xxxxxxxx/a.tmp'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.migrate-1/a.tmp'))).toBe(true);
    expect(fs.existsSync(path.join(root, G, 'b.tmp'))).toBe(false);
  });
});

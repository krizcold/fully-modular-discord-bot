import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyRefusal, KeyTree } from '../../src/bot/internalSetup/utils/storableData';
import { hashNamespaceAt, importBundle, namespaceHashOf, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { canonicalGuildKey } from '../../src/bot/internalSetup/utils/dataKeys';
import { flushAll, saveData, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { caseSensitiveWhereAllowed } from '../helpers/caseInsensitiveDisk';

// NB12 item 6 (wip-redesign/sheets/NB12.md, decision 17): a bundle import refuses a record the bot could not store
// before it touches the live guild folder, and an export refuses what its import would refuse.

let guilds = 9_400_000_000;
const freshGuild = () => String(++guilds);
let n = 0;
const bundleFile = () => path.join(DATA_ROOT, `nb12-${++n}.dbex`);

function buildBundle(guildId: string, records: Array<[string, Buffer]>): string {
  const parts: Buffer[] = [Buffer.from('DBEX1\n')];
  const files: { relPath: string; size: number; sha256: string }[] = [];
  for (const [relPath, bytes] of records) {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const header = Buffer.from(JSON.stringify({ g: guildId, p: relPath, s: bytes.length, h: sha256 }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length, 0);
    parts.push(len, header, bytes);
    files.push({ relPath, size: bytes.length, sha256 });
  }
  parts.push(Buffer.alloc(4), Buffer.from(JSON.stringify({ t: 'summary', ...namespaceHashOf(files) })));
  const file = bundleFile();
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(dir, child), 'hex');
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out;
}

const foldsCase = caseSensitiveWhereAllowed(DATA_ROOT);
const stagingLeft = () => fs.readdirSync(DATA_ROOT).filter(name => name.startsWith('.bundle-import-'));
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('bundle import refuses a record the bot could not store', () => {
  it.each([
    ['a 0x00 byte', [['m/a.jsonl', Buffer.from([0x61, 0x00, 0x0a])]], 'm/a.jsonl'],
    ['bytes that are not UTF-8', [['m/a.json', Buffer.from([0xc3, 0x28])]], 'm/a.json'],
    ['m/x.tmp', [['m/x.tmp', json(1)]], 'm/x.tmp'],
    ['cache.tmp/x.json', [['cache.tmp/x.json', json(1)]], 'cache.tmp/x.json'],
    ['.graveyard.json at the root', [['.graveyard.json', json(1)]], '.graveyard.json'],
    ['.Graveyard.json at the root', [['.Graveyard.json', json(1)]], '.Graveyard.json'],
    ['a 201-byte part', [[`m/${'a'.repeat(201)}`, json(1)]], `m/${'a'.repeat(201)}`],
    ['U+0000 in a name', [['m/a\u0000.json', json(1)]], 'm/a\u0000.json'],
    ['":" in a name', [['m/a:b.json', json(1)]], 'm/a:b.json'],
    ['a file and a folder of one name', [['m/a', json(1)], ['m/a/x.json', json(2)]], 'm/a/x.json'],
    ['two names differing in letter case', [['m/a.json', json(1)], ['m/A.json', json(2)]], 'm/A.json'],
    ['two names only the wider fold merges', [['w/kir.json', json(1)], ['w/k\u0131r.json', json(2)]], 'w/k\u0131r.json'],
  ] as Array<[string, Array<[string, Buffer]>, string]>)('%s: the import throws naming it, the live folder unchanged', async (_label, records, named) => {
    const guildId = freshGuild();
    const live = dataPath(guildId);
    fs.mkdirSync(path.join(live, 'keep'), { recursive: true });
    fs.writeFileSync(path.join(live, 'keep', 'v.json'), '{"v":1}');
    const before = snapshot(live);
    const file = buildBundle(guildId, records);
    // On Windows the path guard refuses a name holding ':' first, as a drive-relative path.
    const windowsGuard = process.platform === 'win32' && named.includes(':');
    await expect(importBundle(file)).rejects.toThrow(windowsGuard ? `Rejected out-of-scope relPath for ${guildId}: ${named}` : `[DataInterchange] ${guildId}/${named}: `);
    await expect(importBundle(file)).rejects.toThrow('the live guild dir was not touched');
    expect(snapshot(live)).toEqual(before);
    expect(stagingLeft()).toEqual([]);
  });

  it('imports a BOM file and CRLF text unchanged (a guard)', async () => {
    const guildId = freshGuild();
    const bom = Buffer.from('\uFEFF{"a":1}\r\n', 'utf8');
    await importBundle(buildBundle(guildId, [['m/a.json', bom]]));
    expect(fs.readFileSync(dataPath(guildId, 'm', 'a.json'))).toEqual(bom);
  });

  it('a guild written through the facade exports and imports with every key and the same bytes', async () => {
    const guildId = freshGuild();
    const keys = ['m/a.json', 'm/sub/b.json', 'root.json', 'x/y/z/deep.json', 'w/kir.json', 'cachetmp/v.json'];
    for (const [i, key] of keys.entries()) expect(saveData(key, { guildId }, { i, s: '\u0000\uD800' })).toBe(true);
    await flushAll();
    const before = snapshot(dataPath(guildId));
    const file = bundleFile();
    await writeBundle(guildId, file);
    fs.rmSync(dataPath(guildId), { recursive: true });
    await importBundle(file);
    expect(snapshot(dataPath(guildId))).toEqual(before);
  });
});

describe('a generated round trip', () => {
  it('a guild written through the facade with generated keys exports and imports with every key and the same bytes', async () => {
    const part = fc.oneof(
      fc.constantFrom('m', 'users', 'Bob', 'k\u0131r', 'cache', 'x.json', 'a.jsonl', '\u20AC', 'tmp', 'log'),
      fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 6 }),
    );
    const key = fc.array(part, { minLength: 1, maxLength: 3 }).map(p => p.join('/'));
    await fc.assert(fc.asyncProperty(fc.uniqueArray(key, { minLength: 1, maxLength: 8 }), async keys => {
      const guildId = freshGuild();
      const tree = new KeyTree();
      let written = 0;
      for (const k of keys) {
        if (k.endsWith('.jsonl')) continue;
        const answer = saveDataTracked(k, { guildId }, { k, s: '\u0000\uD800' });
        if (answer.outcome !== 'saved') {
          expect(answer).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
          continue;
        }
        // The facade stores NB3's canonical key ('./m' is 'm'), and the rules judge that key.
        const c = canonicalGuildKey('', k);
        const stored = c.module ? `${c.module}/${c.filename}` : c.filename;
        expect(keyRefusal(stored, 'save')).toBeNull();
        if (!tree.keys().includes(stored)) {
          expect(tree.check(stored)).toBeNull();
          tree.add(stored);
        }
        written += 1;
      }
      await flushAll();
      if (written === 0) return;
      const before = snapshot(dataPath(guildId));
      const file = bundleFile();
      await writeBundle(guildId, file);
      fs.rmSync(dataPath(guildId), { recursive: true });
      await importBundle(file);
      expect(snapshot(dataPath(guildId))).toEqual(before);
      expect(Object.keys(before).sort()).toEqual(tree.keys().sort());
    }), { numRuns: 30 });
  }, 60_000);
});

describe('bundle export refuses what its import would refuse', () => {
  it.each([
    ['a .tmp folder', { 'cache.tmp/x.json': '{}', 'notes/a.json': '{}' }, ['cache.tmp/x.json: the part "cache.tmp" ends in ".tmp", which marks an interrupted write']],
    ['a 0x00 byte', { 'm/log.jsonl': 'a\u0000\n' }, ['m/log.jsonl: it holds U+0000 at character 1, which the database cannot store']],
  ] as Array<[string, Record<string, string>, string[]]>)('%s: throws naming it, writes no bundle and keeps a previous one', async (_label, files, named) => {
    const guildId = freshGuild();
    for (const [rel, text] of Object.entries(files)) {
      const abs = dataPath(guildId, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    const before = snapshot(dataPath(guildId));
    const file = bundleFile();
    fs.writeFileSync(file, 'previous');
    const error = (await writeBundle(guildId, file).then(() => null, e => e as Error))!;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(new RegExp(`^\\[DataInterchange\\] Guild ${guildId} holds ${named.length} file\\(s\\) a bundle cannot carry: `));
    for (const rel of named) expect(error.message).toContain(rel);
    expect(error.message).toMatch(/move their content to an allowed name or delete them, then export again$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
    expect(snapshot(dataPath(guildId))).toEqual(before);
  });

  async function refusedExport(files: Record<string, string>, named: string[]) {
    const guildId = freshGuild();
    for (const [rel, text] of Object.entries(files)) {
      const abs = dataPath(guildId, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    const before = snapshot(dataPath(guildId));
    const file = bundleFile();
    fs.writeFileSync(file, 'previous');
    const error = (await writeBundle(guildId, file).then(() => null, e => e as Error))!;
    expect(error).toBeInstanceOf(Error);
    for (const rel of named) expect(error.message).toContain(rel);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
    expect(snapshot(dataPath(guildId))).toEqual(before);
  }

  // Windows refuses ':' in a file name even in a case-sensitive folder.
  it.skipIf(process.platform === 'win32')('a reserved character: throws naming it, writes no bundle and keeps a previous one', async () => {
    await refusedExport({ 'notes/a:b.json': '{}' }, ['notes/a:b.json: the part "a:b.json" holds ":"']);
  });

  it.skipIf(foldsCase)("a stored pair 'users/Bob.json' and 'users/bob.json': throws naming the second, so no bundle its import refuses is written", async () => {
    await refusedExport({ 'users/Bob.json': '{"b":1}', 'users/bob.json': '{"b":2}' }, ['users/bob.json: it differs only in letter case from users/Bob.json']);
  });

  it('a .tmp folder holding only a .tmp file exports, the file left out', async () => {
    const guildId = freshGuild();
    fs.mkdirSync(dataPath(guildId, 'cache.tmp'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'cache.tmp', 'x.tmp'), 'partial');
    fs.writeFileSync(dataPath(guildId, 'a.json'), '{}');
    const summary = await writeBundle(guildId, bundleFile());
    expect(summary.fileCount).toBe(1);
  });

  it('the namespace hash counts a file inside a .tmp folder', async () => {
    const guildId = freshGuild();
    fs.mkdirSync(dataPath(guildId, 'a.tmp'), { recursive: true });
    fs.writeFileSync(dataPath(guildId, 'a.tmp', 'x.json'), '{}');
    expect((await hashNamespaceAt(dataPath(guildId))).fileCount).toBe(1);
  });
});

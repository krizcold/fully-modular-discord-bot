import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The modules read the platform once at load: they load here as on Linux, where production runs, whatever runs the test.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import { importBundle, namespaceHashOf, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { FolderSyncError, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

const ROOT = path.resolve(DATA_ROOT);
const GRAVEYARD = path.resolve(dataPath('_graveyard'));
let guilds = 871_100_000_000_000_000n;
const freshGuild = () => String(++guilds);
const errno = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

type Rule = { dir: string; on: 'open' | 'sync'; code: string };
let rules: Rule[] = [];

/** Folders opened through fs.promises.open get a handle whose fsync answers the rules (the host's own folder fsync is not what Linux does). */
function fakeFolders(): void {
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, flags: any, ...rest: any[]) => {
    const at = path.resolve(String(p));
    if ((flags === 'r' || flags === undefined) && isDir(at)) {
      const take = (on: Rule['on']) => {
        const i = rules.findIndex(r => r.dir === at && r.on === on);
        return i < 0 ? null : rules.splice(i, 1)[0].code;
      };
      const opened = take('open');
      if (opened) throw errno(opened);
      return {
        stat: (options?: any) => fs.promises.stat(at, options),
        sync: async () => {
          const code = take('sync');
          if (code) throw errno(code);
        },
        close: async () => {},
      };
    }
    return (open as any)(p, flags, ...rest);
  }) as any);
}

async function bundleOf(g: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    const file = dataPath(g, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa1-bundle-')), 'b.dbex');
  await writeBundle(g, file);
  return file;
}

async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  rules = [];
  setBackendKind('file');
  fs.mkdirSync(GRAVEYARD, { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  fakeFolders();
});
afterEach(() => {
  vi.restoreAllMocks();
  setBackendKind(null);
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('a bundle import whose folder sync after the swap fails', () => {
  it('a failed sync of /data/_graveyard after replacing the live folder throws the sync text and names the previous copy', async () => {
    const g = freshGuild();
    const file = await bundleOf(g, { 'm/a.json': '{"new":1}' });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"live":1}');
    rules.push({ dir: GRAVEYARD, on: 'sync', code: 'EIO' });
    const error = await rejected(() => importBundle(file)) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    const replaced = error.replaced!;
    expect(path.dirname(replaced)).toBe(dataPath('_graveyard'));
    const { why, next } = syncWords('sync', GRAVEYARD, 'EIO');
    expect(error.message).toBe(`Guild ${g} is imported, but ${why}, so can't confirm it is stored. ${next} The previous copy is at ${replaced}.`);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"new":1}');
    expect(fs.readFileSync(path.join(replaced, 'm', 'a.json'), 'utf8')).toBe('{"live":1}');
  });

  it('a /data that cannot be opened for its sync, with no live folder replaced, says to check the guild and names no previous copy', async () => {
    const g = freshGuild();
    const file = await bundleOf(g, { 'm/a.json': '{"new":1}' });
    fs.rmSync(dataPath(g), { recursive: true, force: true });
    rules.push({ dir: ROOT, on: 'open', code: 'EMFILE' });
    const error = await rejected(() => importBundle(file)) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    expect(error.replaced).toBeUndefined();
    const { why } = syncWords('open', ROOT, 'EMFILE');
    expect(error.message).toBe(`Guild ${g} is imported, but ${why}, so can't confirm it is stored. Check the guild's data before you import it again.`);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"new":1}');
  });
});

describe('a bundle that names no guild id', () => {
  it('is refused with the name it carries, before any staging', async () => {
    const bytes = Buffer.from('{"a":1}');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const header = Buffer.from(JSON.stringify({ g: 'abc', p: 'm/a.json', s: bytes.length, h: sha }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length, 0);
    const summary = { t: 'summary', ...namespaceHashOf([{ relPath: 'm/a.json', size: bytes.length, sha256: sha }]) };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa1-bundle-')), 'abc.dbex');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('DBEX1\n'), len, header, bytes, Buffer.alloc(4), Buffer.from(JSON.stringify(summary))]));
    const error = await rejected(() => importBundle(file)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('[DataInterchange] Bundle names "abc", which is not a guild id');
    expect(fs.readdirSync(DATA_ROOT).filter(n => n.startsWith('.bundle-import-abc'))).toEqual([]);
  });
});

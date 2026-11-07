import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_FS } from '../helpers/forwardingFs';
import { dataPath } from '../../src/utils/dataRoot';
import {
  dropPendingForGuild,
  enqueueDelete,
  enqueueWrite,
  flushAll,
  flushGuild,
  graveyardGuildDir,
  guildKeyStored,
  placeGuildWrite,
  readRawStrict,
  restoreGuildDirFromGraveyard,
  setGuildViewCache,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { keyRefusal } from '../../src/bot/internalSetup/utils/storableData';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

// NB12 (wip-redesign/sheets/NB12.md) decisions 8, 9 and 14 on the file route: the queue overlay a placement reads, the
// bot's cached view and when it is dropped or read again, the folder listing's errors and its log line, and the
// atomic write's rename retry.

const realFs = (fs as any)[REAL_FS] as typeof fs;
let guilds = 9_410_000_000;
let errors: string[];

const newGuild = (): string => String(++guilds);
const gp = (g: string, ...rel: string[]): string => dataPath(g, ...rel.flatMap(r => r.split('/')));
const coded = (code: string): Error => Object.assign(new Error(`${code}: refused by the test`), { code });

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error: any) {
    return error?.code ?? 'no code';
  }
  return undefined;
}

/** Every readdirSync from now on, as resolved paths. */
function listings(): () => string[] {
  const spy = vi.spyOn(fs, 'readdirSync');
  return () => spy.mock.calls.map(c => path.resolve(String(c[0])));
}

const under = (g: string, all: string[]): string[] => all.filter(p => p === gp(g) || p.startsWith(gp(g) + path.sep));

/** The bot's view of the guild read while it holds name, then name removed from the disk behind it. */
function staleView(g: string, name: string, removeFolder: boolean): void {
  fs.mkdirSync(gp(g), { recursive: true });
  fs.writeFileSync(gp(g, name), '{}');
  expect(placeGuildWrite(g, 'probe.json')).toEqual({ ok: true });
  if (removeFolder) fs.rmSync(gp(g), { recursive: true, force: true });
  else fs.unlinkSync(gp(g, name));
}

const logsFor = (g: string): string[] => errors.filter(e => e.includes(`[Data] Guild ${g} holds`));

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  setGuildViewCache(false);
  await flushAll();
});

describe('the queue overlay a guild write is placed against', () => {
  it('counts a queued write at the guild folder root', async () => {
    const g = newGuild();
    enqueueWrite(gp(g, 'a.json'), '{}');
    expect(placeGuildWrite(g, 'A.json')).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from a.json' });
    await flushGuild(g);
  });

  it('holds no op queued outside the data root, even for a guild named ..', async () => {
    const u = `nb12L5s1-${process.pid}-${newGuild()}`;
    const parent = path.resolve(dataPath(), '..');
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: any, o: any) => (path.resolve(String(p)) === parent ? [] : realFs.readdirSync(p, o))) as any);
    enqueueDelete(path.join(dataPath(), '..', u, 'a.json'));
    expect(placeGuildWrite('..', `${u}/A.json`)).toEqual({ ok: true });
    await flushAll();
  });

  it('keeps a still queued write of the guild when another of its writes lands', async () => {
    const g = newGuild();
    const b = gp(g, 'b.json');
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).startsWith(`${b}.`)) throw coded('EACCES');
      return (realOpen as any)(p, ...rest);
    }) as any);
    enqueueWrite(gp(g, 'a.json'), '{"a":1}');
    enqueueWrite(b, '{"b":1}');
    await flushGuild(g);
    try {
      expect(realFs.readFileSync(gp(g, 'a.json'), 'utf8')).toBe('{"a":1}');
      expect(realFs.existsSync(b)).toBe(false);
      expect(placeGuildWrite(g, 'B.json')).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from b.json' });
    } finally {
      dropPendingForGuild(g);
    }
  });
});

describe('the atomic write', () => {
  it('waits before it tries a refused rename again', async () => {
    const g = newGuild();
    const target = gp(g, 'r.json');
    const realRename = fs.promises.rename.bind(fs.promises);
    const times: number[] = [];
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (String(to) === target) {
        times.push(performance.now());
        if (times.length === 1) throw coded('EPERM');
      }
      return realRename(from, to);
    }) as any);
    enqueueWrite(target, '{"r":1}');
    await flushGuild(g);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(20);
    expect(realFs.readFileSync(target, 'utf8')).toBe('{"r":1}');
  });
});

describe('readRawStrict on a folder', () => {
  it('throws for the data root itself', () => {
    expect(errorCode(() => readRawStrict(dataPath()))).toBe('EISDIR');
  });

  it('answers absent for a folder at a guild folder root', () => {
    const g = newGuild();
    fs.mkdirSync(gp(g, 'd.json'), { recursive: true });
    expect(readRawStrict(gp(g, 'd.json'))).toBeNull();
  });

  it('throws under a folder whose name only starts with digits', () => {
    const p = dataPath(`${newGuild()}abc`, 'd.json');
    fs.mkdirSync(p, { recursive: true });
    expect(errorCode(() => readRawStrict(p))).toBe('EISDIR');
  });
});

describe('when the bot drops its view of a guild', () => {
  it('drops a view read during the retire note write when the retire returns', async () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    fs.writeFileSync(gp(g, 'r.json'), '{}');
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).endsWith('.graveyard.json') && path.basename(path.dirname(String(p))).startsWith(`${g}-`)) staleView(g, 'x.json', true);
      return (realWriteFile as any)(p, ...rest);
    }) as any);
    expect(await graveyardGuildDir(g, 'test')).toBe(true);
    expect(guildKeyStored(g, 'x.json')).toBe(false);
  });

  it('drops a view read while a retire rename failed, before the next try', async () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    fs.writeFileSync(gp(g, 'x.json'), '{}');
    const realRename = fs.promises.rename.bind(fs.promises);
    let tries = 0;
    let seen: boolean | undefined;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (String(from) === gp(g)) {
        tries += 1;
        if (tries === 1) {
          expect(placeGuildWrite(g, 'probe.json')).toEqual({ ok: true });
          fs.unlinkSync(gp(g, 'x.json'));
          throw coded('EPERM');
        }
        seen = guildKeyStored(g, 'x.json');
      }
      return realRename(from, to);
    }) as any);
    expect(await graveyardGuildDir(g, 'test')).toBe(true);
    expect(tries).toBe(2);
    expect(seen).toBe(false);
  });

  it('drops a view read during the restore rename before the restore logs its success', async () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    fs.writeFileSync(gp(g, 'r.json'), '{}');
    expect(await graveyardGuildDir(g, 'test')).toBe(true);
    const realRename = fs.promises.rename.bind(fs.promises);
    let seen: boolean | undefined;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (String(to) === gp(g)) staleView(g, 'x.json', true);
      return realRename(from, to);
    }) as any);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes(`Guild ${g} restored from graveyard entry`)) seen = guildKeyStored(g, 'x.json');
    });
    expect(await restoreGuildDirFromGraveyard(g, undefined, { stop: () => null, writerLost: () => false, writerTaken: () => false, replace: false, enterSection: () => () => undefined, progress: { renamed: false, moved: null } }))
      .toMatchObject({ ok: true, reason: 'test' });
    expect(seen).toBe(false);
    expect(guildKeyStored(g, 'r.json')).toBe(true);
  });

  it('drops every view when the cache is turned on again', () => {
    setGuildViewCache(true);
    const g = newGuild();
    staleView(g, 'x.json', false);
    setGuildViewCache(false);
    setGuildViewCache(true);
    expect(guildKeyStored(g, 'x.json')).toBe(false);
  });
});

describe('the bot reads a guild folder once', () => {
  it('lists the guild folder and a recorded top-level folder once each', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g, 'ab'), { recursive: true });
    const read = listings();
    expect(placeGuildWrite(g, 'ab/x.json')).toEqual({ ok: true });
    expect(under(g, read())).toEqual([gp(g), gp(g, 'ab')]);
  });

  it('logs the refused keys of a folder once, though the folder is read again', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    fs.writeFileSync(gp(g, '.graveyard.json'), '{}');
    expect(placeGuildWrite(g, 'x.json')).toEqual({ ok: true });
    fs.writeFileSync(gp(g, 'x.json'), '{}');
    expect(placeGuildWrite(g, 'x.json')).toEqual({ ok: true });
    expect(logsFor(g)).toHaveLength(1);
  });

  it('does not walk again a folder below a walked one', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g, 'Data/sub'), { recursive: true });
    fs.writeFileSync(gp(g, 'Data/sub/y.json'), '{}');
    expect(placeGuildWrite(g, 'data/2.json')).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from Data' });
    const read = listings();
    expect(placeGuildWrite(g, 'Data/SUB/x.json')).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from Data/sub' });
    expect(under(g, read())).toEqual([gp(g, 'Data')]);
  });

  it('removes a walked folder below that holds no key', () => {
    const g = newGuild();
    fs.mkdirSync(gp(g, 'Data/empty'), { recursive: true });
    fs.writeFileSync(gp(g, 'Data/f.json'), '{}');
    expect(placeGuildWrite(g, 'data/1.json')).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from Data' });
    expect(realFs.existsSync(gp(g, 'Data/empty'))).toBe(false);
    expect(realFs.existsSync(gp(g, 'Data/f.json'))).toBe(true);
  });
});

describe('the bot reads a key path again for an entry its view lacks', () => {
  it('does not read again for a file its view holds at a folder of the key', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    fs.writeFileSync(gp(g, 'a.json'), '{}');
    expect(placeGuildWrite(g, 'b.json')).toEqual({ ok: true });
    const read = listings();
    expect(placeGuildWrite(g, 'a.json/x')).toEqual({ ok: false, cause: 'unstorable', reason: 'the folder a.json of it is a file' });
    expect(under(g, read())).toEqual([gp(g)]);
  });

  it('sees a file another process wrote at a folder of the key', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    expect(placeGuildWrite(g, 'b.json')).toEqual({ ok: true });
    fs.writeFileSync(gp(g, 'a.json'), '{}');
    expect(placeGuildWrite(g, 'a.json/x')).toEqual({ ok: false, cause: 'unstorable', reason: 'the folder a.json of it is a file' });
  });

  it('sees a folder another process wrote at the key', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    expect(placeGuildWrite(g, 'b.json')).toEqual({ ok: true });
    fs.mkdirSync(gp(g, 'm'));
    fs.writeFileSync(gp(g, 'm/a.json'), '{}');
    expect(placeGuildWrite(g, 'm')).toEqual({ ok: false, cause: 'unstorable', reason: 'm names a folder that holds other keys' });
  });

  it('lists again the folders along the key, so a delete finds a file written since', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g, 'm'), { recursive: true });
    fs.writeFileSync(gp(g, 'm/a.json'), '{}');
    expect(placeGuildWrite(g, 'm/b.json')).toEqual({ ok: true });
    fs.writeFileSync(gp(g, 'm/c.json'), '{}');
    expect(guildKeyStored(g, 'm/c.json')).toBe(true);
  });
});

describe('a refusal checked against the disk', () => {
  it('takes a write queued here as the colliding file, with no further listing', async () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    enqueueWrite(gp(g, 'a.json'), '{}');
    const read = listings();
    expect(placeGuildWrite(g, 'A.json')).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from a.json' });
    expect(under(g, read())).toEqual([gp(g)]);
    await flushGuild(g);
  });

  it('lists the parent of a colliding folder, though a write is queued at its path', () => {
    setGuildViewCache(true);
    const g = newGuild();
    fs.mkdirSync(gp(g), { recursive: true });
    enqueueWrite(gp(g, 'm'), '{}');
    enqueueWrite(gp(g, 'm/x.json'), '{}');
    const read = listings();
    const placed = placeGuildWrite(g, 'M');
    dropPendingForGuild(g);
    expect(placed).toEqual({ ok: false, cause: 'unstorable', reason: 'it differs only in letter case from m' });
    expect(under(g, read())).toEqual([gp(g), gp(g), gp(g)]);
  });
});

describe('a guild folder listing', () => {
  it('throws an error other than a missing folder', () => {
    const g = newGuild();
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: any, o: any) => {
      if (path.resolve(String(p)) === gp(g)) throw coded('EACCES');
      return realFs.readdirSync(p, o);
    }) as any);
    expect(errorCode(() => placeGuildWrite(g, 'a.json'))).toBe('EACCES');
  });

  it('counts a guild path that is not a folder as empty', () => {
    const g = newGuild();
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: any, o: any) => {
      if (path.resolve(String(p)) === gp(g)) throw coded('ENOTDIR');
      return realFs.readdirSync(p, o);
    }) as any);
    expect(placeGuildWrite(g, 'a.json')).toEqual({ ok: true });
  });

  it('logs the counts and the first three refused or colliding keys', () => {
    const g = newGuild();
    const names = ['CON', 'a.json', 'A.json', 'b.json', 'B.json', 'c.json', 'C.json', 'd.json', 'D.json', 'e|f.json'];
    const entries = names.map(name => ({ name, isDirectory: () => false, isFile: () => true }));
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: any, o: any) => (path.resolve(String(p)) === gp(g) ? entries : realFs.readdirSync(p, o))) as any);
    expect(placeGuildWrite(g, 'zz.json')).toEqual({ ok: true });
    const lines = logsFor(g);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `[Data] Guild ${g} holds, in its folder, 2 key(s) a write is refused for and 4 key(s) whose name collides with another stored key ` +
      `(first: CON: ${keyRefusal('CON')}, A.json: it differs only in letter case from a.json, B.json: it differs only in letter case from b.json). `,
    );
  });
});

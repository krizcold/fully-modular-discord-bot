import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guildKeyStored,
  recoverGraveyardRestores,
  setGuildViewCache,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { resetFolderSyncFailureForTests } from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const X = 1000;
let guilds = 841_100_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const errno = (code: string) => Object.assign(new Error(code), { code });
const lines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '));

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

/** The state a replace leaves when it stops after K4: the live folder is entry r and the copy is still aside. */
function afterK4(g: string, r: number, rNote?: object): string {
  writeTree(path.join(graveyard(), `${g}-${X}`), { 'm/new.json': '{"x":1}' });
  writeTree(path.join(graveyard(), `${g}-${r}`), { 'm/old.json': '{"prev":1}' });
  if (rNote) fs.writeFileSync(path.join(graveyard(), `${g}-${r}`, '.graveyard.json'), JSON.stringify(rNote));
  const restore = path.join(graveyard(), `.restore-${g}-${X}-${r}`);
  writeTree(restore, { 'm/new.json': '{"x":1}' });
  return restore;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fs.mkdirSync(graveyard(), { recursive: true });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  setGuildViewCache(false);
  vi.restoreAllMocks();
});

describe('the boot ends a restore folder', () => {
  it('a drop whose rename fails is logged with the folder name, and the folder stays', () => {
    const g = freshGuild();
    const name = `.copy-${g}-${X}-${X + 1}`;
    writeTree(path.join(graveyard(), name), { 'm/a.json': '{}' });
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((a: any, b: any) => {
      if (path.basename(String(a)) === name) throw errno('EBUSY');
      return rename(a, b);
    }) as any);
    recoverGraveyardRestores();
    expect(lines(errorSpy)).toContain(`[DataManager] Cannot drop graveyard folder ${name} at boot (tried again at the next sweep or boot): Error: EBUSY`);
    expect(fs.existsSync(path.join(graveyard(), name))).toBe(true);
  });

  it('a finish whose rename fails is logged, and nothing more is done for it', () => {
    const g = freshGuild();
    const r = X + 7;
    const restore = afterK4(g, r);
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((a: any, b: any) => {
      if (path.resolve(String(a)) === path.resolve(restore)) throw errno('EACCES');
      return rename(a, b);
    }) as any);
    recoverGraveyardRestores();
    expect(lines(errorSpy)).toContain(`[DataManager] Cannot finish the replace of guild ${g}'s data with entry ${X} at boot (tried again at the next boot): Error: EACCES`);
    expect(fs.existsSync(path.join(graveyard(), `${g}-${r}`, '.graveyard.json'))).toBe(false);
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(fs.existsSync(restore)).toBe(true);
    expect(lines(logSpy).some(l => l.includes(`Finished the replace of guild ${g}'s`))).toBe(false);
  });

  it('a finish logs it, and a view read before it is not used after it', () => {
    setGuildViewCache(true);
    const g = freshGuild();
    const r = X + 9;
    writeTree(dataPath(g), { 'm/old.json': '{"prev":1}' });
    expect(guildKeyStored(g, 'm/old.json')).toBe(true);
    fs.rmSync(dataPath(g), { recursive: true, force: true });
    afterK4(g, r);
    recoverGraveyardRestores();
    expect(fs.readFileSync(dataPath(g, 'm', 'new.json'), 'utf8')).toBe('{"x":1}');
    expect(guildKeyStored(g, 'm/old.json')).toBe(false);
    expect(guildKeyStored(g, 'm/new.json')).toBe(true);
    expect(lines(logSpy)).toContain(`[DataManager] Finished the replace of guild ${g}'s data with entry ${X}; its data from before is entry ${r}`);
  });

  it('a finish keeps a note entry r already has', () => {
    const g = freshGuild();
    const r = X + 11;
    const kept = { guildId: g, reason: 'kept-reason', ts: r };
    afterK4(g, r, kept);
    recoverGraveyardRestores();
    expect(fs.readFileSync(dataPath(g, 'm', 'new.json'), 'utf8')).toBe('{"x":1}');
    expect(JSON.parse(fs.readFileSync(path.join(graveyard(), `${g}-${r}`, '.graveyard.json'), 'utf8'))).toEqual(kept);
  });

  it.skipIf(process.platform === 'win32')('a finish syncs /data and the graveyard after its rename', () => {
    resetFolderSyncFailureForTests();
    const g = freshGuild();
    const r = X + 13;
    const restore = afterK4(g, r, { guildId: g, reason: 'kept-reason', ts: r });
    const calls: string[] = [];
    const rename = fs.renameSync;
    const open = fs.openSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((a: any, b: any) => {
      if (path.resolve(String(a)) === path.resolve(restore)) calls.push('finish');
      return rename(a, b);
    }) as any);
    vi.spyOn(fs, 'openSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (calls.length > 0) calls.push(`open ${path.resolve(String(p))}`);
      return (open as any)(p, ...rest);
    }) as any);
    recoverGraveyardRestores();
    expect(calls[0]).toBe('finish');
    expect(calls).toContain(`open ${path.resolve(dataPath())}`);
    expect(calls).toContain(`open ${path.resolve(graveyard())}`);
  });
});

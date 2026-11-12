import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  nextGraveyardName,
  recoverGraveyardRestores,
  writeGraveyardNote,
  writeGraveyardNoteSync,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

let guilds = 840_400_000_000_000_000n;
const freshGuild = () => String(++guilds);
const graveyard = () => dataPath('_graveyard');
const errno = (code: string) => Object.assign(new Error(code), { code });
const isNote = (p: unknown) => path.basename(String(p)) === '.graveyard.json';
const tmpsIn = (dir: string) => fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));

function makeEntry(g: string, n: number): string {
  const dir = path.join(graveyard(), `${g}-${n}`);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":1}');
  return dir;
}

const realSetTimeout = globalThis.setTimeout;

let errorSpy:ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fs.mkdirSync(graveyard(), { recursive: true });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function drive<T>(promise: Promise<T>, stepMs: number): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  let result: { ok: true; value: T } | { ok: false; error: any } | null = null;
  promise.then(value => { result = { ok: true, value }; }, error => { result = { ok: false, error }; });
  const deadline = vi.getRealSystemTime() + 5000;
  while (!result && vi.getRealSystemTime() < deadline) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>(resolve => realSetTimeout(resolve, 1));
  }
  if (!result) throw new Error('writeGraveyardNote did not settle');
  return result;
}

describe('nextGraveyardName', () => {
  it("ignores another guild's entry numbers", () => {
    const mine = freshGuild();
    const other = freshGuild();
    const far = Date.now() + 1_000_000_000;
    makeEntry(other, far);
    const before = Date.now();
    const n = nextGraveyardName(mine);
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThan(far);
  });

  it("ignores another guild's restore folder numbers", () => {
    const mine = freshGuild();
    const other = freshGuild();
    const far = Date.now() + 2_000_000_000;
    fs.mkdirSync(path.join(graveyard(), `.restore-${other}-5-${far}`), { recursive: true });
    const before = Date.now();
    const n = nextGraveyardName(mine);
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThan(far);
  });

  it("takes one above the guild's own entry and restore folder", () => {
    const mine = freshGuild();
    const far = Date.now() + 3_000_000_000;
    makeEntry(mine, far);
    expect(nextGraveyardName(mine)).toBe(far + 1);
    fs.mkdirSync(path.join(graveyard(), `.copy-${mine}-5-${far + 7}`), { recursive: true });
    expect(nextGraveyardName(mine)).toBe(far + 8);
  });
});

describe('writeGraveyardNote rename retry', () => {
  it('retries a failing rename after 25, 50 and 75 ms and lands the note', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const g = freshGuild();
    const dir = makeEntry(g, 1000);
    const rename = fs.promises.rename.bind(fs.promises);
    const times: number[] = [];
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (!isNote(to)) return rename(from, to);
      times.push(Date.now());
      if (times.length <= 3) throw errno('EPERM');
      return rename(from, to);
    }) as any);
    const note = { guildId: g, reason: 'webui-operator-delete', ts: 1000 };
    const result = await drive(writeGraveyardNote(dir, note), 1);
    expect(result.ok).toBe(true);
    expect(times.map(t => t - times[0])).toEqual([0, 25, 75, 150]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.graveyard.json'), 'utf-8'))).toEqual(note);
    expect(tmpsIn(dir)).toEqual([]);
  });

  it('gives up after ten rename tries, rejects with the error and removes the temp file', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const g = freshGuild();
    const dir = makeEntry(g, 2000);
    const rename = fs.promises.rename.bind(fs.promises);
    let tries = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: any, to: any) => {
      if (!isNote(to)) return rename(from, to);
      tries++;
      throw errno('EPERM');
    }) as any);
    const result = await drive(writeGraveyardNote(dir, { guildId: g, reason: 'r', ts: 2000 }), 5);
    expect(result.ok).toBe(false);
    expect((result as { error: any }).error).toMatchObject({ code: 'EPERM' });
    expect(tries).toBe(10);
    expect(fs.existsSync(path.join(dir, '.graveyard.json'))).toBe(false);
    expect(tmpsIn(dir)).toEqual([]);
  });
});

describe('writeGraveyardNoteSync', () => {
  it('removes its temp file when the rename fails', () => {
    const g = freshGuild();
    const dir = makeEntry(g, 3000);
    const renameSync = (fs as any).renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (isNote(to)) throw errno('EIO');
      return renameSync(from, to);
    }) as any);
    expect(() => writeGraveyardNoteSync(dir, { guildId: g, reason: 'r', ts: 3000 })).toThrow('EIO');
    expect(tmpsIn(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.graveyard.json'))).toBe(false);
  });
});

describe('recoverGraveyardRestores', () => {
  it('drops a .copy- folder even when its entry exists and the guild has no live folder', () => {
    const g = freshGuild();
    makeEntry(g, 4000);
    const copy = path.join(graveyard(), `.copy-${g}-77-4000`);
    fs.mkdirSync(path.join(copy, 'm'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'm', 'a.json'), '{"n":2}');
    recoverGraveyardRestores();
    expect(fs.existsSync(dataPath(g))).toBe(false);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(path.join(graveyard(), `.sweep-restore-${g}-77-4000`, 'm', 'a.json'), 'utf-8')).toBe('{"n":2}');
  });

  it('logs a restore folder it cannot check and keeps it', () => {
    const g = freshGuild();
    const name = `.restore-${g}-78-5000`;
    const folder = path.join(graveyard(), name);
    fs.mkdirSync(folder, { recursive: true });
    const failure = errno('EACCES');
    const exists = (fs as any).existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(((p: any) => {
      if (path.basename(String(p)) === `${g}-5000`) throw failure;
      return exists(p);
    }) as any);
    recoverGraveyardRestores();
    expect(errorSpy).toHaveBeenCalledWith(
      `[DataManager] Cannot check graveyard folder ${name} at boot (tried again at the next sweep or boot):`,
      failure,
    );
    expect(fs.existsSync(folder)).toBe(true);
  });
});

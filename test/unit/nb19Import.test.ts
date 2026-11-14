import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/client', async orig => {
  const real = await orig<any>();
  class Client { async panelAnswers() { return { bot: 'no', migration: 'no' }; } }
  return { ...real, Client, resolveTarget: () => ({}) };
});

import { importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { dispatch } from '../../src/cli/commands';
import { EXIT_ERR } from '../../src/cli/output';
import { FolderSyncError, resetFolderSyncFailureForTests, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// NB19 decision 11: the bundle import fsyncs every file it stages and syncs every staged folder before the swap, then
// syncs /data and /data/_graveyard after it; a failure after the swap throws FolderSyncError with T12.

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
let guilds = 860_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
let stub: AppendStub;

function guildWith(g: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const file = dataPath(g, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
async function bundleOf(g: string, files: Record<string, string>): Promise<string> {
  guildWith(g, files);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nb19-bundle-')), 'b.dbex');
  await writeBundle(g, file);
  return file;
}
/** Records each file fsync and each folder sync, in order, through the stub's handles. */
function recordSyncs(): string[] {
  const events: string[] = [];
  const stubbed = vi.mocked(fs.promises.open).getMockImplementation()!;
  vi.mocked(fs.promises.open).mockImplementation((async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const handle = await stubbed(file, flags as never, mode);
    const p = path.resolve(String(file));
    let dir = false;
    try { dir = (flags === 'r' || flags === undefined) && fs.statSync(p).isDirectory(); } catch { /* not there */ }
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === 'sync') return async () => { events.push(`${dir ? 'dir' : 'file'}:${p}`); return target.sync(); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as typeof fs.promises.open);
  return events;
}
class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}
async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stub = stubAppendHandles();
});
afterEach(() => {
  stub.restore();
  vi.restoreAllMocks();
  setBackendKind(null);
  fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
  resetFolderSyncFailureForTests();
});

describe.skipIf(!POSIX)('rows 45 to 47: the bundle import', () => {
  it('45: EIO on a staged folder throws with "the live guild dir was not touched"; /data/G is unchanged', async () => {
    const g = freshGuild();
    const file = await bundleOf(g, { 'm/a.json': '{"new":1}' });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"live":1}');
    stub.failDirSync(new RegExp(`/\\.bundle-import-${g}-\\d+/m$`), 'EIO');
    const error = await rejected(() => importBundle(file)) as Error;
    expect(error.message).toContain('the live guild dir was not touched');
    expect(error.message).toContain("The staged import's folders can't be confirmed as stored");
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"live":1}');
  });

  it('46: EIO on /data after the swap that replaced a live /data/G: FolderSyncError with T12 and the graveyard path', async () => {
    const g = freshGuild();
    const file = await bundleOf(g, { 'm/a.json': '{"new":1}' });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"live":1}');
    stub.failDirSync(ROOT, 'EIO');
    const error = await rejected(() => importBundle(file)) as FolderSyncError;
    expect(error).toBeInstanceOf(FolderSyncError);
    const replaced = error.replaced!;
    expect(path.dirname(replaced)).toBe(dataPath('_graveyard'));
    const { why, next } = syncWords('sync', ROOT, 'EIO');
    expect(error.message).toBe(`Guild ${g} is imported, but ${why}, so can't confirm it is stored. ${next} The previous copy is at ${replaced}.`);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"new":1}');
    expect(JSON.parse(fs.readFileSync(path.join(replaced, '.graveyard.json'), 'utf8')).reason).toBe('replaced by bundle import');
    expect(fs.readFileSync(path.join(replaced, 'm', 'a.json'), 'utf8')).toBe('{"live":1}');
  });

  it('47: with good syncs every staged folder is synced, the staging folder last, then /data and /data/_graveyard', async () => {
    const g = freshGuild();
    const file = await bundleOf(g, { 'm/a.json': '{"a":1}', 'm/sub/b.json': '{"b":1}' });
    stub.dirSyncs.length = 0;
    const realRename = fs.promises.rename.bind(fs.promises);
    let swapAt = -1;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (/\.bundle-import-/.test(String(from)) && path.resolve(String(to)) === path.resolve(dataPath(g))) swapAt = stub.dirSyncs.length;
    });
    await importBundle(file);
    const staged = stub.dirSyncs.filter(d => /\.bundle-import-/.test(d));
    expect(staged.map(d => d.replace(/^.*\.bundle-import-\d+-\d+/, '')).map(d => d.replace(/\\/g, '/'))).toEqual(['/m/sub', '/m', '']);
    const stagedAt = stub.dirSyncs.indexOf(staged.at(-1)!);
    expect(swapAt).toBeGreaterThan(stagedAt);
    const after = stub.dirSyncs.slice(swapAt);
    expect(after.indexOf(ROOT)).toBeGreaterThanOrEqual(0);
    expect(after.indexOf(dataPath('_graveyard'))).toBeGreaterThan(after.indexOf(ROOT));
  });
});

describe.skipIf(!POSIX)('rows 46 and 47: the CLI, the tool and the file fsyncs', () => {
  async function replacingImport(): Promise<{ g: string; file: string }> {
    const g = freshGuild();
    const file = await bundleOf(g, { 'm/a.json': '{"new":1}' });
    fs.writeFileSync(dataPath(g, 'm', 'a.json'), '{"live":1}');
    stub.failDirSync(ROOT, 'EIO');
    return { g, file };
  }
  const t12 = (g: string, replaced: string) => {
    const { why, next } = syncWords('sync', ROOT, 'EIO');
    return `Guild ${g} is imported, but ${why}, so can't confirm it is stored. ${next} The previous copy is at ${replaced}.`;
  };

  it('46: smdb bundle import prints T12 with the replaced path in its JSON and stderr, and exits EXIT_ERR', async () => {
    const { g, file } = await replacingImport();
    let out = '';
    let err = '';
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out += String(chunk); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err += String(chunk); return true; }) as never);
    const client = { panelAnswers: async () => ({ bot: 'no', migration: 'no' }) } as never;
    let code: number | undefined | 'none' = 'none';
    try {
      await dispatch(client, ['bundle', 'import', file], { json: true });
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      code = e.code;
    }
    expect(code).toBe(EXIT_ERR);
    const body = JSON.parse(out);
    expect(path.dirname(body.replaced)).toBe(dataPath('_graveyard'));
    expect(body).toEqual({ success: false, error: `bundle import can't be confirmed: ${t12(g, body.replaced)}`, replaced: body.replaced });
    expect(err).toBe(`smdb: bundle import can't be confirmed: ${t12(g, body.replaced)}` + '\n');
    expect(out).not.toContain('"fileCount"');
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"new":1}');
  });

  it('46: tools/dataBundle.ts import prints T12 with the replaced path and exits 1', async () => {
    const { g, file } = await replacingImport();
    const exits: Array<number | undefined> = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); }) as never);
    const argv = process.argv;
    process.argv = [argv[0], 'dataBundle', 'import', file];
    try {
      vi.resetModules();
      await import('../../src/tools/dataBundle');
      await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
    } finally {
      process.argv = argv;
    }
    expect(exits).toEqual([1]);
    const lines = vi.mocked(console.error).mock.calls.map(c => c.map(String).join(' ')).filter(l => l.startsWith('bundle import'));
    expect(lines).toHaveLength(1);
    const replaced = /The previous copy is at (.*)\.$/.exec(lines[0])![1];
    expect(path.dirname(replaced)).toBe(dataPath('_graveyard'));
    expect(lines[0]).toBe(`bundle import can't be confirmed: ${t12(g, replaced)}`);
    expect(vi.mocked(console.log).mock.calls.some(c => String(c[0]).startsWith('Imported guild'))).toBe(false);
  });

  it('47: every imported file is fsynced before the first staged folder sync', async () => {
    const g = freshGuild();
    const file = await bundleOf(g, { 'm/a.json': '{"a":1}', 'm/sub/b.json': '{"b":1}', 'n/c.json': '{"c":1}' });
    const events = recordSyncs();
    await importBundle(file);
    const staging = /\.bundle-import-\d+-\d+/;
    const fileSyncs = events.filter(e => e.startsWith('file:') && staging.test(e)).map(e => e.replace(/^.*\.bundle-import-\d+-\d+/, '').replace(/\\/g, '/'));
    expect(fileSyncs.sort()).toEqual(['/m/a.json', '/m/sub/b.json', '/n/c.json']);
    const firstDir = events.findIndex(e => e.startsWith('dir:') && staging.test(e));
    const lastFile = events.map((e, i) => (e.startsWith('file:') && staging.test(e) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(firstDir).toBeGreaterThan(lastFile);
    expect(fs.readFileSync(dataPath(g, 'n', 'c.json'), 'utf8')).toBe('{"c":1}');
  });
});

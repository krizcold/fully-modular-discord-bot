import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reads the platform once at load: it loads here as on Linux, where production runs, so its folder syncs run.
const h = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return {
    platform: real,
    renameSync: null as null | ((real: (a: any, b: any) => void, a: any, b: any) => void),
  };
});
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const renameSync = (a: any, b: any) => (h.renameSync ? h.renameSync(real.renameSync, a, b) : real.renameSync(a, b));
  return { ...real, renameSync, default: { ...real, renameSync } };
});

import fs from 'fs';
import {
  restoreGuildDirFromGraveyard,
  type FileRestoreHooks,
} from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';

const X = 1000;
const PREV = { 'm/a.json': '{"prev":1}' };
const XFILES = { 'm/a.json': '{"x":1}', 'm/log.jsonl': 'zero\n' };
const ROOT = path.resolve(DATA_ROOT);
const realSetTimeout = globalThis.setTimeout;

let guilds = 820_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const errno = (code: string) => Object.assign(new Error(code), { code });
const same = (a: unknown, b: unknown) => path.resolve(String(a)) === path.resolve(String(b));

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

function setUp(g: string): void {
  writeTree(dataPath(g), PREV);
  const entry = dataPath('_graveyard', `${g}-${X}`);
  writeTree(entry, XFILES);
  fs.writeFileSync(path.join(entry, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: X }));
}

type Phase = 'k3' | 'k4' | 'undo' | 'k6';
type Plan = { open?: string; sync?: string };

/** Hooks for a replace, folder handles faked by phase (only /data's open or sync fails as planned), K5 failing as asked. */
function rig(g: string, plans: Partial<Record<Phase, Plan>>, k5: null | (() => unknown) = null, takenAfterUndo = false): { hooks: FileRestoreHooks } {
  const live = dataPath(g);
  let rejects = 0;
  const hooks: FileRestoreHooks = {
    stop: () => null,
    writerLost: () => false,
    writerTaken: () => takenAfterUndo && rejects > 0 && fs.existsSync(live),
    replace: true,
    enterSection: () => () => undefined,
    progress: { renamed: false, moved: null },
  };
  const phase = (): Phase => (!hooks.progress.moved ? 'k3' : hooks.progress.renamed ? 'k6' : rejects > 0 ? 'undo' : 'k4');
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch { /* not there */ }
    if (!isDir) return (open as any)(p, ...rest);
    const at = path.resolve(String(p));
    const plan = at === ROOT ? plans[phase()] : undefined;
    if (plan?.open) throw errno(plan.open);
    return {
      stat: async () => ({ dev: 1n, ino: 1n, birthtimeNs: 0n }),
      sync: async () => { if (plan?.sync) throw errno(plan.sync); },
      close: async () => undefined,
    };
  }) as any);
  if (k5) {
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation((async (a: any, b: any) => {
      if (path.basename(String(a)).startsWith('.restore-') && same(b, live)) {
        rejects += 1;
        throw k5();
      }
      return rename(a, b);
    }) as any);
  }
  return { hooks };
}

/** The restore's retry waits run at once. */
function quickRetries(): void {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...rest: any[]) =>
    realSetTimeout(fn, ms !== undefined && ms <= 250 ? 0 : ms, ...rest)) as any);
}

let error: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
const firsts = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  h.renameSync = null;
});
afterEach(() => {
  h.renameSync = null;
  vi.restoreAllMocks();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', h.platform);
});

const replacedLine = (g: string, n: number) => `[DataManager] Guild ${g}'s data was replaced with a copy of graveyard entry ${g}-${X}; its data from before is entry ${g}-${n}`;
const unconfirmedLine = (g: string, code: string) => `[DataManager] Guild ${g}'s data was replaced with a copy of graveyard entry ${g}-${X}, but the disk did not confirm a folder sync (${code}), so a power cut can undo the replace`;
const putLine = (g: string) => `[DataManager] The copy of graveyard entry ${g}-${X} could not be put in place for guild ${g}:`;

describe('a replace whose folder syncs all passed (rc5)', () => {
  it('answers ok without moveUnconfirmed, marks the copy renamed and logs the replace as a warning', async () => {
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, {});
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const n = answer.replaced!.retiredAt;
    expect(answer).toEqual({ ok: true, retiredAt: X, reason: 'webui-operator-delete', usedAt: answer.usedAt, replaced: { retiredAt: n, reason: `replaced-by-restore-${X}` } });
    expect(hooks.progress.renamed).toBe(true);
    expect(firsts(warn)).toContain(replacedLine(g, n));
    expect(firsts(error).filter(l => l.includes('did not confirm a folder sync'))).toEqual([]);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"x":1}');
  });
});

describe('a replace whose folder sync failed (rc5)', () => {
  it('a failed sync after K4 answers moveUnconfirmed with its code and logs the power cut risk', async () => {
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, { k4: { sync: 'EIO' } });
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: true, retiredAt: X, moveUnconfirmed: 'EIO' });
    expect(firsts(error)).toContain(unconfirmedLine(g, 'EIO'));
    expect(firsts(warn).filter(l => l.includes('its data from before is entry'))).toEqual([]);
  });

  it('a failed sync after K6 alone answers its code', async () => {
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, { k6: { sync: 'EROFS' } });
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: true, moveUnconfirmed: 'EROFS' });
    expect(firsts(error)).toContain(unconfirmedLine(g, 'EROFS'));
  });

  it('when both fail, the K4 code is the one answered', async () => {
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, { k4: { sync: 'EIO' }, k6: { sync: 'EROFS' } });
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: true, moveUnconfirmed: 'EIO' });
    expect(firsts(error)).toContain(unconfirmedLine(g, 'EIO'));
  });

  it('a folder that could not be opened after K4 answers its code', async () => {
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, { k4: { open: 'ENOENT' } });
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: true, moveUnconfirmed: 'ENOENT' });
    expect(firsts(error)).toContain(unconfirmedLine(g, 'ENOENT'));
  });
});

describe('a replace whose copy could not be put in place (rc5)', () => {
  it('a put that failed every try logs the copy and undoes the replace', async () => {
    quickRetries();
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, {}, () => errno('EPERM'));
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: false, why: 'undone', x: X, code: 'EPERM' });
    expect(firsts(error)).toContain(putLine(g));
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"prev":1}');
  });

  it('a put whose retry threw answers the undo with the thrown code, never ok', async () => {
    const g = freshGuild();
    setUp(g);
    const thrown = errno('EBADMSG');
    const { hooks } = rig(g, {}, () => ({ get code(): string { throw thrown; } }));
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: false, why: 'undone', x: X, code: 'EBADMSG' });
    expect(hooks.progress.renamed).toBe(false);
    expect(error.mock.calls.some((c: unknown[]) => c[0] === putLine(g) && c[1] === thrown)).toBe(true);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"prev":1}');
  });

  it('an undo whose folder sync failed answers its syncCode', async () => {
    quickRetries();
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, { undo: { sync: 'EIO' } }, () => errno('EPERM'));
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: false, why: 'undone', x: X, code: 'EPERM', syncCode: 'EIO' });
  });

  it('an undo during which another process took the data files answers undone-taken and keeps the copy', async () => {
    quickRetries();
    const g = freshGuild();
    setUp(g);
    const { hooks } = rig(g, {}, () => errno('EPERM'), true);
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: false, why: 'undone-taken', x: X, code: 'EPERM' });
    if (answer.ok || answer.why !== 'undone-taken') return;
    expect(firsts(error)).toContain(`[DataManager] Guild ${g}: the server's data moved back from graveyard entry ${g}-${answer.r} while another process took the data files; a save of that process may have replaced one of its files`);
    expect(fs.existsSync(dataPath('_graveyard', `.restore-${g}-${X}-${answer.r}`))).toBe(true);
  });

  it('an undo whose rename failed every try logs both entries as listed', async () => {
    quickRetries();
    const g = freshGuild();
    setUp(g);
    h.renameSync = (real, a, b) => {
      if (same(b, dataPath(g))) throw errno('EBUSY');
      real(a, b);
    };
    const { hooks } = rig(g, {}, () => errno('EPERM'));
    const answer = await restoreGuildDirFromGraveyard(g, X, hooks);
    expect(answer).toMatchObject({ ok: false, why: 'half', x: X, code: 'EPERM', undoCode: 'EBUSY' });
    if (answer.ok || answer.why !== 'half') return;
    expect(firsts(error)).toContain(`[DataManager] Guild ${g}: its data could not be moved back from graveyard entry ${g}-${answer.r}; entries ${answer.r} and ${X} are both listed:`);
    expect(fs.readFileSync(dataPath('_graveyard', `${g}-${answer.r}`, 'm', 'a.json'), 'utf8')).toBe('{"prev":1}');
  });
});

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateEventDispatch } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { listGraveyardEntries } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { saveMark } from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import {
  deleteGuildNamespace,
  flushAll,
  guildDataOpOf,
  loadData,
  restoreGuildFromGraveyard,
  saveData,
  saveDataTracked,
  sweepGraveyard,
  writeRawAtomic,
} from '../../src/bot/internalSetup/utils/dataManager';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB11 (wip-redesign/sheets/NB11.md): the JSON restore and delete; the sweep, the barrier's edge, raw writes under a
// held guild, the restore's event buffer and the operation's deadline.

let guilds = 870_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const entryDir = (g: string, ms: number) => dataPath('_graveyard', `${g}-${ms}`);
const opts = (guildId: string) => ({ guildId, category: 'm' });
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const same = (a: unknown, b: unknown) => path.resolve(String(a)) === path.resolve(String(b));
const event = (g: string) => [{ guildId: g }];
const liveText = (r: number) => `live guild data exists; nothing was restored. To restore entry ${r}, delete this server's data, then restore with retiredAt ${r} before the bot saves anything new for the server; data it saves in between blocks the restore again. While the server's members are active, remove the bot from the server first and add it back after the restore.`;

function bury(g: string, ms: number, files: Record<string, string> = { 'm/a.json': '{"n":5}' }): void {
  const dir = entryDir(g, ms);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }, null, 2));
}
const listed = async (g: string) => (await listGraveyardEntries()).filter(e => e.guildId === g);

/** Holds the next readdir of the graveyard (the restore's entry lookup) until the returned release is called. */
function holdLookup(): () => void {
  const lookup = deferred();
  const readdir = fs.promises.readdir.bind(fs.promises);
  let held = true;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
    if (held && same(args[0], dataPath('_graveyard'))) {
      held = false;
      await lookup.promise;
    }
    return (readdir as any)(...args);
  }) as any);
  return () => lookup.resolve();
}

/** Starts a delete of g held in its flush (g's file opens wait); returns the delete and its release. */
async function heldDelete(g: string): Promise<{ deleting: Promise<unknown>; release: () => void }> {
  saveData('a.json', opts(g), { a: 1 });
  await flushAll();
  const open = fs.promises.open.bind(fs.promises);
  const wire = deferred();
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
    if (String(p).includes(`${path.sep}${g}${path.sep}`)) await wire.promise;
    return (open as any)(p, ...rest);
  }) as any);
  saveData('b.json', opts(g), { b: 1 });
  const deleting = deleteGuildNamespace(g, 'test', 5000);
  return { deleting, release: () => wire.resolve() };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const warnLines = (): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0]));

beforeEach(() => {
  setBackendKind('file');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  await flushAll();
});

describe('the file graveyard sweep', () => {
  it('removes an expired entry, and keeps the expired entry of a guild a restore holds', async () => {
    const swept = freshGuild();
    const held = freshGuild();
    bury(swept, 1000);
    bury(held, 1000, { 'm/a.json': '{"h":1}' });
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(held);
    expect(guildDataOpOf(held)).toBe('restore');
    await sweepGraveyard();
    expect(await listed(swept)).toEqual([]);
    expect(fs.existsSync(entryDir(swept, 1000))).toBe(false);
    expect(fs.readFileSync(path.join(entryDir(held, 1000), 'm', 'a.json'), 'utf8')).toBe('{"h":1}');
    release();
    expect(await restoring).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete' });
    expect(fs.readFileSync(dataPath(held, 'm', 'a.json'), 'utf8')).toBe('{"h":1}');
  });
});

describe('the barrier after a JSON restore', () => {
  it('a command that opened right at the barrier saves', async () => {
    const g = freshGuild();
    bury(g, 1000);
    await flushAll();
    const before = saveMark().stamp;
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete' });
    const ledger = openLedger('interaction');
    // The restore took exactly one stamp, its barrier, so the ledger opened at the barrier itself.
    expect(ledger.openedMark.stamp).toBe(before + 1);
    expect(runInLedger(ledger, 'm', () => saveDataTracked('a.json', opts(g), { n: 6 })).outcome).toBe('saved');
    await flushAll();
    expect(JSON.parse(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8'))).toEqual({ n: 6 });
    expect(warnLines().some(l => l.includes('refused'))).toBe(false);
  });

  it('a global write that names the restored guild, from a command older than the restore, saves', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const gate = deferred();
    const global = { scope: 'global' as const, guildId: g, category: 'nb11l5s5' };
    const running = runInLedger(openLedger('interaction'), 'm', async () => {
      await gate.promise;
      return saveDataTracked('g.json', global, { from: g });
    });
    expect(await restoreGuildFromGraveyard(g, 1000)).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete' });
    gate.resolve();
    expect((await running).outcome).toBe('saved');
    await flushAll();
    expect(loadData('g.json', global, null)).toEqual({ from: g });
    expect(warnLines().some(l => l.includes(`for guild ${g} refused`))).toBe(false);
  });
});

describe('raw writes under a held guild', () => {
  it('a raw write under a restored guild\'s folder is refused with the restore\'s reason, also for a name ending in ..', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(g);
    expect(guildDataOpOf(g)).toBe('restore');
    const plain = dataPath(g, 'm', 'r.json');
    const dotted = dataPath(g, 'm', 'r..');
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'm', () => [writeRawAtomic(plain, '{}'), writeRawAtomic(dotted, '{}')])).toEqual([false, false]);
    expect(ledger.refusedDocs().map(r => [r.cause, r.doc])).toEqual([['not-ready', `file:${plain}`], ['not-ready', `file:${dotted}`]]);
    expect(warnLines()).toEqual([
      `[Data] Write of ${plain} refused: its guild's data is being restored from the graveyard`,
      `[Data] Write of ${dotted} refused: its guild's data is being restored from the graveyard`,
    ]);
    release();
    expect(await restoring).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete' });
    await flushAll();
    expect(fs.readdirSync(dataPath(g, 'm'))).toEqual(['a.json']);
  });

  it('a raw write under a deleted guild\'s folder is refused with the delete\'s reason', async () => {
    const g = freshGuild();
    const { deleting, release } = await heldDelete(g);
    expect(guildDataOpOf(g)).toBe('delete');
    warn.mockClear();
    const abs = dataPath(g, 'm', 'r.json');
    expect(writeRawAtomic(abs, '{}')).toBe(false);
    expect(warnLines()).toEqual([`[Data] Write of ${abs} refused: its guild's data is being deleted`]);
    release();
    expect(await deleting).toEqual({ ok: true });
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it.each([['abc123'], ['123abc']])('a folder named %s is no guild folder: a raw write there is accepted while a restore holds that id', async name => {
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(name);
    expect(guildDataOpOf(name)).toBe('restore');
    const abs = dataPath(name, 'm', 'r.json');
    const ledger = openLedger('panel');
    expect(runInLedger(ledger, 'm', () => writeRawAtomic(abs, '{"r":1}'))).toBe(true);
    expect(ledger.refusedDocs()).toEqual([]);
    expect(warnLines().some(l => l.includes('refused'))).toBe(false);
    release();
    expect(await restoring).toEqual({ ok: false, code: 'invalid', error: 'no graveyard entry for this guild' });
    await flushAll();
    expect(fs.readFileSync(abs, 'utf8')).toBe('{"r":1}');
  });
});

describe('events and the restore buffer', () => {
  it('with no restore holding the guild an event dispatches at once and is never replayed', async () => {
    const g = freshGuild();
    const ran = vi.fn();
    expect(await gateEventDispatch('messageCreate', event(g), ran)).toBe(true);
    // A later restore of the guild replays only the events it held.
    fs.mkdirSync(dataPath(g), { recursive: true });
    bury(g, 1000);
    expect(await restoreGuildFromGraveyard(g)).toEqual({ ok: false, code: 'invalid', error: liveText(1000) });
    expect(ran).not.toHaveBeenCalled();
  });

  it('an event held by one restore runs once, and is not replayed again by the next restore', async () => {
    const g = freshGuild();
    fs.mkdirSync(dataPath(g), { recursive: true });
    bury(g, 1000);
    const ran: string[] = [];
    for (const name of ['first', 'second']) {
      const release = holdLookup();
      const restoring = restoreGuildFromGraveyard(g);
      expect(await gateEventDispatch('messageCreate', event(g), () => { ran.push(name); })).toBe(false);
      release();
      expect(await restoring).toEqual({ ok: false, code: 'invalid', error: liveText(1000) });
      vi.restoreAllMocks();
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      error = vi.spyOn(console, 'error').mockImplementation(() => {});
    }
    expect(ran).toEqual(['first', 'second']);
  });

  it('a replayed event that throws is logged with its guild, and the next event still runs', async () => {
    const g = freshGuild();
    fs.mkdirSync(dataPath(g), { recursive: true });
    bury(g, 1000);
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(g);
    const boom = new Error('handler broke');
    const ran: string[] = [];
    expect(await gateEventDispatch('messageCreate', event(g), () => { throw boom; })).toBe(false);
    expect(await gateEventDispatch('messageCreate', event(g), () => { ran.push('next'); })).toBe(false);
    release();
    expect(await restoring).toEqual({ ok: false, code: 'invalid', error: liveText(1000) });
    expect(ran).toEqual(['next']);
    expect(error.mock.calls).toContainEqual([`[Data] Buffered event replay failed for guild ${g}:`, boom]);
  });

  it('three events past the buffer\'s 256 drop the three oldest with one overflow line', async () => {
    const g = freshGuild();
    fs.mkdirSync(dataPath(g), { recursive: true });
    bury(g, 1000);
    const release = holdLookup();
    const restoring = restoreGuildFromGraveyard(g);
    const ran: number[] = [];
    for (let i = 0; i < 259; i++) expect(await gateEventDispatch('messageCreate', event(g), () => { ran.push(i); })).toBe(false);
    const overflow = warnLines().filter(l => l.startsWith(`[Data] Event buffer overflow for guild ${g}`));
    expect(overflow).toEqual([`[Data] Event buffer overflow for guild ${g} (1 drop(s) total); oldest dropped`]);
    release();
    expect(await restoring).toEqual({ ok: false, code: 'invalid', error: liveText(1000) });
    expect(ran).toEqual(Array.from({ length: 256 }, (_v, i) => i + 3));
  });
});

describe('the operation deadline', () => {
  it('a restore and a delete whose deadline is exactly now still run', async () => {
    const r = freshGuild();
    bury(r, 1000);
    const d = freshGuild();
    saveData('a.json', opts(d), { a: 1 });
    await flushAll();
    const now = process.hrtime.bigint();
    vi.spyOn(process.hrtime, 'bigint').mockReturnValue(now);
    expect(await restoreGuildFromGraveyard(r, 1000, now)).toEqual({ ok: true, retiredAt: 1000, reason: 'webui-operator-delete' });
    expect(await deleteGuildNamespace(d, 'test', 5000, now)).toEqual({ ok: true });
    vi.restoreAllMocks();
    expect(fs.readFileSync(dataPath(r, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(fs.existsSync(dataPath(d))).toBe(false);
    const [entry] = await listed(d);
    expect(JSON.parse(fs.readFileSync(path.join(entryDir(d, entry.retiredAt), 'm', 'a.json'), 'utf8'))).toEqual({ a: 1 });
  });
});

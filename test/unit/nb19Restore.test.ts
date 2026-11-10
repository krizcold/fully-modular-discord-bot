import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmFile, enqueueWrite, fileTicket, fileTicketFailure, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { deleteGuildNamespace, restoreGuildFromGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { folderSyncFailed, syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// NB19 decisions 6 and 7: a restore whose copy the disk does not confirm restores nothing, in the words of the
// failure's kind, and every rename of /data/G in a restore forgets the folder records under it.

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(DATA_ROOT);
let guilds = 870_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const fwd = (p: string) => p.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]]/g, '\\$&');
let stub: AppendStub;
let errors: string[];

function bury(g: string, ms: number): void {
  const dir = dataPath('_graveyard', `${g}-${ms}`);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":5}');
  fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }, null, 2));
}
async function save(p: string): Promise<{ answer: string; t: ReturnType<typeof fileTicket> }> {
  enqueueWrite(p, '{"v":1}');
  const t = fileTicket(p);
  return { answer: await confirmFile(t, 3000), t };
}
const copyNamed = (g: string) => fs.readdirSync(dataPath('_graveyard')).filter(n => n.startsWith(`.copy-${g}-`) || n.startsWith(`.restore-${g}-`));

beforeEach(() => {
  setBackendKind('file');
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stub = stubAppendHandles();
});
afterEach(async () => {
  stub.restore();
  await flushAll();
  vi.restoreAllMocks();
  setBackendKind(null);
});

describe.skipIf(!POSIX)('rows 13, 57 and 69: a restore whose copy is not confirmed', () => {
  it('13: EIO on a folder of the copy: T4 and T18, no "could not be copied", the copy dropped, nothing restored', async () => {
    const g = freshGuild();
    bury(g, 1000);
    stub.failDirSync(new RegExp(`/_graveyard/\\.copy-${g}-1000-\\d+/m$`), 'EIO');
    const reply = await restoreGuildFromGraveyard(g, 1000);
    expect(reply).toEqual({ ok: false, code: 'io-error', error: 'the disk did not confirm the copy of entry 1000 (EIO); nothing was restored; check the disk, then restart the machine and try again' });
    const line = errors.find(e => e.startsWith(`[DataManager] Cannot restore guild ${g}: the copy of entry ${g}-1000 is written, but the disk did not confirm the sync of `));
    expect(line).toMatch(/\.copy-\d+-1000-\d+[\\/]m \(EIO\)$/);
    expect(errors.some(e => e.includes('could not be copied'))).toBe(false);
    expect(copyNamed(g)).toEqual([]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('57: under a flag set by /data/x, a restore answers T4 earlier and logs T18 quoting /data/x', async () => {
    const x = dataPath(`x${freshGuild()}`);
    stub.failDirSync(x, 'EIO');
    expect((await save(path.join(x, 'f.json'))).answer).toBe('unavailable');
    const g = freshGuild();
    bury(g, 1000);
    const reply = await restoreGuildFromGraveyard(g, 1000);
    expect(reply).toEqual({
      ok: false, code: 'io-error',
      error: 'the copy of entry 1000 is not trusted, since the disk did not confirm a folder sync earlier in this process (EIO); nothing was restored; check the disk, then restart the machine and try again',
    });
    expect(errors).toContain(`[DataManager] Cannot restore guild ${g}: the copy of entry ${g}-1000 is written, but ${syncWords('earlier', x, 'EIO').why}`);
    expect(errors.some(e => e.includes('after the copy'))).toBe(false);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('69: the copy syncs, then the open of /data fails with EMFILE at the check after it: T4 open names /data', async () => {
    const g = freshGuild();
    bury(g, 1000);
    stub.rejectDirOpen(ROOT, 'EMFILE', 1);
    const reply = await restoreGuildFromGraveyard(g, 1000);
    expect(reply).toEqual({ ok: false, code: 'io-error', error: `${DATA_ROOT} could not be opened for the sync of the copy of entry 1000 (EMFILE); nothing was restored; try again` });
    expect(folderSyncFailed()).toBe(false);
  });
});

describe.skipIf(!POSIX)('rows 11 and 29: the records after a move', () => {
  it('11: after a delete and a restore of /data/G, the next save there syncs up to /data', async () => {
    stub.statAs(new RegExp(`^${fwd(ROOT)}`), real => ({ birthtimeNs: real.birthtimeNs > 0n ? real.birthtimeNs : 7n }), 1_000_000);
    const g = freshGuild();
    expect((await save(dataPath(g, 'm', 'a.json'))).answer).toBe('ok');
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: true });
    expect(await restoreGuildFromGraveyard(g)).toMatchObject({ ok: true });
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'm', 'b.json'))).answer).toBe('ok');
    expect(stub.dirSyncs.slice(mark)).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });

  it('11: after a delete, the next save under the new /data/G syncs up to /data', async () => {
    stub.statAs(new RegExp(`^${fwd(ROOT)}`), real => ({ birthtimeNs: real.birthtimeNs > 0n ? real.birthtimeNs : 7n }), 1_000_000);
    const g = freshGuild();
    expect((await save(dataPath(g, 'm', 'a.json'))).answer).toBe('ok');
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: true });
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'm', 'b.json'))).answer).toBe('ok');
    expect(stub.dirSyncs.slice(mark)).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });

  it('11: after the undo of a replace whose put failed, the next save under /data/G syncs up to /data', async () => {
    stub.statAs(new RegExp(`^${fwd(ROOT)}`), real => ({ birthtimeNs: real.birthtimeNs > 0n ? real.birthtimeNs : 7n }), 1_000_000);
    const g = freshGuild();
    expect((await save(dataPath(g, 'm', 'a.json'))).answer).toBe('ok');
    bury(g, 1000);
    const live = path.resolve(dataPath(g));
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === live && /[\\/]\.restore-/.test(String(from))) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
      return realRename(from, to);
    });
    const reply = await restoreGuildFromGraveyard(g, 1000, undefined, true);
    expect(reply.ok).toBe(false);
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"v":1}');
    const mark = stub.dirSyncs.length;
    expect((await save(dataPath(g, 'm', 'b.json'))).answer).toBe('ok');
    expect(stub.dirSyncs.slice(mark)).toEqual([dataPath(g, 'm'), dataPath(g), ROOT]);
  });

  it('29: a delete whose /data sync answers EIO keeps its answer; a save under a new /data/G is unconfirmed, earlier', async () => {
    const g = freshGuild();
    expect((await save(dataPath(g, 'm', 'a.json'))).answer).toBe('ok');
    stub.failDirSync(ROOT, 'EIO');
    expect(await deleteGuildNamespace(g, 'test', 5000)).toEqual({ ok: true, moveUnconfirmed: 'EIO' });
    const p = dataPath(g, 'm', 'b.json');
    const { answer, t } = await save(p);
    expect(answer).toBe('unavailable');
    expect(fileTicketFailure(t)).toMatchObject({ kind: 'earlier', dir: ROOT });
    const { why, next } = syncWords('earlier', ROOT, 'EIO');
    expect(errors).toContain(`[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`);
  });
});

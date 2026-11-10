import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmFile, enqueueWrite, fileTicket, flushAll, queuedFilePaths, type FileTicket } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { carryWrites, NO_WRITES } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { BotManager } from '../../src/webui/botManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { stubAppendHandles, type AppendStub } from '../helpers/fileHandleStub';

// NB19 row 67 and T22: the web UI's landOrCancel words a change whose file is written but whose folder sync failed as
// can't confirm, with the clause and the next step of the failure's kind, never as not saved.

const POSIX = process.platform !== 'win32';
let stub: AppendStub;
let n = 0;
let guilds = 880_000_000_000_000_000n;
const entry = { label: 'x', provider: false, run: async () => undefined, again: async () => undefined, resolve: () => undefined };
const banned = /not saved|nothing was saved|Not saved/;

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stub = stubAppendHandles();
});
afterEach(async () => {
  stub.restore();
  await flushAll();
  setBackendKind(null);
  vi.restoreAllMocks();
});

function ticketOf(tracked: ReturnType<typeof saveDataTracked>): FileTicket {
  if (tracked.outcome !== 'saved' || tracked.ticket.kind !== 'file') throw new Error(`not accepted: ${tracked.outcome}`);
  return tracked.ticket;
}
async function saveUnder(scope: 'guild' | 'global'): Promise<FileTicket> {
  const category = `nb19lc${process.pid}${++n}`;
  const options = scope === 'guild' ? { scope, guildId: String(++guilds), category } : { scope, category };
  const t = ticketOf(saveDataTracked('x.json', options as never, { v: 1 }));
  return t;
}
const unconfirmedReply = (t: FileTicket) => carryWrites({ ok: false, code: 'unconfirmed', answer: 'unavailable', partial: false, error: 'e' }, { ...NO_WRITES, tickets: [t] });

describe.skipIf(!POSIX)('row 67: landOrCancel after a folder open that keeps failing', () => {
  it.each(['guild', 'global'] as const)('a %s file: T22 with the open clause and "Reload to check before you try again."', async scope => {
    const probe = await saveUnder(scope);
    await flushAll();
    const dir = path.dirname(probe.path);
    stub.rejectDirOpen(dir, 'EMFILE', 1_000);
    const t = ticketOf(saveDataTracked('x.json', { ...(scope === 'guild' ? { scope, guildId: path.basename(path.dirname(dir)) } : { scope }), category: path.basename(dir) } as never, { v: 2 }));
    expect(t.path).toBe(probe.path);
    expect(await confirmFile(t, 3000)).toBe('unavailable');
    expect(JSON.parse(fs.readFileSync(t.path, 'utf8'))).toEqual({ v: 2 });
    expect(queuedFilePaths()).not.toContain(t.path);
    const answer = await (new BotManager() as any).landOrCancel(entry, unconfirmedReply(t));
    const { why } = syncWords('open', path.resolve(dir), 'EMFILE');
    expect(answer).toEqual({
      ok: false, status: 503, code: 'disk',
      error: `Can't confirm whether your change was saved: x.json is written, but ${why}. Reload to check before you try again.`,
    });
    expect(answer.error).not.toContain('Check the disk');
    expect(answer.error).not.toMatch(banned);
  });

  it('a shared file under a flag set by EIO on /data/x: T22 with the earlier clause and the restart', async () => {
    const x = dataPath(`nb19lcx${process.pid}${++n}`);
    stub.failDirSync(x, 'EIO');
    enqueueWrite(path.join(x, 'f.json'), '{}');
    expect(await confirmFile(fileTicket(path.join(x, 'f.json')), 3000)).toBe('unavailable');
    const t = await saveUnder('global');
    expect(await confirmFile(t, 3000)).toBe('unavailable');
    expect(JSON.parse(fs.readFileSync(t.path, 'utf8'))).toEqual({ v: 1 });
    const answer = await (new BotManager() as any).landOrCancel(entry, unconfirmedReply(t));
    const { why } = syncWords('earlier', path.resolve(x), 'EIO');
    expect(answer).toEqual({
      ok: false, status: 503, code: 'disk',
      error: `Can't confirm whether your change was saved: x.json is written, but ${why}. Check the disk, then restart the machine, then reload to check before you try again.`,
    });
    expect(answer.error).not.toMatch(banned);
  });
});

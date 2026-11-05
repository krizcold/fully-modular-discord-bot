import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The executor's answers to the web UI's guild data ops: validation, the restore and namespace delete when another
// process took the data files, refusals, an unreadable stored file and the IPC route.

const h = vi.hoisted(() => ({
  holder: null as null | { pid: number; role?: string; start: string | null },
  restore: null as null | ((...a: any[]) => any),
  nsDelete: null as null | ((...a: any[]) => any),
  del: null as null | ((...a: any[]) => any),
  save: null as null | ((...a: any[]) => any),
  readRaw: null as null | ((...a: any[]) => any),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    restoreGuildFromGraveyard: (...a: any[]) => (h.restore ? h.restore(...a) : real.restoreGuildFromGraveyard(...a)),
    deleteGuildNamespace: (...a: any[]) => (h.nsDelete ? h.nsDelete(...a) : real.deleteGuildNamespace(...a)),
    deleteDataTracked: (...a: any[]) => (h.del ? h.del(...a) : real.deleteDataTracked(...a)),
    saveDataTracked: (...a: any[]) => (h.save ? h.save(...a) : real.saveDataTracked(...a)),
    readGuildDocRaw: (...a: any[]) => (h.readRaw ? h.readRaw(...a) : real.readGuildDocRaw(...a)),
  };
});

vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    deposedHolder: () => h.holder ?? real.deposedHolder(),
    checkWriterLock: () => (h.holder ? { kind: 'not-held' } : real.checkWriterLock()),
  };
});

import { applyOperatorDataWrite, setupDataIPCHandlers } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { carriedWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';

const G = '123456789012345678';
const file = () => dataPath(G, 'mod', 'x.json');
const HOLDER = { pid: 4242, role: 'bot', start: null };
const DEPOSED = 'Another process took the data files';

function put(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.holder = null;
  h.restore = h.nsDelete = h.del = h.save = h.readRaw = null;
  await flushAll();
  fs.rmSync(dataPath(G), { recursive: true, force: true });
});

afterEach(() => {
  h.holder = null;
  h.restore = h.nsDelete = h.del = h.save = h.readRaw = null;
  vi.restoreAllMocks();
});

describe('validation of a write', () => {
  it('a module name with a slash answers invalid module and writes nothing', async () => {
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'a/b', filename: 'x.json', op: 'write', contentJson: '{"v":1}' });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'invalid module' });
    await flushAll();
    expect(fs.existsSync(dataPath(G, 'a', 'b', 'x.json'))).toBe(false);
  });

  it('a module name with .. answers invalid module', async () => {
    const reply = await applyOperatorDataWrite({ guildId: G, module: '..', filename: 'x.json', op: 'write', contentJson: '{"v":1}' });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'invalid module' });
  });
});

describe('the read a write was built on is compared for writes only', () => {
  it('a delete carrying a stale sha still deletes', async () => {
    put(file(), { v: 1 });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'delete', expectSha: 'absent' });
    expect(reply).toMatchObject({ ok: true });
    await flushAll();
    expect(fs.existsSync(file())).toBe(false);
  });
});

describe('restore from the graveyard', () => {
  it('a restore that worked answers ok', async () => {
    h.restore = async () => ({ ok: true });
    expect(await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'restore-graveyard' })).toEqual({ ok: true });
  });

  it('a refused restore answers invalid with its reason', async () => {
    h.restore = async () => ({ ok: false, code: 'invalid', error: 'nothing in the graveyard' });
    expect(await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'restore-graveyard' })).toEqual({ ok: false, code: 'invalid', error: 'nothing in the graveyard' });
  });

  it('a refused restore after another process took the data files answers held-elsewhere, not ok', async () => {
    h.restore = async () => {
      h.holder = HOLDER;
      return { ok: false, error: 'refused' };
    };
    const reply = await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'restore-graveyard' });
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('held-elsewhere');
    expect(reply.error).toContain(DEPOSED);
    expect(reply.error).toContain('pid 4242');
  });
});

describe('deleting a guild namespace', () => {
  it('a delete that moved the data answers ok', async () => {
    h.nsDelete = async () => ({ ok: true });
    expect(await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'delete-namespace' })).toEqual({ ok: true });
  });

  it('a failed delete with no other writer answers io-error: nothing was removed', async () => {
    h.nsDelete = async () => ({ ok: false, code: 'io-error', error: 'guild data delete failed; nothing was removed' });
    expect(await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'delete-namespace' })).toEqual({ ok: false, code: 'io-error', error: 'guild data delete failed; nothing was removed' });
  });

  it('a failed delete after another process took the data files answers held-elsewhere', async () => {
    h.nsDelete = async () => {
      h.holder = HOLDER;
      return { ok: false, code: 'io-error', error: 'guild data delete failed; nothing was removed' };
    };
    const reply = await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'delete-namespace' });
    expect(reply).toMatchObject({ ok: false, code: 'held-elsewhere' });
    expect(reply.error).toContain(DEPOSED);
  });
});

describe('a refused write answers with the truthful text of a whole write', () => {
  it('a refused delete is not ok and says the change was not saved', async () => {
    h.del = () => ({ outcome: 'refused', cause: 'node-stopping' });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'delete' });
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: 'The bot is restarting, so your change was not saved. Please try again in a moment.' });
  });

  it('a refused save is not ok and says the change was not saved', async () => {
    h.save = () => ({ outcome: 'refused', cause: 'node-stopping' });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":1}' });
    expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: 'The bot is restarting, so your change was not saved. Please try again in a moment.' });
  });

  it('a save that threw answers io-error and its reply carries no writes', async () => {
    h.save = () => {
      throw new Error('disk on fire');
    };
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":1}' });
    expect(reply).toEqual({ ok: false, code: 'io-error', error: 'disk on fire' });
    expect(carriedWrites(reply)).toBeUndefined();
  });

  it('a save that was refused still carries its (empty) writes', async () => {
    h.save = () => ({ outcome: 'refused', cause: 'node-stopping' });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":1}' });
    expect(carriedWrites(reply)).toMatchObject({ tickets: [], refused: false });
  });
});

describe('a global twin that cannot be read', () => {
  it('answers invalid with the twin\'s own error, and is not ok', async () => {
    put(file(), { v: 1 });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":2}', twin: { rel: '../evil.json', expectSha: 'absent' } });
    expect(reply).toEqual({ ok: false, code: 'invalid', error: 'invalid global file' });
    await flushAll();
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ v: 1 });
  });
});

describe('a stored file that cannot be read for the compare', () => {
  const write = () => applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":2}', expectSha: 'absent' });

  it('an error with a code answers io-error naming the code, and nothing is saved', async () => {
    h.readRaw = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    expect(await write()).toEqual({ ok: false, code: 'io-error', error: 'the stored file cannot be read (EACCES); nothing was saved' });
    h.readRaw = null;
    await flushAll();
    expect(fs.existsSync(file())).toBe(false);
  });

  it('an error without a code answers unknown error', async () => {
    h.readRaw = () => {
      throw new Error('no code here');
    };
    expect(await write()).toEqual({ ok: false, code: 'io-error', error: 'the stored file cannot be read (unknown error); nothing was saved' });
  });

  it('a thrown undefined answers unknown error', async () => {
    h.readRaw = () => {
      throw undefined;
    };
    expect(await write()).toEqual({ ok: false, code: 'io-error', error: 'the stored file cannot be read (unknown error); nothing was saved' });
  });
});

describe('the guild data IPC route', () => {
  let saved: typeof process.send;
  let before: Function[];

  beforeEach(() => {
    saved = process.send;
    before = process.listeners('message');
  });

  afterEach(() => {
    for (const l of process.listeners('message')) if (!before.includes(l)) process.removeListener('message', l as any);
    process.send = saved;
  });

  async function ask(message: object): Promise<any> {
    const send = vi.fn(() => true);
    process.send = send as any;
    setupDataIPCHandlers();
    process.emit('message' as any, message as any);
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 2000, interval: 5 });
    return (send.mock.calls[0] as any[])[0];
  }

  it('a write is answered with the write\'s own reply', async () => {
    const sent = await ask({ type: 'data:guild-write', requestId: 'r1', data: { guildId: 'nope' } });
    expect(sent.requestId).toBe('r1');
    expect(sent.data).toMatchObject({ ok: false, code: 'invalid', error: 'invalid guildId' });
  });

  it('a read is answered with the stored text', async () => {
    put(file(), { v: 7 });
    const sent = await ask({ type: 'data:guild-read', requestId: 'r2', data: { guildId: G, module: 'mod', filename: 'x.json' } });
    expect(sent.requestId).toBe('r2');
    expect(sent.data.ok).toBe(true);
    expect(JSON.parse(sent.data.contentJson)).toEqual({ v: 7 });
  });
});

import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { Client } from '../../src/cli/client';
import { dispatch } from '../../src/cli/commands';
import { EXIT_ERR, EXIT_USAGE } from '../../src/cli/output';
import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import { createConfigRoutes } from '../../src/webui/routes/config';
import type { BotManager } from '../../src/webui/botManager';
import { applyOperatorDataWrite, CHANGED_SINCE_OPEN_TEXT, shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { restoreGuildFromGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { FakeChild, botFor, call, resetData, startApp } from '../helpers/configRig';
import { forks } from '../helpers/forkMock';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

// NB11 tests 4 (wip-redesign/sheets/NB11.md, decisions 10 to 12, 18 to 20): the graveyard route, the CLI verb, the
// web UI's wait and stamp for a restore and a delete, and the delete's texts through config.ts.

const G = '123456789012345678';
const MINUTE = "Within a minute, if it was restored, the server's data is back and its entry is gone from `smdb graveyard list`; if not, the entry is still listed, unless it had passed the graveyard's keep time and the graveyard sweep removed it, data and all.";
const DELETE_MINUTE = "Within a minute, `smdb graveyard list` lists a new entry for this server if it was deleted; if no new entry is listed by then, it was not.";
const liveText = (r: number) => `live guild data exists; nothing was restored. To restore entry ${r}, delete this server's data, then restore with retiredAt ${r} before the bot saves anything new for the server; data it saves in between blocks the restore again. While the server's members are active, remove the bot from the server first and add it back after the restore.`;
const unknownText = (r: number) => `can't confirm whether server ${G} was restored: the database did not confirm the commit. Within a minute, if it was restored, the server's data is back and entry ${r} is gone from \`smdb graveyard list\`; if not, the entry is still listed, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all.`;
const WHOLE_MS = 'retiredAt must be a whole number of milliseconds';

beforeEach(async () => {
  quiet();
  setBackendKind('file');
  await resetData();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function graveyardApp(reply: (req: any) => unknown) {
  const requests: any[] = [];
  const manager = { writeGuildData: async (req: any) => { requests.push(req); return reply(req); } } as unknown as BotManager;
  return { requests, start: () => startApp(app => app.use('/api/data/graveyard', createGraveyardRoutes(manager))) };
}

describe('the restore route', () => {
  it.each([
    ['ok', { ok: true, retiredAt: 5, reason: 'webui-operator-delete', moved: 3 }, 200, { success: true, retiredAt: 5, reason: 'webui-operator-delete', moved: 3 }],
    ['live data', { ok: false, code: 'invalid', error: liveText(5) }, 409, { success: false, error: liveText(5) }],
    ['not loaded', { ok: false, code: 'backend-unavailable', error: "this server's data is not loaded in this bot process; nothing was restored; try again in a moment" }, 503, { success: false, error: "this server's data is not loaded in this bot process; nothing was restored; try again in a moment" }],
    ['unknown', { ok: false, code: 'backend-unavailable', error: unknownText(5) }, 503, { success: false, error: unknownText(5) }],
    ['deposed', { ok: false, code: 'not-owner', error: "another bot process now serves this server's data; nothing was restored" }, 503, { success: false, error: "another bot process now serves this server's data; nothing was restored" }],
    ['an error in the bot', { ok: false, code: 'io-error', error: 'the restore stopped on an error in the bot (boom); nothing was restored; see the bot log' }, 500, { success: false, error: 'the restore stopped on an error in the bot (boom); nothing was restored; see the bot log' }],
    ['maintenance', { ok: false, code: 'maintenance', error: 'down for a moment' }, 503, { success: false, error: 'down for a moment' }],
    ['frozen', { ok: false, code: 'frozen' }, 503, { success: false, error: "This guild's shard is not served by this bot process right now, so nothing was changed; retry in a moment" }],
  ] as const)('%s answers its status and text', async (_name, reply, status, body) => {
    const { start } = graveyardApp(() => reply);
    const app = await start();
    try {
      const res = await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: G, retiredAt: 5 });
      expect(res.status).toBe(status);
      expect(res.body).toEqual(body);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['timeout', `can't confirm whether server ${G} was restored: the bot did not answer within 50 s. ${MINUTE}`],
    ['stopped', `can't confirm whether server ${G} was restored: the bot process stopped before answering. ${MINUTE}`],
    ['failed', `can't confirm whether server ${G} was restored: the request could not be handed to the bot. ${MINUTE}`],
  ] as const)('a reply with noAnswer %s answers 503 can\'t confirm, never "nothing was restored"', async (noAnswer, text) => {
    const { start } = graveyardApp(() => ({ ok: false, code: 'io-error', noAnswer, error: 'IPC request timed out' }));
    const app = await start();
    try {
      const res = await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: G });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe(text);
      expect(res.body.error).not.toContain('nothing was restored');
      expect(res.body.error).toContain("unless it had passed the graveyard's keep time");
    } finally {
      await app.close();
    }
  });

  it('the unknown text holds the expiry clause', () => {
    expect(unknownText(5)).toContain("unless it had passed the graveyard's keep time");
  });

  it.each([1.5, -1, 2 ** 53, '5'])('retiredAt %s answers 400 at the route and invalid at the IPC handler', async retiredAt => {
    const { requests, start } = graveyardApp(() => ({ ok: true }));
    const app = await start();
    try {
      const res = await call(app.url, 'POST', '/api/data/graveyard/restore', { guildId: G, retiredAt });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(WHOLE_MS);
      expect(requests).toEqual([]);
    } finally {
      await app.close();
    }
    expect(await applyOperatorDataWrite({ guildId: G, module: '', filename: '', op: 'restore-graveyard', contentJson: JSON.stringify({ retiredAt }) })).toEqual({ ok: false, code: 'invalid', error: WHOLE_MS });
  });
});

describe('the CLI verb', () => {
  const exits: number[] = [];
  let stdout: string[];
  let stderr: string[];
  beforeEach(() => {
    exits.length = 0;
    stdout = [];
    stderr = [];
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { exits.push(code); throw new Error(`exit ${code}`); }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { stdout.push(String(chunk)); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true; }) as never);
  });

  async function server(handler: http.RequestListener) {
    const srv = http.createServer(handler);
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as AddressInfo).port;
    return { client: new Client({ host: '127.0.0.1', port }), close: () => new Promise<void>(resolve => { srv.closeAllConnections(); srv.close(() => resolve()); }) };
  }

  it.each(['1.5', '-1', String(2 ** 53), 'x'])('retiredAt %s exits with the usage code', async raw => {
    const { client, close } = await server((_req, res) => { res.end('{}'); });
    try {
      await dispatch(client, ['graveyard', 'restore', G, raw], {}).catch(() => undefined);
      expect(exits).toEqual([EXIT_USAGE]);
      expect(stderr.join('')).toContain(WHOLE_MS);
    } finally {
      await close();
    }
  });

  it('a cut answer prints the can\'t confirm text and exits with the failure code', async () => {
    const { client, close } = await server((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"success":');
      setTimeout(() => res.socket?.destroy(), 10);
    });
    try {
      await dispatch(client, ['graveyard', 'restore', G], {}).catch(() => undefined);
      expect(exits).toEqual([EXIT_ERR]);
      expect(stderr.join('')).toContain(`can't confirm whether server ${G} was restored: the web UI did not answer. ${MINUTE}`);
    } finally {
      await close();
    }
  });

  it('an ok answer prints the restored entry and the rows moved', async () => {
    const { client, close } = await server((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, retiredAt: 5000, reason: 'webui-operator-delete', moved: 3 }));
    });
    const tty = process.stdout.isTTY;
    (process.stdout as any).isTTY = true;
    try {
      await dispatch(client, ['graveyard', 'restore', G], {}).catch(() => undefined);
      expect(exits).toEqual([0]);
      expect(stdout.join('')).toContain(`restored server ${G} from the entry deleted at ${new Date(5000).toISOString()} (retiredAt 5000, reason webui-operator-delete)`);
      expect(stdout.join('')).toContain('3 row(s) moved');
    } finally {
      (process.stdout as any).isTTY = tty;
      await close();
    }
  });
});

describe('the web UI\'s wait and stamp', () => {
  beforeEach(() => {
    resetForks();
    freshWriterLock('webui');
  });
  afterEach(() => {
    for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  });

  it('a restore and a delete carry answerByMono 45 s ahead and wait 50 s; other ops wait 15 s with none', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    answering(child, () => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const before = process.hrtime.bigint();
    const write = manager.writeGuildData({ guildId: G, module: 'm', filename: 'x.json', op: 'write', contentJson: '{}', expectSha: 'absent' });
    const restore = manager.writeGuildData({ guildId: G, module: '', filename: '', op: 'restore-graveyard', contentJson: '{}' });
    const del = manager.writeGuildData({ guildId: G, module: '', filename: '', op: 'delete-namespace' });
    const after = process.hrtime.bigint();
    const sent = sentTo(child, 'data:guild-write').map(m => m.data);
    expect(sent.find(d => d.op === 'write').answerByMono).toBeUndefined();
    for (const op of ['restore-graveyard', 'delete-namespace']) {
      const stamp = BigInt(sent.find(d => d.op === op).answerByMono);
      expect(stamp >= before + 45_000_000_000n && stamp <= after + 45_000_000_000n).toBe(true);
    }
    const settled: Record<string, unknown> = {};
    void write.then(v => { settled.write = v; });
    void restore.then(v => { settled.restore = v; });
    void del.then(v => { settled.del = v; });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(settled.write).toMatchObject({ noAnswer: 'timeout' });
    expect(settled.restore).toBeUndefined();
    expect(settled.del).toBeUndefined();
    await vi.advanceTimersByTimeAsync(33_900);
    expect(settled.restore).toBeUndefined();
    expect(settled.del).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(settled.restore).toMatchObject({ ok: false, code: 'io-error', noAnswer: 'timeout' });
    expect(settled.del).toMatchObject({ ok: false, code: 'io-error', noAnswer: 'timeout' });
  });
});

describe('the delete through config.ts', () => {
  function deleteApp(reply: unknown) {
    const manager = { writeGuildData: async () => reply, isRunning: () => true, writeRefusal: () => null } as unknown as BotManager;
    return startApp(app => app.use('/api/config', createConfigRoutes(manager)));
  }

  it.each([
    ['unknown', { ok: false, code: 'backend-unavailable', error: `can't confirm whether this server's data was deleted: the database did not confirm the commit. ${DELETE_MINUTE}` }, 503],
    ['during a restore', { ok: false, code: 'invalid', error: 'a restore of this server from the graveyard is running; nothing was removed; try again once it ends' }, 400],
    ['the flush refusal', { ok: false, code: 'backend-unavailable', error: "the server's unsaved changes are not confirmed saved yet; nothing was removed; try again in a moment" }, 503],
    ['a failing file', { ok: false, code: 'backend-unavailable', error: "a file of this server keeps failing to save (m/a.json: ENOSPC); nothing was removed; free disk space or fix the file's permissions, then try again" }, 503],
    ['unavailable', { ok: false, code: 'backend-unavailable', error: 'the database did not answer or ended the connection (x); nothing was removed; try again in a moment' }, 503],
    ['the timeout', { ok: false, code: 'backend-unavailable', error: 'the database did not finish the delete within its 40 s; nothing was removed; try again in a moment' }, 503],
    ['out-of-time', { ok: false, code: 'backend-unavailable', error: 'the delete ran out of its 40 s before it could commit; nothing was removed; try again in a moment' }, 503],
  ] as const)('%s answers its status and text', async (_name, reply, status) => {
    const app = await deleteApp(reply);
    try {
      const res = await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G });
      expect(res.status).toBe(status);
      expect(res.body.error).toBe(reply.error);
    } finally {
      await app.close();
    }
  });

  it.each([
    [{ ok: true, moveUnconfirmed: 'EIO' }, { success: true, warning: "The disk did not confirm the move of this server's folder (EIO), so a power cut can undo the delete. Check the disk." }],
    [{ ok: true }, { success: true }],
  ] as const)('D2: an ok reply %j answers 200 with %j', async (reply, body) => {
    const app = await deleteApp(reply);
    try {
      const res = await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(body);
    } finally {
      await app.close();
    }
  });

  it('a deposed flush answers 503 with the text that nothing was removed', async () => {
    const error = "another bot process now serves this server's data; nothing was removed";
    const app = await deleteApp({ ok: false, code: 'not-owner', error });
    try {
      const res = await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G });
      expect(res.status).toBe(503);
      expect(res.body.error).toContain(error);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['timeout', 'The bot did not answer in time'],
    ['stopped', 'The bot stopped before answering'],
    ['failed', 'The bot did not answer'],
  ] as const)('a delete with noAnswer %s names the graveyard list within a minute', async (noAnswer, lead) => {
    const app = await deleteApp({ ok: false, code: 'io-error', noAnswer, error: 'x' });
    try {
      const res = await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe(`${lead}; can't confirm whether this server's data was deleted. ${DELETE_MINUTE}`);
      expect(res.body.error).not.toContain('Reload to check.');
    } finally {
      await app.close();
    }
  });
});

describe('a web UI write during a restore on a JSON bot', () => {
  it('is refused while the restore holds the guild, and one built on a read from before the restore answers changed', async () => {
    fs.mkdirSync(dataPath(G, 'm'), { recursive: true });
    fs.writeFileSync(dataPath(G, 'm', 'a.json'), '{"n":5}');
    const child = new FakeChild();
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(botFor(child))));
    const SIX = JSON.stringify({ n: 6 }, null, 2);
    try {
      const loaded = await call(app.url, 'GET', `/api/config/data/get?file=${encodeURIComponent('m/a.json')}&guildId=${G}`);
      const loadedSha = loaded.body.sha as string;
      expect((await call(app.url, 'POST', '/api/config/data/update', { file: 'm/a.json', guildId: G, data: { n: 6 }, loadedSha })).status).toBe(200);
      expect(fs.readFileSync(dataPath(G, 'm', 'a.json'), 'utf8')).toBe(SIX);
      expect((await call(app.url, 'POST', '/api/config/data/delete-guild', { guildId: G })).status).toBe(200);
      expect(fs.existsSync(dataPath(G))).toBe(false);
      const whileDeleted = await call(app.url, 'GET', `/api/config/data/get?file=${encodeURIComponent('m/a.json')}&guildId=${G}`);
      expect(whileDeleted.status).toBe(404);
      const deletedSha = shaOfRaw(null);
      const backups = await call(app.url, 'GET', `/api/config/backups?file=${encodeURIComponent('m/a.json')}&guildId=${G}&category=data`);
      const backup = backups.body.backups[0].filename as string;

      const readdir = fs.promises.readdir.bind(fs.promises);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let holding = true;
      vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
        if (holding && path.resolve(String(args[0])) === path.resolve(dataPath('_graveyard'))) {
          holding = false;
          await held;
        }
        return (readdir as any)(...args);
      }) as any);
      const writes = child.writes.length;
      const restoring = restoreGuildFromGraveyard(G);
      const during = await call(app.url, 'POST', '/api/config/restore', { file: 'm/a.json', filename: backup, guildId: G, category: 'data' });
      expect(child.writes.slice(writes).map(w => w.op)).toEqual(['write']);
      expect(during.status).toBe(503);
      expect(during.body).toEqual({ success: false, error: "This server's data is still loading, so your change was not saved. Please try again in a moment." });
      expect(vi.mocked(console.warn).mock.calls.map(c => c.map(String).join(' '))).toContain(`[Data] Write for guild ${G} refused: its data is being restored from the graveyard`);
      expect(fs.existsSync(dataPath(G))).toBe(false);
      release();
      expect(await restoring).toMatchObject({ ok: true });
      expect(fs.readdirSync(dataPath(G))).toEqual(['m']);
      expect(fs.readdirSync(dataPath(G, 'm'))).toEqual(['a.json']);
      expect(fs.readFileSync(dataPath(G, 'm', 'a.json'), 'utf8')).toBe(SIX);
      const after = await call(app.url, 'POST', '/api/config/data/update', { file: 'm/a.json', guildId: G, data: { n: 0 }, loadedSha });
      expect(after.status).toBe(409);
      expect(fs.readFileSync(dataPath(G, 'm', 'a.json'), 'utf8')).toBe(SIX);
      const fromDeleted = await call(app.url, 'POST', '/api/config/data/update', { file: 'm/a.json', guildId: G, data: { n: 0 }, loadedSha: deletedSha });
      expect(fromDeleted.status).toBe(409);
      expect(fromDeleted.body).toEqual({ success: false, error: CHANGED_SINCE_OPEN_TEXT });
      expect(fs.readFileSync(dataPath(G, 'm', 'a.json'), 'utf8')).toBe(SIX);
      expect(fs.readdirSync(dataPath(G, 'm'))).toEqual(['a.json']);
    } finally {
      await app.close();
    }
  });
});

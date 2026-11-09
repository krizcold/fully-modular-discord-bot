import fs from 'fs';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/webui/auth/guildPermissionRefresher', () => ({ refreshUserGuilds: async (user: unknown) => user }));
vi.mock('../../src/webui/auth/oauthMiddleware', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/webui/auth/oauthMiddleware')>();
  return { ...real, saveRefreshedUser: async () => undefined };
});

// NB15 test 2 through the real routers (createCommandRoutes, createPanelRoutes, createGuildPanelRoutes,
// createSetupRoutes) and the real BotManager methods: the invoke route's statuses, the guild id check of the admin
// action routes on both backends, the member routes' access check before the plan, the child's no-answer conversion,
// and 'control:guild-webui' at the guild report and after a credentials save.
import { createCommandRoutes } from '../../src/webui/routes/commands';
import { createPanelRoutes } from '../../src/webui/routes/panels';
import { createGuildPanelRoutes } from '../../src/webui/routes/guildPanels';
import { createSetupRoutes } from '../../src/webui/routes/setup';
import { BotManager } from '../../src/webui/botManager';
import { isGuildWebUIEnabled } from '../../src/webui/auth/oauthConfig';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { BOT_DOWN, GUILD, fakeTime, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

let rig: Rig;

function handler(router: any, method: string, routePath: string): (req: any, res: any) => Promise<void> {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const out = { status: 200, body: undefined as any };
  const res: any = { status: (code: number) => { out.status = code; return res; }, json: (body: any) => { out.body = body; return res; } };
  return { res, out };
}

async function call(router: any, method: 'get' | 'post', routePath: string, req: Record<string, any>) {
  const { res, out } = fakeRes();
  await handler(router, method, routePath)({ body: {}, query: {}, session: {}, ...req }, res);
  return out;
}

function bot(reply: any = { success: true, data: { content: 'View' } }, over: Record<string, any> = {}) {
  const sentIpc: Array<{ type: string; data: any }> = [];
  const b: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sentIpc.push({ type, data }); return typeof reply === 'function' ? reply(type, data) : reply; },
    invokeCommand: async (data: any) => { sentIpc.push({ type: 'command:invoke', data }); return reply; },
    getPanelList: async () => { sentIpc.push({ type: 'panel:list', data: {} }); return reply; },
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
    isUserDev: async () => ({ success: true, isDev: false }),
    ...over,
  };
  return { b, sentIpc };
}

beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  resetNb7();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /api/commands/invoke through createCommandRoutes', () => {
  const invoke = (reply: any, body: Record<string, unknown> = {}) => call(createCommandRoutes(bot(reply).b), 'post', '/invoke', { body: { command: 'probe', guildId: GUILD, ...body } });

  it('answers 200 for success, 400 for ran: false and 500 for a command that ran and failed', async () => {
    expect((await invoke({ success: true, ran: true, captured: [] })).status).toBe(200);
    expect(await invoke({ success: false, ran: false, error: 'no such command: probe' })).toMatchObject({ status: 400, body: { success: false, ran: false } });
    expect(await invoke({ success: false, ran: true, truth: 'deposed', error: 'The action ran, but another bot process took over.' })).toMatchObject({ status: 500, body: { ran: true } });
  });

  it('a child that never answered is 503 no-answer, never 500', async () => {
    expect(await invoke({ success: false, error: 'IPC request timed out', noAnswer: 'timeout' })).toMatchObject({ status: 503, body: { code: 'no-answer', noAnswer: 'timeout' } });
    expect(await invoke({ success: false, error: 'bot process exited before replying', noAnswer: 'stopped' })).toMatchObject({ status: 503, body: { code: 'no-answer', noAnswer: 'stopped' } });
  });

  it('refuses a non-numeric or out-of-range guild id with 400 and sends nothing', async () => {
    for (const guildId of ['abc', '99999999999999999999']) {
      const { b, sentIpc } = bot();
      const out = await call(createCommandRoutes(b), 'post', '/invoke', { body: { command: 'probe', guildId } });
      expect(out.status, guildId).toBe(400);
      expect(sentIpc).toHaveLength(0);
    }
    expect(rig.statements).toHaveLength(0);
  });
});

describe('the admin action routes refuse a bad guild id with 400 on both backends (test 2)', () => {
  const ROUTES: Array<['get' | 'post', string, Record<string, unknown>]> = [
    ['post', '/execute', { panelId: 'p' }],
    ['post', '/button', { panelId: 'p', buttonId: 'b' }],
    ['post', '/dropdown', { panelId: 'p', values: ['a'] }],
    ['post', '/modal', { panelId: 'p', modalId: 'm', fields: {} }],
    ['get', '/list', {}],
    ['get', '/channels', {}],
    ['get', '/roles', {}],
  ];
  it.each((['file', 'postgres'] as const).flatMap(kind => ROUTES.map(([m, p, body]) => [kind, m, p, body] as const)))('%s %s %s', async (kind, method, routePath, body) => {
    setBackendKind(kind);
    for (const guildId of ['abc', '99999999999999999999']) {
      const { b, sentIpc } = bot();
      const req = method === 'post' ? { body: { ...body, guildId, userId: 'web-ui-owner' } } : { query: { guildId } };
      const out = await call(createPanelRoutes(b), method, routePath, req);
      expect(out.status, `${routePath} ${guildId}`).toBe(400);
      expect(out.body.success).toBe(false);
      expect(sentIpc).toHaveLength(0);
    }
    expect(rig.statements.filter(s => s.sql === REQUEST_INSERT_SQL)).toHaveLength(0);
    expect(rig.holderCalls).toHaveLength(0);
  });
});

describe('the member routes keep their access check before the plan', () => {
  const SERVER = '200000000000000000';
  const stranger = { id: '123456789012345678', username: 'm', guilds: [{ id: SERVER, permissions: '0', owner: false }] };
  it.each([
    ['post', '/execute', { panelId: 'p', guildId: SERVER }],
    ['post', '/button', { panelId: 'p', buttonId: 'b', guildId: SERVER }],
    ['post', '/dropdown', { panelId: 'p', values: ['a'], guildId: SERVER }],
    ['post', '/modal', { panelId: 'p', modalId: 'm', fields: {}, guildId: SERVER }],
    ['get', '/channels', { guildId: SERVER }],
    ['get', '/roles', { guildId: SERVER }],
  ] as const)('%s %s: 403 with no holder statement, no insert and no IPC', async (method, routePath, fields) => {
    const { b, sentIpc } = bot(undefined, { writerRoute: () => BOT_DOWN, isRunning: () => false });
    const req = method === 'post' ? { body: fields, user: stranger } : { query: fields, user: stranger };
    const out = await call(createGuildPanelRoutes(b), method, routePath, req);
    expect(out.status).toBe(403);
    expect(rig.holderCalls).toHaveLength(0);
    expect(rig.statements).toHaveLength(0);
    expect(sentIpc).toHaveLength(0);
  });
});

/** A BotManager with only what panelIpc and the guild-webui sender read: a child that the test drives. */
function manager() {
  const child: any = new EventEmitter();
  child.sent = [] as any[];
  child.send = (message: any) => { child.sent.push(message); };
  const m: any = Object.create(BotManager.prototype);
  Object.assign(m, {
    botProcess: child, pendingIpcRejects: new Set(), stageWaiters: [], childStage: 'none',
    isRunning: () => true, stageReached: () => true,
  });
  return { m, child };
}

describe("BotManager.panelIpc: the child's no answer becomes noAnswer (test 2)", () => {
  it("a child that never replies: noAnswer 'timeout' after 30 s", async () => {
    const { m, child } = manager();
    let reply: any;
    void m.panelIpc('panel:button', { panelId: 'p' }).then((r: any) => { reply = r; });
    expect(child.sent[0]).toMatchObject({ type: 'panel:button' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(reply).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1500);
    expect(reply).toMatchObject({ success: false, noAnswer: 'timeout' });
  });

  it.each(['file', 'postgres'] as const)("%s: POST /button over the real panelIpc answers 503 no-answer with can't confirm when the child never replies or exits", async kind => {
    setBackendKind(kind);
    for (const end of ['timeout', 'exit'] as const) {
      const { m } = manager();
      m.writerRoute = () => ({ route: 'child' });
      m.emitPanelUpdate = () => undefined;
      const { res, out } = fakeRes();
      const done = handler(createPanelRoutes(m), 'post', '/button')({ body: { panelId: 'p', buttonId: 'b', guildId: GUILD, userId: 'web-ui-owner' }, query: {} }, res);
      await vi.advanceTimersByTimeAsync(10);
      if (end === 'exit') m.failPendingIpc('bot process exited before replying');
      else await vi.advanceTimersByTimeAsync(31_000);
      await done;
      expect(out.status, `${kind} ${end}`).toBe(503);
      expect(out.body).toMatchObject({ success: false, code: 'no-answer', noAnswer: end === 'exit' ? 'stopped' : 'timeout' });
      expect(out.body.error).toMatch(/can't confirm whether the panel action ran\. Check the server before you run it again\.$/);
    }
  });

  it.each(['bot process exited before replying', 'bot process was stopped before replying'])("a child gone before it replied (%s): noAnswer 'stopped'", async message => {
    const { m } = manager();
    const pending = m.panelIpc('command:invoke', { command: 'probe' });
    await vi.advanceTimersByTimeAsync(10);
    m.failPendingIpc(message);
    expect(await pending).toMatchObject({ success: false, noAnswer: 'stopped', error: message });
  });

  it('any other failure carries no noAnswer', async () => {
    const { m } = manager();
    m.botProcess.send = () => { throw new Error('channel closed'); };
    expect(await m.panelIpc('panel:button', {})).toEqual({ success: false, error: 'channel closed' });
  });
});

describe("'control:guild-webui' (decision 3, ruling 15)", () => {
  beforeEach(() => { fs.rmSync(dataPath('.env'), { force: true }); });

  it("the current child's guild report sends the setting with isGuildWebUIEnabled(); another child's report does not", () => {
    const { m, child } = manager();
    m.noteWriterStage(child, { stage: 'shared' });
    expect(child.sent).toEqual([]);
    m.noteWriterStage(child, { stage: 'guild' });
    expect(child.sent).toEqual([{ type: 'control:guild-webui', data: { enabled: isGuildWebUIEnabled() } }]);
    const standby: any = new EventEmitter();
    standby.sent = [];
    standby.send = (msg: any) => standby.sent.push(msg);
    m.noteWriterStage(standby, { stage: 'guild' });
    expect(standby.sent).toEqual([]);
    expect(child.sent).toHaveLength(1);
  });

  it('a promoted standby, once it is the current child, gets the setting at its guild report', () => {
    const { m } = manager();
    const promoted: any = new EventEmitter();
    promoted.sent = [];
    promoted.send = (msg: any) => promoted.sent.push(msg);
    m.botProcess = promoted;
    m.childStage = 'none';
    m.noteWriterStage(promoted, { stage: 'guild' });
    expect(promoted.sent).toEqual([{ type: 'control:guild-webui', data: { enabled: isGuildWebUIEnabled() } }]);
  });

  it('a credentials save through the setup route while the child runs sends it again with the new value', async () => {
    const { m, child } = manager();
    m.noteWriterStage(child, { stage: 'guild' });
    expect(child.sent[0].data.enabled).toBe(false);
    const router = createSetupRoutes({ migrationRunning: () => false, ownerChannelWriteStart: () => null, sendGuildWebUiSetting: () => m.sendGuildWebUiSetting() } as any);
    const on = await call(router, 'post', '/credentials', { body: {
      ENABLE_GUILD_WEBUI: 'true', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'a'.repeat(32),
      OAUTH_CALLBACK_URL: 'http://localhost:3000/auth/discord/callback', SESSION_SECRET: 'b'.repeat(48),
    } });
    expect(on.body?.success, JSON.stringify(on.body)).toBe(true);
    expect(isGuildWebUIEnabled()).toBe(true);
    expect(child.sent[child.sent.length - 1]).toEqual({ type: 'control:guild-webui', data: { enabled: true } });
    const off = await call(router, 'post', '/credentials', { body: { ENABLE_GUILD_WEBUI: 'false' } });
    expect(off.body?.success, JSON.stringify(off.body)).toBe(true);
    expect(child.sent[child.sent.length - 1]).toEqual({ type: 'control:guild-webui', data: { enabled: false } });
    expect(child.sent.filter((s: any) => s.type === 'control:guild-webui')).toHaveLength(3);
  });
});

describe('GET /guild/api/panels/guilds on a JSON bot (test 8): unchanged', () => {
  const S1 = '200000000000000000';
  const S2 = '300000000000000000';
  const owner = { id: '123456789012345678', username: 'm', guilds: [{ id: S1, name: 'One', icon: null, owner: true, permissions: '8' }, { id: S2, name: 'Two', icon: null, owner: true, permissions: '8' }] };

  it("lists the child's guilds the member administers, with no request row and no notice", async () => {
    setBackendKind('file');
    const { b } = bot(undefined, { getBotGuilds: async () => ({ success: true, guilds: [{ id: S1 }] }) });
    const out = await call(createGuildPanelRoutes(b), 'get', '/guilds', { user: owner });
    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
    expect(out.body.guilds.map((g: any) => g.id)).toEqual([S1]);
    expect(out.body.notice ?? null).toBeNull();
    expect(rig.holderCalls).toHaveLength(0);
    expect(rig.statements).toHaveLength(0);
  });

  it('with no child it answers 503 Bot is not running, as today', async () => {
    setBackendKind('file');
    const { b } = bot(undefined, { isRunning: () => false });
    expect(await call(createGuildPanelRoutes(b), 'get', '/guilds', { user: owner })).toEqual({ status: 503, body: { success: false, error: 'Bot is not running' } });
  });
});

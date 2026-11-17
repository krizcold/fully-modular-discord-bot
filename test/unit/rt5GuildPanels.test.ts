import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/webui/auth/guildPermissionRefresher', () => ({ refreshUserGuilds: async (user: unknown) => user }));
vi.mock('../../src/webui/auth/oauthMiddleware', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/webui/auth/oauthMiddleware')>();
  return { ...real, saveRefreshedUser: async () => undefined };
});

import { createGuildPanelRoutes } from '../../src/webui/routes/guildPanels';
import { _resetGuildRequests, _setGuildRequestDeps } from '../../src/webui/utils/guildRequests';
import { MEMBER_NOTICES, _resetMemberLists } from '../../src/webui/utils/memberGuilds';
import { setBackendKind } from '../helpers/backendKind';

const S1 = '200000000000000000';
const S2 = '300000000000000000';
const S3 = '400000000000000000';
let userSeq = 0;

function member(guilds: any[]) {
  userSeq += 1;
  return { id: String(500000000000000000n + BigInt(userSeq)), username: 'm', guilds };
}

const adminOf = (id: string, name = 'G') => ({ id, name, icon: null, owner: true, permissions: '8' });

function handler(router: any, method: string, routePath: string): (req: any, res: any) => Promise<void> {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function call(router: any, method: 'get' | 'post', routePath: string, req: Record<string, any>) {
  const out = { status: 200, body: undefined as any };
  const res: any = { status: (code: number) => { out.status = code; return res; }, json: (body: any) => { out.body = body; return res; }, writableFinished: true, once: () => res };
  await handler(router, method, routePath)({ body: {}, query: {}, session: {}, ...req }, res);
  return out;
}

function bot(reply: any, over: Record<string, any> = {}) {
  const sent: Array<{ type: string; data: any }> = [];
  const b: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sent.push({ type, data }); return reply; },
    isUserDev: async () => ({ success: true, isDev: false }),
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
    ...over,
  };
  return { b, sent };
}

beforeEach(() => {
  _resetGuildRequests();
  _resetMemberLists();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  _resetMemberLists();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('POST /dropdown and /modal on a JSON bot: the IPC payload and the answer', () => {
  beforeEach(() => { setBackendKind('file'); });

  it('/dropdown sends the channel id the page gave, null when it gave none, and answers the panel', async () => {
    const user = member([adminOf(S1)]);
    const { b, sent } = bot({ success: true, data: { content: 'Picked' } });
    const out = await call(createGuildPanelRoutes(b), 'post', '/dropdown', { body: { panelId: 'p', values: ['a'], dropdownId: 'd', guildId: S1, channelId: 'C1' }, user });
    expect(out).toEqual({ status: 200, body: { success: true, panel: { content: 'Picked' } } });
    expect(sent).toEqual([{ type: 'panel:dropdown', data: { panelId: 'p', values: ['a'], userId: user.id, dropdownId: 'd', channelId: 'C1', guildId: S1 } }]);
    const none = await call(createGuildPanelRoutes(b), 'post', '/dropdown', { body: { panelId: 'p', values: ['a'], guildId: S1 }, user });
    expect(none.status).toBe(200);
    expect(sent[1].data.channelId).toBeNull();
  });

  it('/dropdown answers panel null when the bot sent no view', async () => {
    const { b } = bot({ success: true });
    const out = await call(createGuildPanelRoutes(b), 'post', '/dropdown', { body: { panelId: 'p', values: ['a'], guildId: S1 }, user: member([adminOf(S1)]) });
    expect(out.body).toEqual({ success: true, panel: null });
  });

  it("/dropdown: a failed reply with no words of its own answers 'Failed to handle dropdown'", async () => {
    const { b } = bot({ success: false });
    const out = await call(createGuildPanelRoutes(b), 'post', '/dropdown', { body: { panelId: 'p', values: ['a'], guildId: S1 }, user: member([adminOf(S1)]) });
    expect(out).toEqual({ status: 500, body: { success: false, error: 'Failed to handle dropdown' } });
  });

  it('/modal sends the fields and the channel id the page gave, null when it gave none, and answers the panel', async () => {
    const user = member([adminOf(S1)]);
    const { b, sent } = bot({ success: true, data: { content: 'Saved form' } });
    const out = await call(createGuildPanelRoutes(b), 'post', '/modal', { body: { panelId: 'p', modalId: 'm', fields: { name: 'x' }, guildId: S1, channelId: 'C1' }, user });
    expect(out).toEqual({ status: 200, body: { success: true, panel: { content: 'Saved form' } } });
    expect(sent).toEqual([{ type: 'panel:modal', data: { panelId: 'p', modalId: 'm', fields: { name: 'x' }, userId: user.id, channelId: 'C1', guildId: S1 } }]);
    await call(createGuildPanelRoutes(b), 'post', '/modal', { body: { panelId: 'p', modalId: 'm', fields: {}, guildId: S1 }, user });
    expect(sent[1].data).toEqual({ panelId: 'p', modalId: 'm', fields: {}, userId: user.id, channelId: null, guildId: S1 });
  });

  it('/modal answers panel null when the bot sent no view', async () => {
    const { b } = bot({ success: true });
    const out = await call(createGuildPanelRoutes(b), 'post', '/modal', { body: { panelId: 'p', modalId: 'm', fields: {}, guildId: S1 }, user: member([adminOf(S1)]) });
    expect(out.body).toEqual({ success: true, panel: null });
  });

  it("/modal: a failed reply with no words of its own answers 'Failed to handle modal'", async () => {
    const { b } = bot({ success: false });
    const out = await call(createGuildPanelRoutes(b), 'post', '/modal', { body: { panelId: 'p', modalId: 'm', fields: {}, guildId: S1 }, user: member([adminOf(S1)]) });
    expect(out).toEqual({ status: 500, body: { success: false, error: 'Failed to handle modal' } });
  });
});

describe('GET /channels and /roles on a JSON bot', () => {
  beforeEach(() => { setBackendKind('file'); });

  it("answers the bot's channels, and 'Failed to get channels' for a failed reply with no words", async () => {
    const user = member([adminOf(S1)]);
    const channels = [{ id: 'c1', name: 'general' }];
    const ok = await call(createGuildPanelRoutes(bot({ success: true, channels }).b), 'get', '/channels', { query: { guildId: S1 }, user });
    expect(ok).toEqual({ status: 200, body: { success: true, channels } });
    const bad = await call(createGuildPanelRoutes(bot({ success: false }).b), 'get', '/channels', { query: { guildId: S1 }, user });
    expect(bad).toEqual({ status: 500, body: { success: false, error: 'Failed to get channels' } });
  });

  it("answers the bot's roles, and 'Failed to get roles' for a failed reply with no words", async () => {
    const user = member([adminOf(S1)]);
    const roles = [{ id: 'r1', name: 'Mods' }];
    const ok = await call(createGuildPanelRoutes(bot({ success: true, roles }).b), 'get', '/roles', { query: { guildId: S1 }, user });
    expect(ok).toEqual({ status: 200, body: { success: true, roles } });
    const bad = await call(createGuildPanelRoutes(bot({ success: false }).b), 'get', '/roles', { query: { guildId: S1 }, user });
    expect(bad).toEqual({ status: 500, body: { success: false, error: 'Failed to get roles' } });
  });
});

describe('GET /guilds on a JSON bot', () => {
  beforeEach(() => { setBackendKind('file'); });

  it("answers 500 'Failed to get bot guilds' when the child could not list its servers", async () => {
    const { b } = bot(null, { getBotGuilds: async () => ({ success: false }) });
    const out = await call(createGuildPanelRoutes(b), 'get', '/guilds', { user: member([adminOf(S1)]) });
    expect(out).toEqual({ status: 500, body: { success: false, error: 'Failed to get bot guilds' } });
  });

  it('a child answer with no guild list lists no server, even a session guild with no id', async () => {
    const { b } = bot(null, { getBotGuilds: async () => ({ success: true }) });
    const out = await call(createGuildPanelRoutes(b), 'get', '/guilds', { user: member([{ name: 'No id', icon: null, owner: true, permissions: '8' }, adminOf(S1)]) });
    expect(out).toEqual({ status: 200, body: { success: true, guilds: [], isDev: false } });
  });
});

describe('GET /guilds on a Postgres bot (NB15 decision 14)', () => {
  function pgDeps(rows: any[] = []) {
    const holderMapCalls: number[] = [];
    _setGuildRequestDeps({
      holderMap: async (boundMs: number) => { holderMapCalls.push(boundMs); return { rows, url: 'postgres://one' }; },
      currentUrl: () => 'postgres://one',
      nodeId: () => 'n-a',
    });
    setBackendKind('postgres');
    return holderMapCalls;
  }

  function pgBot(localGuilds: string[], childRoute: boolean) {
    const routeArgs: any[] = [];
    const getBotGuilds = vi.fn(async () => ({ success: true, guilds: localGuilds.map(id => ({ id })) }));
    const { b } = bot(null, {
      isRunning: () => false,
      writerRoute: (kind: string, opts: any) => {
        routeArgs.push([kind, opts]);
        return childRoute && opts?.postgresGuild === true ? { route: 'child' } : { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' };
      },
      getBotGuilds,
    });
    return { b, routeArgs, getBotGuilds };
  }

  it("lists the local child's servers with no child running in the file sense, and the notice for servers no machine runs", async () => {
    const holderMapCalls = pgDeps();
    const { b, routeArgs } = pgBot([S1], true);
    const out = await call(createGuildPanelRoutes(b), 'get', '/guilds', { user: member([adminOf(S1, 'One'), adminOf(S2, 'Two')]) });
    expect(out).toEqual({ status: 200, body: { success: true, guilds: [{ id: S1, name: 'One', icon: null }], isDev: false, notice: MEMBER_NOTICES.noHolder } });
    expect(routeArgs).toEqual([['guild', { postgresGuild: true }]]);
    expect(holderMapCalls).toHaveLength(1);
  });

  it("does not ask the child for its servers when the guild route is not the child's", async () => {
    pgDeps();
    const { b, getBotGuilds } = pgBot([S1], false);
    const out = await call(createGuildPanelRoutes(b), 'get', '/guilds', { user: member([adminOf(S1, 'One')]) });
    expect(out).toEqual({ status: 200, body: { success: true, guilds: [], isDev: false, notice: MEMBER_NOTICES.noHolder } });
    expect(getBotGuilds).not.toHaveBeenCalled();
  });

  it('asks other machines only about the servers the member administers', async () => {
    const holderMapCalls = pgDeps();
    const { b } = pgBot([S1], true);
    const stranger = { id: S3, name: 'Three', icon: null, owner: false, permissions: '0' };
    const out = await call(createGuildPanelRoutes(b), 'get', '/guilds', { user: member([adminOf(S1, 'One'), stranger]) });
    expect(out).toEqual({ status: 200, body: { success: true, guilds: [{ id: S1, name: 'One', icon: null }], isDev: false } });
    expect(holderMapCalls).toHaveLength(0);
  });
});

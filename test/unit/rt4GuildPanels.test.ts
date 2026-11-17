import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/webui/auth/guildPermissionRefresher', () => ({ refreshUserGuilds: async (user: unknown) => user }));
vi.mock('../../src/webui/auth/oauthMiddleware', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/webui/auth/oauthMiddleware')>();
  return { ...real, saveRefreshedUser: async () => undefined };
});

import { createGuildPanelRoutes } from '../../src/webui/routes/guildPanels';
import { setBackendKind } from '../helpers/backendKind';

const GUILD = '200000000000000001';
const admin = { id: '300000000000000001', username: 'admin', guilds: [{ id: GUILD, permissions: '8', owner: false }] };
const dev = { id: '300000000000000002', username: 'dev', guilds: [] };

function handler(router: any, method: string, routePath: string): (req: any, res: any) => Promise<void> {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function bot(reply: any) {
  const sent: Array<{ type: string; data: any }> = [];
  const b: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sent.push({ type, data }); return reply; },
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
    isUserDev: async () => ({ success: true, isDev: true }),
  };
  return { b, sent };
}

async function call(reply: any, method: 'get' | 'post', routePath: string, req: Record<string, any>) {
  const { b, sent } = bot(reply);
  const out = { status: 200, body: undefined as any };
  const res: any = {
    status: (code: number) => { out.status = code; return res; },
    json: (body: any) => { out.body = body; return res; },
    writableFinished: true,
    once: () => res,
  };
  await handler(createGuildPanelRoutes(b), method, routePath)({ body: {}, query: {}, session: {}, ...req }, res);
  return { ...out, sent };
}

const MIXED = [
  { id: 'sys', scope: 'system' },
  { id: 'gld', scope: 'guild' },
  { id: 'none' },
  { id: 'other', scope: 'other' },
];

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('GET /list filters the panels by scope', () => {
  it('a guild list holds the guild-scoped and unscoped panels only, with the guild id', async () => {
    const out = await call({ success: true, panels: MIXED }, 'get', '/list', { query: { guildId: GUILD }, user: admin });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true, panels: [{ id: 'gld', scope: 'guild' }, { id: 'none' }], guildId: GUILD });
  });

  it('a system list holds the system-scoped panels only, with guild id null', async () => {
    const out = await call({ success: true, panels: MIXED }, 'get', '/list', { query: { guildId: 'null' }, user: dev });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true, panels: [{ id: 'sys', scope: 'system' }], guildId: null });
  });

  it('a reply without panels gives an empty list for a guild and for the system', async () => {
    const guild = await call({ success: true }, 'get', '/list', { query: { guildId: GUILD }, user: admin });
    expect(guild.body).toEqual({ success: true, panels: [], guildId: GUILD });
    const system = await call({ success: true }, 'get', '/list', { query: { guildId: 'null' }, user: dev });
    expect(system.body).toEqual({ success: true, panels: [], guildId: null });
  });

  it('a failed reply with no text says "Failed to get panel list"', async () => {
    const out = await call({ success: false }, 'get', '/list', { query: { guildId: GUILD }, user: admin });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ success: false, error: 'Failed to get panel list' });
  });
});

const ACTIONS = [
  { route: '/execute', op: 'panel:execute', body: { panelId: 'p1' }, failure: 'Failed to execute panel' },
  { route: '/button', op: 'panel:button', body: { panelId: 'p1', buttonId: 'b1' }, failure: 'Failed to handle button' },
  { route: '/dropdown', op: 'panel:dropdown', body: { panelId: 'p1', values: ['v1'], dropdownId: 'd1' }, failure: 'Failed to handle dropdown' },
] as const;

describe.each(ACTIONS)('POST $route', ({ route, op, body, failure }) => {
  it('sends the panel, the user and the channel to the bot and answers its view', async () => {
    const view = { content: 'View' };
    const out = await call({ success: true, data: view }, 'post', route, { body: { ...body, guildId: GUILD, channelId: '400000000000000001' }, user: admin });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true, panel: view });
    expect(out.sent).toEqual([{ type: op, data: { ...body, userId: admin.id, channelId: '400000000000000001', guildId: GUILD } }]);
  });

  it('sends channel null when the request has no channel, and answers panel null for a reply without data', async () => {
    const out = await call({ success: true }, 'post', route, { body: { ...body, guildId: GUILD }, user: admin });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true, panel: null });
    expect(out.sent).toEqual([{ type: op, data: { ...body, userId: admin.id, channelId: null, guildId: GUILD } }]);
  });

  it(`a failed reply with no text says "${failure}"`, async () => {
    const out = await call({ success: false }, 'post', route, { body: { ...body, guildId: GUILD }, user: admin });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ success: false, error: failure });
  });
});

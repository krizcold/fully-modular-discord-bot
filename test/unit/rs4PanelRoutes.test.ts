import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPanelRoutes } from '../../src/webui/routes/panels';
import { respondPanelOp, watcherFor, type PanelOpSpec } from '../../src/webui/routes/panelRequestRoute';
import { _resetPanelLiveWatch } from '../../src/webui/utils/panelLiveWatch';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { BOT_DOWN, GUILD, nb7Rig, resetNb7 } from '../helpers/nb7Rig';

const OWNER_ID = '123456789012345678';

function botStub(reply: unknown = { success: true, panels: [{ id: 'giveaway' }] }) {
  const sent: Array<{ type: string; data: any }> = [];
  const bot: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sent.push({ type, data }); return reply; },
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
  };
  return { bot, sent };
}

describe('the panel routes: the guild id of the System context and the list answer', () => {
  let app: { url: string; close: () => Promise<void> } | null = null;
  let stub: ReturnType<typeof botStub>;

  async function mount(reply?: unknown) {
    stub = botStub(reply);
    app = await startApp(a => a.use('/api/panels', createPanelRoutes(stub.bot)));
  }
  async function get(path: string) {
    const res = await fetch(`${app!.url}/api/panels${path}`);
    return { status: res.status, body: await res.json() };
  }

  beforeEach(() => setBackendKind('file'));
  afterEach(async () => {
    await app?.close();
    app = null;
    setBackendKind(null);
  });

  it.each([
    ['no guildId', '/list'],
    ['an empty guildId', '/list?guildId='],
    ["the text 'null'", '/list?guildId=null'],
  ])('a list with %s asks the System context and answers its panels', async (_name, path) => {
    await mount();
    expect(await get(path)).toEqual({ status: 200, body: { success: true, panels: [{ id: 'giveaway' }] } });
    expect(stub.sent).toEqual([{ type: 'panel:list', data: { guildId: null } }]);
  });

  it('a list with a guild id that is no snowflake is refused with its text and sends nothing', async () => {
    await mount();
    expect(await get('/list?guildId=abc')).toEqual({ status: 400, body: { success: false, error: 'Invalid guild ID format' } });
    expect(stub.sent).toEqual([]);
  });

  it('a failed list that gives no reason answers the route text', async () => {
    await mount({ success: false });
    expect(await get('/list')).toEqual({ status: 500, body: { success: false, error: 'Failed to get panel list' } });
  });

  it('an execute whose JSON guildId is null runs the panel in the System context', async () => {
    await mount({ success: true, data: { content: 'View' } });
    const res = await fetch(`${app!.url}/api/panels/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panelId: 'giveaway', userId: OWNER_ID, guildId: null }),
    });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { success: true, panel: { content: 'View' } } });
    expect(stub.sent).toEqual([{ type: 'panel:execute', data: { panelId: 'giveaway', userId: OWNER_ID, channelId: null, guildId: null } }]);
  });
});

describe('respondPanelOp keeps the reply fields the page reads', () => {
  const KEPT = { code: 'c', servedBy: 'BRAVO', noAnswer: 'timeout', ran: true, truth: 'deposed', partial: true, pending: true, note: 'a note', oversize: { bytes: 5 }, capturedOmitted: { lines: 2 } };

  function respond(reply: Record<string, unknown>, status: number | null) {
    const out = { status: 0, body: null as any };
    const r: any = { status: (code: number) => { out.status = code; return r; }, json: (body: any) => { out.body = body; return r; } };
    const spec: PanelOpSpec = { op: 'panel:button', guildId: GUILD, payload: {}, audience: 'owner', userId: 'web-ui-owner', success: () => ({}), failureText: 'Failed to handle button' };
    respondPanelOp(r, spec, { status, reply } as any);
    return out;
  }

  it.each(Object.keys(KEPT))('a successful answer carries %s', field => {
    const out = respond({ success: true, ...KEPT }, null);
    expect(out.status).toBe(200);
    expect(out.body[field]).toEqual((KEPT as any)[field]);
  });

  it.each(Object.keys(KEPT))('a failed answer carries %s', field => {
    const out = respond({ success: false, error: 'x', ...KEPT }, 503);
    expect(out.status).toBe(503);
    expect(out.body[field]).toEqual((KEPT as any)[field]);
  });
});

describe("the owner's live watcher fetch", () => {
  afterEach(() => {
    _resetPanelLiveWatch();
    resetNb7();
    setBackendKind(null);
  });

  it('sends the panel, the version the page has and the watching owner in the request row', async () => {
    const rig = nb7Rig();
    rig.script[rig.url] = sql => (sql === REQUEST_INSERT_SQL ? Object.assign(new Error('relation does not exist'), { code: '42P01' }) : undefined);
    const bot: any = { isRunning: () => false, writerRoute: () => BOT_DOWN, panelIpc: async () => ({ success: true }), emitPanelUpdate: () => 0, emitPanelLiveStatus: () => undefined };
    const deps = (watcherFor(bot) as any).deps;
    await deps.fetch(GUILD, 'giveaway', OWNER_ID, { haveVersion: 3, haveSince: 7 });
    const insert = rig.statements.find(s => s.sql === REQUEST_INSERT_SQL);
    expect(insert).toBeDefined();
    expect(JSON.parse(insert!.values[6] as string)).toEqual({
      panelId: 'giveaway', haveVersion: 3, haveSince: 7, actor: { via: 'owner', userId: OWNER_ID }, guildId: GUILD,
    });
  });
});

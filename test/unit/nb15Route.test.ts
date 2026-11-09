import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 2 (decisions 3, 9 and 12): which route an op takes and how the route answers it, for both audiences.
import { runPanelOp, respondPanelOp, type PanelOpSpec } from '../../src/webui/routes/panelRequestRoute';
import { BotManager } from '../../src/webui/botManager';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { setBackendKind } from '../helpers/backendKind';
import { BOT_DOWN, GUILD, fakeTime, heldRow, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const URL1 = 'postgres://one';
let rig: Rig;

function res() {
  const out = { status: 0, body: null as any };
  const r: any = { status: (code: number) => { out.status = code; return r; }, json: (body: any) => { out.body = body; return r; } };
  return { r, out };
}

function bot(over: Record<string, any> = {}) {
  const sentIpc: Array<{ type: string; data: any }> = [];
  const b: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sentIpc.push({ type, data }); return over.reply ?? { success: true, data: { content: 'View' } }; },
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
    ...over,
  };
  return { b, sentIpc };
}

const spec = (over: Partial<PanelOpSpec> = {}): PanelOpSpec => ({
  op: 'panel:button', guildId: GUILD, payload: { panelId: 'p', buttonId: 'b', userId: 'web-ui-owner' }, audience: 'owner', userId: 'web-ui-owner',
  success: reply => ({ panel: reply.data ?? null }), failureText: 'Failed to handle button', ...over,
});

async function answer(b: any, s: PanelOpSpec) {
  const { r, out } = res();
  respondPanelOp(r, s, await runPanelOp(b, s));
  return out;
}

beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
});
afterEach(() => {
  resetNb7();
  setBackendKind(null);
  vi.useRealTimers();
});

describe('the plan (decision 9)', () => {
  it('a JSON bot sends locally as today; with no child it answers Bot is not running', async () => {
    setBackendKind('file');
    const { b, sentIpc } = bot();
    expect(await answer(b, spec())).toEqual({ status: 200, body: { success: true, panel: { content: 'View' } } });
    expect(sentIpc).toHaveLength(1);
    expect(await answer(bot({ isRunning: () => false }).b, spec())).toEqual({ status: 503, body: { success: false, error: 'Bot is not running' } });
  });

  it('the admin action routes refuse a non-numeric or out-of-range guild id with 400', async () => {
    for (const guildId of ['abc', '99999999999999999999']) {
      expect((await answer(bot().b, spec({ guildId }))).status).toBe(400);
    }
  });

  it('a child at its guild report sends locally; its not-held turns to the request route with the actor', async () => {
    const { b, sentIpc } = bot({ reply: { success: false, code: 'not-held' } });
    rig.script[URL1] = sql => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 } : sql.includes('WHERE id = $1') && !sql.includes('AND state') ? { rows: [{ state: 'done', reply: JSON.stringify({ success: true, data: { v: 2 } }), pickup_over: true, answer_over: false }] } : undefined);
    const out = await answer(b, spec());
    expect(sentIpc).toHaveLength(1);
    expect(out).toEqual({ status: 200, body: { success: true, panel: { v: 2 }, servedBy: 'BRAVO' } });
    const body = JSON.parse(rig.statements.find(s => s.sql === REQUEST_INSERT_SQL)!.values[6] as string);
    expect(body.actor).toEqual({ via: 'owner', userId: 'web-ui-owner' });
    expect(body.guildId).toBe(GUILD);
  });

  it("every member body carries actor.via 'member', and a member answer names no machine", async () => {
    rig.script[URL1] = sql => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 } : sql.includes('WHERE id = $1') && !sql.includes('AND state') ? { rows: [{ state: 'done', reply: JSON.stringify({ success: true, data: { v: 2 } }), pickup_over: true, answer_over: false }] } : undefined);
    const out = await answer(bot({ writerRoute: () => BOT_DOWN, isRunning: () => false }).b, spec({ audience: 'member', userId: '123456789012345678' }));
    expect(out).toEqual({ status: 200, body: { success: true, panel: { v: 2 } } });
    const body = JSON.parse(rig.statements.find(s => s.sql === REQUEST_INSERT_SQL)!.values[6] as string);
    expect(body.actor).toEqual({ via: 'member', userId: '123456789012345678' });
  });

  it("no child and a holder on this machine answers this machine's own answer", async () => {
    rig.holder = () => ({ rows: [heldRow({ holder_node: 'n-a' })] });
    expect(await answer(bot({ writerRoute: () => BOT_DOWN, isRunning: () => false }).b, spec())).toEqual({ status: 503, body: { success: false, error: 'Bot is not running' } });
  });

  it('no holder: owner gets NB7 texts with "nothing was run", a member the no-holder text', async () => {
    rig.holder = () => ({ rows: [heldRow({ holder_process: null })] });
    const down = bot({ writerRoute: () => BOT_DOWN, isRunning: () => false }).b;
    expect((await answer(down, spec())).body.error).toMatch(/nothing was run/);
    expect(await answer(down, spec({ audience: 'member', userId: '123456789012345678' }))).toEqual({ status: 503, body: { success: false, code: 'no-holder', error: "This server's bot is restarting or not running right now; nothing was run. Try again in a moment." } });
  });
});

describe('the local answers (decision 12)', () => {
  it("a local timeout answers 503 no-answer 'timeout', a stopped child 'stopped', never 500; local not-ready is 503", async () => {
    expect(await answer(bot({ reply: { success: false, error: 'IPC request timed out', noAnswer: 'timeout' } }).b, spec())).toMatchObject({ status: 503, body: { code: 'no-answer', noAnswer: 'timeout' } });
    expect(await answer(bot({ reply: { success: false, error: 'bot process exited before replying', noAnswer: 'stopped' } }).b, spec())).toMatchObject({ status: 503, body: { code: 'no-answer', noAnswer: 'stopped' } });
    expect(await answer(bot({ reply: { success: false, ran: false, code: 'not-ready', error: 'x' } }).b, spec())).toMatchObject({ status: 503, body: { code: 'not-ready' } });
  });

  it('the invoke route answers 200, 400 for ran false and 500 for a command that ran and failed', async () => {
    const invoke = (reply: any) => answer(bot({ reply }).b, spec({ op: 'command:invoke', payload: { command: 'probe' }, success: r => r, failureStatus: r => (r.ran === false ? 400 : 500) }));
    expect((await invoke({ success: true, ran: true, captured: [] })).status).toBe(200);
    expect((await invoke({ success: false, ran: false, error: 'no such command: probe' })).status).toBe(400);
    expect((await invoke({ success: false, ran: true, truth: 'deposed', error: 'x' })).status).toBe(500);
  });
});

describe("'control:guild-webui' (decision 3, ruling 15)", () => {
  it('sendGuildWebUiSetting sends the setting to a running child', () => {
    const sent: any[] = [];
    const manager = Object.create(BotManager.prototype);
    Object.assign(manager, { botProcess: { send: (m: any) => sent.push(m) }, isRunning: () => true });
    manager.sendGuildWebUiSetting();
    expect(sent).toEqual([{ type: 'control:guild-webui', data: { enabled: expect.any(Boolean) } }]);
  });
});

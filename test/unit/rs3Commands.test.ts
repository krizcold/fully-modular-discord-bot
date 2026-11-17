import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rs3: POST /api/commands/invoke through createCommandRoutes (NB15 decisions 9 and 12): the guild id
// check, the IPC payload the bot child gets, the actor of a request row, and the failure text.

import { createCommandRoutes } from '../../src/webui/routes/commands';
import { REQUEST_INSERT_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { setBackendKind } from '../helpers/backendKind';
import { BOT_DOWN, GUILD, fakeTime, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const URL1 = 'postgres://one';
const USER = '123456789012345678';
let rig: Rig;

function bot(reply: any = { success: true, ran: true, captured: [] }, over: Record<string, any> = {}) {
  const sentIpc: Array<{ type: string; data: any }> = [];
  const b: any = {
    isRunning: () => true,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sentIpc.push({ type, data }); return reply; },
    emitPanelUpdate: () => undefined,
    emitPanelLiveStatus: () => undefined,
    ...over,
  };
  return { b, sentIpc };
}

async function invoke(b: any, body: Record<string, unknown>) {
  const router: any = createCommandRoutes(b);
  const layer = router.stack.find((l: any) => l.route?.path === '/invoke' && l.route.methods.post);
  const out = { status: 200, body: undefined as any, sends: 0 };
  const res: any = { status: (code: number) => { out.status = code; return res; }, json: (b2: any) => { out.sends += 1; out.body = b2; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ body, query: {}, session: {} }, res);
  return out;
}

beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  resetNb7();
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rs3 the guild id of an invoke', () => {
  it('rs3 a guildId of null runs in the System context on this machine', async () => {
    setBackendKind('file');
    const { b, sentIpc } = bot();
    const out = await invoke(b, { command: 'probe', guildId: null });
    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
    expect(sentIpc).toHaveLength(1);
    expect(sentIpc[0].type).toBe('command:invoke');
    expect(sentIpc[0].data.guildId).toBeNull();
  });

  it('rs3 a JSON bot refuses an out-of-range guild id with the 400 text and sends nothing', async () => {
    setBackendKind('file');
    const { b, sentIpc } = bot();
    const out = await invoke(b, { command: 'probe', guildId: '99999999999999999999' });
    expect(out).toEqual({ status: 400, body: { success: false, error: 'Invalid guild ID format' }, sends: 1 });
    expect(sentIpc).toHaveLength(0);
  });
});

describe('rs3 the payload the bot child gets', () => {
  it('rs3 omitted ids and options arrive as null and an empty object', async () => {
    setBackendKind('file');
    const { b, sentIpc } = bot();
    expect((await invoke(b, { command: 'probe', guildId: GUILD })).status).toBe(200);
    expect(sentIpc[0].data).toStrictEqual({ command: 'probe', channelId: null, userId: null, options: {}, force: false, guildId: GUILD });
  });

  it('rs3 given ids and options arrive as sent', async () => {
    setBackendKind('file');
    const { b, sentIpc } = bot();
    const body = { command: 'probe', guildId: GUILD, channelId: '22222', userId: USER, options: { n: 3 }, force: 1 };
    expect((await invoke(b, body)).status).toBe(200);
    expect(sentIpc[0].data).toStrictEqual({ command: 'probe', channelId: '22222', userId: USER, options: { n: 3 }, force: true, guildId: GUILD });
  });

  it("rs3 a request row to the holder names the invoking user as its actor", async () => {
    rig.script[URL1] = sql => (sql === REQUEST_INSERT_SQL ? { rows: [], rowCount: 1 } : sql.includes('WHERE id = $1') && !sql.includes('AND state') ? { rows: [{ state: 'done', reply: JSON.stringify({ success: true, ran: true, captured: [] }), pickup_over: true, answer_over: false }] } : undefined);
    const { b, sentIpc } = bot(undefined, { writerRoute: () => BOT_DOWN, isRunning: () => false });
    const out = await invoke(b, { command: 'probe', guildId: GUILD, userId: USER });
    expect(out.status).toBe(200);
    expect(sentIpc).toHaveLength(0);
    const row = rig.statements.find(s => s.sql === REQUEST_INSERT_SQL);
    const sent = JSON.parse(row!.values[6] as string);
    expect(sent.actor).toEqual({ via: 'owner', userId: USER });
    expect(sent.userId).toBe(USER);
  });
});

describe('rs3 a failed command', () => {
  it('rs3 a failed reply with no error of its own answers "The command failed"', async () => {
    setBackendKind('file');
    const { b } = bot({ success: false, ran: true });
    const out = await invoke(b, { command: 'probe', guildId: GUILD });
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ success: false, ran: true, error: 'The command failed' });
  });
});

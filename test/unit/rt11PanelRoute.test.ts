import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { respondPanelOp, runPanelOp, sendPanelOp, watcherFor, type PanelOpSpec } from '../../src/webui/routes/panelRequestRoute';
import { _resetPanelLiveWatch, getPanelLiveWatch, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';
import { setBackendKind } from '../helpers/backendKind';

const GUILD = '123456789012345678';
const OWNER = '223456789012345678';

function botStub(reply: unknown = { success: true }, running = true) {
  const sent: Array<{ type: string; data: any }> = [];
  const updates: unknown[] = [];
  const statuses: unknown[] = [];
  const bot: any = {
    isRunning: () => running,
    writerRoute: () => ({ route: 'child' }),
    panelIpc: async (type: string, data: any) => { sent.push({ type, data }); return reply; },
    emitPanelUpdate: (data: unknown) => { updates.push(data); return 2; },
    emitPanelLiveStatus: (data: unknown) => { statuses.push(data); },
  };
  return { bot, sent, updates, statuses };
}

function spec(over: Partial<PanelOpSpec> = {}): PanelOpSpec {
  return {
    op: 'panel:button', guildId: GUILD, payload: { panelId: 'giveaway' }, audience: 'owner', userId: 'web-ui-owner',
    success: () => ({}), failureText: 'Failed to handle button', ...over,
  };
}

function fakeRes(finished = true) {
  const out = { status: 0, body: undefined as any };
  const res: any = Object.assign(new EventEmitter(), {
    writableFinished: finished,
    status: (code: number) => { out.status = code; return res; },
    json: (body: unknown) => { out.body = JSON.parse(JSON.stringify(body)); return res; },
  });
  return { res, out };
}

const respond = (s: PanelOpSpec, answer: { status: number | null; reply: Record<string, unknown> }) => {
  const { res, out } = fakeRes();
  respondPanelOp(res, s, answer as any);
  return out;
};

beforeEach(() => setBackendKind('file'));
afterEach(() => {
  _resetPanelLiveWatch();
  setBackendKind(null);
});

describe("rt11 the owner's live watcher talks to this bot manager", () => {
  it('rt11 a fetch on a JSON bot asks the bot for the pair with the version the page has', async () => {
    const stub = botStub({ success: true, since: 7, version: 3, data: { content: 'v' } });
    const deps = (watcherFor(stub.bot) as any).deps as WatchDeps;
    const answer = await deps.fetch(GUILD, 'giveaway', OWNER, { haveVersion: 3, haveSince: 7 });
    expect(stub.sent).toEqual([{ type: 'panel:live', data: { guildId: GUILD, panelId: 'giveaway', haveVersion: 3, haveSince: 7 } }]);
    expect(answer.reply).toEqual({ success: true, since: 7, version: 3, data: { content: 'v' } });
  });

  it('rt11 a state for the tabs reaches the bot manager and its client count comes back', () => {
    const stub = botStub();
    const deps = (watcherFor(stub.bot) as any).deps as WatchDeps;
    const data = { panelId: 'giveaway', guildId: GUILD, sessionId: null, response: { content: 'v' }, servedBy: 'BRAVO' };
    expect(deps.emitUpdate(data)).toBe(2);
    expect(stub.updates).toEqual([data]);
  });

  it('rt11 a live status reaches the bot manager', () => {
    const stub = botStub();
    const deps = (watcherFor(stub.bot) as any).deps as WatchDeps;
    const data = { guildId: GUILD, panelId: 'giveaway', live: false, reason: 'off' } as any;
    deps.emitStatus(data);
    expect(stub.statuses).toEqual([data]);
  });
});

describe('rt11 runPanelOp in the System context', () => {
  it('rt11 sends the payload with a null guild id to a running bot', async () => {
    const stub = botStub({ success: true, panels: [] });
    const answer = await runPanelOp(stub.bot, spec({ op: 'panel:list', guildId: null, payload: { userId: OWNER } }));
    expect(stub.sent).toEqual([{ type: 'panel:list', data: { userId: OWNER, guildId: null } }]);
    expect(answer?.reply).toEqual({ success: true, panels: [] });
  });

  it('rt11 answers null and sends nothing while the bot is not running', async () => {
    const stub = botStub({ success: true }, false);
    expect(await runPanelOp(stub.bot, spec({ op: 'panel:list', guildId: null, payload: {} }))).toBeNull();
    expect(stub.sent).toEqual([]);
  });
});

describe('rt11 respondPanelOp: success and failure', () => {
  it("rt11 a route's own field is not blanked by a kept field the reply lacks", () => {
    const out = respond(spec({ success: () => ({ note: 'route note' }) }), { status: null, reply: { success: true } });
    expect(out).toStrictEqual({ status: 200, body: { success: true, note: 'route note' } });
  });

  it('rt11 a success reply under a 503 status answers the failure', () => {
    expect(respond(spec(), { status: 503, reply: { success: true } })).toStrictEqual({ status: 503, body: { success: false, error: 'Failed to handle button' } });
  });

  it('rt11 a success reply under a 300 status answers the failure', () => {
    expect(respond(spec(), { status: 300, reply: { success: true } })).toStrictEqual({ status: 300, body: { success: false, error: 'Failed to handle button' } });
  });

  it('rt11 a failed reply under a 200 status answers the failure', () => {
    expect(respond(spec(), { status: 200, reply: { success: false, error: 'it broke' } })).toStrictEqual({ status: 200, body: { success: false, error: 'it broke' } });
  });

  it("rt11 a panel action's failure carries only the kept fields", () => {
    const out = respond(spec(), { status: 503, reply: { success: false, error: 'it broke', output: 'x' } });
    expect(out).toStrictEqual({ status: 503, body: { success: false, error: 'it broke' } });
  });

  it("rt11 a console invoke's failure carries the whole reply", () => {
    const out = respond(spec({ op: 'command:invoke' }), { status: 503, reply: { success: false, error: 'it broke', output: 'x' } });
    expect(out).toStrictEqual({ status: 503, body: { success: false, error: 'it broke', output: 'x' } });
  });
});

describe("rt11 sendPanelOp keeps an opened panel's answer for the watch its page starts", () => {
  const VIEW = { success: true, servedBy: 'BRAVO', liveSince: 7, liveVersion: 4, data: { content: 'v' } };
  let fetches: Array<{ haveVersion: number; haveSince: number | null }>;

  beforeEach(() => {
    fetches = [];
    getPanelLiveWatch(() => ({
      fetch: (_g, _p, _u, have) => { fetches.push(have); return new Promise(() => undefined); },
      emitUpdate: () => 0,
      emitStatus: () => undefined,
      entry: () => ({ refusal: 'off' }),
      makeClient: () => { throw new Error('no client'); },
    }));
  });

  const open = async (reply: Record<string, unknown>, over: Partial<PanelOpSpec> = {}, finished = true) => {
    const stub = botStub(reply);
    const { res, out } = fakeRes(finished);
    await sendPanelOp(stub.bot, res, spec({ op: 'panel:execute', ...over }));
    return { res, out };
  };
  const watchHas = () => {
    watcherFor({} as any).watch(GUILD, 'giveaway', OWNER, 'BRAVO');
    return fetches[fetches.length - 1];
  };

  it("rt11 another machine's view, answered at once, is the version the watch then has", async () => {
    const { out } = await open(VIEW);
    expect(out.status).toBe(200);
    expect(watchHas()).toEqual({ haveVersion: 4, haveSince: 7 });
  });

  it("rt11 a member's open is kept for no watch", async () => {
    await open(VIEW, { audience: 'member', userId: OWNER });
    expect(watchHas()).toEqual({ haveVersion: 0, haveSince: null });
  });

  it("rt11 this machine's own answer is kept for no watch", async () => {
    const { servedBy: _s, ...local } = VIEW;
    await open(local);
    expect(watchHas()).toEqual({ haveVersion: 0, haveSince: null });
  });

  it('rt11 a response still being written is kept once it finished, before its close', async () => {
    const { res } = await open(VIEW, {}, false);
    res.writableFinished = true;
    res.emit('finish');
    expect(watchHas()).toEqual({ haveVersion: 4, haveSince: 7 });
    res.emit('close');
  });
});

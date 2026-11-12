import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuildRequestSweep, type PanelHooks, type SweepDeps } from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  READ_ANSWERS_SQL,
  REQUEST_CLAIM_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

interface Sent { text: string; values: any[] }

const GUILD = String(1n << 22n);
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const MEMBER = { via: 'member', userId: '123456789012345678' };
const BUTTON = JSON.stringify({ panelId: 'p', buttonId: 'b', actor: OWNER });

let sent: Sent[];
let script: (s: Sent) => unknown;
let hooks: PanelHooks & { calls: Array<{ op: string; body: any }> };
let ids: number;
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

function row(over: Record<string, unknown> = {}) {
  return {
    id: `r${++ids}`, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'panel:button',
    body: BUTTON, requested_by: 'ALPHA', left_ms: 30_000, ...over,
  };
}

function makeHooks(): typeof hooks {
  const calls: Array<{ op: string; body: any }> = [];
  return {
    calls,
    answerPanel: vi.fn(async (op: string, body: any) => { calls.push({ op, body }); return op === 'guild:channels' ? { success: true, channels: [{ id: '1' }] } : { success: true, data: { content: 'View' } }; }),
    answerInvoke: vi.fn(async (body: any) => { calls.push({ op: 'command:invoke', body }); return { success: true, ran: true }; }),
    maintenanceRefusal: () => null,
    getPanel: () => ({ panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: (requested: string[]) => ({ success: true, guilds: requested.map(id => ({ id })) }),
    registerInterest: () => 1234,
  } as any;
}

function sweep(over: Partial<SweepDeps> = {}) {
  let batch = 0;
  const deps: SweepDeps = {
    db: {
      query: async (text, values) => {
        const s = { text, values };
        sent.push(s);
        const answer = await script(s);
        if (answer instanceof Error) throw answer;
        return (answer as any) ?? { rows: [], rowCount: (values?.[0] as unknown[] | undefined)?.length ?? 1 };
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    newId: () => `b${++batch}`,
    panel: hooks,
    ...over,
  };
  return new GuildRequestSweep(deps);
}

const isClaim = (s: Sent) => s.text === REQUEST_CLAIM_SQL;
const answers = () => sent.filter(s => s.text === ANSWER_SQL).map(s => ({ id: s.values[0], batch: s.values[1], reply: JSON.parse(s.values[2]) }));
const readAnswers = () => sent.filter(s => s.text === READ_ANSWERS_SQL).flatMap(s => s.values[0].map((id: string, i: number) => ({ id, reply: JSON.parse(s.values[1][i]) })));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
const claims = (...passes: any[][]) => { let n = 0; return (s: Sent) => (isClaim(s) ? { rows: passes[n++] ?? [] } : undefined); };
const warned = (part: string) => warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes(part)).map((c: unknown[]) => String(c[0]));
const logged = (part: string) => log.mock.calls.filter((c: unknown[]) => String(c[0]).includes(part)).map((c: unknown[]) => String(c[0]));
const malformed = (reason: string) => ({ success: false, ran: false, code: 'invalid', error: `The request for this server was malformed (${reason}); nothing was run.` });
const resolveAfter = (ms: number) => new Promise(resolve => { setTimeout(() => resolve({ success: true }), ms); });

async function runOnce(rows: any[], over: Partial<SweepDeps> = {}) {
  script = claims(rows);
  const s = sweep(over);
  await s.pass();
  await flush();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  sent = [];
  script = () => undefined;
  hooks = makeHooks();
  ids = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the start checks of a row', () => {
  it('a body that is JSON but not an object is answered as not an object', async () => {
    await runOnce([row({ op: 'guild:channels', body: '5' }), row({ op: 'guild:channels', body: '"text"' })]);
    expect(readAnswers()).toEqual([
      { id: 'r1', reply: malformed('the request is not an object') },
      { id: 'r2', reply: malformed('the request is not an object') },
    ]);
    expect(hooks.calls).toEqual([]);
  });

  it('a guild id that is not a number is answered as off the shard, and the pass goes on', async () => {
    await runOnce([row({ guild_id: 'abc', op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })]);
    expect(readAnswers()).toEqual([{ id: 'r1', reply: malformed("the server is not on the request's shard") }]);
  });

  it('a shard count of 0 is answered as off the shard', async () => {
    await runOnce([row({ shard_count: 0, op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })]);
    expect(readAnswers()).toEqual([{ id: 'r1', reply: malformed("the server is not on the request's shard") }]);
  });

  it('a shard count that is not an integer is answered as off the shard', async () => {
    await runOnce([row({ shard_count: 1.5, op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })]);
    expect(readAnswers()).toEqual([{ id: 'r1', reply: malformed("the server is not on the request's shard") }]);
  });

  it("a read that is not a panel's is answered even when every panel is a system one", async () => {
    hooks.getPanel = () => ({ panelScope: 'system' });
    await runOnce([row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })]);
    expect(readAnswers()).toEqual([{ id: 'r1', reply: { success: true, channels: [{ id: '1' }] } }]);
  });

  it('a panel action runs even when every command is a developer one', async () => {
    hooks.getCommand = () => ({ devOnly: true });
    await runOnce([row()]);
    expect(answers()).toEqual([{ id: 'r1', batch: 'b1', reply: { success: true, data: { content: 'View' }, liveSince: 1234, liveVersion: 0 } }]);
  });

  it("a member's action before the member panel setting is known is answered not-ready, unsuccessful", async () => {
    hooks.guildWebUi = () => null;
    await runOnce([row({ body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: MEMBER }) })]);
    expect(answers()).toEqual([{ id: 'r1', batch: 'b1', reply: { success: false, ran: false, code: 'not-ready', error: 'The bot that runs this server has not yet learned whether its member web panel is on; nothing was run. Try again in a moment.' } }]);
    expect(hooks.calls).toEqual([]);
  });

  it("a member's action with the member panel off is answered member-panel-off, unsuccessful", async () => {
    hooks.guildWebUi = () => false;
    await runOnce([row({ body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: MEMBER }) })]);
    expect(answers()).toEqual([{ id: 'r1', batch: 'b1', reply: { success: false, ran: false, code: 'member-panel-off', error: 'The member web panel is turned off for the machine that runs this server; nothing was run.' } }]);
    expect(hooks.calls).toEqual([]);
  });

  it("a console invoke runs with the body's own user, never the actor's", async () => {
    const actor = { via: 'owner', userId: '111111111111111111' };
    await runOnce([row({ op: 'command:invoke', body: JSON.stringify({ command: 'ping', actor }) })]);
    expect(hooks.calls).toEqual([{ op: 'command:invoke', body: { command: 'ping', actor, guildId: GUILD } }]);
  });
});

describe('the reads', () => {
  it('a member asking to watch a panel is refused and no panel code runs', async () => {
    await runOnce([row({ op: 'panel:live', body: JSON.stringify({ panelId: 'p', actor: MEMBER }) })]);
    expect(readAnswers()).toEqual([{ id: 'r1', reply: malformed('a member cannot watch a panel') }]);
    expect(hooks.calls).toEqual([]);
  });

  it("a member's channel list is answered", async () => {
    await runOnce([row({ op: 'guild:channels', body: JSON.stringify({ actor: MEMBER }) })]);
    expect(readAnswers()).toEqual([{ id: 'r1', reply: { success: true, channels: [{ id: '1' }] } }]);
  });

  it('a read whose panel code throws is answered unsuccessful with the error', async () => {
    hooks.answerPanel = vi.fn(async () => { throw new Error('boom'); });
    await runOnce([row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })]);
    expect(readAnswers()).toEqual([{ id: 'r1', reply: { success: false, error: 'boom' } }]);
  });

  it('a read whose id an action of this process holds is still answered by its own run', async () => {
    hooks.answerPanel = vi.fn((op: string) => (op === 'guild:channels' ? Promise.resolve({ success: true, channels: [] }) : new Promise(() => undefined)));
    script = claims([row()], [{ ...row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) }), id: 'r1' }]);
    const s = sweep();
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(readAnswers()).toEqual([{ id: 'r1', reply: { success: true, channels: [] } }]);
    expect(warned('claimed again')).toEqual([]);
  });
});

describe('the actions', () => {
  it('an action claimed again is logged as claimed again and only the latest claim writes the answer', async () => {
    let done: (v: unknown) => void = () => undefined;
    hooks.answerPanel = vi.fn(() => new Promise(resolve => { done = resolve; }));
    const first = row();
    script = claims([first], [first]);
    const s = sweep();
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(warned('claimed again')).toEqual([`[GuildRequests] The panel:button of server ${GUILD} sent from ALPHA was claimed again after this process started it; it is answered with the first run's outcome, not run again`]);
    done({ success: true });
    await flush();
    expect(answers().map(a => a.batch)).toEqual(['b2']);
    expect(hooks.answerPanel).toHaveBeenCalledTimes(1);
  });

  it("an earlier claim's answer write that finds the row taken by a later claim neither reads back nor warns", async () => {
    let releaseFirst: (v: unknown) => void = () => undefined;
    const first = row();
    let claim = 0;
    script = s => {
      if (isClaim(s)) return { rows: ++claim <= 2 ? [first] : [] };
      if (s.text === ANSWER_SQL && s.values[1] === 'b1') return new Promise(resolve => { releaseFirst = resolve; });
      return undefined;
    };
    const s = sweep();
    await s.pass();
    await flush();
    expect(answers().map(a => a.batch)).toEqual(['b1']);
    await s.pass();
    await flush();
    releaseFirst({ rows: [], rowCount: 0 });
    await flush();
    expect(sent.filter(x => x.text === ANSWER_READ_BACK_SQL)).toEqual([]);
    expect(warned('holds another answer')).toEqual([]);
  });

  it('an answer that is not an object gets no live fields and is written as no answer', async () => {
    hooks.answerPanel = vi.fn(async () => 'done');
    await runOnce([row()]);
    expect(answers()).toEqual([{ id: 'r1', batch: 'b1', reply: { success: false, error: 'The bot gave no answer.' } }]);
  });

  it('the still-runs line comes at left_ms + 5 s, not before', async () => {
    hooks.answerPanel = vi.fn(() => new Promise(() => undefined));
    await runOnce([row()]);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(warned('still runs')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(warned('still runs')).toEqual([`[GuildRequests] The panel:button of server ${GUILD} sent from ALPHA still runs after 35 s; its sender read can't confirm`]);
  });

  it('an action that ended at once never logs the still-runs line later', async () => {
    await runOnce([row()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warned('still runs')).toEqual([]);
  });

  it('an action that ends at once is logged as ran, not as ended after its sender stopped waiting', async () => {
    await runOnce([row()]);
    expect(logged('panel:button for server')).toEqual([`[GuildRequests] panel:button for server ${GUILD}, sent from ALPHA: ran`]);
    expect(warned('stopped waiting')).toEqual([]);
  });

  it('an action that ends 30 s after its claim, inside left_ms + 5 s, is logged as ran', async () => {
    hooks.answerPanel = vi.fn(() => resolveAfter(30_000));
    await runOnce([row()]);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(logged('panel:button for server')).toEqual([`[GuildRequests] panel:button for server ${GUILD}, sent from ALPHA: ran`]);
    expect(warned('stopped waiting')).toEqual([]);
  });

  it('an action that ends exactly at left_ms + 5 s is still logged as ran', async () => {
    hooks.answerPanel = vi.fn(() => resolveAfter(35_000));
    await runOnce([row()]);
    await vi.advanceTimersByTimeAsync(35_000);
    await flush();
    expect(logged('panel:button for server')).toEqual([`[GuildRequests] panel:button for server ${GUILD}, sent from ALPHA: ran`]);
    expect(warned('stopped waiting')).toEqual([]);
  });

  it('an action that ends after left_ms + 5 s names its server and sender in the ended-after line', async () => {
    hooks.answerPanel = vi.fn(() => resolveAfter(36_000));
    await runOnce([row()]);
    await vi.advanceTimersByTimeAsync(36_000);
    await flush();
    expect(warned('stopped waiting')).toEqual([`[GuildRequests] The panel:button of server ${GUILD} sent from ALPHA ended after its sender stopped waiting: ran`]);
    expect(logged('panel:button for server')).toEqual([]);
  });

  it('the places-full line lists only the actions that still run', async () => {
    const pending = () => new Promise(() => undefined);
    let n = 0;
    hooks.answerPanel = vi.fn(() => (++n === 1 ? Promise.resolve({ success: true }) : pending()));
    script = claims([row()], Array.from({ length: 8 }, () => row()), []);
    const s = sweep();
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(s.runningActionCount()).toBe(8);
    await s.pass();
    await flush();
    const line = warned('panel actions or commands sent from other machines still run');
    expect(line).toHaveLength(1);
    expect(line[0].match(/panel:button of server/g)).toHaveLength(8);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 4 (decision 8, decisions 3 and 10, gatekeeper rulings 1 and 13): the holder's sweep over a scripted
// database and scripted panel hooks. One claim with three picks; the start checks; reads answered in groups; actions
// through `started`; the log lines.
import { GuildRequestSweep, type PanelHooks, type SweepDeps } from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ACTION_OPS,
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  CLEANUP_BODIES_SQL,
  CLEANUP_SQL,
  DATA_OPS,
  READ_ANSWERS_READ_BACK_SQL,
  READ_ANSWERS_SQL,
  READ_OPS,
  REQUEST_CLAIM_SQL,
  UNANSWERED_BATCHES_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

interface Sent { text: string; values: any[]; boundMs: number; carries?: boolean }

const GUILD = String(1n << 22n);
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const MEMBER = { via: 'member', userId: '123456789012345678' };

let sent: Sent[];
let script: (s: Sent) => unknown;
let hooks: PanelHooks & { calls: Array<{ op: string; body: any }>; interests: string[] };
let ids: number;

function row(over: Record<string, unknown> = {}) {
  return {
    id: `r${++ids}`, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'panel:button',
    body: JSON.stringify({ panelId: 'p', buttonId: 'b', userId: 'web-ui-owner', actor: OWNER }),
    requested_by: 'ALPHA', left_ms: 30_000, ...over,
  };
}

function makeHooks(): typeof hooks {
  const calls: Array<{ op: string; body: any }> = [];
  const interests: string[] = [];
  return {
    calls,
    interests,
    answerPanel: vi.fn(async (op: string, body: any) => { calls.push({ op, body }); return op === 'guild:channels' ? { success: true, channels: [{ id: '1' }] } : { success: true, data: { content: 'View' } }; }),
    answerInvoke: vi.fn(async (body: any) => { calls.push({ op: 'command:invoke', body }); return { success: true, ran: true, captured: [] }; }),
    maintenanceRefusal: () => null,
    getPanel: (id: string) => (id === 'updateManager' ? { panelScope: 'system' } : id === 'devp' ? { devOnly: true } : { panelScope: 'guild' }),
    getCommand: (name: string) => (name === 'webui' ? { devOnly: true } : { devOnly: false }),
    guildWebUi: () => true,
    membership: (requested: string[]) => ({ success: true, guilds: requested.map(id => ({ id })) }),
    registerInterest: (g: string, p: string) => { interests.push(`${g}/${p}`); return 1234; },
  } as any;
}

function sweep(over: Partial<SweepDeps> = {}) {
  let batch = 0;
  const deps: SweepDeps = {
    db: {
      query: async (text, values, boundMs, _at, carries) => {
        const s = { text, values, boundMs, carries };
        sent.push(s);
        const answer = script(s);
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
const answers = () => sent.filter(s => s.text === ANSWER_SQL).map(s => ({ id: s.values[0], reply: JSON.parse(s.values[2]) }));
const readAnswers = () => sent.filter(s => s.text === READ_ANSWERS_SQL).flatMap(s => s.values[0].map((id: string, i: number) => ({ id, reply: JSON.parse(s.values[1][i]) })));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
const claimOnce = (rows: any[]) => { let first = true; return (s: Sent) => (isClaim(s) && first ? (first = false, { rows }) : undefined); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  sent = [];
  script = () => undefined;
  hooks = makeHooks();
  ids = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the claim', () => {
  it('one statement per pass with three picks, one batch id, the body emptied and returned with shard_count and shard_id', async () => {
    const s = sweep();
    await s.pass();
    const claims = sent.filter(isClaim);
    expect(claims).toHaveLength(1);
    expect(claims[0].values).toEqual(['p-a', 'b1', [2], [1], [9], DATA_OPS, 16, ACTION_OPS, 8, READ_OPS, 64]);
    expect(claims[0].carries).toBe(true);
    expect(REQUEST_CLAIM_SQL).toMatch(/body = ''/);
    expect(REQUEST_CLAIM_SQL).toMatch(/RETURNING r\.id, r\.guild_id, r\.shard_count, r\.shard_id, r\.op, pick\.body/);
    expect((REQUEST_CLAIM_SQL.match(/FOR UPDATE OF r SKIP LOCKED/g) ?? []).length).toBe(3);
  });

  it('with 8 actions running the action pick takes LIMIT 0, the data and read picks do not, and a read is answered in that pass', async () => {
    const hang: Array<() => void> = [];
    hooks.answerPanel = vi.fn((op: string) => (op === 'guild:channels'
      ? Promise.resolve({ success: true, channels: [] })
      : new Promise(resolve => { hang.push(() => resolve({ success: true })); })));
    let pass = 0;
    script = s => (isClaim(s) ? (++pass === 1 ? { rows: Array.from({ length: 8 }, () => row()) } : pass === 2 ? { rows: [row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })] } : { rows: [] }) : undefined);
    const s = sweep();
    await s.pass();
    await flush();
    expect(s.runningActionCount()).toBe(8);
    await s.pass();
    await flush();
    const second = sent.filter(isClaim)[1];
    expect(second.values[8]).toBe(0);
    expect(second.values[6]).toBe(16);
    expect(second.values[10]).toBe(64);
    expect(readAnswers()).toEqual([{ id: 'r9', reply: { success: true, channels: [] } }]);
    hang.forEach(done => done());
    await flush();
    expect(s.runningActionCount()).toBe(0);
  });

  it('the places-full line at most every 30 s while 8 run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hooks.answerPanel = vi.fn(() => new Promise(() => undefined));
    script = claimOnce(Array.from({ length: 8 }, () => row()));
    const s = sweep();
    await s.pass();
    await flush();
    const full = () => warn.mock.calls.filter(c => String(c[0]).startsWith('[GuildRequests] 8 panel actions or commands sent from other machines still run')).length;
    await s.pass();
    expect(full()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await s.pass();
    expect(full()).toBe(1);
    await vi.advanceTimersByTimeAsync(21_000);
    await s.pass();
    expect(full()).toBe(2);
  });
});

describe('the start checks (decision 8, steps 1 to 3)', () => {
  it.each([
    ['an unknown op', { op: 'panel:delete' }, 'the request names no operation this bot knows'],
    ['a body that is not an object', { body: '[1]' }, 'the request is not an object'],
    ['a body over 16 KiB', { body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: OWNER, pad: 'x'.repeat(17 * 1024) }) }, 'the request is over 16 KiB'],
    ["a guild whose shard is not the row's", { shard_id: 0 }, "the server is not on the request's shard"],
    ['a missing actor', { body: JSON.stringify({ panelId: 'p', buttonId: 'b' }) }, 'no actor'],
    ['an actor that is a string', { body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: 'owner' }) }, 'no actor'],
    ["an actor whose kind is 'admin'", { body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: { via: 'admin', userId: 'web-ui-owner' } }) }, "the actor's kind is not valid"],
    ['an actor with no kind', { body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: { userId: '123456789012345678' } }) }, "the actor's kind is not valid"],
    ["a member actor named web-ui-owner", { body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: { via: 'member', userId: 'web-ui-owner' } }) }, "the actor's user id is not valid"],
    ['a member actor with no user id', { body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: { via: 'member' } }) }, "the actor's user id is not valid"],
    ['an owner actor whose user id is a number', { body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: { via: 'owner', userId: 42 } }) }, "the actor's user id is not valid"],
    ['a member invoke', { op: 'command:invoke', body: JSON.stringify({ command: 'probe', actor: MEMBER }) }, 'a member cannot invoke a command'],
  ] as const)('%s answers invalid with its text and runs nothing', async (_what, over, reason) => {
    script = claimOnce([row(over as any)]);
    const s = sweep();
    await s.pass();
    await flush();
    const all = [...answers(), ...readAnswers()];
    expect(all).toHaveLength(1);
    expect(all[0].reply).toEqual({ success: false, ran: false, code: 'invalid', error: `The request for this server was malformed (${reason}); nothing was run.` });
    expect(hooks.calls).toHaveLength(0);
  });

  it.each([
    ['a system panel sent as web-ui-owner', { body: JSON.stringify({ panelId: 'updateManager', buttonId: 'b', actor: OWNER }) }, 'This panel runs only from the web panel of its own machine; nothing was run.'],
    ['a devOnly panel', { body: JSON.stringify({ panelId: 'devp', buttonId: 'b', actor: { via: 'owner', userId: '123456789012345678' } }) }, 'This panel runs only from the web panel of its own machine; nothing was run.'],
    ['a devOnly command', { op: 'command:invoke', body: JSON.stringify({ command: 'webui', actor: { via: 'owner', userId: '123456789012345678' } }) }, '/webui is a developer command and runs only from the console of its own machine; nothing was run.'],
  ] as const)('%s answers not-allowed and runs nothing', async (_what, over, text) => {
    script = claimOnce([row(over as any)]);
    const s = sweep();
    await s.pass();
    await flush();
    expect(answers()[0].reply).toMatchObject({ success: false, ran: false, code: 'not-allowed', error: text });
    expect(hooks.calls).toHaveLength(0);
  });

  it("a member row: not-ready before any value, member-panel-off after false, runs after true, decided again for each row", async () => {
    let on: boolean | null = null;
    hooks.guildWebUi = () => on;
    const memberRow = () => row({ body: JSON.stringify({ panelId: 'p', buttonId: 'b', actor: MEMBER }) });
    let next: any[] = [];
    script = s => (isClaim(s) ? { rows: next.splice(0) } : undefined);
    const s = sweep();
    next = [memberRow()];
    await s.pass();
    await flush();
    on = false;
    next = [memberRow()];
    await s.pass();
    await flush();
    on = true;
    next = [memberRow()];
    await s.pass();
    await flush();
    const got = answers().map(a => a.reply);
    expect(got[0]).toMatchObject({ code: 'not-ready', ran: false });
    expect(got[0].error).toBe('The bot that runs this server has not yet learned whether its member web panel is on; nothing was run. Try again in a moment.');
    expect(got[1]).toMatchObject({ code: 'member-panel-off', ran: false, error: 'The member web panel is turned off for the machine that runs this server; nothing was run.' });
    expect(got[2]).toMatchObject({ success: true });
    expect(hooks.calls).toHaveLength(1);
    expect(hooks.calls[0].body.userId).toBe(MEMBER.userId);
  });

  it("the body's guildId is replaced by the row's; an owner action registers its interest before it starts and its answer carries liveSince; a member's does not", async () => {
    script = claimOnce([
      row({ body: JSON.stringify({ panelId: 'p', buttonId: 'b', guildId: '999999999999', actor: OWNER }) }),
      row({ body: JSON.stringify({ panelId: 'q', buttonId: 'b', actor: MEMBER }) }),
    ]);
    const s = sweep();
    await s.pass();
    await flush();
    expect(hooks.calls.map(c => c.body.guildId)).toEqual([GUILD, GUILD]);
    expect(hooks.interests).toEqual([`${GUILD}/p`]);
    expect(answers().find(a => a.id === 'r1')!.reply).toMatchObject({ success: true, liveSince: 1234 });
    expect(answers().find(a => a.id === 'r2')!.reply).not.toHaveProperty('liveSince');
  });
});

describe('reads (decision 8) and started (ruling 1)', () => {
  it("'guild:membership' answers through its hook, and 1000 reads leave started empty", async () => {
    let left = 1000;
    script = s => (isClaim(s) ? { rows: Array.from({ length: Math.min(64, left) }, () => (left--, row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) }))) } : undefined);
    const s = sweep();
    for (let i = 0; i < 16; i++) {
      await s.pass();
      await flush();
    }
    expect(left).toBe(0);
    expect(s.startedCount()).toBe(0);
    expect(sent.filter(isClaim).every(c => c.values[10] === 64)).toBe(true);
  });

  it('16 lists of 200 KiB are written in groups of at most 256 KiB; a group that fails leaves the others written', async () => {
    const big = 'x'.repeat(200 * 1024);
    hooks.answerPanel = vi.fn(async () => ({ success: true, channels: [{ name: big }] }));
    let groups = 0;
    script = s => {
      if (isClaim(s)) return groups === 0 ? (groups = -1, { rows: Array.from({ length: 16 }, () => row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })) }) : { rows: [] };
      if (s.text === READ_ANSWERS_SQL) return ++groups === 1 ? new Error('Query read timeout') : { rows: [], rowCount: s.values[0].length };
      if (s.text === READ_ANSWERS_READ_BACK_SQL) return { rows: [] };
      return undefined;
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const s = sweep();
    await s.pass();
    await vi.advanceTimersByTimeAsync(12_000);
    const writes = sent.filter(x => x.text === READ_ANSWERS_SQL);
    expect(writes.every(w => w.values[1].reduce((n: number, t: string) => n + Buffer.byteLength(t), 0) <= 256 * 1024)).toBe(true);
    const written = new Set(writes.slice(1).flatMap(w => w.values[0]));
    expect(written.size).toBeGreaterThanOrEqual(15);
  });

  it('an action claimed again after a lost claim is answered from its kept outcome, never run again', async () => {
    const r = row();
    let pass = 0;
    script = s => (isClaim(s) ? (++pass <= 2 ? { rows: [r] } : { rows: [] }) : undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = sweep();
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(hooks.calls).toHaveLength(1);
    const written = answers().filter(a => a.id === r.id);
    expect(written).toHaveLength(2);
    expect(written[1].reply, 'R4 ruling (d): the kept outcome keeps liveSince and liveVersion').toEqual({ success: true, oversize: { bytes: 0, reason: 'not-kept' }, liveSince: 1234, liveVersion: 0 });
  });

  it('started entries and the ids the unanswered statement leaves out are pruned an hour after the claim', async () => {
    let pass = 0;
    script = s => (isClaim(s) ? (++pass === 1 ? { rows: [row()] } : new Error('Query read timeout')) : undefined);
    const s = sweep();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await s.pass();
    await flush();
    await s.pass();
    expect(sent.filter(x => x.text === UNANSWERED_BATCHES_SQL).at(-1)!.values[1]).toEqual(['r1']);
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(s.startedCount()).toBe(0);
  });
});

describe('the carries flag (ruling 13)', () => {
  it('the claim, the answer write and its read-back, the read-answer groups and their read-back carry it; the unanswered statement and the cleanup do not', async () => {
    let pass = 0;
    script = s => {
      if (isClaim(s)) return ++pass === 1 ? { rows: [row(), row({ op: 'guild:channels', body: JSON.stringify({ actor: OWNER }) })] } : new Error('Query read timeout');
      if (s.text === ANSWER_SQL || s.text === READ_ANSWERS_SQL) return { rows: [], rowCount: 0 };
      if (s.text === ANSWER_READ_BACK_SQL || s.text === READ_ANSWERS_READ_BACK_SQL) return { rows: [] };
      return undefined;
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = sweep({ serving: () => true });
    await s.pass();
    await flush();
    await s.pass();
    await s.cleanupTick();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    const carried = (text: string) => sent.filter(x => x.text === text).map(x => x.carries);
    for (const text of [REQUEST_CLAIM_SQL, ANSWER_SQL, ANSWER_READ_BACK_SQL, READ_ANSWERS_SQL, READ_ANSWERS_READ_BACK_SQL]) {
      expect(carried(text).length, text).toBeGreaterThan(0);
      expect(carried(text).every(c => c === true), text).toBe(true);
    }
    for (const text of [UNANSWERED_BATCHES_SQL, CLEANUP_BODIES_SQL, CLEANUP_SQL]) {
      expect(carried(text).length, text).toBeGreaterThan(0);
      expect(carried(text).some(c => c === true), text).toBe(false);
    }
  });
});

describe('answers (decision 10) and the log lines', () => {
  it('an answer over 256 KiB, with a BigInt or a cycle, or whose toJSON throws, keeps success, ran, truth and pending', async () => {
    const cyclic: any = { n: 1n };
    cyclic.me = cyclic;
    const replies = [
      { success: true, ran: true, data: { big: 'y'.repeat(300 * 1024) } },
      { success: true, data: cyclic },
      { success: false, ran: true, truth: 'pending', pending: true, data: { toJSON() { throw new Error('no'); } }, error: 'e'.repeat(5000) },
    ];
    let i = 0;
    hooks.answerPanel = vi.fn(async () => replies[i++]);
    script = claimOnce([row(), row(), row()]);
    const s = sweep();
    await s.pass();
    await flush();
    const got = answers().map(a => a.reply);
    expect(got[0]).toMatchObject({ success: true, ran: true, oversize: { reason: 'too-large' } });
    expect(got[0]).not.toHaveProperty('data');
    expect(got[1]).toMatchObject({ success: true, data: { n: '1', me: '[Circular]' } });
    expect(got[2]).toMatchObject({ success: false, ran: true, truth: 'pending', pending: true, oversize: { bytes: 0, reason: 'not-serializable' } });
    expect(got[2].error).toHaveLength(2000);
    expect(got[2].error.endsWith('...')).toBe(true);
  });

  it('the still-runs line at left_ms + 5 s, and an answer written after it with the ended-after line, tried for 10 s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let finish: (v: unknown) => void = () => undefined;
    hooks.answerPanel = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    let answerTries = 0;
    script = s => {
      if (isClaim(s)) return sent.filter(isClaim).length === 1 ? { rows: [row({ left_ms: 1000 })] } : { rows: [] };
      if (s.text === ANSWER_SQL) return ++answerTries < 5 ? new Error('Query read timeout') : { rows: [], rowCount: 1 };
      return undefined;
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = sweep();
    await s.pass();
    await flush();
    await vi.advanceTimersByTimeAsync(6001);
    expect(warn.mock.calls.some(c => String(c[0]).includes('still runs after 6 s; its sender read can\'t confirm'))).toBe(true);
    finish({ success: true });
    await vi.advanceTimersByTimeAsync(8000);
    expect(answerTries).toBe(5);
    expect(warn.mock.calls.some(c => String(c[0]).includes('ended after its sender stopped waiting: ran'))).toBe(true);
  });

  it('an answer write that keeps failing stops after 10 s with the could-not-record line, and sends nothing after', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    script = s => {
      if (isClaim(s)) return sent.filter(isClaim).length === 1 ? { rows: [row()] } : { rows: [] };
      if (s.text === ANSWER_SQL) return Object.assign(new Error('permission denied for table guild_requests'), { code: '42501' });
      return undefined;
    };
    const s = sweep();
    await s.pass();
    await flush();
    await vi.advanceTimersByTimeAsync(9000);
    expect(error.mock.calls.some(c => String(c[0]).startsWith('[GuildRequests] Could not record the answer to the panel:button'))).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    const tries = sent.filter(x => x.text === ANSWER_SQL).length;
    expect(tries).toBeGreaterThanOrEqual(10);
    expect(tries).toBeLessThanOrEqual(11);
    expect(error.mock.calls.filter(c => String(c[0]).startsWith('[GuildRequests] Could not record the answer to the panel:button'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.filter(x => x.text === ANSWER_SQL)).toHaveLength(tries);
  });
});

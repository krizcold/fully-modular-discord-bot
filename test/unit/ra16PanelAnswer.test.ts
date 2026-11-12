import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GuildRequestSweep,
  RequestsStoppedError,
  type PanelHooks,
  type SweepDeps,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  READ_ANSWERS_READ_BACK_SQL,
  READ_ANSWERS_SQL,
  REQUEST_CLAIM_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

const GUILD = String(1n << 22n);
const CHANNEL = '123456789012345678';
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const FROM = `server ${GUILD} sent from ALPHA`;
const DONE_LINE = `[GuildRequests] command:invoke for server ${GUILD}, sent from ALPHA: ran`;
const STOPPED = 'this process stopped writing to its database';

interface Call { text: string; values: unknown[] }

let logs: string[];
let calls: Call[];

type Handler = (text: string, values: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

function invokeRow(id = 'r1') {
  return {
    id, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'command:invoke',
    body: JSON.stringify({ command: 'probe', channelId: CHANNEL, actor: OWNER }),
    requested_by: 'ALPHA', left_ms: 30_000,
  };
}

function readRow(id = 'q1') {
  return {
    id, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'guild:channels',
    body: JSON.stringify({ actor: OWNER }), requested_by: 'ALPHA', left_ms: 30_000,
  };
}

function hooks(answer: unknown): PanelHooks {
  return {
    answerPanel: async () => answer,
    answerInvoke: async () => answer,
    maintenanceRefusal: () => null,
    getPanel: () => ({ panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: () => ({ success: true, guilds: [] }),
    registerInterest: () => 1,
  };
}

/** A sweep whose claims hand out the given rows, one list per pass, and whose other statements go to handle. */
function sweep(claims: any[][], handle: Handler, answer: unknown = { success: true }) {
  let pass = 0;
  let batch = 0;
  const deps: SweepDeps = {
    db: {
      query: async (text, values) => {
        calls.push({ text, values });
        if (text === REQUEST_CLAIM_SQL) return { rows: claims[pass++] ?? [] };
        return handle(text, values);
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    newId: () => `b${++batch}`,
    hrtime: () => 1000n,
    panel: hooks(answer),
  };
  return new GuildRequestSweep(deps);
}

async function settle(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
}

/** Runs the fake clock on until check holds, a second at a time, at most 15 s of fake time. */
async function runClockUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 15 && !check(); i++) {
    await settle();
    if (check()) return;
    await vi.advanceTimersByTimeAsync(1000);
  }
  await settle();
}

const answers = (batch?: string) => calls.filter(c => c.text === ANSWER_SQL && (batch === undefined || c.values[1] === batch));
const readBacks = () => calls.filter(c => c.text === ANSWER_READ_BACK_SQL);
const guildLines = () => logs.filter(l => l.startsWith('[GuildRequests]') && !l.includes('was claimed again'));

beforeEach(() => {
  logs = [];
  calls = [];
  const keep = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the answer write of an action sent from another machine', () => {
  it('an answer the statement counted is logged as the action and its outcome', async () => {
    const s = sweep([[invokeRow()]], async () => ({ rows: [], rowCount: 1 }));
    await s.pass();
    await waitFor(() => guildLines().length > 0);
    expect(guildLines()).toEqual([DONE_LINE]);
  });

  it('an answer the statement did not count, read back from its own row, is logged as answered', async () => {
    let sent = '';
    const s = sweep([[invokeRow('r7')]], async (text, values) => {
      if (text === ANSWER_SQL) {
        sent = String(values[2]);
        return { rows: [], rowCount: 0 };
      }
      if (text === ANSWER_READ_BACK_SQL) {
        return { rows: values.length === 1 && values[0] === 'r7' ? [{ state: 'answered', reply: sent }] : [] };
      }
      return { rows: [], rowCount: 0 };
    });
    await s.pass();
    await waitFor(() => guildLines().length > 0);
    await settle();
    expect(sent).toBe('{"success":true}');
    expect(readBacks().map(c => c.values)).toEqual([['r7']]);
    expect(guildLines()).toEqual([DONE_LINE]);
  });

  it('a row that holds another answer is logged as such, never as answered', async () => {
    const s = sweep([[invokeRow()]], async text => {
      if (text === ANSWER_SQL) return { rows: [], rowCount: 0 };
      if (text === ANSWER_READ_BACK_SQL) return { rows: [{ state: 'answered', reply: '{"success":false}' }] };
      return { rows: [], rowCount: 0 };
    });
    await s.pass();
    await waitFor(() => guildLines().length > 0);
    await settle();
    expect(guildLines()).toEqual([
      `[GuildRequests] The command:invoke of ${FROM} ended (ran), but its row holds another answer or none; its sender may have read that answer or can't confirm`,
    ]);
    expect(answers()).toHaveLength(1);
  });

  it('a row that holds no answer is logged as such', async () => {
    const s = sweep([[invokeRow()]], async text => {
      if (text === ANSWER_SQL) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    await s.pass();
    await waitFor(() => guildLines().length > 0);
    await settle();
    expect(guildLines()).toEqual([
      `[GuildRequests] The command:invoke of ${FROM} ended (ran), but its row holds another answer or none; its sender may have read that answer or can't confirm`,
    ]);
  });

  it('a stop while the write waited, with a why, says it can not confirm and names the why', async () => {
    const s = sweep([[invokeRow()]], async text => {
      if (text === ANSWER_SQL) throw new RequestsStoppedError('lease lost', false);
      return { rows: [], rowCount: 0 };
    });
    await s.pass();
    await waitFor(() => guildLines().length > 0);
    await settle();
    expect(guildLines()).toEqual([
      `[GuildRequests] Can't confirm whether the answer to the command:invoke of ${FROM} was recorded: ${STOPPED} while it waited (lease lost); its sender reads that answer or can't confirm. The answer was: ran`,
    ]);
    expect(answers()).toHaveLength(1);
  });

  it('a stop while the write waited, with no why, names none', async () => {
    const s = sweep([[invokeRow()]], async text => {
      if (text === ANSWER_SQL) throw new RequestsStoppedError(null, false);
      return { rows: [], rowCount: 0 };
    });
    await s.pass();
    await waitFor(() => guildLines().length > 0);
    await settle();
    expect(guildLines()).toEqual([
      `[GuildRequests] Can't confirm whether the answer to the command:invoke of ${FROM} was recorded: ${STOPPED} while it waited; its sender reads that answer or can't confirm. The answer was: ran`,
    ]);
  });
});

describe('whether a failed answer write may have landed', () => {
  async function failing(first: () => unknown, second: () => unknown, firstCount = false) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    const s = sweep([[invokeRow()]], async text => {
      if (text === ANSWER_SQL) {
        n += 1;
        if (n === 1 && firstCount) return { rows: [], rowCount: 0 };
        throw n === 1 ? first() : second();
      }
      if (text === ANSWER_READ_BACK_SQL) throw first();
      return { rows: [], rowCount: 0 };
    });
    await s.pass();
    await runClockUntil(() => guildLines().length > 0);
    return guildLines();
  }

  const landed = `[GuildRequests] Can't confirm whether the answer to the command:invoke of ${FROM} was recorded: an attempt that got no answer may have landed, and no later attempt confirmed it (${STOPPED}); its sender reads that answer or can't confirm. The answer was: ran`;
  const notRecorded = `[GuildRequests] Could not record the answer to the command:invoke of ${FROM} (${STOPPED}); its sender reads can't confirm. The answer was: ran`;

  it('an answer statement that left and got no answer may have landed', async () => {
    const lines = await failing(() => new Error('connection reset'), () => new RequestsStoppedError(null, true));
    expect(lines).toEqual([landed]);
    expect(answers()).toHaveLength(2);
  });

  it('a thrown nothing from the answer statement is still a statement that may have landed', async () => {
    const lines = await failing(() => undefined, () => new RequestsStoppedError(null, true));
    expect(lines).toEqual([landed]);
  });

  it('an answer statement that never left did not land', async () => {
    const lines = await failing(() => Object.assign(new Error('no connection'), { notSent: true }), () => new RequestsStoppedError(null, true));
    expect(lines).toEqual([notRecorded]);
    expect(answers()).toHaveLength(2);
  });

  it('a read-back that got no answer is not an answer that may have landed', async () => {
    const lines = await failing(() => new Error('read reset'), () => new RequestsStoppedError(null, true), true);
    expect(lines).toEqual([notRecorded]);
    expect(readBacks()).toHaveLength(1);
    expect(answers()).toHaveLength(2);
  });
});

describe('an answer write whose action was claimed again meanwhile', () => {
  async function reclaimed(firstEnds: (release: { ok: () => void; fail: () => void }) => void) {
    let release!: (how: 'ok' | 'fail') => void;
    const gate = new Promise<'ok' | 'fail'>(resolve => { release = resolve; });
    const s = sweep([[invokeRow('r9')], [invokeRow('r9')]], async (text, values) => {
      if (text === ANSWER_SQL && values[1] === 'b1') {
        const how = await gate;
        if (how === 'fail') throw new Error('connection reset');
        return { rows: [], rowCount: 0 };
      }
      if (text === ANSWER_SQL) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await s.pass();
    await waitFor(() => answers('b1').length === 1);
    await s.pass();
    await waitFor(() => logs.includes(DONE_LINE));
    expect(answers('b2')).toHaveLength(1);
    firstEnds({ ok: () => release('ok'), fail: () => release('fail') });
    await settle();
  }

  it('the earlier claim, whose statement counted nothing, reads nothing back and logs nothing', async () => {
    await reclaimed(r => r.ok());
    expect(readBacks()).toHaveLength(0);
    expect(guildLines()).toEqual([DONE_LINE]);
  });

  it('the earlier claim, whose statement failed, does not try again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await reclaimed(r => r.fail());
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
    }
    expect(answers('b1')).toHaveLength(1);
    expect(guildLines()).toEqual([DONE_LINE]);
  });
});

describe('the answers of the reads a pass claimed', () => {
  it('a single read whose answer is over 256 KiB is written in one statement of its own row', async () => {
    const big: Record<string, unknown> = { success: true };
    for (let i = 0; i < 200; i++) big[`k${i}`] = 'x'.repeat(2000);
    const s = sweep([[readRow('q1')]], async (text, values) => {
      if (text === READ_ANSWERS_SQL) return { rows: [], rowCount: (values[0] as unknown[]).length };
      return { rows: [], rowCount: 0 };
    }, big);
    await s.pass();
    await waitFor(() => calls.some(c => c.text === READ_ANSWERS_SQL && (c.values[0] as unknown[]).length > 0));
    await settle();
    const writes = calls.filter(c => c.text === READ_ANSWERS_SQL);
    expect(writes.map(c => c.values[0])).toEqual([['q1']]);
    expect(Buffer.byteLength(String((writes[0].values[1] as unknown[])[0]), 'utf8')).toBeGreaterThan(256 * 1024);
    expect(calls.filter(c => c.text === READ_ANSWERS_READ_BACK_SQL)).toHaveLength(0);
  });
});

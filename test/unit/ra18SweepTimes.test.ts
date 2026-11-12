import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GuildRequestSweep,
  RequestsStoppedError,
  UnprotectedTransportError,
  type PanelHooks,
  type SweepDeps,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ANSWER_SQL,
  CLEANUP_BODIES_SQL,
  CLEANUP_SQL,
  REQUEST_CLAIM_SQL,
  UNANSWERED_BATCHES_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

const GUILD = String(1n << 22n);
const FROM = `server ${GUILD} sent from ALPHA`;
const UNPROTECTED = "[GuildRequests] This bot's database address does not check the database's certificate, so requests from other machines (panel actions, commands and data changes) are not taken. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL.";
const CLAIM_FAILED = "[GuildRequests] Cannot read the changes sent from other machines' panels (Connection terminated); they are refused until this works";
const CLAIM_WORKS = "[GuildRequests] Reading the changes sent from other machines' panels works again";

type Sent = { text: string; values: unknown[] };
type Script = (text: string, values: unknown[]) => any;

let logs: string[];
let sent: Sent[];
let batches: number;

function sweepWith(script: Script, over: Partial<SweepDeps> = {}) {
  const deps: SweepDeps = {
    db: {
      query: async (text, values) => {
        sent.push({ text, values });
        const answer = script(text, values);
        if (answer instanceof Error) throw answer;
        return answer ?? { rows: [], rowCount: 0 };
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    serving: () => true,
    newId: () => `b${++batches}`,
    hrtime: () => 1000n,
    ...over,
  };
  return new GuildRequestSweep(deps);
}

const dataRow = (leftMs: string, id = 'r1') => ({
  id, guild_id: GUILD, op: 'write', requested_by: 'ALPHA', left_ms: leftMs,
  body: JSON.stringify({ module: 'm', filename: 'f.json', contentJson: '{"a":1}' }),
});

const invokeRow = (id: string) => ({
  id, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'command:invoke',
  body: JSON.stringify({ command: 'probe', channelId: '123456789012345678', actor: { via: 'owner', userId: 'web-ui-owner' } }),
  requested_by: 'ALPHA', left_ms: 30_000,
});

const hangingHooks: PanelHooks = {
  answerPanel: () => new Promise(() => undefined),
  answerInvoke: () => new Promise(() => undefined),
  maintenanceRefusal: () => null,
  getPanel: () => ({ panelScope: 'guild' }),
  getCommand: () => ({ devOnly: false }),
  guildWebUi: () => true,
  membership: () => ({ success: true, guilds: [] }),
  registerInterest: () => 1,
};

/** Claims that return each given answer in turn, then no rows. */
function claims(...answers: Array<any[] | Error>): Script {
  let n = 0;
  return text => {
    if (text !== REQUEST_CLAIM_SQL) return undefined;
    const next = answers[n++];
    if (next === undefined) return { rows: [] };
    return next instanceof Error ? next : { rows: next };
  };
}

const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const count = (text: string) => sent.filter(s => s.text === text).length;
const lines = (prefix: string) => logs.filter(l => l.startsWith(prefix));

beforeEach(() => {
  logs = [];
  sent = [];
  batches = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const keep = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the answer write of a data change', () => {
  it('an answer refused with a SQLSTATE never landed: the line says it could not be recorded, not that it may have been', async () => {
    const claim = claims([dataRow('0')]);
    const s = sweepWith((text, values) => {
      if (text === ANSWER_SQL) return Object.assign(new Error('duplicate key'), { code: '23505' });
      return claim(text, values);
    });
    await s.pass();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines('[GuildRequests] ')).toEqual([
      `[GuildRequests] Could not record the answer to the write of ${FROM} (SQLSTATE 23505: duplicate key); its sender reads can't confirm. The answer was: saved`,
    ]);
  });

  it('a stop with no why while the answer waited names no cause in parentheses', async () => {
    const claim = claims([dataRow('20000')]);
    const s = sweepWith((text, values) => {
      if (text === ANSWER_SQL) return new RequestsStoppedError(null, false);
      return claim(text, values);
    });
    await s.pass();
    await flush();
    expect(lines('[GuildRequests] ')).toEqual([
      `[GuildRequests] Can't confirm whether the answer to the write of ${FROM} was recorded: this process stopped writing to its database while it waited; its sender reads that answer or can't confirm. The answer was: saved`,
    ]);
    expect(count(ANSWER_SQL)).toBe(1);
  });

  it('a failing answer write stops retrying once a later claim of the row writes the answer', async () => {
    const claim = claims([dataRow('20000')], [dataRow('20000')]);
    const s = sweepWith((text, values) => {
      if (text === ANSWER_SQL) return values[1] === 'b1' ? new Error('Connection terminated unexpectedly') : { rows: [], rowCount: 1 };
      return claim(text, values);
    });
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    const first = sent.filter(q => q.text === ANSWER_SQL && q.values[1] === 'b1');
    expect(first).toHaveLength(2);
    expect(lines('[GuildRequests] ')).toEqual([
      `[GuildRequests] The write of ${FROM} was claimed again after this process started it; it is answered with the first apply's outcome, not applied again`,
      `[GuildRequests] write of m/f.json for server ${GUILD}, sent from ALPHA: saved`,
    ]);
  });

  it('a row with no time left is retried every second up to 5 s after its claim: six attempts', async () => {
    const claim = claims([dataRow('0')]);
    const s = sweepWith((text, values) => {
      if (text === ANSWER_SQL) return Object.assign(new Error('duplicate key'), { code: '23505' });
      return claim(text, values);
    });
    await s.pass();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(count(ANSWER_SQL)).toBe(6);
  });
});

describe('the unanswered batches statement', () => {
  it('leaves out an id whose hour since its claim ran out while the statement was being built', async () => {
    let armed = false;
    let calls = 0;
    const gate = {
      epoch: () => {
        if (armed && ++calls === 2) vi.advanceTimersByTime(20);
        return 1;
      },
      refusal: () => null,
      stopWhy: () => null,
    };
    let claimCalls = 0;
    const script = claims([dataRow('20000')], new Error('Connection terminated'));
    const s2 = sweepWith((text, values) => {
      if (text === ANSWER_SQL) return { rows: [], rowCount: 1 };
      if (text === REQUEST_CLAIM_SQL) claimCalls += 1;
      return script(text, values);
    }, { gate });
    await s2.pass();
    await flush();
    expect(claimCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(3_600_000 - 10);
    armed = true;
    await s2.pass();
    await flush();
    const statements = sent.filter(q => q.text === UNANSWERED_BATCHES_SQL);
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toEqual([['b2'], []]);
  });

  it('a batch kept for over an hour is no longer sent', async () => {
    const s = sweepWith(claims(new Error('Connection terminated')));
    await s.pass();
    await flush();
    expect(sent.filter(q => q.text === UNANSWERED_BATCHES_SQL).map(q => q.values[0])).toEqual([['b1']]);
    await vi.advanceTimersByTimeAsync(3_600_001);
    await s.pass();
    await flush();
    expect(count(UNANSWERED_BATCHES_SQL)).toBe(1);
  });
});

describe('the cleanup', () => {
  it('runs nothing while the data layer does not serve', async () => {
    const s = sweepWith(() => undefined, { serving: () => false });
    await s.cleanupTick();
    expect(sent).toEqual([]);
  });

  it('sends both statements with no parameters', async () => {
    const s = sweepWith(() => undefined);
    await s.cleanupTick();
    expect(sent).toEqual([{ text: CLEANUP_BODIES_SQL, values: [] }, { text: CLEANUP_SQL, values: [] }]);
  });

  it('runs again exactly 60 s after the last one', async () => {
    const s = sweepWith(() => undefined);
    await s.cleanupTick();
    await vi.advanceTimersByTimeAsync(59_999);
    await s.cleanupTick();
    expect(count(CLEANUP_SQL)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await s.cleanupTick();
    expect(count(CLEANUP_SQL)).toBe(2);
  });
});

describe('the places-full line', () => {
  it('lists each running action with its age in seconds, and is written again exactly 30 s later', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => invokeRow(`a${i}`));
    const s = sweepWith(claims(rows), { panel: hangingHooks });
    await vi.advanceTimersByTimeAsync(5000);
    await s.pass();
    await flush();
    expect(s.runningActionCount()).toBe(8);
    await vi.advanceTimersByTimeAsync(2000);
    await s.pass();
    await flush();
    const item = (age: number) => `command:invoke of server ${GUILD} for ${age} s`;
    const line = (age: number) => `[GuildRequests] 8 panel actions or commands sent from other machines still run (${Array(8).fill(item(age)).join(', ')}); new ones are not taken until one ends or this bot restarts`;
    expect(lines('[GuildRequests] 8 panel')).toEqual([line(2)]);
    await vi.advanceTimersByTimeAsync(30_000);
    await s.pass();
    await flush();
    expect(lines('[GuildRequests] 8 panel')).toEqual([line(2), line(32)]);
  });
});

describe('the unprotected-transport line', () => {
  it('is written once, then not again for 10 minutes, then again exactly 10 minutes after the last one', async () => {
    const s = sweepWith(claims(new UnprotectedTransportError(), new UnprotectedTransportError(), new UnprotectedTransportError()));
    await vi.advanceTimersByTimeAsync(700_000);
    await s.pass();
    expect(lines(UNPROTECTED)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await s.pass();
    expect(lines(UNPROTECTED)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(599_000);
    await s.pass();
    expect(lines(UNPROTECTED)).toHaveLength(2);
  });

  it('is written again at once after a claim on a protected client worked', async () => {
    const s = sweepWith(claims(new UnprotectedTransportError(), [], new UnprotectedTransportError()));
    await s.pass();
    await vi.advanceTimersByTimeAsync(1000);
    await s.pass();
    await vi.advanceTimersByTimeAsync(1000);
    await s.pass();
    expect(lines(UNPROTECTED)).toHaveLength(2);
  });
});

describe('the claim-failed line', () => {
  it('is written once, then not again for 30 s, then again exactly 30 s after the last one', async () => {
    const fail = () => new Error('Connection terminated');
    const s = sweepWith(claims(fail(), fail(), fail()));
    await vi.advanceTimersByTimeAsync(700_000);
    await s.pass();
    expect(lines(CLAIM_FAILED)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await s.pass();
    expect(lines(CLAIM_FAILED)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_000);
    await s.pass();
    expect(lines(CLAIM_FAILED)).toHaveLength(2);
  });

  it('a working claim says so once, and a failure after it is written at once', async () => {
    const fail = () => new Error('Connection terminated');
    const s = sweepWith(claims(fail(), [], [], fail()));
    await s.pass();
    await vi.advanceTimersByTimeAsync(1000);
    await s.pass();
    await vi.advanceTimersByTimeAsync(1000);
    await s.pass();
    expect(lines(CLAIM_WORKS)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await s.pass();
    expect(lines(CLAIM_FAILED)).toHaveLength(2);
  });
});

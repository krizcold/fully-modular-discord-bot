import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GuildRequestSweep,
  UnprotectedTransportError,
  keptAnswer,
  type PanelHooks,
  type SweepDeps,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ANSWER_SQL,
  READ_ANSWERS_SQL,
  REQUEST_CLAIM_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { MAX_BODY_BYTES } from '../../src/bot/internalSetup/utils/panelRequestShape';

interface Sent { text: string; values: any[] }

const GUILD = String(1n << 22n);
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const HOUR = 60 * 60 * 1000;
const CHANNELS = { success: true, channels: [{ id: '1' }] };

let sent: Sent[];
let onClaim: () => Promise<{ rows: any[] }>;
let hooks: PanelHooks;
let applies: number;

function makeHooks(): PanelHooks {
  return {
    answerPanel: vi.fn(async () => CHANNELS),
    answerInvoke: vi.fn(async () => ({ success: true, ran: true })),
    maintenanceRefusal: () => null,
    getPanel: () => ({ panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: () => ({ success: true, guilds: [] }),
    registerInterest: () => 1,
  };
}

function sweep(over: Partial<SweepDeps> = {}) {
  let batch = 0;
  const deps: SweepDeps = {
    db: {
      query: async (text, values) => {
        sent.push({ text, values });
        if (text === REQUEST_CLAIM_SQL) return onClaim();
        return { rows: [], rowCount: Array.isArray(values?.[0]) ? (values[0] as unknown[]).length : 1 };
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => { applies += 1; return { ok: true }; },
    newId: () => `b${++batch}`,
    hrtime: () => 1000n,
    panel: hooks,
    ...over,
  };
  return new GuildRequestSweep(deps);
}

function claims(...passes: any[][]) {
  let i = 0;
  return async () => ({ rows: i < passes.length ? passes[i++] : [] });
}

function readRow(body: unknown, id = 'q1') {
  return { id, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'guild:channels', body, requested_by: 'ALPHA', left_ms: 30_000 };
}

function writeRow(id = 'w1') {
  return {
    id, guild_id: GUILD, op: 'write', requested_by: 'ALPHA', left_ms: 30_000,
    body: JSON.stringify({ module: 'm', filename: 'f.json', contentJson: '{}' }),
  };
}

const claimCount = () => sent.filter(s => s.text === REQUEST_CLAIM_SQL).length;
const readAnswers = () => sent.filter(s => s.text === READ_ANSWERS_SQL).flatMap(s => s.values[0].map((id: string, i: number) => ({ id, reply: JSON.parse(s.values[1][i]) })));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };
const malformed = (reason: string) => ({ success: false, ran: false, code: 'invalid', error: `The request for this server was malformed (${reason}); nothing was run.` });

function bodyOfBytes(bytes: number): string {
  const base = JSON.stringify({ actor: OWNER, pad: '' });
  const text = JSON.stringify({ actor: OWNER, pad: 'x'.repeat(bytes - base.length) });
  expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
  return text;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  sent = [];
  onClaim = async () => ({ rows: [] });
  hooks = makeHooks();
  applies = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('keptAnswer', () => {
  it('keeps finite numbers and booleans, and drops objects, undefined and non-finite numbers', () => {
    const kept = keptAnswer({ success: true, code: { x: 1 }, ran: 3, truth: Number.NaN, partial: Number.POSITIVE_INFINITY, pending: false });
    expect(kept).toStrictEqual({ oversize: { bytes: 0, reason: 'not-kept' }, success: true, ran: 3, pending: false });
    expect(Object.keys(kept).sort()).toEqual(['oversize', 'pending', 'ran', 'success']);
  });

  it('a liveSince that is not a finite number is not kept', () => {
    expect('liveSince' in keptAnswer({ success: true, liveSince: Number.NaN, liveVersion: 2 })).toBe(false);
    expect(keptAnswer({ success: true, liveSince: 7, liveVersion: 2 })).toMatchObject({ liveSince: 7, liveVersion: 2 });
  });

  it('a liveVersion that throws on read drops the liveSince already read', () => {
    const answer = { success: true, liveSince: 5, get liveVersion(): number { throw new Error('gone'); } };
    const kept = keptAnswer(answer);
    expect('liveSince' in kept).toBe(false);
    expect('liveVersion' in kept).toBe(false);
  });

  it('an answer with no boolean success keeps success false', () => {
    expect(keptAnswer({}).success).toBe(false);
    expect(keptAnswer({ success: 'yes' }).success).toBe(false);
    expect(keptAnswer({ success: true }).success).toBe(true);
  });
});

describe('the timers', () => {
  it('start runs a claim each second', async () => {
    const s = sweep();
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(claimCount()).toBe(1);
    s.stop();
  });

  it('stop after two starts leaves no timer that claims', async () => {
    const s = sweep();
    s.start();
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(claimCount()).toBe(0);
  });

  it('stop after one start leaves no timer that claims', async () => {
    const s = sweep();
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(claimCount()).toBe(0);
  });
});

describe('the pass', () => {
  it('a pass while one runs sends no second claim', async () => {
    let release!: () => void;
    onClaim = () => new Promise(resolve => { release = () => resolve({ rows: [] }); });
    const s = sweep();
    const first = s.pass();
    const second = s.pass();
    await flush();
    expect(claimCount()).toBe(1);
    release();
    await first;
    await second;
  });

  it('a claim rejected with undefined is logged and its batch is kept as unanswered', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onClaim = () => Promise.reject(undefined);
    const s = sweep();
    await expect(s.pass()).resolves.toBeUndefined();
    expect(s.unanswered()).toEqual(['b1']);
    expect(error.mock.calls.map(c => String(c[0]))).toContain("[GuildRequests] Cannot read the changes sent from other machines' panels (undefined); they are refused until this works");
  });

  it('the unprotected line comes again after a claim that worked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let n = 0;
    onClaim = async () => {
      n += 1;
      if (n === 2) return { rows: [] };
      throw new UnprotectedTransportError();
    };
    const s = sweep();
    await s.pass();
    await s.pass();
    await s.pass();
    const lines = error.mock.calls.map(c => String(c[0])).filter(l => l.includes("does not check the database's certificate"));
    expect(lines).toHaveLength(2);
  });
});

describe('the hour a batch and a start are kept', () => {
  it('an unanswered batch is kept at exactly one hour and gone just after', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onClaim = () => Promise.reject(new Error('connection reset'));
    const s = sweep();
    await s.pass();
    expect(s.unanswered()).toEqual(['b1']);
    vi.advanceTimersByTime(HOUR);
    expect(s.unanswered()).toEqual(['b1']);
    vi.advanceTimersByTime(1);
    expect(s.unanswered()).toEqual([]);
  });

  it('a started write is counted at exactly one hour and not just after', async () => {
    onClaim = claims([writeRow()]);
    const s = sweep();
    await s.pass();
    await flush();
    expect(applies).toBe(1);
    expect(s.startedCount()).toBe(1);
    vi.advanceTimersByTime(HOUR);
    expect(s.startedCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(s.startedCount()).toBe(0);
  });

  it('a write started late in the process life is counted right after its claim', async () => {
    vi.advanceTimersByTime(2 * HOUR);
    onClaim = claims([writeRow()]);
    const s = sweep();
    await s.pass();
    await flush();
    expect(s.startedCount()).toBe(1);
  });

  it('a write claimed again is answered with the first outcome, logged, and not applied again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onClaim = claims([writeRow()], [writeRow()]);
    const s = sweep();
    await s.pass();
    await flush();
    await s.pass();
    await flush();
    expect(applies).toBe(1);
    expect(sent.filter(x => x.text === ANSWER_SQL).map(x => [x.values[0], x.values[1], JSON.parse(x.values[2])])).toEqual([
      ['w1', 'b1', { ok: true }],
      ['w1', 'b2', { ok: true }],
    ]);
    expect(warn.mock.calls.map(c => String(c[0]))).toContain(`[GuildRequests] The write of server ${GUILD} sent from ALPHA was claimed again after this process started it; it is answered with the first apply's outcome, not applied again`);
  });
});

describe('the start checks of a read', () => {
  async function answerFor(body: unknown) {
    onClaim = claims([readRow(body)]);
    const s = sweep();
    await expect(s.pass()).resolves.toBeUndefined();
    await flush();
    return readAnswers();
  }

  it('a body of exactly 16 KiB is answered', async () => {
    expect(await answerFor(bodyOfBytes(MAX_BODY_BYTES))).toEqual([{ id: 'q1', reply: CHANNELS }]);
    expect(hooks.answerPanel).toHaveBeenCalledTimes(1);
  });

  it('a body one byte over 16 KiB is refused', async () => {
    expect(await answerFor(bodyOfBytes(MAX_BODY_BYTES + 1))).toEqual([{ id: 'q1', reply: malformed('the request is over 16 KiB') }]);
    expect(hooks.answerPanel).not.toHaveBeenCalled();
  });

  it('a body that is not JSON is refused as not JSON', async () => {
    expect(await answerFor('{not json')).toEqual([{ id: 'q1', reply: malformed('the request is not JSON') }]);
  });

  it('a row with no body is refused as not JSON', async () => {
    expect(await answerFor(undefined)).toEqual([{ id: 'q1', reply: malformed('the request is not JSON') }]);
  });

  it('a body of null is refused as not an object', async () => {
    expect(await answerFor('null')).toEqual([{ id: 'q1', reply: malformed('the request is not an object') }]);
  });

  it('a body of a number is refused as not an object', async () => {
    expect(await answerFor('5')).toEqual([{ id: 'q1', reply: malformed('the request is not an object') }]);
    expect(hooks.answerPanel).not.toHaveBeenCalled();
  });
});

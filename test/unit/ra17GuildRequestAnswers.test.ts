import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuildRequestSweep, RequestsStoppedError, type PanelHooks } from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ANSWER_READ_BACK_SQL,
  ANSWER_SQL,
  READ_ANSWERS_READ_BACK_SQL,
  READ_ANSWERS_SQL,
  REQUEST_CLAIM_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';

const GUILD = String(1n << 22n);
const OWNER = { via: 'owner', userId: 'web-ui-owner' };

interface Call { text: string; values: any[]; carries: boolean | undefined }
interface Row { batch: string | null; state: string; reply: string | null }
type Override = (call: Call, n: number, real: () => { rows: any[]; rowCount: number }) => unknown;

let logs: string[];
let warns: string[];
let errors: string[];

function fakeDb(passes: any[][], overrides: Partial<Record<string, Override>> = {}) {
  const table = new Map<string, Row>();
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  let pass = 0;
  const realOf = (text: string, values: any[]): { rows: any[]; rowCount: number } => {
    if (text === REQUEST_CLAIM_SQL) {
      const rows = passes[pass++] ?? [];
      for (const r of rows) {
        const kept = table.get(r.id);
        table.set(r.id, { batch: String(values[1]), state: 'applying', reply: kept?.reply ?? null });
      }
      return { rows, rowCount: rows.length };
    }
    if (text === ANSWER_SQL) {
      const row = table.get(String(values[0]));
      if (!row || row.batch !== values[1] || row.state !== 'applying') return { rows: [], rowCount: 0 };
      row.state = 'done';
      row.reply = String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (text === READ_ANSWERS_SQL) {
      let n = 0;
      (values[0] as string[]).forEach((id, i) => {
        const row = table.get(id);
        if (!row || row.batch !== values[2] || row.state !== 'applying') return;
        row.state = 'done';
        row.reply = (values[1] as string[])[i];
        n += 1;
      });
      return { rows: [], rowCount: n };
    }
    if (text === ANSWER_READ_BACK_SQL) {
      const row = table.get(String(values[0]));
      return { rows: row ? [{ state: row.state, reply: row.reply }] : [], rowCount: row ? 1 : 0 };
    }
    if (text === READ_ANSWERS_READ_BACK_SQL) {
      const ids = Array.isArray(values[0]) ? (values[0] as string[]) : [];
      const rows = ids.filter(id => table.has(id)).map(id => ({ id, state: table.get(id)!.state, reply: table.get(id)!.reply }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const db = {
    query: async (text: string, values: unknown[], _bound: number, _at?: number | null, carries?: boolean) => {
      const call: Call = { text, values: values as any[], carries };
      calls.push(call);
      const n = (counts.get(text) ?? 0) + 1;
      counts.set(text, n);
      const override = overrides[text];
      const out = override ? await override(call, n, () => realOf(text, values as any[])) : realOf(text, values as any[]);
      return out as { rows: any[]; rowCount: number };
    },
  };
  return { db, table, calls, count: (text: string) => counts.get(text) ?? 0 };
}

function hooks(answers: Record<string, unknown>): PanelHooks {
  return {
    answerPanel: async (_op, body) => answers[String((body as any).tag)],
    answerInvoke: async () => ({ success: true }),
    maintenanceRefusal: () => null,
    getPanel: () => ({ panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: () => ({ success: true, guilds: [] }),
    registerInterest: () => 1,
  };
}

function readRow(id: string, tag: string) {
  return {
    id, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'guild:roles',
    body: JSON.stringify({ actor: OWNER, tag }), requested_by: 'ALPHA', left_ms: 30_000,
  };
}

function dataRow(id: string, body: object, leftMs = 30_000) {
  return { id, guild_id: GUILD, op: 'write', body: JSON.stringify(body), requested_by: 'ALPHA', left_ms: leftMs };
}

function sweepOf(db: { query: any }, panel?: PanelHooks, batches: string[] = ['b1', 'b2', 'b3']) {
  let n = 0;
  return new GuildRequestSweep({
    db,
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    newId: () => batches[n++] ?? `b${n}`,
    hrtime: () => 1000n,
    panel,
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
}

const rolesAnswer = (fill: string) => ({ success: true, roles: [fill] });
const textOf = (answer: unknown) => JSON.stringify(answer);
const transient = () => new Error('Connection terminated');

beforeEach(() => {
  logs = [];
  warns = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the answers to reads sent from other machines', () => {
  it('two reads that together hold exactly 256 KiB are answered in one statement', async () => {
    const base = Buffer.byteLength(textOf(rolesAnswer('')), 'utf8');
    const fill = 'x'.repeat(128 * 1024 - base);
    const a = rolesAnswer(fill);
    const b = rolesAnswer(fill.replace(/^x/, 'y'));
    expect(Buffer.byteLength(textOf(a), 'utf8') + Buffer.byteLength(textOf(b), 'utf8')).toBe(256 * 1024);
    const f = fakeDb([[readRow('r1', 'a'), readRow('r2', 'b')]]);
    await sweepOf(f.db, hooks({ a, b })).pass();
    await waitFor(() => f.table.get('r2')?.state === 'done' && f.table.get('r1')?.state === 'done');
    const writes = f.calls.filter(c => c.text === READ_ANSWERS_SQL);
    expect(writes).toHaveLength(1);
    expect(writes[0].values[0]).toEqual(['r1', 'r2']);
    expect(f.table.get('r1')!.reply).toBe(textOf(a));
    expect(f.table.get('r2')!.reply).toBe(textOf(b));
  });

  it('a short count reads each row back and stays quiet when each row holds its own answer', async () => {
    const a = rolesAnswer('first');
    const b = rolesAnswer('second');
    const f = fakeDb([[readRow('r1', 'a'), readRow('r2', 'b')]], {
      [READ_ANSWERS_SQL]: (_c, _n, real) => ({ rows: [], rowCount: real().rowCount - 1 }),
    });
    await sweepOf(f.db, hooks({ a, b })).pass();
    await waitFor(() => f.count(READ_ANSWERS_READ_BACK_SQL) > 0);
    await waitFor(() => false);
    expect(f.count(READ_ANSWERS_READ_BACK_SQL)).toBe(1);
    expect(f.calls.find(c => c.text === READ_ANSWERS_READ_BACK_SQL)!.values).toEqual([['r1', 'r2']]);
    expect(f.table.get('r1')!.reply).toBe(textOf(a));
    expect(f.table.get('r2')!.reply).toBe(textOf(b));
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a read whose row holds another answer is named in a warning', async () => {
    const f = fakeDb([[readRow('r1', 'a')]], {
      [READ_ANSWERS_SQL]: () => {
        f.table.get('r1')!.reply = '{"other":true}';
        return { rows: [], rowCount: 0 };
      },
    });
    await sweepOf(f.db, hooks({ a: rolesAnswer('mine') })).pass();
    await waitFor(() => warns.length > 0 || errors.length > 0);
    expect(errors).toEqual([]);
    expect(warns).toEqual([
      `[GuildRequests] The guild:roles of server ${GUILD} sent from ALPHA was answered, but its row holds another answer or none (no attempt answered); its sender may have read that answer or can't confirm`,
    ]);
  });

  it('a failed answer is retried a second later and the retry records it without a warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const a = rolesAnswer('mine');
    const f = fakeDb([[readRow('r1', 'a')]], {
      [READ_ANSWERS_SQL]: (_c, n, real) => { if (n === 1) throw transient(); return real(); },
    });
    await sweepOf(f.db, hooks({ a })).pass();
    await waitFor(() => f.count(READ_ANSWERS_SQL) === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => f.table.get('r1')?.state === 'done');
    expect(f.count(READ_ANSWERS_SQL)).toBe(2);
    expect(f.table.get('r1')!.reply).toBe(textOf(a));
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a statement that throws null is retried like any other failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const a = rolesAnswer('mine');
    const f = fakeDb([[readRow('r1', 'a')]], {
      [READ_ANSWERS_SQL]: (_c, n, real) => { if (n === 1) throw null; return real(); },
    });
    await sweepOf(f.db, hooks({ a })).pass();
    await waitFor(() => f.count(READ_ANSWERS_SQL) === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => f.table.get('r1')?.state === 'done');
    expect(f.count(READ_ANSWERS_SQL)).toBe(2);
    expect(f.table.get('r1')!.reply).toBe(textOf(a));
  });

  it('an answer that keeps failing is tried 11 times over 10 s, then read back and named', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fakeDb([[readRow('r1', 'a')]], {
      [READ_ANSWERS_SQL]: () => { throw transient(); },
    });
    await sweepOf(f.db, hooks({ a: rolesAnswer('mine') })).pass();
    await waitFor(() => f.count(READ_ANSWERS_SQL) === 1);
    for (let i = 0; i < 15; i++) await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => warns.length > 0);
    expect(f.count(READ_ANSWERS_SQL)).toBe(11);
    expect(f.count(READ_ANSWERS_READ_BACK_SQL)).toBe(1);
    expect(warns).toEqual([
      `[GuildRequests] The guild:roles of server ${GUILD} sent from ALPHA was answered, but its row holds another answer or none (Connection terminated); its sender may have read that answer or can't confirm`,
    ]);
  });

  it('a stop that never sent is not retried, and a failed read-back says the answer was not recorded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fakeDb([[readRow('r1', 'a')]], {
      [READ_ANSWERS_SQL]: () => { throw new RequestsStoppedError(null, true); },
      [READ_ANSWERS_READ_BACK_SQL]: () => { throw new Error('read-back lost'); },
    });
    await sweepOf(f.db, hooks({ a: rolesAnswer('mine') })).pass();
    await waitFor(() => errors.length > 0);
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => false);
    expect(f.count(READ_ANSWERS_SQL)).toBe(1);
    expect(errors).toEqual([
      "[GuildRequests] Could not record the answers to 1 reads sent from other machines (read-back lost); their senders read can't confirm",
    ]);
  });
});

describe('the answer to a data change sent from another machine', () => {
  it('a file with no module is named alone in the log', async () => {
    const f = fakeDb([[dataRow('w1', { filename: 'f.json', contentJson: '{}' })]]);
    await sweepOf(f.db).pass();
    await waitFor(() => logs.length > 0);
    expect(logs).toEqual([`[GuildRequests] write of f.json for server ${GUILD}, sent from ALPHA: saved`]);
  });

  it('a change with no file names none in the log', async () => {
    const f = fakeDb([[dataRow('w1', { contentJson: '{}' })]]);
    await sweepOf(f.db).pass();
    await waitFor(() => logs.length > 0);
    expect(logs).toEqual([`[GuildRequests] write for server ${GUILD}, sent from ALPHA: saved`]);
  });

  it('the answer and its read-back go as statements that carry an answer, and the read-back of its own row confirms it', async () => {
    const f = fakeDb([[dataRow('w1', { module: 'm', filename: 'f.json', contentJson: '{}' })]], {
      [ANSWER_SQL]: (_c, _n, real) => { real(); return { rows: [], rowCount: 0 }; },
    });
    await sweepOf(f.db).pass();
    await waitFor(() => logs.length > 0 || warns.length > 0);
    const sent = f.calls.filter(c => c.text === ANSWER_SQL || c.text === ANSWER_READ_BACK_SQL);
    expect(sent.map(c => c.text)).toEqual([ANSWER_SQL, ANSWER_READ_BACK_SQL]);
    expect(sent.map(c => c.carries)).toEqual([true, true]);
    expect(sent[1].values).toEqual(['w1']);
    expect(warns).toEqual([]);
    expect(logs).toEqual([`[GuildRequests] write of m/f.json for server ${GUILD}, sent from ALPHA: saved`]);
  });

  it('a failed read-back after an answered statement does not count as a write that may have landed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fakeDb([[dataRow('w1', { module: 'm', filename: 'f.json', contentJson: '{}' })]], {
      [ANSWER_SQL]: (_c, n) => {
        if (n === 1) return { rows: [], rowCount: 0 };
        throw new RequestsStoppedError(null, true);
      },
      [ANSWER_READ_BACK_SQL]: () => { throw transient(); },
    });
    await sweepOf(f.db).pass();
    await waitFor(() => f.count(ANSWER_READ_BACK_SQL) === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => errors.length > 0);
    expect(f.count(ANSWER_SQL)).toBe(2);
    expect(errors).toEqual([
      `[GuildRequests] Could not record the answer to the write of server ${GUILD} sent from ALPHA (this process stopped writing to its database); its sender reads can't confirm. The answer was: saved`,
    ]);
  });

  it('an answer statement that throws null is retried and then recorded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fakeDb([[dataRow('w1', { module: 'm', filename: 'f.json', contentJson: '{}' })]], {
      [ANSWER_SQL]: (_c, n, real) => { if (n === 1) throw null; return real(); },
    });
    await sweepOf(f.db).pass();
    await waitFor(() => f.count(ANSWER_SQL) === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => logs.length > 0);
    expect(f.count(ANSWER_SQL)).toBe(2);
    expect(f.table.get('w1')!.state).toBe('done');
    expect(logs).toEqual([`[GuildRequests] write of m/f.json for server ${GUILD}, sent from ALPHA: saved`]);
  });

  it('the answer of a claim that was claimed again gives way to the later claim and logs nothing more', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const row = dataRow('w1', { module: 'm', filename: 'f.json', contentJson: '{}' });
    const f = fakeDb([[row], [row]], {
      [ANSWER_SQL]: async (c, _n, real) => {
        if (c.values[1] === 'b1') await held;
        return real();
      },
    });
    const s = sweepOf(f.db);
    await s.pass();
    await waitFor(() => f.count(ANSWER_SQL) === 1);
    await s.pass();
    await waitFor(() => logs.length > 0);
    release();
    await waitFor(() => f.count(ANSWER_READ_BACK_SQL) > 0 || logs.length > 1 || warns.length > 1);
    expect(f.table.get('w1')).toEqual({ batch: 'b2', state: 'done', reply: '{"ok":true}' });
    expect(logs).toEqual([`[GuildRequests] write of m/f.json for server ${GUILD}, sent from ALPHA: saved`]);
    expect(warns).toEqual([
      `[GuildRequests] The write of server ${GUILD} sent from ALPHA was claimed again after this process started it; it is answered with the first apply's outcome, not applied again`,
    ]);
    expect(f.count(ANSWER_READ_BACK_SQL)).toBe(0);
  });
});

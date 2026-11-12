import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GuildRequestSweep,
  RequestsStoppedError,
  UnprotectedTransportError,
  keptAnswer,
  type PanelHooks,
  type SweepDeps,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import type { GuildDataWriteRequest } from '../../src/bot/internalSetup/utils/ipcDataHandler';

const GUILD = String(1n << 22n);
const CHANNEL = '123456789012345678';
const OWNER = { via: 'owner', userId: 'web-ui-owner' };

let logs: string[];
let answered: string[];
let ids: number;

function sweepOver(rows: any[], over: Partial<SweepDeps> = {}) {
  let first = true;
  const deps: SweepDeps = {
    db: {
      query: async (text, values) => {
        if (text === REQUEST_CLAIM_SQL) {
          if (!first) return { rows: [] };
          first = false;
          return { rows };
        }
        if (text === ANSWER_SQL) answered.push(String(values[0]));
        return { rows: [], rowCount: 1 };
      },
    },
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    newId: () => 'b1',
    hrtime: () => 1000n,
    ...over,
  };
  return new GuildRequestSweep(deps);
}

function dataRow(body: string, op = 'write') {
  return { id: `r${++ids}`, guild_id: GUILD, op, body, requested_by: 'ALPHA', left_ms: 30_000 };
}

function invokeRow() {
  return {
    id: `r${++ids}`, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'command:invoke',
    body: JSON.stringify({ command: 'probe', channelId: CHANNEL, actor: OWNER }),
    requested_by: 'ALPHA', left_ms: 30_000,
  };
}

function hooksAnswering(answer: unknown): PanelHooks {
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

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
}

async function applied(body: string, op = 'write'): Promise<GuildDataWriteRequest[]> {
  const seen: GuildDataWriteRequest[] = [];
  const s = sweepOver([dataRow(body, op)], { apply: async req => { seen.push(req); return { ok: true }; } });
  await s.pass().catch(() => undefined);
  await waitFor(() => answered.length > 0);
  return seen;
}

async function dataOutcome(reply: any): Promise<string | undefined> {
  const s = sweepOver([dataRow(JSON.stringify({ module: 'm', filename: 'f.json', contentJson: '{}' }))], { apply: async () => reply });
  await s.pass();
  await waitFor(() => logs.some(l => l.startsWith('[GuildRequests] write')));
  return logs.find(l => l.startsWith('[GuildRequests] write of m/f.json for server'));
}

async function panelOutcome(answer: unknown): Promise<string | undefined> {
  const s = sweepOver([invokeRow()], { panel: hooksAnswering(answer) });
  await s.pass();
  await waitFor(() => logs.some(l => l.startsWith('[GuildRequests] command:invoke')));
  return logs.find(l => l.startsWith('[GuildRequests] command:invoke for server'));
}

beforeEach(() => {
  logs = [];
  answered = [];
  ids = 0;
  const keep = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the errors a sweep statement throws', () => {
  it('a stop with no why says only that the process stopped writing', () => {
    const error = new RequestsStoppedError(null, true);
    expect(error.message).toBe('this process stopped writing to its database');
    expect(String(error)).toBe('RequestsStoppedError: this process stopped writing to its database');
  });

  it('a stop with a why names it in parentheses', () => {
    expect(new RequestsStoppedError('lease lost', false).message).toBe('this process stopped writing to its database (lease lost)');
  });

  it('an unprotected transport refusal is not sent, and names the certificate check', () => {
    const error = new UnprotectedTransportError();
    expect(error.notSent).toBe(true);
    expect(error.message).toBe("this bot's database address does not check the database's certificate");
    expect(String(error)).toBe("UnprotectedTransportError: this bot's database address does not check the database's certificate");
  });
});

describe('keptAnswer', () => {
  it('keeps the code and the pending flag of an answer', () => {
    const kept = keptAnswer({ success: true, code: 'partial-write', pending: true, captured: [1, 2] });
    expect(kept.code).toBe('partial-write');
    expect(kept.pending).toBe(true);
    expect(kept.capturedOmitted).toEqual({ count: 2, bytes: 0, reason: 'not-kept' });
  });
});

describe('the logged outcome of a data change', () => {
  it('a refusal with an error and no code is logged as refused with the error', async () => {
    expect(await dataOutcome({ ok: false, error: 'disk full' })).toMatch(/: refused: disk full$/);
  });

  it('a refusal with a code and no error is logged as its code', async () => {
    expect(await dataOutcome({ ok: false, code: 'conflict' })).toMatch(/ALPHA: conflict$/);
  });

  it('a refusal with neither is logged as refused', async () => {
    expect(await dataOutcome({ ok: false })).toMatch(/ALPHA: refused$/);
  });
});

describe('the logged outcome of an action sent from another machine', () => {
  it('a run whose writes are pending says they are not confirmed as saved', async () => {
    expect(await panelOutcome({ success: true, pending: true })).toMatch(/ALPHA: ran, writes not confirmed as saved yet$/);
  });

  it('no answer at all is answered and logged as refused', async () => {
    const line = await panelOutcome(null);
    expect(answered).toHaveLength(1);
    expect(line).toMatch(/ALPHA: refused$/);
  });

  it('a refusal with a code and no error text is logged as the code and refused', async () => {
    expect(await panelOutcome({ success: false, code: 'not-ready' })).toMatch(/ALPHA: not-ready: refused$/);
  });

  it('a refusal with neither code nor error text is logged as refused', async () => {
    expect(await panelOutcome({ success: false })).toMatch(/ALPHA: refused$/);
  });

  it('a refusal with a code and an error is logged as both', async () => {
    expect(await panelOutcome({ success: false, code: 'not-allowed', error: 'No.' })).toMatch(/ALPHA: not-allowed: No\.$/);
  });
});

describe('the request a claimed data row hands to apply', () => {
  it('a body of JSON null is applied as a request with no module and no file', async () => {
    const seen = await applied('null');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toStrictEqual({ guildId: GUILD, op: 'write', module: '', filename: '' });
  });

  it('a body without module or file names neither', async () => {
    const seen = await applied(JSON.stringify({ contentJson: '{}' }));
    expect(seen[0].module).toBe('');
    expect(seen[0].filename).toBe('');
    expect('twin' in seen[0]).toBe(false);
  });

  it('a twin that is not an object is not passed on', async () => {
    const seen = await applied(JSON.stringify({ module: 'm', filename: 'f.json', twin: 'x' }));
    expect('twin' in seen[0]).toBe(false);
  });

  it('a twin object is passed on', async () => {
    const twin = { module: 'm2', filename: 'g.json' };
    const seen = await applied(JSON.stringify({ module: 'm', filename: 'f.json', twin }));
    expect(seen[0].twin).toEqual(twin);
  });

  it('sinceOpen true is passed on as true', async () => {
    const seen = await applied(JSON.stringify({ module: 'm', filename: 'f.json', sinceOpen: true }));
    expect(seen[0].sinceOpen).toBe(true);
  });

  it('sinceOpen false is not passed on', async () => {
    const seen = await applied(JSON.stringify({ module: 'm', filename: 'f.json', sinceOpen: false }));
    expect('sinceOpen' in seen[0]).toBe(false);
  });

  it('a delete-namespace gets its answer deadline on the monotonic clock', async () => {
    const seen = await applied(JSON.stringify({ module: 'm' }), 'delete-namespace');
    expect(seen[0].answerByMono).toBe(String(1000n + 30_000n * 1_000_000n));
  });
});

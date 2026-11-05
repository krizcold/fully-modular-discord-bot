import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// smdb verbs: each one asks the panel route it names with the right method and body, prints what the operator
// reads (tables, event lines, usage errors), and ends with the exit code the operator scripts against.

import { dispatch } from '../../src/cli/commands';

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

interface Call { method: string; path: string; opts: unknown }

let out: string[];
let err: string[];
let exits: Array<number | undefined>;
let throwOnExit: boolean;

beforeEach(() => {
  out = [];
  err = [];
  exits = [];
  throwOnExit = true;
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err.push(String(s)); return true; }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code);
    if (throwOnExit) throw new Exit(code);
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeClient(body: unknown = { success: true }) {
  const calls: Call[] = [];
  const ws: { cb?: (msg: { type: string; data: unknown }) => void; closed: number } = { closed: 0 };
  const client = {
    request: async (method: string, path: string, opts?: unknown) => {
      calls.push({ method, path, opts });
      return { status: 200, ok: true, body };
    },
    openWs: (cb: (msg: { type: string; data: unknown }) => void) => {
      ws.cb = cb;
      return { close: () => { ws.closed++; } };
    },
  };
  return { client, calls, ws };
}

async function run(positionals: string[], flags: Record<string, string | boolean> = { json: true }, body?: unknown) {
  const f = fakeClient(body);
  let code: number | undefined | 'none' = 'none';
  try {
    await dispatch(f.client as never, positionals, flags);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  }
  return { ...f, code, stdout: out.join(''), stderr: err.join('') };
}

describe('plain verbs ask the route they name', () => {
  const cases: Array<[string[], string, string]> = [
    [['update', 'all-modules'], 'POST', '/api/update/modules'],
    [['update', 'loaded-modules'], 'GET', '/api/update/loaded-modules'],
    [['update', 'backups'], 'GET', '/api/update/backups'],
    [['usage', 'global'], 'GET', '/api/usage/global'],
    [['usage', 'guilds'], 'GET', '/api/usage/guilds'],
    [['usage', 'guild', 'g 1'], 'GET', '/api/usage/guild/g%201'],
    [['fleet', 'state'], 'GET', '/api/fleet/state'],
    [['graveyard', 'list'], 'GET', '/api/data/graveyard'],
    [['health'], 'GET', '/api/health'],
  ];
  for (const [pos, method, path] of cases) {
    it(`${pos.join(' ')} sends ${method} ${path} and exits 0`, async () => {
      const r = await run(pos);
      expect(r.calls.map(c => [c.method, c.path])).toEqual([[method, path]]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(JSON.stringify({ success: true }, null, 2) + '\n');
    });
  }

  it('usage guild without a guild id names the missing argument', async () => {
    const r = await run(['usage', 'guild']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('smdb: missing argument: guildId\n');
    expect(r.calls).toEqual([]);
  });
});

describe('graveyard list in human mode', () => {
  it('prints the entries as an aligned table with the five columns', async () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const r = await run(['graveyard', 'list'], {}, {
        success: true,
        entries: [{ guildId: 'g1', retiredAt: 5, reason: 'left', rows: 3, backend: 'file' }],
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('guildId  retiredAt  reason  rows  backend\ng1       5          left    3     file\n');
    } finally {
      if (desc) Object.defineProperty(process.stdout, 'isTTY', desc);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});

describe('graveyard restore', () => {
  const restoreCall = (r: { calls: Call[] }) => r.calls.map(c => [c.method, c.path, c.opts]);

  it('without a retiredAt sends only the guild id', async () => {
    const r = await run(['graveyard', 'restore', 'g1']);
    expect(r.code).toBe(0);
    expect(restoreCall(r)).toEqual([['POST', '/api/data/graveyard/restore', { body: { guildId: 'g1' } }]]);
  });

  it('takes the retiredAt from the second argument', async () => {
    const r = await run(['graveyard', 'restore', 'g1', '1700']);
    expect(r.code).toBe(0);
    expect(restoreCall(r)).toEqual([['POST', '/api/data/graveyard/restore', { body: { guildId: 'g1', retiredAt: 1700 } }]]);
  });

  it('takes the retiredAt from --retired-at alone', async () => {
    const r = await run(['graveyard', 'restore', 'g1'], { json: true, 'retired-at': '42' });
    expect(r.code).toBe(0);
    expect(restoreCall(r)).toEqual([['POST', '/api/data/graveyard/restore', { body: { guildId: 'g1', retiredAt: 42 } }]]);
  });

  it('refuses a retiredAt that is not a number and sends nothing', async () => {
    const r = await run(['graveyard', 'restore', 'g1', 'abc']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('smdb: retiredAt must be a whole number of milliseconds\n');
    expect(r.calls).toEqual([]);
  });

  it('without a guild id names the missing argument', async () => {
    const r = await run(['graveyard', 'restore']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('smdb: missing argument: guildId\n');
    expect(r.calls).toEqual([]);
  });
});

describe('api', () => {
  it('upper-cases the method, passes the path and prints the answer', async () => {
    const r = await run(['api', 'get', '/api/x'], { json: true }, { success: true, v: 1 });
    expect(r.calls.map(c => [c.method, c.path, c.opts])).toEqual([['GET', '/api/x', { body: undefined }]]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(JSON.stringify({ success: true, v: 1 }, null, 2) + '\n');
  });

  it('sends the --body JSON', async () => {
    const r = await run(['api', 'POST', '/api/y'], { json: true, body: '{"a":1}' });
    expect(r.calls.map(c => c.opts)).toEqual([{ body: { a: 1 } }]);
  });

  it('names a missing method', async () => {
    const r = await run(['api']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('smdb: missing argument: METHOD\n');
  });

  it('names a missing path', async () => {
    const r = await run(['api', 'GET']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('smdb: missing argument: path\n');
  });
});

describe('events', () => {
  it('prints only events whose type starts with --filter, one JSON line each', async () => {
    throwOnExit = false;
    vi.useFakeTimers();
    const r = await run(['events'], { filter: 'a:' });
    expect(r.ws.cb).toBeTypeOf('function');
    const msgs = [
      { type: 'a:x', data: 1 },
      { type: 'b:y', data: 2 },
      { type: 'q:a:', data: 3 },
      { type: 'a:', data: 4 },
    ];
    for (const m of msgs) r.ws.cb!(m);
    expect(out.join('')).toBe(`${JSON.stringify(msgs[0])}\n${JSON.stringify(msgs[3])}\n`);
    vi.advanceTimersByTime(600_000);
    expect(exits).toEqual([]);
    expect(r.ws.closed).toBe(0);
  });

  it('without --filter prints every event', async () => {
    throwOnExit = false;
    const r = await run(['events'], {});
    const m = { type: 'z', data: null };
    r.ws.cb!(m);
    expect(out.join('')).toBe(`${JSON.stringify(m)}\n`);
  });

  it('with --timeout closes the socket and exits 0 when it runs out', async () => {
    throwOnExit = false;
    vi.useFakeTimers();
    const r = await run(['events'], { timeout: '1' });
    vi.advanceTimersByTime(999);
    expect(exits).toEqual([]);
    expect(r.ws.closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(r.ws.closed).toBe(1);
    expect(exits).toEqual([0]);
  });
});

describe('wait', () => {
  it('polls --get until --until holds, prints the body and exits 0', async () => {
    const r = await run(['wait'], { get: '/api/s', until: 'data.a === 1' }, { a: 1 });
    expect(r.calls.map(c => [c.method, c.path])).toEqual([['GET', '/api/s']]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(JSON.stringify({ a: 1 }, null, 2) + '\n');
  });

  const usage = 'smdb: wait requires --get <path> and --until <expr>\n';
  it('without --get is a usage error', async () => {
    const r = await run(['wait'], { until: 'true' });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(usage);
    expect(r.calls).toEqual([]);
  });

  it('without --until is a usage error', async () => {
    const r = await run(['wait'], { get: '/api/s' });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(usage);
    expect(r.calls).toEqual([]);
  });

  it('with neither flag is a usage error', async () => {
    const r = await run(['wait'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(usage);
  });
});

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const A = 'postgres://bot@db1:5432/bot';
const W = 'postgres://bot@db2:5432/bot';
const BAD = 'mysql://bot@db3:5432/bot';
const PREFIX_CAUSE = 'it does not start with postgresql:// or postgres://';
const CAUSE = { kind: 'replaced', machine: 'node-b', generation: 4 } as const;

const backends: PostgresBackend[] = [];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  for (const b of backends.splice(0)) await b.stop().catch(() => undefined);
  vi.restoreAllMocks();
});

function chooserOf(chosen: string | null, awaited: string | null = chosen): DatabaseChooser {
  return {
    chosen: () => chosen,
    awaitChoice: async () => awaited,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

function fakePool() {
  const emitter = new EventEmitter();
  const pool = {
    connect: vi.fn(async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {}, end: async () => undefined })),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    end: vi.fn(async () => undefined),
    on: (event: string, fn: (...args: unknown[]) => void) => { emitter.on(event, fn); return pool; },
  };
  return pool;
}

type Internals = {
  pool: unknown;
  makePool(config: unknown): unknown;
  sleep(ms: number): Promise<void>;
  bootstrapLoop(): Promise<void>;
};
const internals = (b: PostgresBackend) => b as unknown as Internals;
const lines = (fn: typeof console.error) => vi.mocked(fn).mock.calls.map(c => c.map(String).join(' '));
const steps = () => ({ checkTarget: async () => null, claims: async () => true, settleRetires: async () => true, moved: vi.fn() });

function made(chooser: DatabaseChooser): PostgresBackend {
  const backend = new PostgresBackend({ chooser });
  backends.push(backend);
  return backend;
}

function thrownBy(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return 'nothing thrown';
}

describe('sa5: the data pool a move builds', () => {
  it('turns TCP keepalive on for the new database pool', async () => {
    const backend = made(chooserOf(A));
    internals(backend).pool = fakePool();
    const built: Array<Record<string, unknown>> = [];
    internals(backend).makePool = config => { built.push(config as Record<string, unknown>); return fakePool(); };
    backend.latch(CAUSE);
    expect(await backend.useDatabase(W, steps())).toBe(true);
    expect(built).toHaveLength(1);
    expect(built[0].keepAlive).toBe(true);
  });

  it('logs only the refusal line when the target address cannot be used', async () => {
    const backend = made(chooserOf(A));
    internals(backend).pool = fakePool();
    backend.latch(CAUSE);
    vi.mocked(console.error).mockClear();
    expect(await backend.useDatabase(BAD, steps())).toBe(false);
    expect(lines(console.error)).toEqual([
      `[Database] Not moving to db3:5432/bot: its address can't be used (${PREFIX_CAUSE}); this process keeps its unsaved changes and stays stopped`,
    ]);
  });
});

describe('sa5: the boot loop', () => {
  it('ends without a connect attempt when the chooser answers no database', async () => {
    const backend = made(chooserOf(null, null));
    const sleeps: number[] = [];
    internals(backend).sleep = async ms => { sleeps.push(ms); await backend.stop(); };
    await internals(backend).bootstrapLoop();
    expect(sleeps).toEqual([]);
    expect(lines(console.warn).filter(l => l.includes('Bootstrap attempt'))).toEqual([]);
    expect(backend.connectionState().state).toBe('connecting');
    expect(backend.chosenEntry()).toBeNull();
  });

  it('counts each failed attempt up and backs off longer after each one', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const backend = made(chooserOf(null, BAD));
    const sleeps: number[] = [];
    internals(backend).sleep = async ms => {
      sleeps.push(ms);
      if (sleeps.length >= 3) await backend.stop();
    };
    await internals(backend).bootstrapLoop();
    const cause = `the address db3:5432/bot can't be used (${PREFIX_CAUSE})`;
    expect(lines(console.warn).filter(l => l.includes('Bootstrap attempt'))).toEqual([
      `[PostgresBackend] Bootstrap attempt 1 failed (retrying): ${cause}`,
      `[PostgresBackend] Bootstrap attempt 2 failed (retrying): ${cause}`,
      `[PostgresBackend] Bootstrap attempt 3 failed (retrying): ${cause}`,
    ]);
    expect(sleeps).toEqual([999, 1998, 3996]);
  });
});

describe('sa5: why the chosen entry cannot be used', () => {
  it('names "the chosen address" for an entry that is no URL', () => {
    const backend = made(chooserOf('not a url'));
    expect(thrownBy(() => backend.getPool())).toBe(`the chosen address can't be used (${PREFIX_CAUSE})`);
  });

  it('names the address of an entry that has a no-break space before it', () => {
    const backend = made(chooserOf(String.fromCharCode(0xa0) + BAD));
    expect(thrownBy(() => backend.getPool())).toBe(`the address db3:5432/bot can't be used (${PREFIX_CAUSE})`);
  });
});

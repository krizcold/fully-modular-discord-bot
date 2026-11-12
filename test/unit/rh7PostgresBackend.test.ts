import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser, MoveSteps } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const FROM = 'postgres://nobody@127.0.0.1:9/from';
const C_URL = 'postgres://nobody@127.0.0.1:9/c';
const D_URL = 'postgres://nobody@127.0.0.1:9/d';
const CAUSE = { kind: 'replaced', machine: 'machine-b', generation: 2 } as const;

type Result = { rows: Array<Record<string, unknown>>; rowCount: number };

interface FakePool {
  sent: string[];
  connect(): Promise<never>;
  query(config: unknown): Promise<Result>;
  on(): void;
  end(): Promise<void>;
}

let pools: FakePool[] = [];
let backends: PostgresBackend[] = [];

beforeEach(() => {
  pools = [];
  backends = [];
  vi.spyOn(PostgresBackend.prototype as unknown as { makePool(config: unknown): unknown }, 'makePool').mockImplementation(() => {
    const pool: FakePool = {
      sent: [],
      connect: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
      async query(config: unknown) {
        pool.sent.push(typeof config === 'string' ? config : (config as { text: string }).text);
        return { rows: [], rowCount: 0 };
      },
      on() {},
      async end() {},
    };
    pools.push(pool);
    return pool;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const backend of backends) await backend.stop();
  vi.restoreAllMocks();
});

function chooser(): DatabaseChooser {
  return {
    chosen: () => FROM,
    awaitChoice: async () => FROM,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

function make(): PostgresBackend {
  const backend = new PostgresBackend({ chooser: chooser() });
  backends.push(backend);
  return backend;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function until(condition: () => boolean, boundMs = 2000): Promise<boolean> {
  const end = Date.now() + boundMs;
  while (!condition()) {
    if (Date.now() > end) return false;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return true;
}

function steps(over: Partial<MoveSteps> = {}): MoveSteps {
  return {
    checkTarget: async () => null,
    claims: async () => true,
    settleRetires: async () => true,
    moved: () => undefined,
    ...over,
  };
}

describe('the bootstrap asks the database first', () => {
  it('sends SELECT 1 as its first statement on the chosen pool', async () => {
    const backend = make();
    backend.start();
    expect(await until(() => pools[0]?.sent.length > 0)).toBe(true);
    expect(pools[0].sent[0]).toBe('SELECT 1');
  });
});

describe('a move that waited on its check while another move lifted the latch', () => {
  it('does not move once the latch is gone', async () => {
    const backend = make();
    backend.latch(CAUSE);
    const claimsC = deferred<boolean>();
    const checkD = deferred<null>();
    const movedD = vi.fn();
    const c = backend.useDatabase(C_URL, steps({ claims: () => claimsC.promise }));
    expect(await until(() => backend.chosenEntry() === C_URL)).toBe(true);
    const d = backend.useDatabase(D_URL, steps({ checkTarget: () => checkD.promise, moved: movedD }));
    claimsC.resolve(true);
    expect(await c).toBe(true);
    expect(backend.connectionState()).toEqual({ state: 'ready' });
    checkD.resolve(null);
    expect(await d).toBe(false);
    expect(backend.chosenEntry()).toBe(C_URL);
    expect(movedD).not.toHaveBeenCalled();
  });
});

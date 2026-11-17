import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  pass: null as null | (() => Promise<{ ok: true } | { ok: false; cause: string; local?: true }>),
  passes: 0,
  mutex: null as null | (() => Promise<{ release(): void }>),
  releases: 0,
}));

vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    runStoreDocsPass: (locked: any) => {
      if (!ctl.pass) return real.runStoreDocsPass(locked);
      ctl.passes += 1;
      return ctl.pass();
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    takeStoreMutex: () => (ctl.mutex ? ctl.mutex() : real.takeStoreMutex()),
  };
});

import { BotManager, storeDocsUnreadText } from '../../src/webui/botManager';
import { setBackendKind } from '../helpers/backendKind';

function first(self: { botProcess: object | null; unexitedChildren: Map<number, unknown> }) {
  return BotManager.prototype.storeDocsFirst.call(self as unknown as BotManager);
}

const idle = () => ({ botProcess: null, unexitedChildren: new Map<number, unknown>() });

beforeEach(() => {
  ctl.passes = 0;
  ctl.releases = 0;
  ctl.pass = async () => ({ ok: false, cause: 'connect ECONNREFUSED' });
  ctl.mutex = async () => ({ release: () => { ctl.releases += 1; } });
  setBackendKind('postgres');
});

afterEach(() => {
  vi.useRealTimers();
  setBackendKind(null);
  ctl.pass = null;
  ctl.mutex = null;
});

describe('when the store docs pass runs first', () => {
  it('a Postgres bot with no child runs it and answers its refusal', async () => {
    expect(await first(idle())).toEqual({ status: 503, error: storeDocsUnreadText('connect ECONNREFUSED') });
    expect(ctl.passes).toBe(1);
    expect(ctl.releases).toBe(1);
  });

  it('a JSON bot runs no pass and goes on', async () => {
    setBackendKind('file');
    expect(await first(idle())).toBeNull();
    expect(ctl.passes).toBe(0);
  });

  it('a running bot child runs no pass and goes on', async () => {
    expect(await first({ botProcess: {}, unexitedChildren: new Map() })).toBeNull();
    expect(ctl.passes).toBe(0);
  });

  it('a previous child not yet exited runs no pass and goes on', async () => {
    expect(await first({ botProcess: null, unexitedChildren: new Map([[4242, {}]]) })).toBeNull();
    expect(ctl.passes).toBe(0);
  });
});

describe('the store mutex', () => {
  it('a mutex that cannot be taken answers 500 with its error and runs no pass', async () => {
    ctl.mutex = async () => { throw new Error('the store mutex file is unreadable'); };
    expect(await first(idle())).toEqual({ status: 500, error: 'the store mutex file is unreadable' });
    expect(ctl.passes).toBe(0);
  });
});

describe("the pass's 10 s bound", () => {
  it('a pass with no answer within 10 s answers 503 naming the bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ctl.pass = () => new Promise(() => undefined);
    let answer: unknown = 'pending';
    void first(idle()).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({
      status: 503,
      error: "Can't reach the database to read the App Store's files (no answer within 10 s); nothing was changed. Try again in a moment.",
    });
  });

  it('a pass that answers leaves no timer pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ctl.pass = async () => ({ ok: true });
    expect(await first(idle())).toBeNull();
    expect(ctl.releases).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

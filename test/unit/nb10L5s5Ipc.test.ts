import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 survivors, chunk 5 (sharedOps.ts): the bot process's shared:op handler is installed once and only with an IPC
// channel, ignores a message that is not an object, answers a throw of the op or of the global read with a not-ok
// answer whose code names which request failed, and logs an answer it could not send.

const ctl = vi.hoisted(() => ({
  lockError: null as unknown,
  readError: null as unknown,
}));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  checkWriterLock: () => {
    if (ctl.lockError !== null) throw ctl.lockError;
    return { kind: 'not-held' };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', async orig => ({
  ...(await orig<any>()),
  applyOperatorGlobalRead: () => {
    if (ctl.readError !== null) throw ctl.readError;
    return { ok: true, read: 'fine' };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceIpcRefusal: () => null,
}));

import * as sharedOps from '../../src/bot/internalSetup/utils/sharedOps';

type Listener = (message: unknown) => Promise<void>;

const realSend = process.send;
let installed: Listener[] = [];
let sent: Array<{ requestId: string; data: unknown }> = [];
let sendError: unknown = null;
let errors: ReturnType<typeof vi.spyOn>;

/** A fresh copy of sharedOps, so each test starts with no handler installed. */
async function freshOps(): Promise<typeof sharedOps> {
  vi.resetModules();
  return import('../../src/bot/internalSetup/utils/sharedOps');
}

/** Installs the handler with process.on captured (never registered on the worker's real channel). */
function install(ops: typeof sharedOps, withChannel = true): void {
  const original = process.send;
  if (!withChannel) (process as any).send = undefined;
  try {
    ops.setupSharedOpsIPC();
  } finally {
    (process as any).send = original;
  }
}

/** Delivers one message to the installed handler, with process.send capturing the answers it sends. */
async function deliver(listener: Listener, message: unknown): Promise<void> {
  const original = process.send;
  (process as any).send = (msg: any, ...rest: any[]) => {
    if (msg && typeof msg === 'object' && typeof msg.requestId === 'string' && msg.requestId.startsWith('s5-')) {
      if (sendError !== null) throw sendError;
      sent.push(msg);
      return true;
    }
    return (original as any).apply(process, [msg, ...rest]);
  };
  try {
    await listener(message);
  } finally {
    (process as any).send = original;
  }
}

beforeEach(() => {
  installed = [];
  sent = [];
  sendError = null;
  ctl.lockError = null;
  ctl.readError = null;
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
    if (event === 'message') {
      installed.push(fn);
      return process;
    }
    return realOn(event as any, fn);
  }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (process as any).send = realSend;
  vi.restoreAllMocks();
});

async function handler(): Promise<Listener> {
  const ops = await freshOps();
  install(ops);
  expect(installed).toHaveLength(1);
  return installed[0];
}

describe('installing the shared:op handler', () => {
  it('installs nothing in a process with no IPC channel', async () => {
    expect(typeof realSend).toBe('function');
    const ops = await freshOps();
    install(ops, false);
    expect(installed).toHaveLength(0);
  });

  it('installs one handler however often it is called', async () => {
    const ops = await freshOps();
    install(ops);
    install(ops);
    install(ops);
    expect(installed).toHaveLength(1);
  });

  it('installs once a channel exists after a call made without one', async () => {
    const ops = await freshOps();
    install(ops, false);
    install(ops);
    install(ops);
    expect(installed).toHaveLength(1);
  });

  it('a static import names the same handler setup', () => {
    expect(typeof sharedOps.setupSharedOpsIPC).toBe('function');
  });
});

describe('the shared:op handler', () => {
  it('answers a known request', async () => {
    const listener = await handler();
    await deliver(listener, { type: 'shared:op', requestId: 's5-a', data: { op: 'nope.op' } });
    expect(sent).toEqual([{ requestId: 's5-a', data: { ok: false, code: 'invalid', error: 'unknown op nope.op' } }]);
  });

  it('ignores a message that is null, empty or not an object, and sends nothing', async () => {
    const listener = await handler();
    for (const message of [null, undefined, 0, '', false]) {
      await expect(deliver(listener, message)).resolves.toBeUndefined();
    }
    const callable = Object.assign(() => undefined, { type: 'shared:op', requestId: 's5-fn', data: { op: 'nope.op' } });
    await deliver(listener, callable);
    expect(sent).toEqual([]);
  });

  it('answers a thrown op as failed with its message', async () => {
    const listener = await handler();
    ctl.lockError = new Error('lock file unreadable');
    await deliver(listener, { type: 'shared:op', requestId: 's5-b', data: { op: 'global.write' } });
    expect(sent).toEqual([{ requestId: 's5-b', data: { ok: false, code: 'failed', error: 'lock file unreadable' } }]);
  });

  it('answers a thrown global read as an io-error with its message', async () => {
    const listener = await handler();
    ctl.readError = new Error('disk gone');
    await deliver(listener, { type: 'data:global-read', requestId: 's5-c', data: { rel: 'x.json' } });
    expect(sent).toEqual([{ requestId: 's5-c', data: { ok: false, code: 'io-error', error: 'disk gone' } }]);
  });

  it('answers a throw that is not an Error with "Unknown error"', async () => {
    const listener = await handler();
    ctl.readError = 'a string';
    await deliver(listener, { type: 'data:global-read', requestId: 's5-d', data: {} });
    ctl.readError = null;
    ctl.lockError = 42;
    await deliver(listener, { type: 'shared:op', requestId: 's5-e', data: {} });
    expect(sent).toEqual([
      { requestId: 's5-d', data: { ok: false, code: 'io-error', error: 'Unknown error' } },
      { requestId: 's5-e', data: { ok: false, code: 'failed', error: 'Unknown error' } },
    ]);
  });

  it('logs an answer it could not send, and does not throw', async () => {
    const listener = await handler();
    const failure = new Error('channel closed');
    sendError = failure;
    await expect(deliver(listener, { type: 'data:global-read', requestId: 's5-f', data: {} })).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith('[SharedOps] Could not send an answer to the web UI:', failure);
  });
});

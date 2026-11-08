import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 69 (wip-redesign/sheets/NB6.md: C24, D9, E3; cells 439 and 461; part 9): on a Postgres bot the child answers
// shared:op and data:global-read with T38 until bootShared has ended, the waiting form with the cause once a try of
// the real bootShared failed, and runs them once it ended. A JSON bot and a maintenance boot are not gated.

const ctl = vi.hoisted(() => ({ maintenanceBoot: false }));
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  checkWriterLock: () => ({ kind: 'not-held' }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', async orig => ({
  ...(await orig<any>()),
  applyOperatorGlobalRead: () => ({ ok: true, read: 'fine' }),
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceIpcRefusal: () => null,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async orig => ({
  ...(await orig<any>()),
  isMaintenanceBoot: () => ctl.maintenanceBoot,
}));

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setupSharedOpsIPC } from '../../src/bot/internalSetup/utils/sharedOps';
import { bootShared, sharedBootCause, _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';
import { mirrorRig } from '../helpers/nb6Mirror';
import { lost } from '../helpers/sharedRows';

type Listener = (message: unknown) => Promise<void>;

const m = mirrorRig('nb6childgate');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const FIRST_OP = "The bot is starting and is bringing the shared files up to date from the database; nothing was saved. Try again in a moment.";
const FIRST_READ = 'The bot is starting and is bringing the shared files up to date from the database. Try again in a moment.';
const waitingOp = (cause: string) => `The bot is waiting for the database (${cause}) before it brings the shared files up to date; nothing was saved. Try again once the database answers.`;
const waitingRead = (cause: string) => `The bot is waiting for the database (${cause}) before it brings the shared files up to date. Try again once the database answers.`;

let listener: Listener;
let sent: Array<{ requestId: string; data: any }>;
let n = 0;

// The handler is installed once a module load: it is captured from process.on the first time.
const realOn = process.on.bind(process);
let captured: Listener | null = null;

beforeEach(async () => {
  await m.setup();
  ctl.maintenanceBoot = false;
  sent = [];
  if (!captured) {
    const spy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
      if (event === 'message') {
        captured = fn;
        return process;
      }
      return realOn(event as any, fn);
    }) as any);
    const original = process.send;
    if (!original) (process as any).send = () => true;
    setupSharedOpsIPC();
    (process as any).send = original;
    spy.mockRestore();
  }
  expect(captured).not.toBeNull();
  listener = captured!;
});

afterEach(() => m.teardown());

/** Delivers one message to the handler and answers the reply it sent. */
async function ask(type: 'shared:op' | 'data:global-read', data: unknown): Promise<any> {
  const requestId = `nb6gate-${++n}`;
  const original = process.send;
  (process as any).send = (msg: any) => {
    if (msg?.requestId === requestId) sent.push(msg);
    return true;
  };
  try {
    await listener({ type, requestId, data });
  } finally {
    (process as any).send = original;
  }
  const reply = sent.find(s => s.requestId === requestId);
  expect(reply).toBeDefined();
  return reply!.data;
}

const op = { op: 'nb6.no-such-op' };
const read = { rel: 'nb6childgate/a.json' };

describe('cell 439: a Postgres bot before bootShared ends', () => {
  it('shared:op answers T38 with code starting, and the op is not run', async () => {
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'starting', error: FIRST_OP });
  });

  it('data:global-read answers T38 with code starting, and nothing is read', async () => {
    expect(await ask('data:global-read', read)).toEqual({ ok: false, code: 'starting', error: FIRST_READ });
  });
});

describe('cell 461: after a failed try of bootShared', () => {
  it('both answer the waiting form with the cause; once a try gets the answer, the first form again; once it ends, they run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let down = true;
    m.state.rows.fault = sql => (down && sql === LIST ? lost() : undefined);
    let ended: string | null = null;
    void bootShared().then(v => { ended = v; });
    await vi.advanceTimersByTimeAsync(0);
    const cause = sharedBootCause();
    expect(cause).toBe('Connection terminated unexpectedly');
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'starting', error: waitingOp(cause!) });
    expect(await ask('data:global-read', read)).toEqual({ ok: false, code: 'starting', error: waitingRead(cause!) });
    down = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    m.state.rows.put(m.keyOf('a.json'), '{}');
    m.state.rows.fault = sql => (sql === 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1' ? held.then(() => undefined) : undefined);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(sharedBootCause()).toBeNull());
    expect(ended).toBeNull();
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'starting', error: FIRST_OP });
    release();
    await vi.waitFor(() => expect(ended).toBe('done'));
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'invalid', error: 'unknown op nb6.no-such-op' });
    expect(await ask('data:global-read', read)).toEqual({ ok: true, read: 'fine' });
  });
});

describe('guards: no gate where bootShared does not run', () => {
  it('a JSON bot runs the op at once', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind('file');
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'invalid', error: 'unknown op nb6.no-such-op' });
    expect(await ask('data:global-read', read)).toEqual({ ok: true, read: 'fine' });
  });

  it("a maintenance boot answers as today (it never runs bootShared)", async () => {
    ctl.maintenanceBoot = true;
    _resetSharedMirror();
    expect(await ask('shared:op', op)).toEqual({ ok: false, code: 'invalid', error: 'unknown op nb6.no-such-op' });
    expect(await ask('data:global-read', read)).toEqual({ ok: true, read: 'fine' });
  });
});

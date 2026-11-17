import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 test 5 (sheets/NX5.md decision 10, ruling G7-2), the serving process's rows; the maintenance boot's are in
// nx5AfterOrderBoot.test.ts. From enterForOrder's start, before its save, setupSharedOpsIPC's listener refuses
// shared:op with the maintenance text, sends exactly one reply for its requestId, and applySharedOp makes no write; a
// data:global-read is served on the serving path; a guild write is refused (guard); the webhook route answers the
// refusal 503. Fails today for the shared op (sharedOps.ts:394-398 apply it).

const ctl = vi.hoisted(() => ({ lockChecks: 0, saveHangs: true }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  checkWriterLock: () => {
    ctl.lockChecks += 1;
    return { kind: 'not-held' };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', async orig => ({
  ...(await orig<any>()),
  applyOperatorGlobalRead: () => ({ ok: true, read: 'served' }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: () => (ctl.saveHangs
    ? new Promise(() => undefined)
    : Promise.resolve({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0 })),
  hasHeldWrites: () => false,
}));
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => ({
  ...(await orig<any>()),
  sharedBootDone: () => true,
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { setupSharedOpsIPC } from '../../src/bot/internalSetup/utils/sharedOps';
import { webhookAnswer } from '../../src/webui/routes/hopFailure';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, MESSAGE, OrderStore, order, settle } from '../helpers/nx5Rig';

const m = maintenance as any;
type Listener = (message: unknown) => Promise<void>;
let listeners: Listener[] = [];
let replies: Array<{ requestId: string; data: any }> = [];
const realSend = process.send;

// The handler installs once per module, so the listener captured by the first test serves every test of the file.
beforeEach(() => {
  replies = [];
  ctl.lockChecks = 0;
  ctl.saveHangs = true;
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
    if (event === 'message') {
      listeners.push(fn);
      return process;
    }
    return realOn(event as any, fn);
  }) as any);
  maintenance._setMaintenanceSender(message => {
    if ((message as any).requestId) replies.push(message as any);
  });
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  setupSharedOpsIPC();
});
afterEach(() => {
  (process as any).send = realSend;
  m.attachSaveOrderSource?.(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  vi.restoreAllMocks();
});

async function deliver(message: { type: string; requestId: string; data: unknown }): Promise<void> {
  const original = process.send;
  (process as any).send = (msg: any, ...rest: any[]) => {
    if (msg && typeof msg === 'object' && typeof msg.requestId === 'string' && msg.requestId.startsWith('x5-')) {
      replies.push(msg);
      return true;
    }
    return (original as any).apply(process, [msg, ...rest]);
  };
  try {
    for (const listener of listeners) await listener(message);
    await settle();
  } finally {
    (process as any).send = original;
  }
}

const repliesFor = (id: string) => replies.filter(r => r.requestId === id);

/** The order read starts enterForOrder; its save never answers, so the process is between the refusal's start and its save's answer. */
async function inOrder(): Promise<OrderStore> {
  const store = new OrderStore();
  m.attachSaveOrderSource?.({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  m.noteSaveOrder?.(order());
  await settle();
  return store;
}

describe('test 5: what a serving process accepts from enterForOrder\'s start', () => {
  it('the handler is installed once (guard)', () => {
    expect(listeners).toHaveLength(1);
  });

  it('a shared:op is refused with the maintenance text, one reply goes out for its requestId, and applySharedOp makes no write', async () => {
    await inOrder();
    await deliver({ type: 'shared:op', requestId: 'x5-op', data: { op: 'global.write', args: { rel: 'premium.json', contentJson: '{}', expectSha: 'x' } } });
    expect(repliesFor('x5-op')).toHaveLength(1);
    expect(repliesFor('x5-op')[0].data).toMatchObject({ ok: false, code: 'maintenance', error: MESSAGE });
    expect(ctl.lockChecks).toBe(0);
  });

  it.each(['payment.webhook', 'payment.oauthCallback', 'provider.saveCredentials', 'premium.linkAccount'])('%s is refused the same way', async op => {
    await inOrder();
    await deliver({ type: 'shared:op', requestId: `x5-${op}`, data: { op, args: { providerId: 'patreon' } } });
    expect(repliesFor(`x5-${op}`)).toHaveLength(1);
    expect(repliesFor(`x5-${op}`)[0].data).toMatchObject({ ok: false, code: 'maintenance', error: MESSAGE });
    expect(ctl.lockChecks).toBe(0);
  });

  it('the webhook route answers that refusal 503, so the provider delivers it again', async () => {
    await inOrder();
    await deliver({ type: 'shared:op', requestId: 'x5-hook', data: { op: 'payment.webhook', args: { providerId: 'patreon', body: '' } } });
    const [reply] = repliesFor('x5-hook');
    expect(reply.data.code).toBe('maintenance');
    expect(webhookAnswer(reply.data).status).toBe(503);
  });

  it('G7-2: a data:global-read is served on the serving path', async () => {
    await inOrder();
    await deliver({ type: 'data:global-read', requestId: 'x5-read', data: { rel: 'premium.json' } });
    expect(repliesFor('x5-read')).toEqual([{ requestId: 'x5-read', data: { ok: true, read: 'served' } }]);
  });

  it('a guild write is refused while the gate is closed (guard)', async () => {
    void maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'e-1', data: { message: MESSAGE } });
    await settle();
    expect(maintenance.maintenanceIpcRefusal('data:guild-write')).toEqual({ ok: false, code: 'maintenance', error: MESSAGE });
  });

  it('a shared:op is applied again once the order ends (the order read says running)', async () => {
    ctl.saveHangs = false;
    await inOrder();
    m.noteSaveOrder?.(order({ state: 'running' }));
    await settle();
    await deliver({ type: 'shared:op', requestId: 'x5-after', data: { op: 'nope.op' } });
    expect(repliesFor('x5-after')).toEqual([{ requestId: 'x5-after', data: { ok: false, code: 'invalid', error: 'unknown op nope.op' } }]);
    expect(ctl.lockChecks).toBe(1);
  });

  it('without an order the shared:op reaches applySharedOp as today (guard)', async () => {
    await deliver({ type: 'shared:op', requestId: 'x5-none', data: { op: 'nope.op' } });
    expect(repliesFor('x5-none')).toEqual([{ requestId: 'x5-none', data: { ok: false, code: 'invalid', error: 'unknown op nope.op' } }]);
    expect(ctl.lockChecks).toBe(1);
  });
});

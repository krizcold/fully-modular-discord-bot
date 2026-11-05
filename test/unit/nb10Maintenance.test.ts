import fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 9: in a maintenance boot the bot process answers each shared request exactly once: a premium op from the
// shared handler (and it is applied), global.write and data:global-read with the maintenance refusal, and a guild
// write with the maintenance text.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ on: () => undefined, off: () => undefined, get: () => undefined, list: () => [], startTickers: () => undefined, emitEvent: () => undefined }),
}));

import { markMaintenanceBoot, setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { setupMaintenanceIPC } from '../../src/bot/internalSetup/utils/maintenance';
import { setupSharedOpsIPC } from '../../src/bot/internalSetup/utils/sharedOps';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { dataPath } from '../../src/utils/dataRoot';
import { put, readJson } from '../helpers/configRig';

const answers: Array<{ requestId: string; data: any }> = [];
const MESSAGE = 'Down for an upgrade';
let seq = 0;

beforeAll(() => {
  (process as any).send = (message: any) => { if (message?.requestId) answers.push(message); return true; };
  markMaintenanceBoot();
  setMaintenanceGate({ cause: 'hook', message: MESSAGE });
  setupMaintenanceIPC();
  setupSharedOpsIPC();
});

afterAll(() => {
  delete (process as any).send;
});

beforeEach(() => {
  answers.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** Sends one request as the web UI would and waits until no new answer comes for a moment. */
async function ask(type: string, data: object): Promise<any[]> {
  const requestId = `${type}_${++seq}`;
  process.emit('message' as any, { type, requestId, data } as any);
  for (let i = 0; i < 1000 && !answers.some(a => a.requestId === requestId); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 200));
  return answers.filter(a => a.requestId === requestId).map(a => a.data);
}

describe('a maintenance boot', () => {
  it('a premium op gets exactly one answer, from the shared handler, and it is applied', async () => {
    const replies = await ask('shared:op', { op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'nb10 maintenance' }] } });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true });
    await flushAll();
    expect(readJson(dataPath('global', 'premium-tiers.json')).messages).toMatchObject({ moduleBlocked: 'nb10 maintenance' });
  }, 30_000);

  it('global.write gets exactly one answer, the maintenance refusal, and writes nothing', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const replies = await ask('shared:op', { op: 'global.write', args: { root: 'config', contentJson: '{"a":2}', expectSha: 'absent' } });
    expect(replies).toEqual([{ ok: false, code: 'maintenance', error: MESSAGE }]);
    expect(readJson(ROOT_CONFIG_PATH)).toEqual({ a: 1 });
  });

  it('data:global-read gets exactly one answer, the refusal', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const replies = await ask('data:global-read', { root: 'config' });
    expect(replies).toEqual([{ ok: false, code: 'maintenance', error: 'the bot is in maintenance' }]);
  });

  it('data:guild-write answers the maintenance text once', async () => {
    const G = '123456789012345678';
    put(dataPath(G, 'mod', 'x.json'), { d: 1 });
    const replies = await ask('data:guild-write', { guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{}', expectSha: 'absent' });
    expect(replies).toEqual([{ ok: false, code: 'maintenance', error: MESSAGE }]);
    expect(JSON.parse(fs.readFileSync(dataPath(G, 'mod', 'x.json'), 'utf8'))).toEqual({ d: 1 });
  });
});

import { InteractionResponseType } from 'discord.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB2 ruling 6 (and 7 at boot): a bot process that boots in maintenance mode opens no data backend, takes no claim,
// loads no module and starts no timer of ruling 4; it logs every shard in with the maintenance status and answers every
// interaction and IPC request with the message. Ruling 10's bridge stays attached. This file marks its process as
// booted in maintenance, so it holds only these cases.

const bridge = vi.hoisted(() => ({ attached: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  const discord = { attachGatewayBridge: (attach: (event: string, handler: () => void) => void) => {
    for (const event of ['entitlementCreate', 'entitlementUpdate', 'entitlementDelete']) {
      bridge.attached.push(event);
      attach(event, () => undefined);
    }
  } };
  return { ...real, getPaymentRegistry: () => ({ get: (id: string) => (id === 'discord' ? discord : undefined), on: () => undefined, off: () => undefined }) };
});

import { ModuleLoader } from '../../src/bot/internalSetup/utils/moduleLoader';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { getDataBootStatus } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { getGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { PaymentProviderRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { _resetMaintenance, _setMaintenanceSender, _setMaintenanceTiming, handleMaintenanceIpc, MAINTENANCE_PRESENCE, runMaintenanceBoot } from '../../src/bot/internalSetup/utils/maintenance';
import { isMaintenanceBoot, maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { rawCommand, textOf, tick, type WireCall } from '../helpers/gateRig';

const sent: any[] = [];
const role = process.env.BOT_PROCESS_ROLE;
beforeEach(() => {
  process.env.BOT_PROCESS_ROLE = 'bot';
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ filePollMs: 600_000 });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  resetPremiumManager();
});

/** A booted client whose REST records every call instead of sending it. */
function capture(client: any): WireCall[] {
  const wire: WireCall[] = [];
  for (const method of ['post', 'patch', 'delete', 'get'] as const) {
    client.rest[method] = async (route: string, options: { body?: unknown } = {}) => {
      wire.push({ method, route, body: options.body });
      return undefined;
    };
  }
  return wire;
}

describe('ruling 6: booting in maintenance mode', () => {
  it('opens no data backend, loads no module, starts no ticker, and logs every shard in with the status', async () => {
    const loadModules = vi.spyOn(ModuleLoader.prototype, 'loadAllModules');
    let loggedIn: any = null;
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'Moving servers tonight.' }, {
      shards: async () => 3,
      login: async c => { loggedIn = c; },
    });
    expect(isMaintenanceBoot()).toBe(true);
    expect(loggedIn).toBe(client);
    expect(getWorkingSet()).toBeNull();
    expect(getGuildDataBackend()).toBeNull();
    expect(getDataBootStatus().state).toBe('file');
    expect(loadModules).not.toHaveBeenCalled();
    expect((getPremiumManager() as any).expiryTimer).toBeNull();
    expect(client.options.presence).toMatchObject(MAINTENANCE_PRESENCE);
    expect(client.options.shards).toEqual([0, 1, 2]);
    expect(client.options.shardCount).toBe(3);
    expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'maintenance' } });
  });

  it('a payment provider registered in maintenance mode is not started', () => {
    const registry = new PaymentProviderRegistry();
    const start = vi.fn();
    registry.register({ id: 'p', start } as any);
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps the Discord payment bridge attached (ruling 10)', () => {
    expect(bridge.attached).toEqual(['entitlementCreate', 'entitlementUpdate', 'entitlementDelete']);
  });

  it('answers every interaction with the message', async () => {
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'Back at noon.' }, { shards: async () => 1, login: async () => undefined });
    const wire = capture(client);
    (client as any).actions.InteractionCreate.handle(rawCommand('boot-1'));
    await tick(50);
    expect(wire).toHaveLength(1);
    expect(wire[0].body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
    expect(textOf(wire[0])).toBe('Back at noon.');
  });

  it('answers every IPC request: refused with the message, reads say maintenance, the hook updates the message', async () => {
    expect(await handleMaintenanceIpc({ type: 'command:invoke', requestId: 'a', data: {} })).toEqual({ requestId: 'a', data: { success: false, maintenance: true, error: 'Back at noon.' } });
    expect(await handleMaintenanceIpc({ type: 'panel:action', requestId: 'b', data: {} })).toEqual({ requestId: 'b', data: { success: false, maintenance: true, error: 'Back at noon.' } });
    expect(await handleMaintenanceIpc({ type: 'data:guild-write', requestId: 'c', data: {} })).toEqual({ requestId: 'c', data: { ok: false, code: 'maintenance', error: 'Back at noon.' } });
    expect(await handleMaintenanceIpc({ type: 'data:guild-read', requestId: 'd', data: {} })).toEqual({ requestId: 'd', data: { ok: false, code: 'maintenance', error: 'the bot is in maintenance' } });
    expect(await handleMaintenanceIpc({ type: 'metrics:global', requestId: 'e', data: {} })).toEqual({ requestId: 'e', data: { success: false, ok: false, code: 'maintenance', error: 'the bot is in maintenance' } });
    expect(await handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'f', data: { message: 'New text.' } })).toEqual({ requestId: 'f', data: { saved: true } });
    expect(maintenanceText()).toBe('New text.');
  });

  it('ruling J: a failed Discord login is tried again after 5 seconds, doubling to 60, until it succeeds', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const client = await runMaintenanceBoot({ cause: 'hook', message: 'm' }, {
      shards: async () => 1,
      login: async () => {
        attempts += 1;
        if (attempts <= 6) throw new Error('Discord answered 502');
      },
      sleep: async ms => { waits.push(ms); },
    });
    expect(attempts).toBe(7);
    expect(waits).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    expect(client).toBeTruthy();
  });

  it('ruling J: a failed shard count is tried again the same way', async () => {
    const waits: number[] = [];
    let attempts = 0;
    await runMaintenanceBoot({ cause: 'hook', message: 'm' }, {
      shards: async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error('gateway fetch failed');
        return 1;
      },
      login: async () => undefined,
      sleep: async ms => { waits.push(ms); },
    });
    expect(waits).toEqual([5000, 10000]);
  });

  it('ruling 7 at boot: a refused login boots in maintenance mode and asks for the restart once the login is accepted while the file says running', async () => {
    writeMaintenanceFile('running', 'Owner text.');
    sent.length = 0;
    const answers: Array<'refused' | 'accepted'> = ['refused', 'accepted'];
    await runMaintenanceBoot({ cause: 'login-refused', message: 'Owner text.' }, {
      shards: async () => 1,
      login: async () => undefined,
      loginProbe: async () => answers.shift() ?? 'accepted',
      retryMs: 20,
    });
    expect(sent).toContainEqual({ type: 'maintenance:mode', data: { mode: 'login-refused' } });
    await tick(150);
    expect(sent.filter(m => m.type === 'control:restart-bot')).toHaveLength(1);
  });

  it('ruling B backstop: a hook boot whose maintenance:leave was lost leaves once maintenance.json says running', async () => {
    _resetMaintenance();
    _setMaintenanceTiming({ filePollMs: 20 });
    writeMaintenanceFile('maintenance', 'm');
    sent.length = 0;
    await runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 1, login: async () => undefined });
    await tick(80);
    expect(sent.filter(m => m.type === 'control:restart-bot')).toHaveLength(0);
    writeMaintenanceFile('running', 'm');
    await tick(120);
    expect(sent.filter(m => m.type === 'control:restart-bot')).toHaveLength(1);
  });

  it('ruling B: maintenance:leave to a hook boot answers at once and asks for one restart', async () => {
    _resetMaintenance();
    writeMaintenanceFile('maintenance', 'm');
    sent.length = 0;
    await runMaintenanceBoot({ cause: 'hook', message: 'm' }, { shards: async () => 1, login: async () => undefined });
    expect(await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'l', data: {} })).toEqual({ requestId: 'l', data: { leaving: true } });
    expect(await handleMaintenanceIpc({ type: 'maintenance:leave', requestId: 'm', data: {} })).toEqual({ requestId: 'm', data: { leaving: true } });
    await tick(50);
    expect(sent.filter(m => m.type === 'control:restart-bot')).toHaveLength(1);
  });
});

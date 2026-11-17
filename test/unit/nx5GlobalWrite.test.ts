import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NX5 ruling G8-8 (sheets/NX5.md, invariant 3): from enterForOrder's start until the order ends, module code changes
// no data. A global-scope write is refused the way a guild write is while the gate is closed, so a module timer that
// writes after the process's last answer holds nothing outside that answer; an entitlement event's write still passes
// (decision 10, risk 1). The refusal rows fail today (dataManager.ts refuseInMaintenance refuses guild scope only).

const ctl = vi.hoisted(() => ({ held: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  saveHeldWrites: () => new Promise(() => undefined),
  hasHeldWrites: () => ctl.held,
}));

import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { loadGlobalModuleData, saveGlobalModuleData, updateGlobalData } from '../../src/bot/internalSetup/utils/dataManager';
import { runEntitlementEvent } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { ME, OrderStore, order, settle } from '../helpers/nx5Rig';

const m = maintenance as any;
const MODULE = 'nx5-timer-module';
const FILE = 'state.json';
const refusal = { name: 'DataBackendUnavailableError', causeKey: 'maintenance' };

beforeEach(() => {
  ctl.held = false;
  maintenance._setMaintenanceSender(() => undefined);
  maintenance.markDiscordStarted();
  writeMaintenanceFile('running', 'The last message.');
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  m.attachSaveOrderSource(null);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  vi.restoreAllMocks();
});

async function inOrder(): Promise<void> {
  const store = new OrderStore();
  m.attachSaveOrderSource({ me: ME, read: () => store.readSaveOrder(), writeAck: (ack: any) => store.writeSaveAck(ack) });
  m.noteSaveOrder(order());
  await settle();
}

const stored = () => loadGlobalModuleData(FILE, MODULE, null as null | { v: number });

describe('G8-8: global writes while the save order holds', () => {
  it('a module\'s global save during the order is refused and changes nothing', async () => {
    expect(saveGlobalModuleData(FILE, MODULE, { v: 1 })).toBe(true);
    await inOrder();
    expect(() => saveGlobalModuleData(FILE, MODULE, { v: 2 })).toThrow(expect.objectContaining(refusal));
    expect(stored()).toEqual({ v: 1 });
  });

  it('a module\'s global update during the order is refused and changes nothing', async () => {
    expect(saveGlobalModuleData(FILE, MODULE, { v: 1 })).toBe(true);
    await inOrder();
    expect(() => updateGlobalData(FILE, { v: 0 }, current => ({ v: current.v + 10 }), MODULE)).toThrow(expect.objectContaining(refusal));
    expect(stored()).toEqual({ v: 1 });
  });

  it('the same write after the order ends (the read says running) is accepted', async () => {
    expect(saveGlobalModuleData(FILE, MODULE, { v: 1 })).toBe(true);
    await inOrder();
    expect(() => saveGlobalModuleData(FILE, MODULE, { v: 2 })).toThrow(expect.objectContaining(refusal));
    m.noteSaveOrder(order({ state: 'running' }));
    await settle();
    expect(saveGlobalModuleData(FILE, MODULE, { v: 2 })).toBe(true);
    expect(stored()).toEqual({ v: 2 });
  });

  it('an entitlement event\'s global write during the order is accepted (decision 10, guard)', async () => {
    await inOrder();
    expect(runEntitlementEvent(() => saveGlobalModuleData(FILE, MODULE, { v: 3 }))).toBe(true);
    expect(stored()).toEqual({ v: 3 });
  });

  it('a global write while the hook alone holds the gate is accepted (guard)', async () => {
    void maintenance.handleMaintenanceIpc({ type: 'maintenance:enter', requestId: 'e-1', data: { message: 'From the hook.' } });
    await settle();
    expect(saveGlobalModuleData(FILE, MODULE, { v: 4 })).toBe(true);
    expect(stored()).toEqual({ v: 4 });
  });
});

import { ComponentType, InteractionResponseType, type Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 12, review6 Y1 and Y4: on a persistent (shared) panel the user gate's refusal reaches the acting user alone,
// as an ephemeral reply, before any defer or update of the shared message; the real Discord-side button, dropdown
// and modal handlers run on discord.js interactions over a recorded wire (helpers/gateRig.ts). A system panel's
// interactions by a user below the tier run their handler.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { PanelManager } from '../../src/bot/internalSetup/utils/panelManager';
import buttonEvent from '../../src/bot/internalSetup/events/interactionCreate/buttonHandler';
import dropdownEvent from '../../src/bot/internalSetup/events/interactionCreate/dropdownHandler';
import modalEvent from '../../src/bot/internalSetup/events/interactionCreate/modalSubmitHandler';
import { registerPanelButtonHandler } from '../../src/bot/internalSetup/utils/panel/panelButtonHandler';
import { registerPanelDropdownHandler } from '../../src/bot/internalSetup/utils/panel/panelDropdownHandler';
import { registerPanelModalHandler } from '../../src/bot/internalSetup/utils/panel/panelModalHandler';
import { callbackType, EPHEMERAL, rawButton, rawModal, rig, textOf, user, type WireCall } from '../helpers/gateRig';
import { uh } from '../helpers/p1Holder';
import { p1World, USERS } from '../helpers/p1World';

const w = p1World();
const MOD = 'p1gate';
const M1 = ':no_entry_sign: This is not available for your personal subscription tier.';
const WITH_TIER = USERS[0];
const BELOW = USERS[1];
let ran: string[] = [];
let ids = 0;

const panelOf = (id: string, more: Record<string, unknown>) => ({
  id, name: id, _moduleName: MOD, ...more,
  callback: async () => { ran.push(`${id}:open`); return { content: 'View' }; },
  handleButton: async () => { ran.push(`${id}:button`); return { content: 'Pressed' }; },
  handleDropdown: async () => { ran.push(`${id}:dropdown`); return { content: 'Picked' }; },
  handleModal: async () => { ran.push(`${id}:modal`); return { content: 'Sent' }; },
});

function world() {
  const r = rig();
  const client = r.client as Client & Record<string, unknown>;
  client.buttonHandlers = new Map();
  client.dropdownHandlers = new Map();
  client.modalHandlers = new Map();
  const manager = new PanelManager({} as any);
  const panels = new Map<string, any>();
  for (const panel of [panelOf('p1gate_shared', { persistent: true }), panelOf('p1gate_sys', { panelScope: 'system' })]) {
    manager.registerPanel(panel as any);
    panels.set(panel.id, panel);
  }
  registerPanelButtonHandler(client, (ctx, id) => manager.handleButtonInteraction(ctx, id), panels);
  registerPanelDropdownHandler(client, (ctx, values, id) => manager.handleDropdownInteraction(ctx, values, id), panels);
  registerPanelModalHandler(client, (ctx, id) => manager.handleModalInteraction(ctx, id), panels);
  const as = (userId: string) => ({ user: { ...user, id: userId } });
  const press = (panelId: string, userId: string) => r.emit(
    { ...rawButton(`p1g-${++ids}`), ...as(userId), data: { custom_id: `panel_${panelId}_btn_go`, component_type: ComponentType.Button } },
    i => buttonEvent(client, i));
  const pick = (panelId: string, userId: string) => r.emit(
    { ...rawButton(`p1g-${++ids}`), ...as(userId), data: { custom_id: `panel_${panelId}_dropdown_d`, component_type: ComponentType.StringSelect, values: ['a'] } },
    i => dropdownEvent(client, i));
  const submit = (panelId: string, userId: string) => r.emit(
    { ...rawModal(`p1g-${++ids}`, true), ...as(userId), data: { custom_id: `panel_${panelId}_modal_m`, components: [] } },
    i => modalEvent(client, i));
  return { wire: r.wire, manager, press, pick, submit };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const touchesShared = (call: WireCall) => call.method === 'patch'
  || [InteractionResponseType.UpdateMessage, InteractionResponseType.DeferredMessageUpdate].includes(callbackType(call));

beforeEach(async () => {
  await w.setup();
  await w.addUserTiers();
  expect((await w.grant(uh(WITH_TIER), 'umid', 30)).ok).toBe(true);
  expect((await w.grant(uh(BELOW), 'ulow', 30)).ok).toBe(true);
  const registry = getModuleRegistry();
  registry.unregister(MOD);
  registry.register({ manifest: { name: MOD, version: '1.0.0', tierRequirement: { user: { minPriority: 2 } } }, path: '', commands: [], exports: new Map() } as any);
  ran = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(getPremiumManager() as any, 'moduleTierRequirement').mockImplementation((name: any) => getModuleRegistry().getModule(name)?.manifest?.tierRequirement);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  getModuleRegistry().unregister(MOD);
  await w.teardown();
});

describe('P1 claim 12 on Discord: the user gate on a shared panel', () => {
  it.each([['button', 'press'], ['dropdown', 'pick'], ['modal', 'submit']] as const)(
    'a %s on a persistent panel by a user below the tier gets M1 ephemerally, and the shared message is untouched',
    async (_kind, how) => {
      const d = world();
      const { error } = await d[how]('p1gate_shared', BELOW);
      await settle();
      expect(error).toBeUndefined();
      expect(ran).toEqual([]);
      expect(d.wire.filter(touchesShared)).toEqual([]);
      expect(d.wire.map(c => [callbackType(c), textOf(c), (c.body as any)?.data?.flags & EPHEMERAL])).toEqual([[InteractionResponseType.ChannelMessageWithSource, M1, EPHEMERAL]]);
    },
  );

  it('a user with the tier still runs the shared panel\'s button, dropdown and modal', async () => {
    const d = world();
    await d.press('p1gate_shared', WITH_TIER);
    await d.pick('p1gate_shared', WITH_TIER);
    await d.submit('p1gate_shared', WITH_TIER);
    await settle();
    expect(ran).toEqual(['p1gate_shared:button', 'p1gate_shared:dropdown', 'p1gate_shared:modal']);
  });

  it("a system panel's button, dropdown and modal by a user below the tier run their handler", async () => {
    vi.stubEnv('DEVS', BELOW);
    const { manager } = world();
    const ctx = { panelId: 'p1gate_sys', userId: BELOW, guildId: null, accessMethod: 'web_ui', client: {} } as any;
    const answers = [
      await manager.handleButtonInteraction(ctx, 'go'),
      await manager.handleDropdownInteraction(ctx, ['a'], 'd'),
      await manager.handleModalInteraction(ctx, 'm'),
    ].map(a => JSON.stringify(a));
    expect(ran).toEqual(['p1gate_sys:button', 'p1gate_sys:dropdown', 'p1gate_sys:modal']);
    for (const text of answers) expect(text).not.toContain(M1);
  });
});

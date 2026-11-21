import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 12 (part 5): a module's manifest gates on the acting user's own tier with `tierRequirement.user`, beside
// the server gate. The real manager over the JSON files, the real module registry, the real command, autocomplete
// and panel handlers; the subscriptions are granted through the op.

const h = vi.hoisted(() => ({ local: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => h.local }));

import { dataPath } from '../../src/utils/dataRoot';
import { DEFAULT_MESSAGES, getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getModuleRegistry } from '../../src/bot/internalSetup/utils/moduleRegistry';
import { getModuleEventManager } from '../../src/bot/internalSetup/utils/moduleEventManager';
import { PanelManager } from '../../src/bot/internalSetup/utils/panelManager';
import handleCommands from '../../src/bot/internalSetup/events/interactionCreate/handleCommands';
import handleAutocomplete from '../../src/bot/internalSetup/events/interactionCreate/autocompleteHandler';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { droppedLines } from '../helpers/p1Guard';
import { PREMIUM } from '../helpers/p1World';
import { uh } from '../helpers/p1Holder';
import { p1World, SERVERS, USERS } from '../helpers/p1World';

const w = p1World();
const MOD = 'p1gate';
const M1 = ':no_entry_sign: This is not available for your personal subscription tier.';
const WITH_TIER = USERS[0];
const BELOW = USERS[1];
const SERVER = SERVERS[0];
const pm = (): any => getPremiumManager();

let ran: string[] = [];

function useManifest(tierRequirement: Record<string, unknown> | undefined): void {
  const registry = getModuleRegistry();
  registry.unregister(MOD);
  registry.register({ manifest: { name: MOD, version: '1.0.0', ...(tierRequirement ? { tierRequirement } : {}) }, path: '', commands: [], exports: new Map() } as any);
  h.local = ['alpha', 'beta'].map(name => ({
    name,
    description: name,
    _moduleName: MOD,
    ...(tierRequirement ? { _tierRequirement: tierRequirement } : {}),
    callback: () => { ran.push(name); },
    autocomplete: () => [{ name: 'choice', value: 'choice' }],
  }));
}

function command(name: string, userId: string, guildId: string | null): any {
  const replies: any[] = [];
  return {
    replies,
    commandName: name,
    guildId,
    user: { id: userId },
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    reply: (r: any) => { replies.push(r); return Promise.resolve(); },
  };
}

async function run(name: string, userId: string, guildId: string | null): Promise<{ ran: boolean; content: string | undefined; components: unknown }> {
  ran = [];
  const interaction = command(name, userId, guildId);
  await handleCommands({} as any, interaction);
  return { ran: ran.includes(name), content: interaction.replies[0]?.content, components: interaction.replies[0]?.components };
}

async function routeMessages(body: unknown): Promise<Array<{ status: number; body: any }>> {
  const router: any = createAppStoreRoutes({ isRunning: () => false, runSharedOp: (op: string, args: unknown) => w.sharedOp(op, args) } as any);
  const layer = router.stack.find((l: any) => l.route?.path === '/premium/messages' && l.route.methods.put);
  const answers: Array<{ status: number; body: any }> = [];
  let status = 200;
  const res: any = { status(c: number) { status = c; return res; }, json(b: unknown) { answers.push({ status, body: b }); return res; } };
  await layer.route.stack[0].handle({ params: {}, body, query: {} }, res, () => undefined);
  return answers;
}

async function complete(name: string, userId: string, guildId: string | null): Promise<unknown> {
  const answers: unknown[] = [];
  const interaction: any = {
    commandName: name,
    guildId,
    user: { id: userId },
    responded: false,
    isAutocomplete: () => true,
    respond: async (choices: unknown) => { answers.push(choices); interaction.responded = true; },
  };
  await handleAutocomplete({} as any, interaction);
  return answers;
}

function panels(): { manager: PanelManager; open: (id: string, userId: string, guildId: string | null) => Promise<string> } {
  const manager = new PanelManager({} as any);
  for (const panel of [
    {
      id: 'p1gate_panel', name: 'Gate', _moduleName: MOD, persistent: true,
      callback: async () => { ran.push('panel'); return { content: 'Gate view' }; },
      handleButton: async () => { ran.push('button'); return { content: 'Pressed' }; },
      handleDropdown: async () => { ran.push('dropdown'); return { content: 'Picked' }; },
      handleModal: async () => { ran.push('modal'); return { content: 'Sent' }; },
    },
    { id: 'p1gate_system', name: 'Gate system', _moduleName: MOD, panelScope: 'system', callback: async () => { ran.push('system'); return { content: 'System view' }; } },
  ]) manager.registerPanel(panel as any);
  const open = async (id: string, userId: string, guildId: string | null): Promise<string> => {
    ran = [];
    const response = await manager.handlePanelInteraction({ panelId: id, userId, guildId, accessMethod: 'web_ui', client: {} } as any);
    return JSON.stringify(response);
  };
  return { manager, open };
}

beforeEach(async () => {
  await w.setup();
  const config = dataPath('global', 'appstore', 'component-config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '{}');
  await w.addUserTiers();
  expect((await w.grant(uh(WITH_TIER), 'umid', 30)).ok).toBe(true);
  expect((await w.grant(uh(BELOW), 'ulow', 30)).ok).toBe(true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // Premium reaches the registry by a require, which finds no .ts module under vitest; this hands it the row's registry.
  vi.spyOn(pm(), 'moduleTierRequirement').mockImplementation((name: any) => getModuleRegistry().getModule(name)?.manifest?.tierRequirement);
});
afterEach(async () => {
  vi.restoreAllMocks();
  getModuleRegistry().unregister(MOD);
  h.local = [];
  await w.teardown();
});

describe('P1 claim 12: the user gate', () => {
  it('a gated command is refused with M1 for a user below the priority, in a server and in a direct message', async () => {
    useManifest({ user: { minPriority: 2 } });
    for (const guildId of [SERVER, null]) {
      const answer = await run('alpha', BELOW, guildId);
      expect(answer).toStrictEqual({ ran: false, content: M1, components: undefined });
    }
  });

  it('a gated command runs for a user with the tier in any server and in a direct message', async () => {
    useManifest({ user: { minPriority: 2 } });
    for (const guildId of [SERVER, SERVERS[1], null]) {
      expect(await run('alpha', WITH_TIER, guildId)).toMatchObject({ ran: true, content: undefined });
    }
  });

  it('with gatedCommands only the listed command is gated', async () => {
    useManifest({ user: { minPriority: 2, gatedCommands: ['alpha'] } });
    expect(await run('alpha', BELOW, SERVER)).toMatchObject({ ran: false, content: M1 });
    expect(await run('beta', BELOW, SERVER)).toMatchObject({ ran: true, content: undefined });
  });

  it("a command gated by both gates needs both, and the server's text comes first", async () => {
    useManifest({ minPriority: 1, user: { minPriority: 2 } });
    expect(await run('alpha', BELOW, SERVER)).toMatchObject({ ran: false, content: DEFAULT_MESSAGES.moduleBlocked });
    expect(await run('alpha', WITH_TIER, SERVER)).toMatchObject({ ran: false, content: DEFAULT_MESSAGES.moduleBlocked });
    expect((await w.grant(SERVER, 'low', 30)).ok).toBe(true);
    expect(await run('alpha', BELOW, SERVER)).toMatchObject({ ran: false, content: M1 });
    expect(await run('alpha', WITH_TIER, SERVER)).toMatchObject({ ran: true });
  });

  it('autocomplete answers an empty list to a user below the priority, and the choices to one with the tier', async () => {
    useManifest({ user: { minPriority: 2 } });
    expect(await complete('alpha', BELOW, SERVER)).toStrictEqual([[]]);
    expect(await complete('alpha', BELOW, null)).toStrictEqual([[]]);
    expect(await complete('alpha', WITH_TIER, null)).toStrictEqual([[{ name: 'choice', value: 'choice' }]]);
  });

  it("a panel answers 'Tier Restricted' with M1, with a server and with none; a user with the tier opens it", async () => {
    useManifest({ user: { minPriority: 2 } });
    const { open } = panels();
    for (const guildId of [SERVER, null]) {
      const text = await open('p1gate_panel', BELOW, guildId);
      expect(text).toContain('Tier Restricted');
      expect(text).toContain(M1);
      expect(ran).toEqual([]);
    }
    const allowed = await open('p1gate_panel', WITH_TIER, null);
    expect(allowed).not.toContain('Tier Restricted');
    expect(ran).toEqual(['panel']);
  });

  it("a system panel and a panel opened as 'web-ui-owner' are not gated", async () => {
    useManifest({ user: { minPriority: 2 } });
    const { open } = panels();
    expect(await open('p1gate_system', BELOW, SERVER)).not.toContain('Tier Restricted');
    expect(await open('p1gate_system', 'web-ui-owner', null)).not.toContain('Tier Restricted');
    expect(ran).toEqual(['system']);
    expect(await open('p1gate_panel', 'web-ui-owner', null)).not.toContain('Tier Restricted');
    expect(ran).toEqual(['panel']);
  });

  it('hasUserFeature follows gatedFeatures', () => {
    useManifest({ user: { minPriority: 2, gatedFeatures: ['big'] } });
    expect([pm().hasUserFeature(BELOW, MOD, 'big'), pm().hasUserFeature(BELOW, MOD, 'small'), pm().hasUserFeature(WITH_TIER, MOD, 'big')]).toEqual([false, true, true]);
    useManifest({ user: { minPriority: 2, gatedCommands: ['alpha'] } });
    expect(pm().hasUserFeature(BELOW, MOD, 'big')).toBe(true);
    useManifest({ user: { minPriority: 2 } });
    expect(pm().hasUserFeature(BELOW, MOD, 'big')).toBe(false);
    useManifest({ minPriority: 2 });
    expect(pm().hasUserFeature(BELOW, MOD, 'big')).toBe(true);
  });

  it("the module's events still run for a user below the tier", () => {
    useManifest({ user: { minPriority: 2 } });
    const skip = (args: any[]) => (getModuleEventManager() as any).shouldSkipEvent(MOD, args);
    expect(skip([{ guildId: SERVER, user: { id: BELOW }, author: { id: BELOW } }])).toBe(false);
    expect(skip([{ guild: { id: SERVER }, id: BELOW }])).toBe(false);
  });

  it('a manifest with only user passes every server check', async () => {
    useManifest({ user: { minPriority: 2 } });
    expect(pm().hasFeature(SERVER, MOD, 'any')).toBe(true);
    const skip = (getModuleEventManager() as any).shouldSkipEvent(MOD, [{ guildId: SERVER }]);
    expect(skip).toBe(false);
    expect(await run('alpha', WITH_TIER, SERVER)).toMatchObject({ ran: true });
  });

  it('a manifest without user behaves as today: the server gate only', async () => {
    useManifest({ minPriority: 1 });
    expect(await run('alpha', BELOW, SERVER)).toMatchObject({ ran: false, content: DEFAULT_MESSAGES.moduleBlocked });
    expect(await run('alpha', BELOW, null)).toMatchObject({ ran: true });
    expect(await complete('alpha', BELOW, null)).toStrictEqual([[{ name: 'choice', value: 'choice' }]]);
    const { open } = panels();
    expect(await open('p1gate_panel', BELOW, null)).not.toContain('Tier Restricted');
    useManifest(undefined);
    expect(await run('alpha', BELOW, SERVER)).toMatchObject({ ran: true });
  });

  it('an edited userBlocked is the text sent, in a command and in a panel', async () => {
    useManifest({ user: { minPriority: 2 } });
    const reply = await w.op('setMessages', { userBlocked: 'Your own tier is too low for this.' });
    expect(reply.ok).toBe(true);
    expect(await run('alpha', BELOW, null)).toMatchObject({ ran: false, content: 'Your own tier is too low for this.' });
    const { open } = panels();
    expect(await open('p1gate_panel', BELOW, null)).toContain('Your own tier is too low for this.');
    expect(pm().getMessages().userBlocked).toBe('Your own tier is too low for this.');
  });

  it('the messages route stores a posted userBlocked, and the gate then sends it', async () => {
    useManifest({ user: { minPriority: 2 } });
    const router: any = createAppStoreRoutes({ isRunning: () => false, runSharedOp: (op: string, args: unknown) => w.sharedOp(op, args) } as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/premium/messages' && l.route.methods.put);
    const answers: Array<{ status: number; body: any }> = [];
    let status = 200;
    const res: any = { status(c: number) { status = c; return res; }, json(body: unknown) { answers.push({ status, body }); return res; } };
    await layer.route.stack[0].handle({ params: {}, body: { userBlocked: 'Posted from the web UI.' }, query: {} }, res, () => undefined);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ status: 200, body: { success: true, messages: { userBlocked: 'Posted from the web UI.' }, defaults: { userBlocked: M1 } } });
    expect(w.stored().messages.userBlocked).toBe('Posted from the web UI.');
    expect(await run('alpha', BELOW, null)).toMatchObject({ ran: false, content: 'Posted from the web UI.' });
  });

  it('W1: every interaction of a panel is gated for the acting user, a persistent one opened by a user with the tier included', async () => {
    useManifest({ user: { minPriority: 2 } });
    const { manager, open } = panels();
    expect(await open('p1gate_panel', WITH_TIER, SERVER)).not.toContain('Tier Restricted');
    const ctx = (userId: string) => ({ panelId: 'p1gate_panel', userId, guildId: SERVER, accessMethod: 'web_ui', client: {} } as any);
    ran = [];
    const below = [
      JSON.stringify(await manager.handleButtonInteraction(ctx(BELOW), 'b1')),
      JSON.stringify(await manager.handleDropdownInteraction(ctx(BELOW), ['v'], 'd1')),
      JSON.stringify(await manager.handleModalInteraction(ctx(BELOW), 'm1')),
    ];
    expect(ran).toEqual([]);
    for (const text of below) {
      expect(text).toContain('Tier Restricted');
      expect(text).toContain(M1);
    }
    await manager.handleButtonInteraction(ctx(WITH_TIER), 'b1');
    await manager.handleDropdownInteraction(ctx(WITH_TIER), ['v'], 'd1');
    await manager.handleModalInteraction(ctx(WITH_TIER), 'm1');
    await manager.handleButtonInteraction(ctx('web-ui-owner'), 'b1');
    expect(ran).toEqual(['button', 'dropdown', 'modal', 'button']);
  });

  it('W2: a server tier high enough for both gates does not let a user below the user gate through', async () => {
    useManifest({ minPriority: 1, user: { minPriority: 2 } });
    expect((await w.grant(SERVER, 'high', 30)).ok).toBe(true);
    expect(await run('alpha', BELOW, SERVER)).toMatchObject({ ran: false, content: M1 });
    expect(await complete('alpha', BELOW, SERVER)).toStrictEqual([[]]);
    const { open } = panels();
    const text = await open('p1gate_panel', BELOW, SERVER);
    expect(text).toContain(M1);
    expect(ran).toEqual([]);
    expect(await run('alpha', WITH_TIER, SERVER)).toMatchObject({ ran: true });
  });

  it('W4: autocomplete with user.gatedCommands answers [] for the listed command and the choices for the other', async () => {
    useManifest({ user: { minPriority: 2, gatedCommands: ['alpha'] } });
    expect(await complete('alpha', BELOW, SERVER)).toStrictEqual([[]]);
    expect(await complete('beta', BELOW, SERVER)).toStrictEqual([[{ name: 'choice', value: 'choice' }]]);
  });

  it.each([[''], ['   ']])('W5: a userBlocked of %j is refused by the route and by the op, and nothing changes', async text => {
    const before = { premium: w.storedText(), audit: w.auditText() };
    const answers = await routeMessages({ userBlocked: text });
    expect(answers).toStrictEqual([{ status: 400, body: { success: false, error: 'The user gate message cannot be empty: Discord sends no empty reply.' } }]);
    const reply = await w.op('setMessages', { userBlocked: text });
    expect(reply.ok === false || reply.result === false).toBe(true);
    expect({ premium: w.storedText(), audit: w.auditText() }).toStrictEqual(before);
    expect(pm().getMessages().userBlocked).toBe(M1);
    expect((await routeMessages({ commandBlocked: '' }))[0]).toMatchObject({ status: 200, body: { success: true } });
  });

  it('W6: a module panel without a user gate, opened with no server, does not load premium', async () => {
    useManifest({ minPriority: 2 });
    const { open } = panels();
    await w.settle();
    fs.writeFileSync(PREMIUM, fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'p1', 'premium-tiers.old.json')));
    resetPremiumManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await open('p1gate_panel', BELOW, null)).not.toContain('Tier Restricted');
    expect(droppedLines('L1')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("W7: the console's invoke with no user runs as the bot's own user and is not user-gated", async () => {
    useManifest({ user: { minPriority: 2 } });
    const BOT = '82000000000000001';
    ran = [];
    const interaction = command('alpha', BOT, null);
    await handleCommands({ user: { id: BOT } } as any, interaction);
    expect({ ran: ran.includes('alpha'), replies: interaction.replies }).toStrictEqual({ ran: true, replies: [] });
    ran = [];
    const member = command('alpha', BELOW, null);
    await handleCommands({ user: { id: BOT } } as any, member);
    expect({ ran: ran.includes('alpha'), content: member.replies[0]?.content }).toStrictEqual({ ran: false, content: M1 });
  });

  it("Y3: the module's server settings panels are not user-gated", async () => {
    useManifest({ user: { minPriority: 2 } });
    const manager = new PanelManager({} as any);
    const opened: string[] = [];
    for (const id of ['settings_p1gate', 'settings_global_p1gate']) {
      manager.registerPanel({
        id, name: id,
        callback: async () => { opened.push(id + ':open'); return { content: 'Settings' }; },
        handleButton: async () => { opened.push(id + ':button'); return { content: 'Saved' }; },
      } as any);
      const ctx = { panelId: id, userId: BELOW, guildId: SERVER, accessMethod: 'web_ui', client: {} } as any;
      expect(JSON.stringify(await manager.handlePanelInteraction(ctx))).not.toContain('Tier Restricted');
      expect(JSON.stringify(await manager.handleButtonInteraction(ctx, 'b'))).not.toContain('Tier Restricted');
    }
    expect(opened).toEqual(['settings_p1gate:open', 'settings_p1gate:button', 'settings_global_p1gate:open', 'settings_global_p1gate:button']);
  });

  it('a user whose subscription was revoked is below the tier', async () => {
    useManifest({ user: { minPriority: 2 } });
    expect((await w.revoke(uh(WITH_TIER))).ok).toBe(true);
    expect(await run('alpha', WITH_TIER, null)).toMatchObject({ ran: false, content: M1 });
  });
});

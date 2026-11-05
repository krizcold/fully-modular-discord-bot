import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB12 item 3 (wip-redesign/sheets/NB12.md, decision 13, NB12-2.4): the operator's answer through the real console
// invoke and panel action handlers, and the member's answer taken with no wait on the store.
const local = vi.hoisted(() => ({ commands: [] as any[] }));
const bot = vi.hoisted(() => ({ client: null as any }));
const confirms = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return { ...real, confirmWrite: (...args: Parameters<typeof real.confirmWrite>) => { confirms.calls += 1; return real.confirmWrite(...args); } };
});
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => ({ getClient: () => bot.client }) };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/boot')>();
  return { ...real, admitGuildAction: async () => ({ cause: 'admit', mark: null }) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  return {
    ...real,
    getPremiumManager: () => ({
      getTierOverrides: () => ({}),
      getGuildSubscriptionUrl: () => null,
      getMessages: () => ({ moduleBlocked: 'MODULE BLOCKED', commandBlocked: 'COMMAND BLOCKED' }),
      hasFeatureAccess: () => true,
    }),
  };
});

import { appendData, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { runPanelAction } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { PanelWebUIAdapter } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { storeGuild } from '../helpers/gateRig';

const TMP_REASON = 'the part "cache.tmp" ends in ".tmp", which marks an interrupted write';
const MEMBER_TAIL = "report it to the bot's operator";
let originalSend: typeof process.send;

beforeEach(() => {
  confirms.calls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  originalSend = process.send;
  process.send = ((message: any, ...rest: unknown[]) => {
    if (message?.type === 'panel:live_update') return true;
    return originalSend ? (originalSend as (...a: unknown[]) => boolean).call(process, message, ...rest) : true;
  }) as typeof process.send;
});
afterEach(() => {
  process.send = originalSend;
  vi.restoreAllMocks();
});

function fakeClient(guildId: string) {
  return {
    isReady: () => true,
    guilds: { cache: new Map([[guildId, { id: guildId, members: { cache: new Map(), me: null } }]]) },
    users: { cache: new Map() },
    user: { id: '11' },
    application: { id: '11' },
  };
}

function panelsFor(handler: () => Promise<unknown>) {
  const id = `nb12-panel-${Math.random().toString(36).slice(2, 8)}`;
  const panel = { id, name: id, _moduleName: 'panelMod', callback: async () => ({ content: 'View' }), handleButton: handler };
  const client = { guilds: { cache: new Map(), fetch: async () => undefined }, users: { fetch: async () => undefined } } as unknown as Client;
  const map = new Map([[id, panel]]);
  const adapter = new PanelWebUIAdapter(client, map as never, {} as never);
  return {
    id,
    manager: {
      getPanel: (p: string) => map.get(p),
      handleWebUIButton: (...a: unknown[]) => (adapter.handleWebUIButton as (...x: unknown[]) => Promise<unknown>)(...a),
      executePanelForWebUI: (...a: unknown[]) => (adapter.executePanelForWebUI as (...x: unknown[]) => Promise<unknown>)(...a),
    },
  };
}

describe("the operator's answer through the real handlers", () => {
  it("a console invoke whose command saves 'cache.tmp/x.json' answers error naming the document and the .tmp reason", async () => {
    const { guildId } = await storeGuild();
    bot.client = fakeClient(guildId);
    const name = `cmd${Math.random().toString(36).slice(2, 8)}`;
    local.commands = [{ name, callback: async (_c: unknown, i: any) => { saveData('cache.tmp/x.json', { guildId }, { v: 1 }); await i.reply({ content: 'Done' }); } }];
    const answer = await handleInvoke({ command: name, guildId, force: true });
    expect(answer).toMatchObject({ success: false, truth: 'unstorable' });
    expect(answer.error).toContain(`guild:${guildId}:/cache.tmp/x.json was refused: ${TMP_REASON}`);
    expect(answer.error).not.toContain(MEMBER_TAIL);
  });

  it('a console invoke with an unstorable refusal, a database-backlog refusal and an accepted save names the second with database-backlog', async () => {
    const { guildId, store, options } = await storeGuild();
    bot.client = fakeClient(guildId);
    const ws = getWorkingSet() as any;
    const name = `cmd${Math.random().toString(36).slice(2, 8)}`;
    const backlogCauses: unknown[] = [];
    local.commands = [{
      name,
      callback: async (_c: unknown, i: any) => {
        saveData('cache.tmp/x.json', { guildId }, { v: 1 });
        const backlog = vi.spyOn(ws, 'backlog').mockReturnValue({ bytes: 65 * 1024 * 1024, oldest: 0 });
        ws.checkBounds(Date.now());
        try {
          saveData('other.json', options, { o: 1 });
        } catch (error) {
          backlogCauses.push((error as { causeKey?: unknown }).causeKey);
        }
        backlog.mockRestore();
        saveData('state.json', options, { s: 1 });
        await i.reply({ content: 'Done' });
      },
    }];
    const answer = await handleInvoke({ command: name, guildId, force: true });
    expect(backlogCauses).toEqual(['database-backlog']);
    expect(answer).toMatchObject({ success: false, truth: 'unstorable' });
    expect(answer.error).toContain(`guild:${guildId}:/cache.tmp/x.json was refused: ${TMP_REASON}`);
    expect(answer.error).toContain(`The write of guild:${guildId}:m/other.json was also refused: database-backlog.`);
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(JSON.parse(store.doc(guildId, 'state.json')!)).toEqual({ s: 1 });
    expect(store.doc(guildId, 'other.json')).toBeUndefined();
  });

  it("a panel action whose handler saves 'cache.tmp/x.json' answers error naming the document and the .tmp reason", async () => {
    const { guildId } = await storeGuild();
    const { id, manager } = panelsFor(async () => {
      saveData('cache.tmp/x.json', { guildId }, { v: 1 });
      return { content: 'View' };
    });
    const answer = await runPanelAction('panel:button', { panelId: id, userId: 'web-ui-owner', guildId, buttonId: 'save' }, manager);
    expect(answer.success).toBe(false);
    expect(answer.error).toContain(`guild:${guildId}:/cache.tmp/x.json was refused: ${TMP_REASON}`);
    expect(answer.error).not.toContain(MEMBER_TAIL);
  });

  it('a panel action with a U+0000 append, a BigInt save and an accepted save names both refusals and the accepted-writes sentence', async () => {
    const { guildId, store, options } = await storeGuild();
    const { id, manager } = panelsFor(async () => {
      appendData('log.jsonl', options, 'a\u0000\n');
      saveData('cfg.json', options, { n: 1n });
      saveData('state.json', options, { s: 1 });
      return { content: 'View' };
    });
    const answer = await runPanelAction('panel:button', { panelId: id, userId: 'web-ui-owner', guildId, buttonId: 'save' }, manager);
    expect(answer.success).toBe(false);
    expect(answer.error).toContain('m/log.jsonl');
    expect(answer.error).toContain('U+0000');
    expect(answer.error).toMatch(/The write of .*m\/cfg\.json was also refused/);
    expect(answer.error).not.toContain('other writes were accepted');
    expect(answer.error).toMatch(/accepted writes/);
    expect(answer.error.indexOf('m/log.jsonl')).toBeLessThan(answer.error.indexOf('m/cfg.json'));
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    expect(JSON.parse(store.doc(guildId, 'state.json')!)).toEqual({ s: 1 });
    expect(store.doc(guildId, 'cfg.json')).toBeUndefined();
  });
});

describe("the member's answer", () => {
  it("an interaction whose handler's write is refused unstorable gets the member text, with no confirmWrite call", async () => {
    const { guildId, store, options } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('interaction');
    runInLedger(ledger, 'mod', () => {
      saveData('state.json', options, { s: 1 });
      saveData('cache.tmp/x.json', { guildId }, { v: 1 });
    });
    const verdict = await verdictOf([ledger]);
    expect(verdict).toMatchObject({ ok: false, answer: 'unstorable' });
    expect(confirms.calls).toBe(0);
    const v = verdict as { answer: 'unstorable'; partial: boolean };
    expect(truthText(v.answer, v.partial)).toBe(truthText('unstorable', true));
    store.holding = false;
  });
});

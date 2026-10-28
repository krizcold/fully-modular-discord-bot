import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/botManagerAPI', async importOriginal => ({
  ...(await importOriginal<object>()),
  checkForAllBotUpdates: async () => null,
}));

import updateManagerPanel from '../../src/bot/internalSetup/panels/updateManager';
import { cleanupPersistentPanel, updatePersistentPanel } from '../../src/bot/internalSetup/utils/panel/persistentPanelResponse';
import { recoverPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelRecovery';
import {
  cleanupExpiredPanels,
  getPersistentPanel,
  recordPersistentPanelResponse,
  removePersistentPanel,
  storePersistentPanel,
  updatePersistentPanelState,
} from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { storeGuild, tick } from '../helpers/gateRig';

// NB1 round 1 (F1, F6, F7, F10): a panel writer that acted on one message changes the stored panel only while it is
// still that message; an unparsable panel registry file is moved aside so panels can be stored again.

afterEach(() => { vi.restoreAllMocks(); });

const err = (code: number) => Object.assign(new Error(`code ${code}`), { code });
const panel = (messageId: string, channelId = 'c-1', guildId?: string) =>
  ({ messageId, channelId, userId: '13', ...(guildId ? { guildId } : {}), createdAt: 0, lastUpdated: 0, state: 'a' });

function gate() {
  let open: () => void = () => {};
  let reached: () => void = () => {};
  const opened = new Promise<void>(resolve => { open = resolve; });
  const started = new Promise<void>(resolve => { reached = resolve; });
  return { open, started, wait: async () => { reached(); await opened; } };
}

describe('the panel storage guards by message id', () => {
  it('a state change for a replaced message changes nothing', async () => {
    const { guildId } = await storeGuild();
    await storePersistentPanel('g-state', panel('m-new', 'c-1', guildId), guildId);
    expect(await updatePersistentPanelState('g-state', 'x', 'm-old', guildId)).toBe(false);
    expect((await getPersistentPanel('g-state', guildId))?.state).toBe('a');
    expect(await updatePersistentPanelState('g-state', 'x', 'm-new', guildId)).toBe(true);
    expect((await getPersistentPanel('g-state', guildId))?.state).toBe('x');
  });

  it('a removal for a replaced message keeps the newer record', async () => {
    const { guildId } = await storeGuild();
    await storePersistentPanel('g-rm', panel('m-new', 'c-1', guildId), guildId);
    expect(await removePersistentPanel('g-rm', guildId, undefined, 'm-old')).toBe(false);
    expect((await getPersistentPanel('g-rm', guildId))?.messageId).toBe('m-new');
    expect(await removePersistentPanel('g-rm', guildId, 'none', 'm-new')).toBe(false);
    expect(await removePersistentPanel('g-rm', guildId, undefined, 'm-new')).toBe(true);
    expect(await getPersistentPanel('g-rm', guildId)).toBeNull();
  });

  it('a response recorded for a replaced message is refused', async () => {
    const { guildId } = await storeGuild();
    await storePersistentPanel('g-rec', panel('m-new', 'c-1', guildId), guildId);
    expect(await recordPersistentPanelResponse('g-rec', { content: 'old' }, 'm-old', guildId)).toBe(false);
    expect((await getPersistentPanel('g-rec', guildId))?.sessionData).toBeUndefined();
  });
});

describe('a panel stored again during a Discord call is kept', () => {
  type Site = 'channel gone' | 'channel not text' | 'message gone' | 'message missing';
  const sites: Site[] = ['channel gone', 'channel not text', 'message gone', 'message missing'];

  function recoveryClient(site: Site, held: ReturnType<typeof gate>, guildId: string) {
    const channel = {
      isTextBased: () => site !== 'channel not text',
      messages: {
        fetch: async () => {
          await held.wait();
          if (site === 'message gone') throw err(10008);
          return null;
        },
      },
    };
    return {
      channels: {
        fetch: async () => {
          if (site === 'channel gone' || site === 'channel not text') {
            await held.wait();
            if (site === 'channel gone') throw err(10003);
          }
          return channel;
        },
      },
      guilds: { cache: new Map([[guildId, {}]]) },
    } as never;
  }

  it.each(sites)('recovery of a generic panel (%s) keeps a record stored meanwhile', async site => {
    const { guildId } = await storeGuild();
    const id = `rec-${site}`;
    await storePersistentPanel(id, panel('m-old', 'c-1', guildId), guildId);
    const held = gate();
    const recovery = recoverPersistentPanels(recoveryClient(site, held, guildId));
    await held.started;
    await storePersistentPanel(id, panel('m-new', 'c-1', guildId), guildId);
    held.open();
    await recovery;
    expect((await getPersistentPanel(id, guildId))?.messageId).toBe('m-new');
  });

  it.each(['channel gone', 'channel not text'] as Site[])('recovery of the Update panel (%s) keeps a record stored meanwhile', async site => {
    const { guildId } = await storeGuild();
    await storePersistentPanel('update_manager', panel('m-old', 'c-1', guildId), guildId);
    const held = gate();
    const recovery = recoverPersistentPanels(recoveryClient(site, held, guildId));
    await held.started;
    await storePersistentPanel('update_manager', panel('m-new', 'c-1', guildId), guildId);
    held.open();
    await recovery;
    expect((await getPersistentPanel('update_manager', guildId))?.messageId).toBe('m-new');
  });

  it('recovery of the Update panel does not mark a panel stored during its edit recovered', async () => {
    const { guildId } = await storeGuild();
    await storePersistentPanel('update_manager', panel('m-old', 'c-1', guildId), guildId);
    const held = gate();
    const channel = { isTextBased: () => true, messages: { edit: async () => { await held.wait(); } } };
    const client = { channels: { fetch: async () => channel }, guilds: { cache: new Map([[guildId, {}]]) } } as never;
    await recoverPersistentPanels(client);
    await held.started;
    await storePersistentPanel('update_manager', panel('m-new', 'c-1', guildId), guildId);
    held.open();
    await tick(50);
    const stored = await getPersistentPanel('update_manager', guildId);
    expect(stored?.messageId).toBe('m-new');
    expect(stored?.state).toBe('a');
  });

  it('cleanupPersistentPanel keeps a record stored during its edit', async () => {
    const { guildId } = await storeGuild();
    await storePersistentPanel('cl', panel('m-old', 'c-1', guildId), guildId);
    const held = gate();
    const channel = { isTextBased: () => true, messages: { edit: async () => { await held.wait(); } } };
    const client = { channels: { fetch: async () => channel } } as never;
    const cleanup = cleanupPersistentPanel(client, 'cl', guildId);
    await held.started;
    await storePersistentPanel('cl', panel('m-new', 'c-1', guildId), guildId);
    held.open();
    await cleanup;
    expect((await getPersistentPanel('cl', guildId))?.messageId).toBe('m-new');
  });

  it('updatePersistentPanel answers false and stamps nothing when the panel was stored again during its edit', async () => {
    const { guildId } = await storeGuild();
    await storePersistentPanel('up', panel('m-old', 'c-1', guildId), guildId);
    const held = gate();
    const channel = { isTextBased: () => true, messages: { edit: async () => { await held.wait(); } } };
    const client = { channels: { fetch: async () => channel } } as never;
    const update = updatePersistentPanel(client, 'up', { content: 'v' } as never, guildId, undefined, 'done');
    await held.started;
    await storePersistentPanel('up', panel('m-new', 'c-1', guildId), guildId);
    held.open();
    expect(await update).toBe(false);
    const stored = await getPersistentPanel('up', guildId);
    expect(stored?.state).toBe('a');
    expect(stored?.sessionData).toBeUndefined();
  });

  it('Close on the Update panel removes the record only while it is the closed message', async () => {
    const { guildId } = await storeGuild();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await storePersistentPanel('update_manager', panel('m-new', 'c-1', guildId), guildId);
    const close = (messageId: string) => updateManagerPanel.handleButton!({
      client: null, interaction: { message: { id: messageId, delete: async () => {} } }, panelId: 'update_manager',
      userId: '13', guildId, accessMethod: 'direct_command', navigationStack: [],
    } as never, 'close');
    await close('m-old');
    expect((await getPersistentPanel('update_manager', guildId))?.messageId).toBe('m-new');
    await close('m-new');
    expect(await getPersistentPanel('update_manager', guildId)).toBeNull();
  });
});

describe('cleanupExpiredPanels', () => {
  it('removes sessions not updated for a day and keeps the others', async () => {
    setBackendKind('file');
    const guildId = `nb1-exp-${Date.now()}`;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 24 * 60 * 60 * 1000 - 1000);
    await storePersistentPanel('exp', panel('m-1'), guildId, 's-old');
    await storePersistentPanel('exp-all', panel('m-2'), guildId, 's-old');
    now.mockRestore();
    await storePersistentPanel('exp', panel('m-3'), guildId, 's-new');
    expect(await cleanupExpiredPanels(null as never, guildId)).toBe(2);
    expect(await getPersistentPanel('exp', guildId, 's-old')).toBeNull();
    expect((await getPersistentPanel('exp', guildId, 's-new'))?.messageId).toBe('m-3');
    expect(await getPersistentPanel('exp-all', guildId, 's-old')).toBeNull();
    expect(await cleanupExpiredPanels(null as never, guildId)).toBe(0);
  });
});

describe('an unparsable panel registry file is moved aside', () => {
  const registryPath = (guildId?: string) =>
    path.join(DATA_ROOT, guildId ?? 'global', '_panels', 'persistent-panels.json');

  it.each([
    ['global', 'empty', ''],
    ['global', 'corrupt', '{"a": '],
    ['guild', 'corrupt', 'not json'],
  ])('a %s %s file is moved aside and the store succeeds', async (scope, _kind, bytes) => {
    setBackendKind('file');
    const guildId = scope === 'guild' ? `nb1-f6-${Date.now()}` : undefined;
    const file = registryPath(guildId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (name.startsWith('persistent-panels.json.corrupt-')) fs.unlinkSync(path.join(path.dirname(file), name));
    }
    await flushAll();
    fs.writeFileSync(file, bytes);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await storePersistentPanel('f6', panel('m-1'), guildId)).success).toBe(true);
    expect((await getPersistentPanel('f6', guildId))?.messageId).toBe('m-1');
    const aside = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('persistent-panels.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf-8')).toBe(bytes);
    expect(logged.mock.calls.some(call => String(call[0]).startsWith('[Panels]') && String(call[0]).includes(aside[0]))).toBe(true);
  });

  it('a store after an empty global file is moved aside leaves no refusal in the interaction ledger', async () => {
    setBackendKind('file');
    const file = registryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await flushAll();
    fs.writeFileSync(file, '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ledger = openLedger('interaction');
    const stored = await runInLedger(ledger, null, () => storePersistentPanel('r2-3', panel('m-1')));
    expect(stored.success).toBe(true);
    expect(await verdictOf([ledger])).toEqual({ ok: true });
  });
});

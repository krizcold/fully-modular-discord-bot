import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { setBackendKind } from '../helpers/backendKind';

const h = vi.hoisted(() => ({ failSave: false, docs: new Map<string, string>(), pgGuilds: new Set<string>() }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async (orig) => {
  const real = await orig<any>();
  const key = (g: string, m: string, f: string) => `${g}|${m}|${f}`;
  const fake = {
    read: (g: string, m: string, f: string) => {
      const c = h.docs.get(key(g, m, f));
      return { status: 'ready', value: c === undefined ? undefined : JSON.parse(c) };
    },
    exists: (g: string, m: string, f: string) => h.docs.has(key(g, m, f)),
    save: (g: string, m: string, f: string, c: string) => { h.docs.set(key(g, m, f), c); return 'accepted'; },
    ticketFor: (g: string): any => ({ kind: 'ws', manager: fake, set: {}, guildId: g, seq: 0 }),
  };
  return { ...real, getWorkingSet: () => (h.pgGuilds.size ? fake : real.getWorkingSet()) };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    saveModuleData: (...args: any[]) => (h.failSave ? false : real.saveModuleData(...args)),
  };
});

import { dataPath } from '../../src/utils/dataRoot';
import { flushAll, loadModuleData } from '../../src/bot/internalSetup/utils/dataManager';
import {
  isActiveInstance,
  removePersistentPanel,
  storePersistentPanel,
} from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';
import { discoverGuildConfigFiles } from '../../src/bot/internalSetup/utils/configDiscovery';
import configEditorGuildPanel from '../../src/bot/internalSetup/panels/configEditorGuildPanel';

function instance(messageId: string): any {
  return { messageId, channelId: 'c1', userId: 'u1', createdAt: 1, lastUpdated: 1, state: 'active' };
}

function writeRaw(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function responseText(res: any): string {
  return JSON.stringify(res);
}

describe('C04-1 persistent panel records live in the guild data', () => {
  it('stores the record through the guild data layer, so it moves with the guild', async () => {
    const result = await storePersistentPanel('p_move', instance('m1'), 'g-move');
    expect(result.success).toBe(true);
    const moved = loadModuleData<any>('persistent-panels.json', 'g-move', '_panels', {});
    expect(moved.p_move?.messageId).toBe('m1');
    expect(fs.existsSync(dataPath('g-move', 'persistent-panels.json'))).toBe(false);
  });

  it('a press on the recorded message of a postgres guild is active', async () => {
    h.pgGuilds.add('g-press');
    setBackendKind('postgres');
    try {
      expect((await storePersistentPanel('p_press', instance('m2'), 'g-press')).success).toBe(true);
      expect(h.docs.has('g-press|_panels|persistent-panels.json')).toBe(true);
      expect(fs.existsSync(dataPath('g-press', 'persistent-panels.json'))).toBe(false);
      expect(await isActiveInstance('p_press', 'm2', 'g-press')).toBe('active');
      expect(await isActiveInstance('p_press', 'other', 'g-press')).toBe('replaced');
    } finally {
      h.pgGuilds.delete('g-press');
      setBackendKind(null);
    }
  });

  it('a missing record is told apart from a newer instance', async () => {
    expect(await isActiveInstance('p_none', 'm3', 'g-none')).toBe('missing');
  });

  it('a failed save answers false and does not report success', async () => {
    h.failSave = true;
    try {
      const result = await storePersistentPanel('p_fail', instance('m4'), 'g-fail');
      expect(result.success).toBe(false);
      expect(await removePersistentPanel('p_fail', 'g-fail')).toBe(false);
    } finally {
      h.failSave = false;
    }
    await storePersistentPanel('p_fail2', instance('m5'), 'g-fail2');
    h.failSave = true;
    try {
      expect(await removePersistentPanel('p_fail2', 'g-fail2')).toBe(false);
    } finally {
      h.failSave = false;
    }
  });
});

describe('C04-1 the guild Config Editor leaves files with no schema alone', () => {
  it('does not list a guild file that has no config schema', () => {
    writeRaw(dataPath('g-list', 'loose', 'notes.json'), '{"a":1}');
    writeRaw(dataPath('g-list', 'persistent-panels.json'), '{"p":{"messageId":"m"}}');
    const ids = discoverGuildConfigFiles('g-list').map(f => f.id);
    expect(ids.some(id => id.includes('notes.json'))).toBe(false);
    expect(ids.some(id => id.includes('persistent-panels.json'))).toBe(false);
  });

  it('an unchanged Edit of a file with no schema deletes nothing and says why', async () => {
    const file = dataPath('g-edit', 'persistent-panels.json');
    writeRaw(file, '{"p":{"messageId":"m"}}');
    const context: any = {
      guildId: 'g-edit',
      userId: 'u1',
      interaction: { fields: { getTextInputValue: () => '{}' } },
    };
    const res = await configEditorGuildPanel.handleModal!(context, 'edit_persistent-panels.json');
    await flushAll();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"p":{"messageId":"m"}}');
    expect(responseText(res)).toContain('no config schema');
  });
});

describe('C04-1 an open whose record was not saved is not left posted', () => {
  it('createPersistentPanel deletes the new message and reports the failure', async () => {
    const { Message } = await import('discord.js');
    const { createPersistentPanel } = await import('../../src/bot/internalSetup/utils/panel/persistentPanelResponse');
    const deleted: string[] = [];
    const sent: any = Object.create(Message.prototype);
    Object.defineProperty(sent, 'id', { value: 'new-msg' });
    Object.defineProperty(sent, 'channelId', { value: 'c1' });
    const channel = {
      send: async () => sent,
      isTextBased: () => true,
      messages: { delete: async (id: string) => { deleted.push(id); } },
    };
    const context: any = {
      guildId: 'g-open', userId: 'u1',
      client: { channels: { fetch: async () => channel } },
      interaction: { channel },
    };
    h.failSave = true;
    let threw: unknown;
    try {
      await createPersistentPanel(context, { id: 'p_open', unique: true } as any, { components: [] } as any);
    } catch (e) {
      threw = e;
    } finally {
      h.failSave = false;
    }
    expect(deleted).toEqual(['new-msg']);
    expect(String(threw)).toContain('record could not be saved');
  });
  it('says the new message stays when its delete fails too', async () => {
    const { Message } = await import('discord.js');
    const { createPersistentPanel } = await import('../../src/bot/internalSetup/utils/panel/persistentPanelResponse');
    const sent: any = Object.create(Message.prototype);
    Object.defineProperty(sent, 'id', { value: 'new-msg2' });
    Object.defineProperty(sent, 'channelId', { value: 'c1' });
    const channel = {
      send: async () => sent,
      isTextBased: () => true,
      messages: { delete: async () => { throw Object.assign(new Error('rate limited'), { code: 0 }); } },
    };
    const context: any = {
      guildId: 'g-open2', userId: 'u1',
      client: { channels: { fetch: async () => channel } },
      interaction: { channel },
    };
    h.failSave = true;
    let threw: unknown;
    try {
      await createPersistentPanel(context, { id: 'p_open2', unique: true } as any, { components: [] } as any);
    } catch (e) {
      threw = e;
    } finally {
      h.failSave = false;
    }
    expect(String(threw)).toContain('could not be removed');
  });
});

describe('C04-1 a reset of a file with no schema says so', () => {
  it('answers the no-schema text, not a temporary refusal', async () => {
    const context: any = {
      guildId: 'g-reset', userId: 'u1',
      interaction: { fields: { getTextInputValue: () => 'RESET' } },
    };
    const res = await configEditorGuildPanel.handleModal!(context, 'reset_persistent-panels.json');
    expect(responseText(res)).toContain('no config schema');
    expect(responseText(res)).not.toContain('try again shortly');
  });
});

import fs from 'fs';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// C03-1 (R11-J5, R28-J7): both guild config editors store only what differs from what the guild inherits, and a
// save from a stale copy is refused with nothing written.

import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { ROOT_CONFIG_PATH, configVersionOf } from '../../src/bot/internalSetup/utils/configManager';
import configEditorGuildPanel from '../../src/bot/internalSetup/panels/configEditorGuildPanel';
import { dataPath } from '../../src/utils/dataRoot';
import { FakeChild, call, put, readJson, resetData, startConfigApp } from '../helpers/configRig';
import { heldApi, mount, settle } from '../helpers/jsxRig';

const schemaDefault = vi.hoisted(() => ({ timeoutMs: 30 }));
vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async importOriginal => {
  const real: any = await importOriginal();
  const { dataPath: at } = await import('../../src/utils/dataRoot');
  const meta = (p: string) => ({
    id: 'tm.json', path: p, name: 'TM', description: '', category: 'config', exists: false, default: {}, moduleName: 'tmod',
    schema: { properties: { timeoutMs: { type: 'number', default: schemaDefault.timeoutMs } } },
  });
  return {
    ...real,
    getConfigFileMetadata: (id: string) => (id === 'tm.json' ? meta(at('global', 'tmod', 'tm.json')) : real.getConfigFileMetadata(id)),
    discoverGuildConfigFiles: (guildId: string) => [...real.discoverGuildConfigFiles(guildId), meta(at(guildId, 'tmod', 'tm.json'))],
  };
});

const G1 = '111111111111111111';
const guildConfig = () => dataPath(G1, '_guildConfig', 'config.json');

const child = new FakeChild();
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  ({ url: base, close } = await startConfigApp(child));
});
afterAll(async () => { await close(); });
beforeEach(async () => {
  child.reset();
  await resetData();
});

describe('the web Config editor saves guild overrides against the inherited base (R28-J7)', () => {
  it('stores the changed and already-owned keys, never an untouched inherited one', async () => {
    put(ROOT_CONFIG_PATH, { a: 1, b: 2 });
    put(guildConfig(), { b: 3 });
    const got = await call(base, 'GET', `/api/config/get?file=config.json&guildId=${G1}`);
    expect(got.body.config).toEqual({ a: 1, b: 3 });
    const saved = await call(base, 'POST', '/api/config/update', {
      file: 'config.json', guildId: G1, config: { a: 1, b: 3, c: 4 }, version: got.body.version, effective: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.storedKeys).toBe(2);
    await flushAll();
    expect(readJson(guildConfig())).toEqual({ b: 3, c: 4 });
  });

  it('refuses a save whose loaded copy is stale, and writes nothing', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    put(guildConfig(), { b: 3 });
    const got = await call(base, 'GET', `/api/config/get?file=config.json&guildId=${G1}`);
    put(guildConfig(), { b: 5 });
    const saved = await call(base, 'POST', '/api/config/update', {
      file: 'config.json', guildId: G1, config: { a: 1, b: 9 }, version: got.body.version, effective: true,
    });
    expect(saved.status).toBe(409);
    expect(saved.body.success).toBe(false);
    await flushAll();
    expect(readJson(guildConfig())).toEqual({ b: 5 });
  });

  it('refuses when the global values it inherited changed since the load', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const got = await call(base, 'GET', `/api/config/get?file=config.json&guildId=${G1}`);
    put(ROOT_CONFIG_PATH, { a: 2 });
    const saved = await call(base, 'POST', '/api/config/update', {
      file: 'config.json', guildId: G1, config: { a: 1 }, version: got.body.version, effective: true,
    });
    expect(saved.status).toBe(409);
    expect(fs.existsSync(guildConfig())).toBe(false);
  });
});

const PANEL = fileURLToPath(new URL('../../src/webui/public/components/ConfigPanel.jsx', import.meta.url));

describe('the web Config editor posts its loaded version and effective values for a guild (R28-J7)', () => {
  it('sends the version from the load, marks the values effective, and words the toast from the keys stored', async () => {
    const { calls, api } = heldApi();
    const toasts: string[] = [];
    const panel = mount(PANEL, 'ConfigPanel', {}, {
      api,
      showToast: (message: string) => toasts.push(message),
      confirm: () => true,
      FirstLoadPlaceholder: () => ({ type: 'placeholder', props: {}, children: [] }),
      disabledButtonStyle: () => ({}),
    });
    const answer = async (re: RegExp, value: any) => {
      await settle();
      const c = calls.find(x => !x.done && re.test(x.url));
      if (!c) throw new Error(`no call waits for ${re}`);
      c.answer(value);
      await settle();
    };
    const FILES = [{ id: 'config.json', name: 'Main Bot Config', category: 'config', exists: true }];
    await answer(/^\/setup\/status$/, { success: true, guildIds: { GUILD_ID: G1 } });
    await answer(/^\/config\/list$/, { success: true, files: FILES });
    await answer(/^\/config\/get\?file=config\.json$/, { success: true, config: { a: 1 } });
    await answer(/^\/config\/backups/, { success: true, backups: [] });
    const select = panel.selects().find(s => s.children.some((o: any) => typeof o === 'object' && o.props.value === 'system'))!;
    select.props.onChange({ target: { value: 'test' } });
    await settle();
    await answer(new RegExp(`^/config/list\\?guildId=${G1}$`), { success: true, files: FILES });
    await answer(new RegExp(`^/config/get\\?file=config\\.json&guildId=${G1}$`), { success: true, config: { a: 1, b: 3 }, version: 'v-loaded' });
    await answer(/^\/config\/backups/, { success: true, backups: [] });
    panel.button(/Save/)!.props.onClick();
    await settle();
    const post = calls.find(c => c.method === 'POST' && c.url === '/config/update')!;
    expect(post.body).toMatchObject({ file: 'config.json', guildId: G1, config: { a: 1, b: 3 }, version: 'v-loaded', effective: true });
    post.answer({ success: true, storedKeys: 1 });
    await settle();
    await answer(/^\/config\/list\?guildId=/, { success: true, files: FILES });
    await answer(/^\/config\/get\?file=config\.json&guildId=/, { success: true, config: { a: 1, b: 3 }, version: 'v-2' });
    await answer(/^\/config\/backups/, { success: true, backups: [] });
    expect(toasts.join(' | ')).toContain('1 override stored');
  });
});

function modalContext(fields: Record<string, string>) {
  return {
    guildId: G1,
    interaction: { fields: { getTextInputValue: (id: string) => fields[id] } },
  } as any;
}

async function openEdit(): Promise<string> {
  const opened: any = await configEditorGuildPanel.handleButton!({ guildId: G1 } as any, 'edit_config.json');
  const id: string = opened.modal.data.custom_id;
  return id.replace(/^panel_config_editor_guild_modal_/, '');
}

describe('the Discord Guild Config Editor carries a version and stores only overrides (R11-J5)', () => {
  it('an Edit submit of the pre-filled values stores only the changed and owned keys', async () => {
    put(ROOT_CONFIG_PATH, { a: 1, b: 2 });
    put(guildConfig(), { b: 3 });
    const modalId = await openEdit();
    await configEditorGuildPanel.handleModal!(modalContext({ config_json: JSON.stringify({ a: 1, b: 3, c: 4 }) }), modalId);
    await flushAll();
    expect(readJson(guildConfig())).toEqual({ b: 3, c: 4 });
  });

  it('an Edit submit that reverts every override empties the stored guild config', async () => {
    put(ROOT_CONFIG_PATH, { a: 1, b: 2 });
    put(guildConfig(), { b: 3 });
    const modalId = await openEdit();
    await configEditorGuildPanel.handleModal!(modalContext({ config_json: JSON.stringify({ a: 1, b: 2 }) }), modalId);
    await flushAll();
    expect(readJson(guildConfig())).toEqual({});
  });

  it('refuses an Edit submit when the config changed since the modal opened, writing nothing', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    put(guildConfig(), { b: 3 });
    const modalId = await openEdit();
    put(guildConfig(), { b: 5 });
    const reply: any = await configEditorGuildPanel.handleModal!(modalContext({ config_json: JSON.stringify({ a: 1, b: 9 }) }), modalId);
    await flushAll();
    expect(readJson(guildConfig())).toEqual({ b: 5 });
    expect(JSON.stringify(reply)).toContain('nothing was saved');
  });
});

describe('the guild Web-UI disables panel buttons while a request runs (R11-J5)', () => {
  it('renders PanelViewer executing while a button request is held, and not once it is answered', async () => {
    const { calls, api } = heldApi();
    const viewers: any[] = [];
    const lists: any[] = [];
    const guildApi = {
      getPanelList: (guildId: string) => api.get(`/panels?guildId=${guildId}`),
      getChannels: (guildId: string) => api.get(`/channels?guildId=${guildId}`),
      executePanel: (panelId: string) => api.post(`/execute/${panelId}`),
      handleButton: (panelId: string, buttonId: string) => api.post(`/button/${panelId}/${buttonId}`),
    };
    mount(fileURLToPath(new URL('../../src/webui/public/assets/components/guild/GuildPanelsPanel.jsx', import.meta.url)), 'GuildPanelsPanel',
      { guild: { id: G1 }, user: {}, onBack: () => {} }, {
        guildApi,
        PanelViewer: (props: any) => { viewers.push(props); return { type: 'viewer', props: {}, children: [] }; },
        PanelList: (props: any) => { lists.push(props); return { type: 'list', props: {}, children: [] }; },
        showNotification: () => {},
      });
    const answer = async (re: RegExp, value: any) => {
      await settle();
      const c = calls.find(x => !x.done && re.test(x.url));
      if (!c) throw new Error(`no call waits for ${re}`);
      c.answer(value);
      await settle();
    };
    await answer(new RegExp('^/panels'), { success: true, panels: [{ id: 'p1', name: 'P1' }] });
    lists[lists.length - 1].onSelectPanel('p1');
    await answer(new RegExp('^/execute/p1$'), { success: true, panel: { title: 'P1' } });
    expect(viewers[viewers.length - 1].executing).toBe(false);
    viewers[viewers.length - 1].onButton('b1');
    await settle();
    expect(calls.some(c => !c.done && c.url === '/button/p1/b1')).toBe(true);
    expect(viewers[viewers.length - 1].executing).toBe(true);
    await answer(new RegExp('^/button/p1/b1$'), { success: true, panel: { title: 'P1 after' } });
    expect(viewers[viewers.length - 1].executing).toBe(false);
  });
});

describe('the edit version covers the schema defaults the editor pre-filled (C03-1)', () => {
  it('changes when a schema default changes, so a stale pre-fill cannot be pinned as an override', () => {
    const meta = (d: number) => ({ id: 'm.json', schema: { properties: { timeoutMs: { type: 'number', default: d } } } } as any);
    expect(configVersionOf({}, {}, meta(30))).not.toBe(configVersionOf({}, {}, meta(60)));
    expect(configVersionOf({}, {}, meta(30))).toBe(configVersionOf({}, {}, meta(30)));
  });
});

describe('a schema default changed while an editor is open refuses the save through the real call sites (C03-1)', () => {
  const tmGuild = () => dataPath(G1, 'tmod', 'tm.json');
  beforeEach(() => { schemaDefault.timeoutMs = 30; });

  it('Discord Edit: submitting the pre-filled 30 after the default became 60 saves nothing', async () => {
    const opened: any = await configEditorGuildPanel.handleButton!({ guildId: G1 } as any, 'edit_tm.json');
    const modalId = String(opened.modal.data.custom_id).replace(/^panel_config_editor_guild_modal_/, '');
    schemaDefault.timeoutMs = 60;
    const reply: any = await configEditorGuildPanel.handleModal!(modalContext({ config_json: JSON.stringify({ timeoutMs: 30 }) }), modalId);
    await flushAll();
    expect(JSON.stringify(reply)).toContain('nothing was saved');
    expect(fs.existsSync(tmGuild())).toBe(false);
  });

  it('web: posting the loaded 30 with its version after the default became 60 is a 409 and writes nothing', async () => {
    const got = await call(base, 'GET', `/api/config/get?file=tm.json&guildId=${G1}`);
    expect(got.body.config).toEqual({ timeoutMs: 30 });
    schemaDefault.timeoutMs = 60;
    const saved = await call(base, 'POST', '/api/config/update', {
      file: 'tm.json', guildId: G1, config: { timeoutMs: 30 }, version: got.body.version, effective: true,
    });
    expect(saved.status).toBe(409);
    await flushAll();
    expect(fs.existsSync(tmGuild())).toBe(false);
  });
});

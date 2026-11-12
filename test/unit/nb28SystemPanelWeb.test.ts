import { beforeEach, describe, expect, it, vi } from 'vitest';

const devs = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('../../src/bot/internalSetup/utils/configManager', () => ({
  getConfigProperty: (key: string) => (key === 'DEVS' ? devs.list : undefined),
}));

import { checkPanelPermissions } from '../../src/bot/internalSetup/utils/panel/panelPermissions';
import { PanelWebUIAdapter } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';

const DEV = '111111111111111111';
const ADMIN = '222222222222222222';
const GUILD = '333333333333333333';

function makeAdapter() {
  const opened: string[] = [];
  const systemPanel: any = {
    id: 'settings_global_demo',
    panelScope: 'system',
    callback: async () => { opened.push('open'); return { content: 'global' }; },
    handleButton: async () => { opened.push('button'); return { content: 'global' }; },
    handleDropdown: async () => { opened.push('dropdown'); return { content: 'global' }; },
    handleModal: async () => { opened.push('modal'); return { content: 'global' }; },
  };
  const guildPanel: any = {
    id: 'settings_demo',
    panelScope: 'guild',
    callback: async () => { opened.push('guild-open'); return { content: 'guild' }; },
  };
  const panels = new Map<string, any>([[systemPanel.id, systemPanel], [guildPanel.id, guildPanel]]);
  const client: any = { guilds: { cache: new Map() }, buttonHandlers: new Map() };
  return { adapter: new PanelWebUIAdapter(client, panels, {} as any), opened };
}

beforeEach(() => {
  devs.list = [DEV];
});

describe('system-scope panels on the member web page', () => {
  it('a signed-in user outside DEVS is refused at open and runs nothing', async () => {
    const { adapter, opened } = makeAdapter();
    const res = await adapter.executePanelForWebUI('settings_global_demo', ADMIN, GUILD);
    expect(res.success).toBe(false);
    expect(opened).toEqual([]);
  });

  it('a signed-in user outside DEVS is refused at a button, a select and a modal', async () => {
    const { adapter, opened } = makeAdapter();
    const b = await adapter.handleWebUIButton('settings_global_demo', 'panel_settings_global_demo_btn_x', ADMIN, GUILD);
    const d = await adapter.handleWebUIDropdown('settings_global_demo', ['a'], ADMIN, GUILD, 'x');
    const m = await adapter.handleWebUIModal('settings_global_demo', 'm', { f: 'v' }, ADMIN, GUILD);
    expect([b.success, d.success, m.success]).toEqual([false, false, false]);
    expect(opened).toEqual([]);
  });

  it('a DEVS user opens the system panel and runs its button', async () => {
    const { adapter, opened } = makeAdapter();
    expect((await adapter.executePanelForWebUI('settings_global_demo', DEV, null)).success).toBe(true);
    expect((await adapter.handleWebUIButton('settings_global_demo', 'panel_settings_global_demo_btn_x', DEV, null)).success).toBe(true);
    expect(opened).toEqual(['open', 'button']);
  });

  it('a guild-scope panel still opens for a user outside DEVS', async () => {
    const { adapter, opened } = makeAdapter();
    expect((await adapter.executePanelForWebUI('settings_demo', ADMIN, GUILD)).success).toBe(true);
    expect(opened).toEqual(['guild-open']);
  });

  it('web-ui-owner without fromRequest passes a system panel; with fromRequest it is held to DEVS', () => {
    const panel = { id: 'settings_global_demo', panelScope: 'system' } as any;
    expect(checkPanelPermissions(panel, { accessMethod: 'web_ui', userId: 'web-ui-owner' } as any)).toBe(true);
    expect(checkPanelPermissions(panel, { accessMethod: 'web_ui', userId: 'web-ui-owner', fromRequest: true } as any)).toBe(false);
  });
});

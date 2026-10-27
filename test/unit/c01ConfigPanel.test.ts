import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { heldApi, mount, settle } from '../helpers/jsxRig';

// C01 (lanes/C01/sheet.md, cluster 4: R3-J9, R46-J7, R50-J4, with R34-13's option keys, R8-13's toast and R33-2's
// hidden backups): every Config Editor load is stamped, a late answer never lands, and a Save writes only to the file
// and guild its content was loaded from.

const PANEL = fileURLToPath(new URL('../../src/webui/public/components/ConfigPanel.jsx', import.meta.url));
const G1 = '111111111111111111';
const G2 = '222222222222222222';
const FILES = [
  { id: 'config.json', name: 'Main Bot Config', category: 'config', exists: true },
  { id: 'x.json', name: 'X', category: 'data', moduleName: 'mod', exists: true },
  { id: 'x.json', name: 'X', category: 'data', moduleName: 'other', exists: true },
];

async function open() {
  const { calls, api } = heldApi();
  const toasts: Array<{ message: string; type: string }> = [];
  const panel = mount(PANEL, 'ConfigPanel', {}, {
    api,
    showToast: (message: string, type: string) => toasts.push({ message, type }),
    confirm: () => true,
    FirstLoadPlaceholder: () => ({ type: 'placeholder', props: {}, children: [] }),
    disabledButtonStyle: () => ({}),
  });
  const waiting = (re: RegExp) => calls.find(c => !c.done && re.test(c.url));
  const answer = async (re: RegExp, value: any) => {
    await settle();
    const call = waiting(re);
    if (!call) throw new Error(`no call waits for ${re}; made: ${calls.map(c => `${c.method} ${c.url}${c.done ? ' (answered)' : ''}`).join(', ')}`);
    call.answer(value);
    await settle();
  };
  await answer(/^\/setup\/status$/, { success: true, guildIds: { GUILD_ID: G1, MAIN_GUILD_ID: G2 } });
  await answer(/^\/config\/list$/, { success: true, files: FILES });
  await answer(/^\/config\/get\?file=config\.json$/, { success: true, config: { who: 'system' } });
  await answer(/^\/config\/backups\?file=config\.json/, { success: true, backups: [] });
  const contextSelect = () => panel.selects().find(s => s.children.some(o => typeof o === 'object' && o.props.value === 'system'))!;
  const switchTo = async (value: string) => {
    contextSelect().props.onChange({ target: { value } });
    await settle();
  };
  const clickSave = async () => {
    panel.button(/Save/)!.props.onClick();
    await settle();
  };
  return { panel, calls, toasts, answer, waiting, switchTo, clickSave, contextSelect };
}

const listFor = (g: string) => new RegExp(`^/config/list\\?guildId=${g}$`);
const getFor = (g: string) => new RegExp(`^/config/get\\?file=config\\.json&guildId=${g}$`);
const updates = (calls: ReturnType<typeof heldApi>['calls']) => calls.filter(c => c.method === 'POST' && c.url === '/config/update');

describe('the Config Editor reloads on a guild switch (R3-J9)', () => {
  it('loads the selected file for the new guild, and saves that guild\'s content to it', async () => {
    const ui = await open();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: true, files: FILES });
    await ui.answer(getFor(G1), { success: true, config: { who: 'g1' } });
    await ui.answer(new RegExp(`^/config/backups\\?file=config\\.json&guildId=${G1}`), { success: true, backups: [] });
    await ui.clickSave();
    expect(updates(ui.calls).map(c => c.body)).toEqual([{ file: 'config.json', config: { who: 'g1' }, guildId: G1, effective: true }]);
  });

  it('never saves the content of the old guild into the new one while the new load is in flight', async () => {
    const ui = await open();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: true, files: FILES });
    await ui.clickSave();
    expect(updates(ui.calls).filter(c => c.body.guildId === G1 && c.body.config?.who === 'system')).toEqual([]);
    expect(ui.panel.textarea().props.value).not.toContain('system');
  });
});

describe('every load is stamped and a late answer never lands (R46-J7)', () => {
  it('drops a late answer for a guild the operator left', async () => {
    const ui = await open();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: true, files: FILES });
    await settle();
    const late = ui.waiting(getFor(G1));
    await ui.switchTo('main');
    await ui.answer(listFor(G2), { success: true, files: FILES });
    await ui.answer(getFor(G2), { success: true, config: { who: 'g2' } });
    expect(late).toBeDefined();
    late!.answer({ success: true, config: { who: 'g1' } });
    await settle();
    expect(JSON.parse(ui.panel.textarea().props.value)).toEqual({ who: 'g2' });
    await ui.clickSave();
    expect(updates(ui.calls).map(c => c.body)).toEqual([{ file: 'config.json', config: { who: 'g2' }, guildId: G2, effective: true }]);
  });

  it('disables the guild, tab and file selectors while a load is in flight', async () => {
    const ui = await open();
    await ui.switchTo('test');
    await settle();
    expect(ui.waiting(listFor(G1))).toBeDefined();
    for (const select of ui.panel.selects()) expect(select.props.disabled).toBe(true);
    for (const tab of ui.panel.all(el => el.type === 'button' && /Files$/.test(ui.panel.text(el)))) expect(tab.props.disabled).toBe(true);
  });
});

describe('a save re-reads the file list and tells only the truth (R50-J4, R8-13)', () => {
  it('re-reads the file list after a successful save', async () => {
    const ui = await open();
    const before = ui.calls.filter(c => c.url.startsWith('/config/list')).length;
    await ui.clickSave();
    await ui.answer(/^\/config\/update$/, { success: true, message: 'Config updated successfully', backupCreated: false });
    await settle();
    expect(ui.calls.filter(c => c.url.startsWith('/config/list')).length).toBe(before + 1);
  });

  it('says Backup created only when the server made one', async () => {
    const ui = await open();
    await ui.clickSave();
    await ui.answer(/^\/config\/update$/, { success: true, message: 'Config updated successfully', backupCreated: false });
    expect(ui.toasts.filter(t => /Backup created/.test(t.message))).toEqual([]);
  });
});

describe('data file options are module-qualified, and a failed load hides Restore (R34-13, R33-2)', () => {
  it('names each data file by module/file, so two modules\' x.json stay apart', async () => {
    const ui = await open();
    ui.panel.button(/^Data Files$/)!.props.onClick();
    await settle();
    const fileSelect = ui.panel.selects().find(s => s !== ui.contextSelect())!;
    const values = fileSelect.children.filter(o => typeof o === 'object').map(o => (o as any).props.value);
    expect(values).toEqual(['mod/x.json', 'other/x.json']);
  });

  it('shows no Restore for a file it could not load', async () => {
    const ui = await open();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: true, files: FILES });
    await settle();
    ui.waiting(getFor(G1))!.fail('Config file not found');
    await settle();
    const backups = ui.waiting(/^\/config\/backups/);
    if (backups) backups.answer({ success: true, backups: [{ filename: `config_${G1}_2026-01-01T00-00-00-000Z_1.json`, timestamp: 0, size: 10 }] });
    await settle();
    expect(ui.panel.button(/^Restore$/)).toBeUndefined();
  });
});

// Review round 1 on C01 (lanes/C01/sheet.md, finding C01-R1-7 and the refuter's note M2; C01-R1-9's Free editor).
describe('review round 1', () => {
  async function openDataFile() {
    const ui = await open();
    ui.panel.button(/^Data Files$/)!.props.onClick();
    await ui.answer(/^\/config\/data\/get\?file=mod%2Fx\.json$/, { success: true, data: { v: 1 }, exists: true });
    await ui.answer(/^\/config\/backups\?file=mod%2Fx\.json/, { success: true, backups: [] });
    return ui;
  }

  it('C01-R1-7: a failed file list for a new guild shows none of the previous context\'s files', async () => {
    const ui = await openDataFile();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: false, error: 'Data backend unreachable; retry shortly' });
    const fileSelect = ui.panel.selects().find(s => s !== ui.contextSelect());
    const options = fileSelect ? fileSelect.children.filter(o => typeof o === 'object') : [];
    expect(options).toEqual([]);
    expect(ui.panel.text(ui.panel.tree!)).toMatch(/could not be loaded/);
  });

  it('M2: offers no Delete File for a file the editor did not load for this guild', async () => {
    const ui = await openDataFile();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: false, error: 'Data backend unreachable; retry shortly' });
    const del = ui.panel.button(/Delete File/);
    if (del) del.props.onClick();
    await settle();
    expect(ui.calls.filter(c => c.url === '/config/data/delete')).toEqual([]);
  });
});

const PREMIUM = fileURLToPath(new URL('../../src/webui/public/components/premium/PremiumComponents.jsx', import.meta.url));

describe('review round 1: the Free editor (C01-R1-9)', () => {
  it('saves nothing while a module\'s Free baseline could not be read, and says why', async () => {
    const { calls, api } = heldApi();
    const free = { displayName: 'Free', overrides: {}, baselineUnavailable: { examples: 'A save of this file is still being written' } };
    const panel = mount(PREMIUM, 'TierEditorPanel', { tierId: 'free', tier: free, freeTier: free, onSave: () => undefined, onClose: () => undefined }, {
      api,
      showToast: () => undefined,
    });
    await settle();
    calls.find(c => c.url === '/appstore/premium/module-schemas')!.answer({ success: true, modules: [{ name: 'examples', displayName: 'Examples', commands: [], settings: {} }] });
    await settle();
    const toggle = panel.all(el => el.type === 'label').map(label => label.children.find(c => typeof c === 'object' && typeof c.props.onClick === 'function'))[0] as any;
    toggle.props.onClick({ preventDefault: () => undefined });
    await settle();
    panel.button(/Save Changes/)!.props.onClick();
    await settle();
    expect(calls.filter(c => c.method === 'PUT')).toEqual([]);
    expect(panel.text(panel.tree!)).toMatch(/could not be read/);
  });
});

// Review round 2 on C01 (lanes/C01/sheet.md, finding C01-R2-4 and the refuter's note M-R2-A).
describe('review round 2', () => {
  const fileOptions = (ui: Awaited<ReturnType<typeof open>>) => {
    const fileSelect = ui.panel.selects().find(s => s !== ui.contextSelect());
    return fileSelect ? fileSelect.children.filter(o => typeof o === 'object') : [];
  };

  it('C01-R2-4: a list re-read that fails after a delete shows no file, as its message says', async () => {
    const ui = await open();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: true, files: FILES });
    await ui.answer(getFor(G1), { success: true, config: { who: 'g1' } });
    await ui.answer(new RegExp(`^/config/backups\\?file=config\\.json&guildId=${G1}`), { success: true, backups: [] });
    ui.panel.button(/^Data Files$/)!.props.onClick();
    await ui.answer(new RegExp(`^/config/data/get\\?file=mod%2Fx\\.json&guildId=${G1}$`), { success: true, data: { v: 1 }, exists: true });
    await ui.answer(new RegExp(`^/config/backups\\?file=mod%2Fx\\.json&guildId=${G1}`), { success: true, backups: [] });
    ui.panel.button(/Delete File/)!.props.onClick();
    await ui.answer(/^\/config\/data\/delete$/, { success: true });
    await ui.answer(listFor(G1), { success: false, error: 'Data backend unreachable; retry shortly' });
    expect(ui.panel.text(ui.panel.tree!)).toMatch(/could not be loaded/);
    expect(fileOptions(ui)).toEqual([]);
    expect(ui.panel.button(/Delete File/)).toBeUndefined();
    const saveButton = ui.panel.button(/Save/);
    if (saveButton) {
      saveButton.props.onClick();
      await settle();
    }
    expect(ui.calls.filter(c => c.method === 'POST' && /update$/.test(c.url))).toEqual([]);
  });

  it('C01-R2-4: an earlier failed list is not reported while the next context\'s list loads', async () => {
    const ui = await open();
    await ui.switchTo('test');
    await ui.answer(listFor(G1), { success: false, error: 'Data backend unreachable; retry shortly' });
    expect(ui.panel.text(ui.panel.tree!)).toMatch(/could not be loaded/);
    await ui.switchTo('main');
    expect(ui.waiting(listFor(G2))).toBeDefined();
    expect(ui.panel.text(ui.panel.tree!)).not.toMatch(/could not be loaded/);
  });

  it('M-R2-A: a Premium tier saves nothing while a module\'s Free baseline could not be read, and says why', async () => {
    const { calls, api } = heldApi();
    // The real Free disables examples, which this view lacks; Gold enables it over Free. Free disables other too.
    const free = { displayName: 'Free', overrides: { other: { _moduleEnabled: false } }, baselineUnavailable: { examples: 'A save of this file is still being written' } };
    const gold = { displayName: 'Gold', priority: 1, overrides: { examples: { _moduleEnabled: true } }, offerings: [] };
    const panel = mount(PREMIUM, 'TierEditorPanel', { tierId: 'gold', tier: gold, freeTier: free, onSave: () => undefined, onClose: () => undefined }, {
      api,
      showToast: () => undefined,
    });
    await settle();
    calls.find(c => c.url === '/appstore/premium/module-schemas')!.answer({ success: true, modules: [
      { name: 'examples', displayName: 'Examples', commands: [], settings: {} },
      { name: 'other', displayName: 'Other', commands: [], settings: { k: { type: 'number', default: 0 } } },
    ] });
    await settle();
    // Enabling other on Gold, an edit that leaves examples alone.
    const unlocked = panel.all(el => el.type === 'label' && el.props.style?.opacity === 1);
    const toggles = unlocked.map(label => label.children.find(c => typeof c === 'object' && typeof c.props.onClick === 'function')).filter(Boolean) as any[];
    toggles[toggles.length - 1].props.onClick({ preventDefault: () => undefined });
    await settle();
    panel.button(/Save Changes/)!.props.onClick();
    await settle();
    const puts = calls.filter(c => c.method === 'PUT');
    expect(puts.filter(c => c.body?.overrides?.examples?._moduleEnabled !== true), 'a save that drops Gold\'s examples override').toEqual([]);
    expect(puts).toEqual([]);
    expect(panel.text(panel.tree!)).toMatch(/could not be read/);
  });
});

// Review round 3 on C01 (lanes/C01/sheet.md, finding C01-R3-5).
describe('review round 3', () => {
  // One context only (no guild ids), so no guild selector can re-run the list load.
  async function openSystemOnly() {
    const { calls, api } = heldApi();
    const toasts: Array<{ message: string; type: string }> = [];
    const panel = mount(PANEL, 'ConfigPanel', {}, {
      api,
      showToast: (message: string, type: string) => toasts.push({ message, type }),
      confirm: () => true,
      FirstLoadPlaceholder: () => ({ type: 'placeholder', props: {}, children: [] }),
      disabledButtonStyle: () => ({}),
    });
    await settle();
    calls.find(c => c.url === '/setup/status')!.answer({ success: true, guildIds: {} });
    await settle();
    calls.find(c => !c.done && c.url === '/config/list')!.fail('connection reset');
    await settle();
    return { panel, calls, toasts };
  }

  it('C01-R3-5: a failed file list offers a way to load it again, and loading again shows the files', async () => {
    const ui = await openSystemOnly();
    expect(ui.panel.text(ui.panel.tree!)).toMatch(/could not be loaded/);
    const again = ui.panel.button(/Load the file list again/);
    expect(again).toBeDefined();
    again!.props.onClick();
    await settle();
    const retry = ui.calls.filter(c => c.url === '/config/list');
    expect(retry.length).toBe(2);
    retry[1].answer({ success: true, files: FILES });
    await settle();
    expect(ui.panel.text(ui.panel.tree!)).not.toMatch(/could not be loaded/);
    expect(ui.calls.some(c => !c.done && /^\/config\/get\?file=config\.json$/.test(c.url))).toBe(true);
  });

  it('C01-R3-5: while the file list could not be loaded, a tab never says the context has no files', async () => {
    const ui = await openSystemOnly();
    ui.panel.button(/^Data Files$/)!.props.onClick();
    await settle();
    ui.panel.button(/^Config Files$/)!.props.onClick();
    await settle();
    expect(ui.toasts.filter(t => /No (config|data) files available/.test(t.message))).toEqual([]);
  });
});

import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { heldApi, mount, settle } from '../helpers/jsxRig';

// NB10 test 33: the data editor sends the sha it loaded as loadedSha, and shows the 409 text a changed file answers.

const PANEL = fileURLToPath(new URL('../../src/webui/public/components/ConfigPanel.jsx', import.meta.url));
const G1 = '111111111111111111';
const G2 = '222222222222222222';
const FILES = [
  { id: 'config.json', name: 'Main Bot Config', category: 'config', exists: true },
  { id: 'x.json', name: 'X', category: 'data', moduleName: 'mod', exists: true },
];
const SHA = 'a'.repeat(64);
const CHANGED = 'This file changed since you opened it; nothing was saved. Reload it to see the current values.';

async function openDataFile() {
  const { calls, api } = heldApi();
  const toasts: Array<{ message: string; type: string }> = [];
  const panel = mount(PANEL, 'ConfigPanel', {}, {
    api,
    showToast: (message: string, type: string) => toasts.push({ message, type }),
    confirm: () => true,
    FirstLoadPlaceholder: () => ({ type: 'placeholder', props: {}, children: [] }),
    disabledButtonStyle: () => ({}),
  });
  const answer = async (re: RegExp, value: any) => {
    await settle();
    const call = calls.find(c => !c.done && re.test(c.url));
    if (!call) throw new Error(`no call waits for ${re}; made: ${calls.map(c => `${c.method} ${c.url}${c.done ? ' (answered)' : ''}`).join(', ')}`);
    call.answer(value);
    await settle();
  };
  await answer(/^\/setup\/status$/, { success: true, guildIds: { GUILD_ID: G1, MAIN_GUILD_ID: G2 } });
  await answer(/^\/config\/list$/, { success: true, files: FILES });
  await answer(/^\/config\/get\?file=config\.json$/, { success: true, config: { who: 'system' } });
  await answer(/^\/config\/backups\?file=config\.json/, { success: true, backups: [] });
  panel.button(/^Data Files$/)!.props.onClick();
  await answer(/^\/config\/data\/get\?file=mod%2Fx\.json$/, { success: true, data: { v: 1 }, exists: true, sha: SHA });
  await answer(/^\/config\/backups\?file=mod%2Fx\.json/, { success: true, backups: [] });
  return { panel, calls, toasts, answer };
}

describe('the data editor save', () => {
  it('sends the sha it loaded as loadedSha', async () => {
    const ui = await openDataFile();
    ui.panel.button(/Save/)!.props.onClick();
    await settle();
    const saves = ui.calls.filter(c => c.method === 'POST' && c.url === '/config/data/update');
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toMatchObject({ file: 'mod/x.json', data: { v: 1 }, loadedSha: SHA });
  });

  it('shows the 409 text when the file changed since it was opened', async () => {
    const ui = await openDataFile();
    ui.panel.button(/Save/)!.props.onClick();
    await ui.answer(/^\/config\/data\/update$/, { success: false, error: CHANGED });
    const shown = [...ui.toasts.map(t => t.message), ui.panel.text(ui.panel.tree!)].join('\n');
    expect(shown).toContain(CHANGED);
  });
});

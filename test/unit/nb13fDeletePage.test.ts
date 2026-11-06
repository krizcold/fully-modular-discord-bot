import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { heldApi, mount, settle } from '../helpers/jsxRig';

// NB13F (out/NB13F/design.md, section 7): the Config tab's delete of a guild's data shows the warning of a delete whose
// folder move the disk did not confirm, and the plain success toast otherwise.

const PANEL = fileURLToPath(new URL('../../src/webui/public/components/ConfigPanel.jsx', import.meta.url));
const G1 = '111111111111111111';
const G2 = '222222222222222222';
const FILES = [{ id: 'x.json', name: 'X', category: 'data', moduleName: 'mod', exists: true }];
const W = "The disk did not confirm the move of this server's folder (EIO), so a power cut can undo the delete. Check the disk.";

async function deleteGuild(answer: unknown) {
  const { calls, api } = heldApi();
  const toasts: Array<{ message: string; type: string }> = [];
  const panel = mount(PANEL, 'ConfigPanel', {}, {
    api,
    showToast: (message: string, type: string) => toasts.push({ message, type }),
    confirm: () => true,
    FirstLoadPlaceholder: () => ({ type: 'placeholder', props: {}, children: [] }),
    disabledButtonStyle: () => ({}),
  });
  const reply = async (re: RegExp, value: any) => {
    await settle();
    const call = calls.find(c => !c.done && re.test(c.url));
    if (!call) throw new Error(`no call waits for ${re}; made: ${calls.map(c => `${c.method} ${c.url}${c.done ? ' (answered)' : ''}`).join(', ')}`);
    call.answer(value);
    await settle();
  };
  await reply(/^\/setup\/status$/, { success: true, guildIds: { GUILD_ID: G1, MAIN_GUILD_ID: G2 } });
  await reply(/^\/config\/list$/, { success: true, files: [] });
  const select = panel.selects()[0];
  const option = select.children.find((o: any) => panel.text(o).includes(G1)) as any;
  select.props.onChange({ target: { value: option.props.value } });
  await reply(new RegExp(`^/config/list\\?guildId=${G1}$`), { success: true, files: FILES });
  panel.button(/^Data Files$/)!.props.onClick();
  await reply(/^\/config\/data\/get\?/, { success: true, data: { v: 1 }, exists: true, sha: 'a'.repeat(64) });
  await reply(/^\/config\/backups\?/, { success: true, backups: [] });
  panel.button(/Delete all data for this guild/)!.props.onClick();
  await reply(/^\/config\/data\/delete-guild$/, answer);
  return toasts;
}

describe('the delete of a guild\'s data on the Config tab', () => {
  it('F1: a delete answered with a warning shows it in a warning toast after the deleted line', async () => {
    const toasts = await deleteGuild({ success: true, warning: W });
    expect(toasts).toContainEqual({ message: 'All data for this guild was deleted. ' + W, type: 'warning' });
    expect(toasts.filter(t => t.type === 'success')).toEqual([]);
  });

  it('F2: a delete answered without a warning shows the success toast as before', async () => {
    const toasts = await deleteGuild({ success: true });
    expect(toasts).toContainEqual({ message: 'All data for this guild was deleted', type: 'success' });
    expect(toasts.filter(t => t.type === 'warning')).toEqual([]);
  });
});

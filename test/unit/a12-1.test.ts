import { ButtonStyle } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { handleJsonEditorModal, type JsonEditorConfig } from '../../src/bot/internalSetup/utils/json/jsonEditorSubpanel';

// R50-J5: the redraw after a save follows the stored data, never the existence flag read before the save.

function editor(withReload: boolean) {
  let stored: unknown = null;
  const make = (exists: boolean): JsonEditorConfig => ({
    panelId: 'p',
    dataKey: 'mod/file.json',
    title: 'File',
    infoLines: ['**File:** `file.json`'],
    getData: () => stored,
    saveData: data => { stored = data; },
    fileExists: exists,
    extraButtons: [{ label: 'Delete', customId: 'del', style: ButtonStyle.Danger, disabled: !exists, row: 2 }],
    ...(withReload ? { reload: () => make(stored !== null) } : {}),
  });
  return make(false);
}

function modal(value: string) {
  return { interaction: { fields: { getTextInputValue: () => value } } } as never;
}

function view(response: unknown) {
  return JSON.stringify((response as { components: Array<{ toJSON(): unknown }> }).components.map(c => c.toJSON()));
}

function button(out: string, id: string): { disabled?: boolean } | undefined {
  let found: { disabled?: boolean } | undefined;
  JSON.parse(out, (_k, v) => { if (v && v.custom_id === id) found = v; return v; });
  return found;
}

describe('json editor redraw after saving a new file', () => {
  it('shows the saved data and an enabled Download, not "Not created"', async () => {
    const out = view(await handleJsonEditorModal(editor(false), modal('{"a":1}'), 'jsonedit_mod/file.json'));
    expect(out).not.toContain('Not created');
    expect(out).toContain('Current Data');
    expect(button(out, 'panel_p_btn_jsondownload_mod/file.json')).toBeDefined();
    expect(button(out, 'panel_p_btn_jsondownload_mod/file.json')?.disabled).toBeFalsy();
  });

  it('rebuilds the config through reload so Delete is enabled', async () => {
    const out = view(await handleJsonEditorModal(editor(true), modal('{"a":1}'), 'jsonedit_mod/file.json'));
    expect(out).toContain('Current Data');
    expect(button(out, 'del')).toBeDefined();
    expect(button(out, 'del')?.disabled).toBeFalsy();
  });
});

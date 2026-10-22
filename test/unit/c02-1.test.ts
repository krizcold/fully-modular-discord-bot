import { beforeEach, describe, expect, it, vi } from 'vitest';

// C02-1 (R14-J9, R15-J6, R51-J7): settings values are checked by type before bounds, partial numbers are refused,
// wrong-typed or null stored values read as unset, every System cap edit is whole or not saved, and Reset All on a
// System panel resets values only.
const files = new Map<string, Record<string, any>>();
const fileKey = (o: any) => `${o.guildId ?? 'global'}/${o.category}`;
const setGlobal = vi.fn();
const saveSpy = vi.fn();

vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({
  loadData: (_f: string, o: any, d: any) => JSON.parse(JSON.stringify(files.get(fileKey(o)) ?? d)),
  saveData: (_f: string, o: any, v: any) => { saveSpy(); files.set(fileKey(o), JSON.parse(JSON.stringify(v))); return true; },
  deleteDataOutcome: (_f: string, o: any) => (files.delete(fileKey(o)) ? 'deleted' : 'absent'),
}));

const schema = {
  settings: {
    count: { type: 'number', label: 'Count', default: 5, validation: { min: 1, max: 100 } },
    name: { type: 'string', label: 'Name', default: 'x' },
    tint: { type: 'color', label: 'Tint', default: '0x112233' },
    roles: { type: 'multiRole', label: 'Roles', default: [] },
    minutes: { type: 'number', label: 'Minutes', default: 5, validation: { integer: true, min: 1, max: 60 } },
  },
};
vi.mock('../../src/bot/internalSetup/utils/settings/settingsDiscovery', () => ({ getSettingsSchema: () => schema }));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', () => ({
  getPremiumManager: () => ({
    getPaidTierDelta: () => ({}),
    getTierHardLimits: () => ({}),
    setGlobalModuleConfig: (...args: any[]) => setGlobal(...args),
  }),
}));

import { moduleConfigErrors, parseSettingValue, validateValue } from '../../src/bot/internalSetup/utils/settings/settingsValidation';
import { guildSettingsFileErrors, loadModuleSettings } from '../../src/bot/internalSetup/utils/settings/settingsStorage';
import { buildResetModal } from '../../src/bot/internalSetup/utils/settings/settingsBuilder';
import { handleJsonEditorModal } from '../../src/bot/internalSetup/utils/json/jsonEditorSubpanel';
import { handleSettingsModal } from '../../src/bot/internalSetup/utils/settings/settingsHandlers';

beforeEach(() => {
  files.clear();
  setGlobal.mockReset();
});

describe('parse and validate', () => {
  it('a number parse consumes the whole text or refuses', () => {
    expect(parseSettingValue('10m', 'number')).toBeNull();
    expect(parseSettingValue('1e', 'number')).toBeNull();
    expect(parseSettingValue(' 12.5 ', 'number')).toBe(12.5);
    expect(parseSettingValue('', 'number')).toBeNull();
  });

  it('a wrong type is refused before bounds', () => {
    expect(validateValue('50' as any, { min: 1, max: 100 }, 'number').valid).toBe(false);
    expect(validateValue(Infinity, { max: 100 }, 'number').valid).toBe(false);
    expect(validateValue(7 as any, undefined, 'string').valid).toBe(false);
    expect(validateValue('a' as any, undefined, 'multiRole').valid).toBe(false);
    expect(validateValue(50, { min: 1, max: 100 }, 'number').valid).toBe(true);
  });

  it('a color must be a hex color', () => {
    expect(validateValue('red', undefined, 'color').valid).toBe(false);
    expect(validateValue('0xFF0000', undefined, 'color').valid).toBe(true);
  });
});

describe('stored values read by type', () => {
  it('a wrong-typed or null guild value reads as unset and falls back', () => {
    files.set('global/m', { count: 9 });
    files.set('g1/m', { count: 'ten', name: null, tint: 'blue', roles: 'r' });
    const merged = loadModuleSettings('m', 'g1')!;
    expect(merged.values).toEqual({ count: 9, name: 'x', tint: '0x112233', roles: [], minutes: 5 });
    expect(merged.sources.count).toBe('global');
  });
});

function ctx(fields: Record<string, string>, guildId: string | null) {
  const sent: string[] = [];
  const interaction = {
    fields: { getTextInputValue: (id: string) => fields[id] ?? '', fields: new Map(), getField: (id: string) => (id in fields ? { value: fields[id] } : null) },
    reply: async (m: any) => { sent.push(typeof m === 'string' ? m : JSON.stringify(m)); },
    followUp: async (m: any) => { sent.push(JSON.stringify(m)); },
    deferUpdate: async () => {}, replied: false, deferred: false, isRepliable: () => true,
  };
  const state = { currentSection: 's', currentPage: 0, pendingChanges: {} as Record<string, any> };
  return {
    sent,
    state,
    handler: {
      context: { guildId, interaction, userId: 'u' } as any,
      moduleName: 'm', category: 'c', schema: schema as any, defaultSection: 's',
      getState: () => state, setState: () => {}, render: () => ({}) as any,
    } as any,
  };
}

describe('the modals', () => {
  it('a partial number in a guild edit is refused and not staged', async () => {
    const c = ctx({ value: '10m' }, 'g1');
    await handleSettingsModal(c.handler, 'edit_count');
    expect(c.state.pendingChanges).not.toHaveProperty('count');
    expect(c.sent.join(' ')).toContain('not a number');
  });

  it('a System cap edit with one partial field saves no cap', async () => {
    files.set('global/m', { _hardLimits: { count: { min: 2, max: 50 } } });
    const c = ctx({ value: '', hard_min: '3', hard_max: '40x' }, null);
    await handleSettingsModal(c.handler, 'sysedit_count');
    expect(files.get('global/m')!._hardLimits).toEqual({ count: { min: 2, max: 50 } });
    expect(c.sent.join(' ')).toContain('not changed');
  });

  it('a System cap edit with every field emptied clears the cap', async () => {
    files.set('global/m', { _hardLimits: { count: { min: 2, max: 50 } } });
    const c = ctx({ value: '', hard_min: '', hard_max: '' }, null);
    await handleSettingsModal(c.handler, 'sysedit_count');
    expect(files.get('global/m')!._hardLimits).toBeUndefined();
  });

  it('Reset All on a System panel resets values only, through the global config', async () => {
    files.set('global/m', { count: 9, _hardLimits: { count: { max: 50 } }, _moduleEnabled: false, _disabledCommands: ['a'] });
    setGlobal.mockReturnValue(true);
    const c = ctx({ confirm_text: 'RESET' }, null);
    await handleSettingsModal(c.handler, 'reset');
    expect(setGlobal).toHaveBeenCalledWith('m', { values: {} });
    expect(files.get('global/m')).toEqual({ count: 9, _hardLimits: { count: { max: 50 } }, _moduleEnabled: false, _disabledCommands: ['a'] });
  });
});

describe('review fixes', () => {
  it('a value-only System edit with unchanged caps writes no cap', async () => {
    files.set('global/m', { _hardLimits: { count: { min: 2, max: 50 } } });
    const before = saveSpy.mock.calls.length;
    const c = ctx({ value: '', hard_min: '2', hard_max: '50' }, null);
    await handleSettingsModal(c.handler, 'sysedit_count');
    expect(saveSpy.mock.calls.length).toBe(before);
    files.set('global/m', {});
    const d = ctx({ value: '7' }, null);
    await handleSettingsModal(d.handler, 'sysedit_count');
    expect(saveSpy.mock.calls.length).toBe(before);
  });

  it('a refused number names the allowed range', async () => {
    const c = ctx({ value: '10m' }, 'g1');
    await handleSettingsModal(c.handler, 'edit_count');
    expect(c.sent.join(' ')).toContain('allowed 1 to 100');
    const d = ctx({ value: '10m' }, null);
    await handleSettingsModal(d.handler, 'sysedit_count');
    expect(d.sent.join(' ')).toContain('allowed 1 to 100');
  });

  it('an Upload names the keys it did not restore', async () => {
    const json = JSON.stringify({ count: 7, name: 5, _moduleEnabled: false, _hardLimits: {} });
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => json }));
    const c = ctx({}, 'g1');
    (c.handler.context.interaction.fields as any).getUploadedFiles = () => ({ size: 1, first: () => ({ url: 'u' }) });
    await handleSettingsModal(c.handler, 'upload');
    vi.unstubAllGlobals();
    expect(files.get('g1/m')).toEqual({ count: 7 });
    const text = c.sent.join(' ');
    expect(text).toContain('not restored');
    for (const k of ['name', '_moduleEnabled', '_hardLimits']) expect(text).toContain(k);
  });

  it('an Upload with no restorable key says nothing was applied', async () => {
    const json = JSON.stringify({ _moduleEnabled: false, name: 5 });
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => json }));
    const c = ctx({}, 'g1');
    (c.handler.context.interaction.fields as any).getUploadedFiles = () => ({ size: 1, first: () => ({ url: 'u' }) });
    await handleSettingsModal(c.handler, 'upload');
    vi.unstubAllGlobals();
    expect(files.has('g1/m')).toBe(false);
    const text = c.sent.join(' ');
    expect(text).toContain('Upload not applied');
    expect(text).toContain('nothing was changed');
    expect(text).not.toContain('Upload applied');
    for (const k of ['name', '_moduleEnabled']) expect(text).toContain(k);
  });
});

describe('review round 2', () => {
  it('a count or minute setting refuses a fraction, naming the field, the range and the text', async () => {
    expect(validateValue(2.5, { integer: true }, 'number').valid).toBe(false);
    expect(validateValue(3, { integer: true }, 'number').valid).toBe(true);
    const c = ctx({ value: '2.5' }, 'g1');
    await handleSettingsModal(c.handler, 'edit_minutes');
    expect(c.state.pendingChanges).not.toHaveProperty('minutes');
    const text = c.sent.join(' ');
    for (const part of ['Minutes', '2.5', 'whole number', 'allowed 1 to 60', 'not changed']) expect(text).toContain(part);
  });

  it('an Upload of an empty object says the file holds no settings', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '{}' }));
    const c = ctx({}, 'g1');
    (c.handler.context.interaction.fields as any).getUploadedFiles = () => ({ size: 1, first: () => ({ url: 'u' }) });
    await handleSettingsModal(c.handler, 'upload');
    vi.unstubAllGlobals();
    expect(c.sent.join(' ')).toContain('the file holds no settings; nothing was changed');
  });

  it('the System Reset All modal says caps, switches and commands are kept', () => {
    const label = (m: any) => JSON.stringify(m.toJSON());
    expect(label(buildResetModal('p', 'm', 'c', true))).toContain('caps/switches/commands kept');
    expect(label(buildResetModal('p', 'm', 'c'))).not.toContain('kept');
  });

  it('a raw guild settings.json past a cap or of the wrong type is named', () => {
    files.set('global/m', { _hardLimits: { roles: { maxItems: 1 } } });
    const errors = guildSettingsFileErrors('m', 'g1', { count: 500, roles: ['a', 'b'], name: 'ok', other: 1 })!;
    expect(errors.map(e => e.split(':')[0]).sort()).toEqual(['count', 'roles']);
    expect(guildSettingsFileErrors('m', 'g1', { count: 5 })).toEqual([]);
  });

  it('the JSON editor saves nothing when its check refuses', async () => {
    const saveData = vi.fn();
    const sent: string[] = [];
    const interaction = {
      fields: { getTextInputValue: () => '{"count":500}' },
      followUp: async (m: any) => { sent.push(JSON.stringify(m)); }, deferUpdate: async () => {}, replied: false, deferred: false,
    };
    const config: any = { panelId: 'p', dataKey: 'm/settings.json', title: 't', getData: () => ({}), saveData, validate: () => 'Not saved: count' };
    await handleJsonEditorModal(config, { interaction } as any, 'jsonedit_m/settings.json');
    expect(saveData).not.toHaveBeenCalled();
    expect(sent.join(' ')).toContain('Not saved: count');
  });

  it('a module config write is checked by type and by min <= max after the merge with Free', () => {
    expect(moduleConfigErrors(schema as any, {}, { count: { min: 20 } }, { count: { max: 10 } }).join()).toContain('count');
    expect(moduleConfigErrors(schema as any, { tint: '#abc' }, {}).join()).toContain('tint');
    expect(moduleConfigErrors(schema as any, { roles: '1, 2' }, {}).join()).toContain('roles');
    expect(moduleConfigErrors(schema as any, { count: 20 }, {}, { count: { max: 10 } }).join()).toContain('count');
    expect(moduleConfigErrors(schema as any, { count: 8, roles: ['1'] }, { count: { min: 2 } }, { count: { max: 10 } })).toEqual([]);
  });
});

describe('review round 3: untouched stored entries do not block a save', () => {
  it('a tier or Free save skips values and caps equal to the stored ones', () => {
    const stored = { values: { roles: '111, 222', count: 50 }, hardLimits: { count: { max: 100 } } };
    expect(moduleConfigErrors(schema as any, { roles: '111, 222', count: 50 }, {}, { count: { max: 10 } }, stored)).toEqual([]);
    expect(moduleConfigErrors(schema as any, { count: 50 }, { count: { max: 100 } }, { count: { min: 200 } }, stored)).toEqual([]);
    expect(moduleConfigErrors(schema as any, { count: 51 }, {}, { count: { max: 10 } }, stored).join()).toContain('count');
    expect(moduleConfigErrors(schema as any, { roles: '111' }, {}, {}, stored).join()).toContain('roles');
    expect(moduleConfigErrors(schema as any, {}, { count: { max: 101, min: 200 } }, {}, stored).join()).toContain('count');
  });

  it('a Data Browser save skips keys equal to the stored file', () => {
    expect(guildSettingsFileErrors('m', 'g1', { count: 500, name: 'new' }, { count: 500, name: 'old' })).toEqual([]);
    expect(guildSettingsFileErrors('m', 'g1', { count: 501 }, { count: 500 })!.join()).toContain('count');
  });
});

describe('review round 4: inherited Free copies and reordered lists are unchanged', () => {
  it('a new tier seeded from Free values over the cap or of the wrong type is accepted', () => {
    const free = { values: { roles: '111, 222', count: 50 }, hardLimits: { count: { max: 10 } } };
    expect(moduleConfigErrors(schema as any, { roles: '111, 222', count: 50 }, { count: { max: 10 } }, { count: { max: 10 } }, [{}, free])).toEqual([]);
    expect(moduleConfigErrors(schema as any, { count: 51 }, {}, { count: { max: 10 } }, [{}, free]).join()).toContain('count');
  });

  it('a stored unsorted list over the cap resent sorted is unchanged', () => {
    const stored = { values: { roles: ['333', '111', '222'] } };
    expect(moduleConfigErrors(schema as any, { roles: ['111', '222', '333'] }, {}, { roles: { maxItems: 2 } }, stored)).toEqual([]);
    expect(moduleConfigErrors(schema as any, { roles: ['111', '222', '444'] }, {}, { roles: { maxItems: 2 } }, stored).join()).toContain('roles');
    expect(guildSettingsFileErrors('m', 'g1', { roles: ['111', '222', '333'] }, { roles: ['333', '111', '222'] })).toEqual([]);
  });
});

import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

// C02-3 (R45-J6): a multi-role or multi-channel edit opens on the stored set, on Discord and on the web, and the web's
// whole-array submit is stored as that array, never wrapped again.
import { buildChannelEditModal, buildRoleEditModal } from '../../src/bot/internalSetup/utils/settings/settingsBuilder';
import { serializeModal } from '../../src/bot/internalSetup/utils/panelSerializer';
import { PanelWebUIAdapter } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';

const select = (modal: { toJSON(): any }) => (modal.toJSON().components[0] as any).component;
const field = (modal: Parameters<typeof serializeModal>[0]) => serializeModal(modal).components[0].components[0] as any;

describe('the entity edit modals open on the stored value', () => {
  it('a multiRole edit seeds every stored role', () => {
    const modal = buildRoleEditModal('p', 'k', 'm', 'c', { type: 'multiRole', label: 'Roles' } as any, ['1', '2']);
    expect(select(modal).default_values).toEqual([{ id: '1', type: 'role' }, { id: '2', type: 'role' }]);
  });

  it('a single role edit seeds the stored role', () => {
    const modal = buildRoleEditModal('p', 'k', 'm', 'c', { type: 'role', label: 'Role' } as any, '7');
    expect(select(modal).default_values).toEqual([{ id: '7', type: 'role' }]);
  });

  it('a multiChannel edit seeds every stored channel', () => {
    const modal = buildChannelEditModal('p', 'k', 'm', 'c', { type: 'multiChannel', label: 'Ch' } as any, ['3', '4']);
    expect(select(modal).default_values).toEqual([{ id: '3', type: 'channel' }, { id: '4', type: 'channel' }]);
  });

  it('an unset value seeds nothing', () => {
    for (const value of [null, undefined, [], '']) {
      expect(select(buildRoleEditModal('p', 'k', 'm', 'c', { type: 'multiRole', label: 'R' } as any, value)).default_values).toBeUndefined();
      expect(select(buildChannelEditModal('p', 'k', 'm', 'c', { type: 'channel', label: 'C' } as any, value)).default_values).toBeUndefined();
    }
  });
});

describe('the web modal carries the stored value', () => {
  it('a role select carries its defaults, its bounds and is optional when it may be emptied', () => {
    const f = field(buildRoleEditModal('p', 'k', 'm', 'c', { type: 'multiRole', label: 'Roles' } as any, ['1', '2']));
    expect(f).toMatchObject({ type: 'role_select', defaultValues: ['1', '2'], minValues: 0, maxValues: 25, required: false });
  });

  it('a channel select carries its defaults', () => {
    const f = field(buildChannelEditModal('p', 'k', 'm', 'c', { type: 'multiChannel', label: 'Ch' } as any, ['3']));
    expect(f).toMatchObject({ type: 'channel_select', defaultValues: ['3'], maxValues: 25 });
  });

  it('a single select with no stored value carries no defaults and stays required', () => {
    const f = field(buildRoleEditModal('p', 'k', 'm', 'c', { type: 'role', label: 'R' } as any, null));
    expect(f.defaultValues).toEqual([]);
    expect(f.required).toBe(true);
  });
});

describe('the web submit of an entity select', () => {
  async function submitted(fields: Record<string, unknown>) {
    let seen: unknown;
    const panel = {
      id: 'c023', name: 'c023', _moduleName: 'm', callback: async () => ({ content: 'v' }),
      handleModal: async (ctx: any) => {
        seen = ctx.interaction.fields.getField('value')?.values ?? null;
        return { content: 'v' };
      },
    };
    const client = { guilds: { cache: new Map(), fetch: async () => undefined }, users: { fetch: async () => undefined } } as unknown as Client;
    const adapter = new PanelWebUIAdapter(client, new Map([['c023', panel]]) as never, {} as never);
    await adapter.handleWebUIModal('c023', 'multirole_k_m_c', fields as never, 'u');
    return seen;
  }

  it('an array is passed through as the array', async () => {
    expect(await submitted({ value: ['1', '2'] })).toEqual(['1', '2']);
  });

  it('an emptied multi pick is the empty array', async () => {
    expect(await submitted({ value: [] })).toEqual([]);
  });

  it('a single pick is wrapped once', async () => {
    expect(await submitted({ value: '7' })).toEqual(['7']);
  });
});

const store = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  sources: {} as Record<string, string>,
  clamped: undefined as Record<string, { stored: unknown; effective: unknown }> | undefined,
  limits: {} as Record<string, unknown>,
  saved: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../src/bot/internalSetup/utils/settings/settingsStorage', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/settings/settingsStorage')>();
  return {
    ...real,
    loadModuleSettings: () => ({ values: store.values, sources: store.sources, schema: {}, ...(store.clamped && { clamped: store.clamped }) }),
    getMergedHardLimits: () => store.limits,
    saveModuleSettings: (_m: string, updates: Record<string, unknown>) => { store.saved.push(updates); return true; },
  };
});

import { handleSettingsButton, handleSettingsModal, type SettingsPanelState } from '../../src/bot/internalSetup/utils/settings/settingsHandlers';

const SCHEMA = {
  name: 'm',
  settings: {
    roles: { type: 'multiRole', label: 'Roles' },
    chans: { type: 'multiChannel', label: 'Chans' },
    role: { type: 'role', label: 'Role' },
  },
} as any;

const NO_VALUES = Symbol('no values');

function rig(fields: Record<string, unknown> | null, pending: Record<string, unknown> = {}) {
  const state: SettingsPanelState = { currentSection: '', currentPage: 0, pendingChanges: { ...pending } as never };
  const interaction = {
    fields: {
      getField: (id: string) => {
        if (!fields || !(id in fields)) throw new Error('missing field');
        return fields[id] === NO_VALUES ? { customId: id } : { customId: id, values: fields[id] };
      },
      getUploadedFiles: () => ({ size: 1, first: () => ({ url: 'https://upload.test/x.json' }) }),
    },
    deferUpdate: async () => {}, followUp: async () => {}, replied: false, deferred: false,
  };
  const ctx = {
    context: { interaction, guildId: 'g1', userId: 'u', panelId: 'p', accessMethod: 'web_ui' } as any,
    moduleName: 'm', category: 'c', schema: SCHEMA, panelId: 'p',
    getState: () => state, setState: () => {}, render: () => ({ content: 'view' }) as any,
  };
  return { ctx: ctx as any, state };
}

function storeHas(values: Record<string, unknown>, sources: Record<string, string> = {}, clamped?: typeof store.clamped) {
  store.values = values;
  store.sources = sources;
  store.clamped = clamped;
  store.limits = {};
  store.saved = [];
}

describe('an entity edit records only a real change', () => {
  it('a submit equal to the effective set records nothing, in any order', async () => {
    storeHas({ roles: ['1', '2'] }, { roles: 'global' });
    const { ctx, state } = rig({ value: ['2', '1'] });
    await handleSettingsModal(ctx, 'multirole_roles_m_c');
    expect(state.pendingChanges).toEqual({});
  });

  it('a submit back to the effective value drops an earlier pending change', async () => {
    storeHas({ role: '7' }, { role: 'guild' });
    const { ctx, state } = rig({ value: ['7'] }, { role: '8' });
    await handleSettingsModal(ctx, 'role_role_m_c');
    expect(state.pendingChanges).toEqual({});
  });

  it('an empty submit on a never-set list records nothing', async () => {
    storeHas({ chans: undefined }, { chans: 'default' });
    const { ctx, state } = rig({ value: [] });
    await handleSettingsModal(ctx, 'multichannel_chans_m_c');
    expect(state.pendingChanges).toEqual({});
  });

  it('a submit without the field (a read-only web field) records nothing', async () => {
    storeHas({ chans: ['3'] }, { chans: 'guild' });
    const { ctx, state } = rig({});
    await handleSettingsModal(ctx, 'multichannel_chans_m_c');
    expect(state.pendingChanges).toEqual({});
  });

  it('a present field with no values (an emptied Discord pick) empties the set', async () => {
    storeHas({ roles: ['1', '2'] }, { roles: 'guild' });
    const { ctx, state } = rig({ value: NO_VALUES });
    await handleSettingsModal(ctx, 'multirole_roles_m_c');
    expect(state.pendingChanges).toEqual({ roles: [] });
  });

  it('a changed set is recorded', async () => {
    storeHas({ roles: ['1'] }, { roles: 'guild' });
    const { ctx, state } = rig({ value: ['1', '2'] });
    await handleSettingsModal(ctx, 'multirole_roles_m_c');
    expect(state.pendingChanges).toEqual({ roles: ['1', '2'] });
  });
});

describe('a save keeps the stored ids the clamp hid', () => {
  it('the hidden ids are appended after the submitted ones', async () => {
    storeHas({ roles: ['1', '2'] }, { roles: 'guild' }, { roles: { stored: ['1', '2', '3', '4'], effective: ['1', '2'] } });
    store.limits = { roles: { maxItems: 2 } };
    const { ctx } = rig(null, { roles: ['1', '9'] });
    await handleSettingsButton(ctx, 'save');
    expect(store.saved).toEqual([{ roles: ['1', '9', '3', '4'] }]);
  });

  it('an emptied set is stored empty, with nothing appended', async () => {
    storeHas({ roles: ['1', '2'] }, { roles: 'guild' }, { roles: { stored: ['1', '2', '3', '4'], effective: ['1', '2'] } });
    store.limits = { roles: { maxItems: 2 } };
    const { ctx } = rig(null, { roles: [] });
    await handleSettingsButton(ctx, 'save');
    expect(store.saved).toEqual([{ roles: [] }]);
  });

  it('an inherited clamped value is not copied into the guild', async () => {
    storeHas({ roles: ['1', '2'] }, { roles: 'tier' }, { roles: { stored: ['1', '2', '3'], effective: ['1', '2'] } });
    const { ctx } = rig(null, { roles: ['1'] });
    await handleSettingsButton(ctx, 'save');
    expect(store.saved).toEqual([{ roles: ['1'] }]);
  });
});

describe('lists over the Discord select limit', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => String(1000 + i));

  it('an edit of a stored list over 25 answers instead of throwing', async () => {
    storeHas({ roles: ids(26) }, { roles: 'guild' });
    const { ctx } = rig(null);
    const answer: any = await handleSettingsButton(ctx, 'edit_roles');
    expect(answer.modal).toBeUndefined();
    expect(JSON.stringify(answer)).toContain('more entries than Discord can edit');
  });

  it('an upload with a role or channel list over 25 is refused and writes nothing', async () => {
    storeHas({}, {});
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => JSON.stringify({ chans: ids(26) }) }));
    try {
      const { ctx } = rig(null);
      const answer: any = await handleSettingsModal(ctx, 'upload_m_c');
      expect(JSON.stringify(answer)).toContain('Discord allows at most 25');
      expect(store.saved).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

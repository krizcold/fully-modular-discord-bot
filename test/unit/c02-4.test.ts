import { describe, expect, it, vi } from 'vitest';
import { buildSettingsPanel } from '../../src/bot/internalSetup/utils/settings/settingsBuilder';
import { injectReturnButtonIfNeeded, countV2Components } from '../../src/bot/internalSetup/utils/panel/panelResponseUtils';
import { createV2Response } from '../../src/bot/internalSetup/utils/panel/v2';
import { ContainerBuilder, TextDisplayBuilder } from 'discord.js';

function schemaWith(n: number): any {
  const settings: Record<string, any> = {};
  for (let i = 0; i < n; i++) {
    settings[`s${i}`] = { type: 'string', label: `S${i}`, description: 'd', section: 'a', order: i, default: '' };
  }
  return {
    name: 'Mod', description: 'x',
    sections: [{ id: 'a', name: 'A', order: 0 }, { id: 'b', name: 'B', order: 1 }],
    settings,
  };
}

function render(isSystemPanel: boolean, accessMethod: string) {
  const containers = buildSettingsPanel({
    schema: schemaWith(20), settings: { values: {}, sources: {} } as any,
    currentSection: 'a', currentPage: 0, moduleName: 'm', category: 'c', panelId: 'p',
    isDirty: true, isSystemPanel,
  });
  return injectReturnButtonIfNeeded(createV2Response(containers), { accessMethod } as any);
}

describe('C02-4 settings page component budget', () => {
  it('a full dirty System settings page with the injected row fits 40 components', () => {
    const res = render(true, 'system_panel');
    expect(countV2Components(res.components as any[])).toBeLessThanOrEqual(40);
    const json = JSON.stringify((res.components as any[]).map(c => c.toJSON()));
    expect(json).toContain('admin_panel_system_back');
    expect(json).toContain('Unsaved changes');
  });

  it('a full dirty guild settings page with the injected row fits 40 components', () => {
    const res = render(false, 'guild_panel');
    expect(countV2Components(res.components as any[])).toBeLessThanOrEqual(40);
  });

  it('an over-budget V2 panel is replaced by a visible notice instead of failing silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = new ContainerBuilder();
    for (let i = 0; i < 39; i++) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`t${i}`));
    const res = injectReturnButtonIfNeeded(createV2Response([c]), { accessMethod: 'system_panel' } as any);
    expect(countV2Components(res.components as any[])).toBeLessThanOrEqual(40);
    const json = JSON.stringify((res.components as any[]).map(x => x.toJSON()));
    expect(json).toContain('too many');
    expect(json).toContain('admin_panel_system_back');
    expect(json).not.toContain('t38');
    warn.mockRestore();
  });

  it("an over-budget direct_command panel is refused visibly too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = new ContainerBuilder();
    for (let i = 0; i < 41; i++) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`t${i}`));
    const res = injectReturnButtonIfNeeded(createV2Response([c]), { accessMethod: "direct_command" } as any);
    expect(countV2Components(res.components as any[])).toBeLessThanOrEqual(40);
    const json = JSON.stringify((res.components as any[]).map(x => x.toJSON()));
    expect(json).toContain("too many");
    warn.mockRestore();
  });

  it("the over-budget notice keeps the notification and claims no outcome", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = new ContainerBuilder();
    for (let i = 0; i < 41; i++) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`t${i}`));
    const notification = { content: "Saved", ephemeral: true };
    const res: any = injectReturnButtonIfNeeded({ ...createV2Response([c]), notification } as any, { accessMethod: "system_panel" } as any);
    expect(res.notification).toEqual(notification);
    const json = JSON.stringify((res.components as any[]).map(x => x.toJSON()));
    expect(json).not.toContain("Nothing was changed");
    expect(json).toContain("still stands");
    warn.mockRestore();
  });
});

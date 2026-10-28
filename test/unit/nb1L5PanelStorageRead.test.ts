import { describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadModuleData: () => stored.value,
  loadGlobalModuleData: () => stored.value,
}));

import { loadPersistentPanels } from '../../src/bot/internalSetup/utils/panel/persistentPanelStorage';

describe('loadPersistentPanels reads a stored value that is not an object as no records', () => {
  it.each([
    ['null', null],
    ['a string', 'panels'],
    ['a number', 5],
  ])('%s gives an empty record set', async (_label, value) => {
    stored.value = value;
    expect(await loadPersistentPanels('g1')).toEqual({});
    expect(await loadPersistentPanels()).toEqual({});
  });

  it('an object is returned as stored', async () => {
    const panels = { m1: { messageId: 'm1' } };
    stored.value = panels;
    expect(await loadPersistentPanels('g1')).toBe(panels);
  });
});

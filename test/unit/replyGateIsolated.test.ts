import { describe, expect, it, vi } from 'vitest';

// BT-3 rows that need a module replaced, so they run in their own file: a confirm that throws, and the persistent
// warning's confirm button, whose panel comes from the panel manager.
const panels = vi.hoisted(() => new Map<string, unknown>());
const confirm = vi.hoisted(() => ({ throws: false }));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    confirmWrite: async (...args: Parameters<typeof real.confirmWrite>) => {
      if (confirm.throws) throw new Error('confirm failed');
      return real.confirmWrite(...args);
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => ({ getPanel: (id: string) => panels.get(id) }) };
});

import { saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { handlePersistentWarningButton } from '../../src/bot/internalSetup/utils/panel/persistentPanelWarning';
import { notReadyGuild, rawButton, rawCommand, rig, storeGuild, textOf } from '../helpers/gateRig';

describe('a confirm that throws', () => {
  it('answers unavailable', async () => {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    confirm.throws = true;
    try {
      await emit(rawCommand('i1'), async i => {
        saveData('x.json', options, { v: 1 });
        await i.reply({ content: 'Saved!' });
      });
    } finally {
      confirm.throws = false;
    }
    expect(wire.map(textOf)).toEqual([truthText('unavailable', false)]);
  });
});

describe('the persistent warning\'s confirm', () => {
  async function confirmed(refuse: boolean) {
    const { wire, emit } = rig();
    const { options } = await storeGuild();
    const panelId = `warn-${refuse}`;
    panels.set(panelId, {
      id: panelId,
      name: 'w',
      persistent: true,
      callback: async () => {
        if (refuse) saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
        else saveData('x.json', options, { v: 1 });
        return { components: [] };
      },
    });
    const sent: unknown[] = [];
    await emit(rawButton(`w-${refuse}`), async i => {
      Object.defineProperty(i, 'channel', { value: { send: async (payload: unknown) => { sent.push(payload); return {}; } } });
      await handlePersistentWarningButton(i, panelId);
    });
    return { wire, sent };
  }

  it('posts the panel once the callback\'s writes landed', async () => {
    const { sent } = await confirmed(false);
    expect(sent).toHaveLength(1);
  });

  it('does not post it while a write is refused, and tells the member', async () => {
    const { wire, sent } = await confirmed(true);
    expect(sent).toEqual([]);
    expect(wire.map(textOf).filter(Boolean)).toEqual([truthText('not-ready', false)]);
  });
});

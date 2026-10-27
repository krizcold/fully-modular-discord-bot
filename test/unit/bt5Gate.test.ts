import { ComponentType, InteractionResponseType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { setManifestReader } from '../../src/bot/internalSetup/utils/dataBackends/dataContract';
import { openLedger, runInLedger, withModule } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { ACK_MS, sweepLateWrites, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import buttonEvent, { registerButtonHandler } from '../../src/bot/internalSetup/events/interactionCreate/buttonHandler';
import { registerPanelButtonHandler } from '../../src/bot/internalSetup/utils/panel/panelButtonHandler';
import { callbackType, EPHEMERAL, notReadyGuild, rawButton, rawCommand, rig, storeGuild, textOf, tick } from '../helpers/gateRig';

// BT-5's gate rows (notes/BT.md, "BT-5 design sheet: final", Decision 6): a module whose manifest declares
// dataContract 2 sends its own payloads without the gate's wait and without its deferral, but never past a refusal,
// and its payloads take no sweep mark. Every other sender (core, the ledger kinds, panels, modules without the flag)
// is gated as after BT-4.

const flagged = (name: string) => (name.startsWith('flag') ? { dataContract: 2 } : undefined);
const everyName = () => ({ dataContract: 2 });

let warn: MockInstance;
beforeEach(() => {
  setManifestReader(flagged);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  setManifestReader(null);
  warn.mockRestore();
  vi.useRealTimers();
});

const truthLines = () => warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[Truth]'));
const line = (module: string, site: string) => `[Truth] ${module} sent a reply that did not wait on a write (${site})`;
let ids = 0;
const nextId = () => `g5-${++ids}`;

/** Emits one interaction, runs fn as its module's handler, then sweeps as the dispatcher does at its end. */
async function dispatch(module: string, fn: (interaction: any) => Promise<void>) {
  const { wire, emit } = rig();
  const { interaction, error } = await emit(rawCommand(nextId()), i => withModule(module, () => fn(i)));
  expect(error).toBeUndefined();
  await sweepLateWrites(interaction);
  return { wire };
}

describe('a flagged module\'s payload', () => {
  const methods = [
    ['reply', false, InteractionResponseType.ChannelMessageWithSource],
    ['update', false, InteractionResponseType.UpdateMessage],
    ['editReply', true, undefined],
    ['followUp', true, undefined],
  ] as const;
  for (const [name, ownDefer, type] of methods) {
    it(`its ${name} goes out at once while its write is unlanded, and the gate adds no deferral`, async () => {
      const { wire, emit } = rig();
      const { store, options } = await storeGuild();
      store.holding = true;
      let sent: Promise<unknown> | undefined;
      const raw = name === 'update' ? rawButton(nextId()) : rawCommand(nextId());
      try {
        const { error } = await emit(raw, i => withModule('flagmod', async () => {
          if (ownDefer) await i.deferReply();
          saveData('x.json', options, { v: 1 });
          sent = i[name]({ content: 'Saved!' });
        }));
        expect(error).toBeUndefined();
        await tick(50);
        expect(store.commits).toHaveLength(0);
        const expected = ownDefer
          ? [['post', InteractionResponseType.DeferredChannelMessageWithSource, undefined], [name === 'editReply' ? 'patch' : 'post', undefined, 'Saved!']]
          : [['post', type, 'Saved!']];
        expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual(expected);
      } finally {
        store.release();
        await sent?.catch(() => undefined);
      }
      expect(wire).toHaveLength(ownDefer ? 2 : 1);
    });
  }

  it('a flagged reply called just before the ack deadline is the payload itself, not a deferral', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), i => withModule('flagmod', async () => {
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(ACK_MS - 20);
        sent = i.reply({ content: 'Saved!', flags: EPHEMERAL });
      }));
      await tick(80);
      expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([['post', InteractionResponseType.ChannelMessageWithSource, 'Saved!']]);
      expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
    expect(wire).toHaveLength(1);
  });

  it('the same reply from a module without the flag defers by the ack deadline and is edited once the write lands', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), i => withModule('plainmod', async () => {
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(ACK_MS - 20);
        sent = i.reply({ content: 'Saved!', flags: EPHEMERAL });
      }));
      await tick(80);
      expect(wire.map(c => [c.method, callbackType(c)])).toEqual([['post', InteractionResponseType.DeferredChannelMessageWithSource]]);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'Saved!']]);
  });

  it('a flagged reply called after the ack deadline goes out at once, with no deferral', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), i => withModule('flagmod', async () => {
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(ACK_MS + 500);
        sent = i.reply({ content: 'Saved!' });
      }));
      await tick(20);
      expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([['post', InteractionResponseType.ChannelMessageWithSource, 'Saved!']]);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
  });

  it('a flagged reply does not wait on another sender\'s unlanded write in the interaction either', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), async i => {
        saveData('core.json', options, { v: 1 });
        withModule('plainmod', () => saveData('x.json', options, { v: 1 }));
        sent = withModule('flagmod', () => i.reply({ content: 'Saved!' }));
      });
      await tick(50);
      expect(wire.map(textOf)).toEqual(['Saved!']);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
  });

  it('a commit the store refuses after accepting the write is the flagged module\'s to report: its payload goes out', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.mode = 'unavailable';
    const { error } = await emit(rawCommand(nextId()), i => withModule('flagmod', async () => {
      expect(saveDataOutcome('x.json', options, { v: 1 })).toBe('saved');
      await i.reply({ content: 'Saved!' });
    }));
    expect(error).toBeUndefined();
    expect(wire.map(textOf)).toEqual(['Saved!']);
  });
});

describe('a refusal and a flagged sender', () => {
  it('a refused write in the interaction gives a flagged reply the truth, ephemeral', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand(nextId()), i => withModule('flagmod', async () => {
      expect(saveDataOutcome('x.json', notReadyGuild(), { v: 1 })).toBe('refused');
      await i.reply({ content: 'Saved!' });
    }));
    expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, truthText('not-ready', false)]]);
    expect(wire[0].body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('a refusal beside an unlanded write gives the "in full" truth at once, without waiting on the write', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), i => withModule('flagmod', async () => {
        saveData('x.json', options, { v: 1 });
        saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
        sent = i.reply({ content: 'Saved!' });
      }));
      await tick(50);
      expect(wire.map(c => [callbackType(c), textOf(c)])).toEqual([[InteractionResponseType.ChannelMessageWithSource, truthText('not-ready', true)]]);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
  });

  it('a refusal by another module, or by core, in the same interaction still gives the flagged reply the truth', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand(nextId()), async i => {
      withModule('plainmod', () => saveDataOutcome('x.json', notReadyGuild(), { v: 1 }));
      await withModule('flagmod', () => i.reply({ content: 'Saved!' }));
    });
    await emit(rawCommand(nextId()), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await withModule('flagmod', () => i.reply({ content: 'Saved!' }));
    });
    expect(wire.map(textOf)).toEqual([truthText('not-ready', false), truthText('not-ready', false)]);
  });

  it('a refusal recorded in the frame\'s own ledger is told to a flagged reply too', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand(nextId()), async i => {
      await runInLedger(openLedger('panel'), 'flagmod', async () => {
        saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
        await i.reply({ content: 'Saved!' });
      });
    });
    expect(wire.map(textOf)).toEqual([truthText('not-ready', false)]);
  });
});

describe('the truth told once, to a flagged sender', () => {
  it('after a told refusal, a flagged followUp is dropped and a flagged editReply leaves the message; a new refusal is told again', async () => {
    const { wire, emit } = rig();
    await emit(rawButton(nextId()), i => withModule('flagmod', async () => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.deferUpdate();
      await i.followUp({ content: 'Saved!', flags: EPHEMERAL });
      await i.editReply({ content: 'Saved view' });
      expect(await i.followUp({ content: 'Also saved' })).toBeUndefined();
      saveDataOutcome('z.json', notReadyGuild(), { v: 1 });
      await i.followUp({ content: 'Saved again!' });
    }));
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([
      ['post', undefined],
      ['post', truthText('not-ready', false)],
      ['get', undefined],
      ['post', truthText('not-ready', false)],
    ]);
  });

  it('a refusal told to an unflagged reply is not told again to a flagged followUp', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand(nextId()), async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await withModule('plainmod', () => i.reply({ content: 'Saved!' }));
      expect(await withModule('flagmod', () => i.followUp({ content: 'Also saved' }))).toBeUndefined();
    });
    expect(wire.map(textOf)).toEqual([truthText('not-ready', false)]);
  });
});

describe('other senders stay gated', () => {
  it('a core reply in the same interaction as a flagged module\'s unlanded write defers and waits, though every name declares 2', async () => {
    setManifestReader(everyName);
    vi.useFakeTimers({ toFake: ['performance'] });
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), async i => {
        withModule('flagmod', () => saveData('x.json', options, { v: 1 }));
        vi.advanceTimersByTime(ACK_MS - 20);
        sent = i.reply({ content: 'Saved!' });
      });
      await tick(80);
      expect(wire.map(c => [c.method, callbackType(c)])).toEqual([['post', InteractionResponseType.DeferredChannelMessageWithSource]]);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'Saved!']]);
  });

  it('after a flagged reply went out, a core followUp in the same interaction still waits on the unlanded write', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let replied: Promise<unknown> | undefined;
    let followed: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), async i => {
        withModule('flagmod', () => saveData('x.json', options, { v: 1 }));
        replied = withModule('flagmod', () => i.reply({ content: 'Saved!' }));
        followed = i.followUp({ content: 'Core' });
      });
      await tick(50);
      expect(wire.map(textOf)).toEqual(['Saved!']);
    } finally {
      store.release();
      await Promise.all([replied?.catch(() => undefined), followed?.catch(() => undefined)]);
    }
    expect(wire.map(textOf)).toEqual(['Saved!', 'Core']);
  });

  it('an unflagged module\'s reply waits on a flagged module\'s unlanded write', async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), async i => {
        withModule('flagmod', () => saveData('x.json', options, { v: 1 }));
        sent = withModule('plainmod', () => i.reply({ content: 'Saved!' }));
      });
      await tick(50);
      expect(wire).toEqual([]);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
    expect(wire.map(textOf)).toEqual(['Saved!']);
  });

  for (const kind of ['interaction', 'panel', 'console'] as const) {
    it(`a reply sent as the ledger kind ${kind} waits on the write, though a module of that name declares 2`, async () => {
      setManifestReader(everyName);
      const { wire, emit } = rig();
      const { store, options } = await storeGuild();
      store.holding = true;
      let sent: Promise<unknown> | undefined;
      try {
        await emit(rawCommand(nextId()), async i => {
          saveData('x.json', options, { v: 1 });
          sent = withModule(kind, () => i.reply({ content: 'Saved!' }));
        });
        await tick(50);
        expect(wire).toEqual([]);
      } finally {
        store.release();
        await sent?.catch(() => undefined);
      }
      expect(wire.map(textOf)).toEqual(['Saved!']);
    });
  }

  for (const [label, reader] of [
    ['declares the string \'2\'', (name: string) => (name === 'oddmod' ? { dataContract: '2' } : undefined)],
    ['declares 1', (name: string) => (name === 'oddmod' ? { dataContract: 1 } : undefined)],
    ['declares nothing', (name: string) => (name === 'oddmod' ? {} : undefined)],
    ['is read with no reader installed', null],
  ] as const) {
    it(`a module that ${label} waits on its write`, async () => {
      setManifestReader(reader);
      const { wire, emit } = rig();
      const { store, options } = await storeGuild();
      store.holding = true;
      let sent: Promise<unknown> | undefined;
      try {
        await emit(rawCommand(nextId()), i => withModule('oddmod', async () => {
          saveData('x.json', options, { v: 1 });
          sent = i.reply({ content: 'Saved!' });
        }));
        await tick(50);
        expect(wire).toEqual([]);
      } finally {
        store.release();
        await sent?.catch(() => undefined);
      }
      expect(wire.map(textOf)).toEqual(['Saved!']);
    });
  }

  it('a reply in a panel action\'s frame with no module, inside the interaction, waits on the write', async () => {
    setManifestReader(everyName);
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand(nextId()), async i => {
        withModule('flagmod', () => saveData('x.json', options, { v: 1 }));
        sent = runInLedger(openLedger('panel'), null, () => i.reply({ content: 'Saved!' }));
      });
      await tick(50);
      expect(wire).toEqual([]);
    } finally {
      store.release();
      await sent?.catch(() => undefined);
    }
    expect(wire.map(textOf)).toEqual(['Saved!']);
  });

  it('a module panel\'s view through core\'s panel dispatcher waits on its write, though every name declares 2', async () => {
    setManifestReader(everyName);
    const { client, wire, emit } = rig();
    (client as any).buttonHandlers = new Map();
    const { store, options } = await storeGuild();
    store.holding = true;
    registerPanelButtonHandler(client, async () => {
      saveData('x.json', options, { v: 1 });
      return { content: 'View' } as never;
    }, new Map());
    const raw = { ...rawButton(nextId()), data: { custom_id: 'panel_flagpanel_btn_save', component_type: ComponentType.Button } };
    const done = emit(raw, i => buttonEvent(client, i));
    try {
      await tick(50);
      expect(wire.map(c => [c.method, callbackType(c)])).toEqual([['post', InteractionResponseType.DeferredMessageUpdate]]);
    } finally {
      store.release();
    }
    expect((await done).error).toBeUndefined();
    expect(wire.map(c => [c.method, textOf(c)])).toEqual([['post', undefined], ['patch', 'View']]);
  });

  it('a flagged module\'s own button, dispatched under its module name, updates at once', async () => {
    const { client, wire, emit } = rig();
    (client as any).buttonHandlers = new Map();
    const { store, options } = await storeGuild();
    store.holding = true;
    registerButtonHandler(client, 'flagbtn', async (_client, interaction) => {
      saveData('x.json', options, { v: 1 });
      await interaction.update({ content: 'Done' });
    }, { timeoutMs: null });
    (client as any).buttonHandlers.get('flagbtn')._moduleName = 'flagBtnMod';
    const raw = { ...rawButton(nextId()), data: { custom_id: 'flagbtn_1', component_type: ComponentType.Button } };
    const done = emit(raw, i => buttonEvent(client, i));
    try {
      await tick(50);
      expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([['post', InteractionResponseType.UpdateMessage, 'Done']]);
    } finally {
      store.release();
      await done;
    }
  });
});

describe('the sweep and a flagged sender', () => {
  it('a flagged payload takes no mark: a write after it is not logged', async () => {
    const { options } = await storeGuild();
    const { wire } = await dispatch('flagSweepA', async i => {
      await i.reply({ content: 'Got it' });
      saveData('x.json', options, { v: 1 });
    });
    expect(wire.map(textOf)).toEqual(['Got it']);
    expect(truthLines()).toEqual([]);
  });

  it('a flagged payload clears the mark of an earlier unflagged payload', async () => {
    const { options } = await storeGuild();
    await dispatch('plainSweepB', async i => {
      await i.reply({ content: 'Got it' });
      await withModule('flagSweepB', () => i.followUp({ content: 'Working' }));
      saveData('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([]);
  });

  it('an unflagged payload after a flagged one marks, and the sweep logs it', async () => {
    const { options } = await storeGuild();
    await dispatch('flagSweepC', async i => {
      await i.reply({ content: 'Got it' });
      await withModule('plainSweepC', () => i.followUp({ content: 'More' }));
      saveData('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('plainSweepC', 'command ping')]);
  });
});

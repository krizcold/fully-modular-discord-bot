import fs from 'fs';
import path from 'path';
import { ComponentType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { freezeGuildWrites, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { INTERACTION_LEDGER_LIFE_MS, ledgerOf, openLedger, runInLedger, withModule } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { ACK_MS, answerWrites, sweepLateWrites, writesConfirmed } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { notReadyGuild, rawButton, rawCommand, rawModal, rig, storeGuild, textOf, tick } from '../helpers/gateRig';

// BT-4's sweep (notes/BT.md, "BT-4 design sheet: final", Decisions 8 and 9): at the end of an interaction's dispatch,
// a write the module's last payload was not judged on is logged once per site. It sends nothing to the member.

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

const truthLines = () => warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[Truth]'));
const line = (module: string, site: string) =>
  `[Truth] ${module} sent a reply that did not wait on a write (${site})`;
let ids = 0;

/** Emits one interaction, runs fn as its module's handler, then sweeps as the dispatcher does at its end. */
async function dispatch(module: string, fn: (interaction: any) => Promise<void>, raw: object = rawCommand(`sw${++ids}`), setup?: (client: any) => void) {
  const { client, wire, emit } = rig();
  setup?.(client);
  const { interaction, error } = await emit(raw, i => withModule(module, () => fn(i)));
  expect(error).toBeUndefined();
  await sweepLateWrites(interaction);
  return { wire };
}

describe('the sweep', () => {
  it('a command that replies and then saves logs one line, once per site', async () => {
    const { options } = await storeGuild();
    const { wire } = await dispatch('modA', async i => {
      await i.reply({ content: 'Got it' });
      saveData('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modA', 'command ping')]);
    expect(wire).toHaveLength(1);
    await dispatch('modA', async i => {
      await i.reply({ content: 'Got it' });
      saveData('y.json', options, { v: 1 });
    });
    expect(truthLines()).toHaveLength(1);
  });

  it('one that saves and then replies does not', async () => {
    const { options } = await storeGuild();
    await dispatch('modB', async i => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    });
    expect(truthLines()).toEqual([]);
  });

  it('one that writes and sends no payload does not', async () => {
    const { options } = await storeGuild();
    await dispatch('modC', async () => {
      saveData('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([]);
  });

  it('a payload still queued at the dispatch end is marked before the sweep reads the mark', async () => {
    const { options } = await storeGuild();
    await dispatch('modD', async i => {
      await i.reply({ content: 'Working on it' });
      saveData('x.json', options, { v: 1 });
      void i.followUp({ content: 'Saved!' });
    });
    expect(truthLines()).toEqual([]);
  });

  it('a refusal recorded after the payload is logged', async () => {
    const { guildId, options } = await storeGuild();
    await dispatch('modE', async i => {
      await i.reply({ content: 'Got it' });
      freezeGuildWrites(guildId);
      saveDataOutcome('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modE', 'command ping')]);
  });

  it('answerWrites answering true marks, since its caller\'s visible result goes out next', async () => {
    const { options } = await storeGuild();
    await dispatch('modF', async i => {
      saveData('x.json', options, { v: 1 });
      expect(await answerWrites(i)).toBe(true);
      saveData('y.json', options, { v: 1 });
      saveData('z.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modF', 'command ping')]);
  });

  it('a component is named by its registered handler key, never by its custom id', async () => {
    const { options } = await storeGuild();
    const raw = { ...rawButton(`sw${++ids}`), data: { custom_id: 'ra_add_123456789', component_type: ComponentType.Button } };
    await dispatch('modG', async i => {
      await i.update({ content: 'Added' });
      saveData('x.json', options, { v: 1 });
    }, raw, client => {
      client.buttonHandlers = new Map([['ra_add', { handler: async () => undefined }]]);
    });
    expect(truthLines()).toEqual([line('modG', 'button ra_add')]);
  });

  it('a truth sent in place of the payload is no mark', async () => {
    const { options } = await storeGuild();
    await dispatch('modH', async i => {
      saveDataOutcome('x.json', notReadyGuild(), { v: 1 });
      await i.reply({ content: 'Saved!' });
      saveData('y.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([]);
  });
});

describe('the sweep\'s sites', () => {
  it('a late write and a late refusal give one line', async () => {
    const { options } = await storeGuild();
    await dispatch('modI', async i => {
      await i.reply({ content: 'Got it' });
      saveData('x.json', options, { v: 1 });
      saveDataOutcome('y.json', notReadyGuild(), { v: 1 });
    });
    expect(truthLines()).toEqual([line('modI', 'command ping')]);
  });

  it('the same module at another site logs again', async () => {
    const { options } = await storeGuild();
    await dispatch('modJ', async i => {
      await i.reply({ content: 'Got it' });
      saveData('x.json', options, { v: 1 });
    });
    const raw = { ...rawButton(`sw${++ids}`), data: { custom_id: 'other', component_type: ComponentType.Button } };
    await dispatch('modJ', async i => {
      await i.update({ content: 'Done' });
      saveData('y.json', options, { v: 1 });
    }, raw, client => {
      client.buttonHandlers = new Map([['other', {}]]);
    });
    expect(truthLines()).toEqual([line('modJ', 'command ping'), line('modJ', 'button other')]);
  });

  it('an exact key wins over a shorter prefix, and a prefix needs its _ boundary', async () => {
    const { options } = await storeGuild();
    const handlers = new Map<string, unknown>([['ra', {}], ['ra_a', {}], ['ra_add', {}]]);
    for (const [module, customId, expected] of [['modK', 'ra_add', 'button ra_add'], ['modL', 'ra_add_9', 'button ra_add'], ['modM', 'zz_1', 'button unregistered']]) {
      const raw = { ...rawButton(`sw${++ids}`), data: { custom_id: customId, component_type: ComponentType.Button } };
      await dispatch(module, async i => {
        await i.update({ content: 'Done' });
        saveData('x.json', options, { v: ids });
      }, raw, client => {
        client.buttonHandlers = new Map([...handlers].filter(([key]) => module !== 'modL' || key !== 'ra'));
      });
      expect(truthLines().at(-1)).toBe(line(module, expected));
    }
  });

  it('a component with no handler map is unregistered', async () => {
    const { options } = await storeGuild();
    const raw = { ...rawButton(`sw${++ids}`), data: { custom_id: 'loose_1', component_type: ComponentType.Button } };
    await dispatch('modN', async i => {
      await i.update({ content: 'Done' });
      saveData('x.json', options, { v: 1 });
    }, raw);
    expect(truthLines()).toEqual([line('modN', 'button unregistered')]);
  });

  it('a select menu and a modal are named by their handler keys', async () => {
    const { options } = await storeGuild();
    const select = { ...rawButton(`sw${++ids}`), data: { custom_id: 'pick_7', component_type: ComponentType.StringSelect, values: ['a'] } };
    await dispatch('modO', async i => {
      await i.update({ content: 'Picked' });
      saveData('x.json', options, { v: 1 });
    }, select, client => {
      client.dropdownHandlers = new Map([['pick', {}]]);
    });
    const modal = { ...rawModal(`sw${++ids}`, false), data: { custom_id: 'form_3', components: [] } };
    await dispatch('modP', async i => {
      await i.reply({ content: 'Sent' });
      saveData('y.json', options, { v: 1 });
    }, modal, client => {
      client.modalHandlers = new Map([['form', {}]]);
    });
    expect(truthLines()).toEqual([line('modO', 'dropdown pick'), line('modP', 'modal form')]);
  });

  it('a panel component is named by its panel id, so two panels give two lines', async () => {
    const { options } = await storeGuild();
    const components: Array<[object, string]> = [
      [{ ...rawButton(`sw${++ids}`), data: { custom_id: 'panel_giveaway_btn_end', component_type: ComponentType.Button } }, 'buttonHandlers'],
      [{ ...rawButton(`sw${++ids}`), data: { custom_id: 'panel_role_assign_btn_add_2', component_type: ComponentType.Button } }, 'buttonHandlers'],
      [{ ...rawButton(`sw${++ids}`), data: { custom_id: 'panel_giveaway_dropdown_pick', component_type: ComponentType.StringSelect, values: ['a'] } }, 'dropdownHandlers'],
      [{ ...rawModal(`sw${++ids}`, false), data: { custom_id: 'panel_giveaway_modal_edit', components: [] } }, 'modalHandlers'],
    ];
    for (const [raw, map] of components) {
      await dispatch('panel', async i => {
        await (i.isModalSubmit() ? i.reply({ content: 'Done' }) : i.update({ content: 'Done' }));
        saveData('x.json', options, { v: ids++ });
      }, raw, client => {
        client[map] = new Map([['panel', {}]]);
      });
    }
    expect(truthLines()).toEqual([
      line('panel', 'button giveaway'), line('panel', 'button role_assign'), line('panel', 'dropdown giveaway'), line('panel', 'modal giveaway'),
    ]);
  });

  it('a panel custom id the dispatchers cannot parse is named by its handler key', async () => {
    const { options } = await storeGuild();
    const raw = { ...rawButton(`sw${++ids}`), data: { custom_id: 'panel_x', component_type: ComponentType.Button } };
    await dispatch('panelOdd', async i => {
      await i.update({ content: 'Done' });
      saveData('x.json', options, { v: 1 });
    }, raw, client => {
      client.buttonHandlers = new Map([['panel', {}]]);
    });
    expect(truthLines()).toEqual([line('panelOdd', 'button panel')]);
  });
});

describe('the line', () => {
  it('two late writes to one guild give one line, with no count', async () => {
    const { options } = await storeGuild();
    await dispatch('modLa', async i => {
      await i.reply({ content: 'Got it' });
      saveData('x.json', options, { v: 1 });
      saveData('y.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modLa', 'command ping')]);
  });

  it('names the module that sent the reply, not another that wrote later', async () => {
    const { options } = await storeGuild();
    await dispatch('modLb', async i => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
      withModule('modLc', () => saveData('y.json', options, { v: 1 }));
    });
    expect(truthLines()).toEqual([line('modLb', 'command ping')]);
  });

  it('names the sender when the later write is another module\'s refusal', async () => {
    const { guildId, options } = await storeGuild();
    await dispatch('modLd', async i => {
      await i.reply({ content: 'Got it' });
      freezeGuildWrites(guildId);
      withModule('modLe', () => saveDataOutcome('y.json', options, { v: 1 }));
    });
    expect(truthLines()).toEqual([line('modLd', 'command ping')]);
  });

  it('takes the sender from the frame the reply was called in', async () => {
    const { options } = await storeGuild();
    await dispatch('modLf', async i => {
      await withModule('modLg', () => i.reply({ content: 'Got it' }));
      saveData('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modLg', 'command ping')]);
  });

  it('answerWrites answering true names the module that called it', async () => {
    const { options } = await storeGuild();
    await dispatch('modLh', async i => {
      saveData('x.json', options, { v: 1 });
      expect(await withModule('modLi', () => answerWrites(i))).toBe(true);
      saveData('y.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modLi', 'command ping')]);
  });

  it('a reply called outside any module names the interaction', async () => {
    const { options } = await storeGuild();
    const { emit } = rig();
    const { interaction } = await emit(rawCommand(`sw${++ids}`), async i => {
      await i.reply({ content: 'Got it' });
      withModule('modLj', () => saveData('x.json', options, { v: 1 }));
    });
    await sweepLateWrites(interaction);
    expect(truthLines()).toEqual([line('interaction', 'command ping')]);
  });

  it('a reply called outside every frame names the interaction', async () => {
    const { options } = await storeGuild();
    const { emit } = rig();
    const raw = { ...rawCommand(`sw${++ids}`), data: { id: '12', name: 'outside', type: 1 } };
    const { interaction } = await emit(raw, async () => undefined);
    await interaction.reply({ content: 'Got it' });
    runInLedger(ledgerOf(interaction)!, 'modLk', () => saveData('x.json', options, { v: 1 }));
    await sweepLateWrites(interaction);
    expect(truthLines()).toEqual([line('interaction', 'command outside')]);
  });

  it('answerWrites and writesConfirmed called outside every frame name the interaction', async () => {
    const { options } = await storeGuild();
    for (const [answerer, name] of [[answerWrites, 'outsideanswer'], [writesConfirmed, 'outsideconfirmed']] as const) {
      const { emit } = rig();
      const raw = { ...rawCommand(`sw${++ids}`), data: { id: '12', name, type: 1 } };
      const { interaction } = await emit(raw, async () => undefined);
      expect(await answerer(interaction)).toBe(true);
      runInLedger(ledgerOf(interaction)!, 'modLn', () => saveData(`${name}.json`, options, { v: 1 }));
      await sweepLateWrites(interaction);
    }
    expect(truthLines()).toEqual([line('interaction', 'command outsideanswer'), line('interaction', 'command outsideconfirmed')]);
  });

  it('a reply called in another entry\'s frame with no module names that entry', async () => {
    const { options } = await storeGuild();
    await dispatch('modLl', async i => {
      await runInLedger(openLedger('panel'), null, () => i.reply({ content: 'Got it' }));
      saveData('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('panel', 'command ping')]);
  });
});

describe('the sweep entry', () => {
  it('resolves when its own reading throws', async () => {
    const { options } = await storeGuild();
    const { client, emit } = rig();
    (client as any).buttonHandlers = new (class extends Map<string, unknown> {
      keys(): never {
        throw new Error('boom');
      }
    })();
    const raw = { ...rawButton(`sw${++ids}`), data: { custom_id: 'zz_1', component_type: ComponentType.Button } };
    const { interaction } = await emit(raw, i => withModule('modSe', async () => {
      await i.update({ content: 'Done' });
      saveData('x.json', options, { v: 1 });
    }));
    await expect(sweepLateWrites(interaction)).resolves.toBeUndefined();
    expect(truthLines()).toEqual([]);
  });
});

describe('the gate queue', () => {
  it('answerWrites runs after a reply already queued, in order', async () => {
    const { options } = await storeGuild();
    const order: string[] = [];
    const { wire } = await dispatch('modGq', async i => {
      saveData('x.json', options, { v: 1 });
      const replied = i.reply({ content: 'Saved!' }).then(() => order.push('reply'));
      const answered = answerWrites(i).then(ok => order.push(`answer ${ok}`));
      await Promise.all([replied, answered]);
    });
    expect(order).toEqual(['reply', 'answer true']);
    expect(wire.map(textOf)).toEqual(['Saved!']);
  });
});

describe('the marks', () => {
  it('a second sweep at a site already logged adds no line', async () => {
    const { options } = await storeGuild();
    const { emit } = rig();
    const { interaction } = await emit(rawCommand(`sw${++ids}`), i => withModule('modQ', async () => {
      await i.reply({ content: 'Got it' });
      saveData('x.json', options, { v: 1 });
    }));
    await sweepLateWrites(interaction);
    runInLedger(ledgerOf(interaction)!, 'modR', () => saveData('y.json', options, { v: 1 }));
    await sweepLateWrites(interaction);
    expect(truthLines()).toEqual([line('modQ', 'command ping')]);
  });

  it('a sweep that finds nothing clears its mark too, so a later sweep logs nothing', async () => {
    const { options } = await storeGuild();
    const { emit } = rig();
    const { interaction } = await emit(rawCommand(`sw${++ids}`), i => withModule('modQa', async () => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
    }));
    await sweepLateWrites(interaction);
    runInLedger(ledgerOf(interaction)!, 'modQb', () => saveData('y.json', options, { v: 1 }));
    await sweepLateWrites(interaction);
    expect(truthLines()).toEqual([]);
  });

  it('a write recorded while the reply was held is one that reply did not wait on', async () => {
    const { store, options } = await storeGuild();
    store.holding = true;
    const order: string[] = [];
    const { emit } = rig();
    const raw = { ...rawCommand(`sw${++ids}`), data: { id: '12', name: 'heldwrite', type: 1 } };
    const { interaction, error } = await emit(raw, i => withModule('modZ', async () => {
      saveData('x.json', options, { v: 1 });
      const sent = i.reply({ content: 'Saved!' }).then(() => order.push('reply sent'));
      await tick(5);
      saveData('y.json', options, { v: 1 });
      order.push('y recorded');
      store.release();
      await sent;
    }));
    expect(error).toBeUndefined();
    await sweepLateWrites(interaction);
    expect(order).toEqual(['y recorded', 'reply sent']);
    expect(truthLines()).toEqual([line('modZ', 'command heldwrite')]);
  });

  it('a payload sent once its writes landed marks them', async () => {
    const { options } = await storeGuild();
    await dispatch('modS', async i => {
      saveData('x.json', options, { v: 1 });
      await i.reply({ content: 'Saved!' });
      saveData('y.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modS', 'command ping')]);
  });

  it('only the last mark is kept: a progress reply, a write, then a reply that waited on it log nothing', async () => {
    const { options } = await storeGuild();
    await dispatch('modPr', async i => {
      await i.reply({ content: 'Working on it' });
      saveData('x.json', options, { v: 1 });
      await i.followUp({ content: 'Saved!' });
    });
    expect(truthLines()).toEqual([]);
  });

  it('a payload edited in after the deadline marks', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const { store, options } = await storeGuild();
      store.holding = true;
      const { emit } = rig();
      const done = emit(rawCommand(`sw${++ids}`), i => withModule('modT', async () => {
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(ACK_MS + 100);
        await i.reply({ content: 'Saved!' });
        saveData('y.json', options, { v: 1 });
      }));
      await tick(30);
      store.release();
      const { interaction, error } = await done;
      expect(error).toBeUndefined();
      await sweepLateWrites(interaction);
      expect(truthLines()).toEqual([line('modT', 'command ping')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a later call that waited on its writes marks', async () => {
    const { options } = await storeGuild();
    await dispatch('modU', async i => {
      await i.deferReply();
      saveData('x.json', options, { v: 1 });
      await i.editReply({ content: 'Saved!' });
      saveData('y.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modU', 'command ping')]);
  });

  it('a payload whose send failed is no mark', async () => {
    const { options } = await storeGuild();
    const { control, emit } = rig();
    const { interaction } = await emit(rawCommand(`sw${++ids}`), i => withModule('modV', async () => {
      control.failNext = new Error('Discord 500');
      await i.reply({ content: 'Got it' }).catch(() => undefined);
      saveData('x.json', options, { v: 1 });
    }));
    await sweepLateWrites(interaction);
    expect(truthLines()).toEqual([]);
  });

  it('answerWrites with nothing to wait on marks', async () => {
    const { options } = await storeGuild();
    await dispatch('modW', async i => {
      expect(await answerWrites(i)).toBe(true);
      saveData('x.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modW', 'command ping')]);
  });

  it('writesConfirmed answering true marks', async () => {
    const { options } = await storeGuild();
    await dispatch('modX', async i => {
      saveData('x.json', options, { v: 1 });
      expect(await writesConfirmed(i)).toBe(true);
      saveData('y.json', options, { v: 1 });
    });
    expect(truthLines()).toEqual([line('modX', 'command ping')]);
  });
});

describe('the limits', () => {
  it('a dispatch longer than the ledger\'s life is not swept: its ledger is sealed', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const { options } = await storeGuild();
      await dispatch('modLong', async i => {
        await i.reply({ content: 'Working on it' });
        saveData('x.json', options, { v: 1 });
        vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS);
      });
      expect(truthLines()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the dispatcher', () => {
  // clientInitializer.ts runs main() at import, so its one listener line is pinned by text; the mutation gate's sandbox
  // instruments the file, so the pin is skipped there. dispatchGated's rows (r1j2DispatchGated.test.ts) hold the
  // behaviour: the gate, the dispatch from the admission, and the sweep the listener does not wait on.
  it.skipIf(process.env.__STRYKER_ACTIVE_MUTANT__ !== undefined)('hands every internal event to dispatchGated', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/bot/internalSetup/clientInitializer.ts'), 'utf-8');
    expect(source).toContain('    client.on(eventName, (...args) => dispatchGated(eventName, args, dispatchOrdered));\n');
  });
});

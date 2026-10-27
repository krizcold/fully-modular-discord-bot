import fc from 'fast-check';
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

// BT-4's property (notes/BT.md, "BT-4 design sheet: final"), with an oracle that reads the store, not the ledger: over
// random runs of a panel action or a console invoke, an answer is success:true only when the store holds every write
// the run made and none was refused; with no write and no throw, the answer is the handler's, unchanged.
const local = vi.hoisted(() => ({ commands: [] as any[] }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => local.commands }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  const client = { isReady: () => true, guilds: { cache: new Map() }, users: { cache: new Map() }, user: { id: '11' }, application: { id: '11' } };
  return { ...real, getPanelManager: () => ({ getClient: () => client }) };
});

import { saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { handleInvoke } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { runPanelAction } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { PanelWebUIAdapter } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';
import { notReadyGuild, storeGuild } from '../helpers/gateRig';

type Op = 'save' | 'refuse';
type Entry = 'panel' | 'console';
let runs = 0;

describe('the synthetic entries, over random runs', () => {
  it('answer success only for writes the store holds, none refused', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Entry>('panel', 'console'),
        fc.array(fc.constantFrom<Op>('save', 'refuse'), { maxLength: 3 }),
        fc.constantFrom<'commit' | 'unavailable' | 'deposed'>('commit', 'unavailable', 'deposed'),
        fc.boolean(),
        async (entry, ops, mode, throws) => {
          const { guildId, store, options } = await storeGuild();
          store.mode = mode;
          const written: Array<[string, number]> = [];
          const body = async () => {
            for (const [n, op] of ops.entries()) {
              if (op === 'save') {
                saveData(`s${n}.json`, options, { n });
                written.push([`s${n}.json`, n]);
              } else {
                saveDataOutcome(`r${n}.json`, notReadyGuild(), { n });
              }
            }
            if (throws) throw new Error('handler failed');
          };
          let answer: Record<string, any>;
          if (entry === 'panel') {
            const id = `prop-${++runs}`;
            const panels = new Map([[id, { id, name: id, callback: async () => ({ content: 'VIEW' }), handleModal: async () => { await body(); return { content: 'VIEW' }; } }]]);
            const adapter = new PanelWebUIAdapter({ guilds: { cache: new Map() } } as unknown as Client, panels as never, {} as never);
            const pm = { getPanel: (p: string) => panels.get(p), handleWebUIModal: (...a: unknown[]) => (adapter.handleWebUIModal as (...b: unknown[]) => Promise<unknown>)(...a) };
            answer = await runPanelAction('panel:modal', { panelId: id, modalId: 'm', fields: {}, userId: 'web-ui-owner', guildId }, pm);
          } else {
            local.commands = [{ name: 'prop', callback: async (_c: unknown, i: any) => { await body(); await i.reply({ content: 'VIEW' }); } }];
            answer = await handleInvoke({ command: 'prop', guildId, force: true });
          }
          const committed = written.every(([file, n]) => {
            const doc = store.doc(guildId, file);
            return doc !== undefined && JSON.parse(doc).n === n;
          });
          if (answer.success === true) {
            expect(ops.includes('refuse')).toBe(false);
            expect(committed).toBe(true);
          }
          if (ops.length === 0 && !throws) {
            expect(answer.success).toBe(true);
            if (entry === 'panel') expect(answer).toEqual({ success: true, data: { content: 'VIEW' } });
            else expect(answer.captured).toEqual([{ method: 'reply', payload: { content: 'VIEW' } }]);
          }
          if (throws) expect(answer.success).toBe(false);
        },
      ),
      { numRuns: 40 },
    );
  });
});

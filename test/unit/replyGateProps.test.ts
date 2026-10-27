import { InteractionResponseType } from 'discord.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { appendData, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { EPHEMERAL, notReadyGuild, rawCommand, rig, storeGuild, textOf } from '../helpers/gateRig';

// BT-3's properties (notes/BT.md, "BT-3 design sheet (L0)"), with an oracle that does not use the gate:
// - truth: the payload reaches the wire only when no write was refused and every write is committed in the store at
//   the moment it is sent; otherwise a text that is not the payload goes in its place;
// - order: responses reach the wire in call order;
// - transparency: with no write, the wire carries exactly the calls made, with their payloads.

type Op = 'save' | 'append' | 'refuse';
type Shape = 'reply' | 'deferThenEdit' | 'replyThenFollowUp';

let runs = 0;

describe('the reply gate, over random interactions', () => {
  it('sends a payload only for committed, unrefused writes, in call order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Op>('save', 'append', 'refuse'), { maxLength: 4 }),
        fc.constantFrom<'commit' | 'unavailable'>('commit', 'unavailable'),
        fc.constantFrom<Shape>('reply', 'deferThenEdit', 'replyThenFollowUp'),
        async (ops, mode, shape) => {
          const { wire, control, emit } = rig();
          const { guildId, store, options } = await storeGuild();
          store.mode = mode;
          const written: string[] = [];
          const committedAtSend: boolean[] = [];
          control.onSend = () => {
            committedAtSend.push(written.every(name => store.doc(guildId, name) !== undefined));
          };
          const id = `prop-${++runs}`;
          const { error } = await emit(rawCommand(id), async i => {
            for (const [n, op] of ops.entries()) {
              if (op === 'save') {
                saveData(`s${n}.json`, options, { n });
                written.push(`s${n}.json`);
              } else if (op === 'append') {
                appendData(`a${n}.jsonl`, options, `${n}\n`);
              } else {
                saveDataOutcome(`r${n}.json`, notReadyGuild(), { n });
              }
            }
            if (shape === 'reply') await i.reply({ content: 'PAYLOAD 1' });
            if (shape === 'deferThenEdit') {
              await i.deferReply();
              await i.editReply({ content: 'PAYLOAD 1' });
            }
            if (shape === 'replyThenFollowUp') {
              const first = i.reply({ content: 'PAYLOAD 1' });
              const second = i.followUp({ content: 'PAYLOAD 2' });
              await Promise.all([first, second]);
            }
          });
          expect(error).toBeUndefined();
          const refused = ops.includes('refuse');
          const accepted = ops.some(op => op !== 'refuse');
          const truthful = !refused && (mode === 'commit' || !accepted);
          const texts = wire.map(textOf).filter((text): text is string => text !== undefined);
          const payloads = texts.filter(text => text.startsWith('PAYLOAD'));
          if (truthful) {
            const expected = shape === 'replyThenFollowUp' ? ['PAYLOAD 1', 'PAYLOAD 2'] : ['PAYLOAD 1'];
            expect(payloads).toEqual(expected);
            if (ops.length === 0) expect(texts).toEqual(expected);
          } else {
            expect(payloads).toEqual([]);
            expect(texts.length).toBeGreaterThan(0);
            // Every original here is public: each truth carries the Ephemeral flag, none edits a message, and each
            // deferral (the module's or the gate's), still empty when refused, is deleted.
            for (const call of wire.filter(c => textOf(c) !== undefined)) {
              expect(call.method).toBe('post');
              expect(((call.route.includes('/callback') ? call.body?.data?.flags : call.body?.flags) ?? 0) & EPHEMERAL).toBe(EPHEMERAL);
            }
            const deferrals = wire.filter(c => c.route.includes('/callback') && c.body?.type === InteractionResponseType.DeferredChannelMessageWithSource);
            expect(wire.filter(c => c.method === 'delete')).toHaveLength(deferrals.length);
            if (shape === 'deferThenEdit') expect(deferrals).toHaveLength(1);
          }
          wire.forEach((call, n) => {
            if (textOf(call)?.startsWith('PAYLOAD')) expect(committedAtSend[n]).toBe(true);
          });
        },
      ),
      { numRuns: 40 },
    );
  });
});

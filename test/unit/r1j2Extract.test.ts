import { Guild } from 'discord.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { extractGuildId } from '../../src/bot/internalSetup/utils/dataBackends/boot';

// R17-J6's core half (notes/BT.md, "R1-J2 design sheet (L0): final, after the re-read"): extractGuildId reads the
// guild of a reaction, a thread member, a poll answer and a Guild, and no other id.

const snowflake = fc.bigInt({ min: 1n << 22n, max: (1n << 63n) - 1n }).map(String);
const guildOf = (id: string) => Object.assign(Object.create(Guild.prototype), { id }) as Guild;

describe('extractGuildId', () => {
  it('reads every payload shape that carries a guild', () => {
    fc.assert(fc.property(snowflake, id => {
      const shapes: unknown[][] = [
        [{ guildId: id }],
        [{ guild: { id } }],
        [{ message: { guildId: id } }, { id: '13' }],
        [{ thread: { guildId: id } }],
        [{ poll: { message: { guildId: id } } }, '13'],
        [{ poll: { message: null, channel: { guildId: id } } }, '13'],
        [guildOf(id)],
        [guildOf(id), guildOf(id)],
        [{ id: '13' }, guildOf(id)],
      ];
      for (const args of shapes) expect(extractGuildId(args)).toBe(id);
    }));
  });

  it('reads no id that is not a guild\'s', () => {
    fc.assert(fc.property(snowflake, id => {
      const shapes: unknown[][] = [
        [{ id, guildId: null, guild: null, channelId: id }],
        [{ id, username: 'user' }],
        [{ id, type: 1, recipientId: id }],
        [{ id, poll: { message: { guildId: null }, channel: { guildId: null } } }],
        [{ id }],
        [{ message: { id } }],
        [{ thread: { id } }],
        [id],
        [],
      ];
      for (const args of shapes) expect(extractGuildId(args)).toBeNull();
    }));
  });

  it('keeps the first argument\'s own guild first, as today', () => {
    fc.assert(fc.property(snowflake, snowflake, (a, b) => {
      expect(extractGuildId([{ guildId: a, message: { guildId: b } }])).toBe(a);
      expect(extractGuildId([{ guild: { id: a } }, guildOf(b)])).toBe(a);
    }));
  });
});

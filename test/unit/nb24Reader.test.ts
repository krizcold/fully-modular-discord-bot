import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTICE_TITLE, noticeEmbed, readNewestNotice, readNoticesIn } from '../../src/utils/ownerMessages';
import { DM, FakeOwnerRest } from '../helpers/fakeOwnerRest';

// NB24 section 8 test 1: the reader answers every machine the bot's notices name at the newest generation.

const DATE = '2026-11-05T12:00:00.000Z';
let rest: FakeOwnerRest;

function noticeMessage(generation: number, machine: string, also?: string) {
  const fields = [{ name: 'Machine', value: machine }, { name: 'Generation', value: String(generation) }];
  if (also !== undefined) fields.push({ name: 'Also announced', value: also });
  return { embeds: [{ title: NOTICE_TITLE, timestamp: DATE, fields }] };
}

beforeEach(() => { rest = new FakeOwnerRest(); });
afterEach(() => FakeOwnerRest.reset());

describe('NB24 test 1: the reader', () => {
  it('(a) pins at 3 for A and for B answer both', async () => {
    rest.seed(DM, noticeMessage(3, 'A'), true);
    rest.seed(DM, noticeMessage(3, 'B'), true);
    expect(await readNewestNotice()).toMatchObject({ kind: 'notice', generation: 3, machines: ['A', 'B'] });
  });

  it('(b) A pinned at 3 and B at 3 only among the newest 100 answer both', async () => {
    rest.seed(DM, noticeMessage(3, 'A'), true);
    rest.seed(DM, noticeMessage(3, 'B'));
    const read = await readNewestNotice();
    expect(read).toMatchObject({ kind: 'notice', generation: 3, machine: 'A', machines: ['A', 'B'] });
  });

  it('(c) A at 4, B and C at 3 answer A alone', async () => {
    rest.seed(DM, noticeMessage(3, 'B'), true);
    rest.seed(DM, noticeMessage(3, 'C'));
    rest.seed(DM, noticeMessage(4, 'A'));
    expect(await readNewestNotice()).toMatchObject({ kind: 'notice', generation: 4, machine: 'A', machines: ['A'] });
  });

  it('(d) one message in both the pins and the newest 100 is counted once', async () => {
    rest.seed(DM, noticeMessage(3, 'A'), true);
    expect(await readNewestNotice()).toEqual({ kind: 'notice', generation: 3, machine: 'A', date: DATE, machines: ['A'] });
  });

  it('(e) readNoticesIn answers found with every notice once', async () => {
    const a = rest.seed(DM, noticeMessage(3, 'A'), true);
    const b = rest.seed(DM, noticeMessage(2, 'B'));
    rest.seed(DM, { content: 'not a notice' });
    const read = await readNoticesIn({ kind: 'dm' }, Date.now() + 5_000);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.found.map(n => [n.messageId, n.generation, n.machine, n.pinned]).sort()).toEqual([
      [a.id, 3, 'A', true], [b.id, 2, 'B', false],
    ].sort());
  });

  it('(f) a tie embed reads tie true with its machine and generation; an ordinary one tie false', async () => {
    rest.seed(DM, { embeds: [noticeEmbed({ machine: 'A', generation: 3, date: DATE }, ['B'])] }, true);
    rest.seed(DM, { embeds: [noticeEmbed({ machine: 'C', generation: 2, date: DATE })] });
    const read = await readNoticesIn({ kind: 'dm' }, Date.now() + 5_000);
    if (!read.ok) throw new Error('read failed');
    const tie = read.found.find(n => n.machine === 'A')!;
    expect(tie).toMatchObject({ generation: 3, machine: 'A', tie: true, also: ['B'] });
    expect(read.found.find(n => n.machine === 'C')).toMatchObject({ tie: false, also: [] });
  });

  it("(g) only A's tie notice in view, its Also announced on two lines, answers every machine it names", async () => {
    rest.seed(DM, noticeMessage(3, 'A', 'B, east and C\nD'), true);
    expect(await readNewestNotice()).toMatchObject({ kind: 'notice', generation: 3, machine: 'A', machines: ['A', 'B, east and C', 'D'] });
  });

  it('(h) the tie embed with 20 other machines of 64 characters keeps the field within 1024 characters, on whole names', () => {
    const others = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')}${'m'.repeat(62)}`);
    const embed = noticeEmbed({ machine: 'A', generation: 3, date: DATE }, others);
    const field = embed.fields.find(f => f.name === 'Also announced')!;
    expect(field.value.length).toBeLessThanOrEqual(1024);
    const lines = field.value.split('\n');
    expect(lines.length).toBe(15);
    for (const line of lines) expect(others).toContain(line);
    expect(lines).toEqual([...others].sort().slice(0, 15));
    const listed = `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
    expect(embed.description).toBe(`A also announced itself as the main database of this bot at generation 3, since ${DATE}, while ${listed} announced the same generation. The bot stops on every machine that reads these notices, until the owner presses Keep this machine as the main in one machine's Bot Manager and rejoins the others as copies.`);
    for (const name of others.filter(n => !lines.includes(n))) expect(embed.description).not.toContain(name);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetOwnerMessages,
  _setOwnerRestFactory,
  ALSO_FIELD,
  machineList,
  NOTICE_TITLE,
  noticeEmbed,
  postInPlace,
} from '../../src/utils/ownerMessages';

const BOT = '200000000000000001';
const OWNER = '300000000000000001';
const DM = '400000000000000001';
const NOTICE = { machine: 'node-a', generation: 7, date: '2026-11-16T01:00:00.000Z' };

afterEach(() => {
  _setOwnerRestFactory(null);
  _resetOwnerMessages();
});

function restAnswering(message: unknown) {
  _resetOwnerMessages();
  _setOwnerRestFactory(() => ({
    get: async (route: string) => {
      if (route === '/applications/@me') return { owner: { id: OWNER }, bot: { id: BOT } };
      throw new Error(`no route ${route}`);
    },
    post: async (route: string) => {
      if (route === '/users/@me/channels') return { id: DM };
      if (route === `/channels/${DM}/messages`) return message;
      throw new Error(`no route ${route}`);
    },
    put: async () => undefined,
    delete: async () => undefined,
  }));
}

const fieldOf = (embed: ReturnType<typeof noticeEmbed>) => embed.fields.find(f => f.name === ALSO_FIELD)?.value;
const named = (prefix: string, length: number) => prefix + 'x'.repeat(length - prefix.length);

describe('sa5: machine lists in the switch notices', () => {
  it('joins no machines as an empty text', () => {
    expect(machineList([])).toBe('');
    expect(machineList(['node-a'])).toBe('node-a');
  });

  it('builds the plain notice, with no Also announced field, for an empty list of other machines', () => {
    expect(noticeEmbed(NOTICE, [])).toEqual(noticeEmbed(NOTICE));
    expect(fieldOf(noticeEmbed(NOTICE, []))).toBeUndefined();
  });

  it('fits two machines whose names and separator fill the field to exactly 1024 characters', () => {
    const first = named('a', 500);
    const second = named('b', 523);
    const embed = noticeEmbed(NOTICE, [second, first]);
    expect(fieldOf(embed)).toBe(`${first}\n${second}`);
    expect(fieldOf(embed)!.length).toBe(1024);
    expect(embed.description).toContain(`while ${first} and ${second} announced the same generation`);
  });

  it('leaves out the third machine when the names and their two separators come to 1025 characters', () => {
    const first = named('a', 400);
    const second = named('b', 400);
    const third = named('c', 223);
    const embed = noticeEmbed(NOTICE, [third, second, first]);
    expect(fieldOf(embed)).toBe(`${first}\n${second}`);
    expect(embed.description).toContain(`while ${first} and ${second} announced the same generation`);
  });
});

describe('sa5: a tie notice read back from Discord', () => {
  it('reads the Also announced machines without the empty lines between them', async () => {
    restAnswering({
      id: '500000000000000001',
      channel_id: DM,
      author: { id: BOT },
      embeds: [{
        title: NOTICE_TITLE,
        timestamp: NOTICE.date,
        fields: [
          { name: 'Machine', value: 'node-a' },
          { name: 'Generation', value: '7' },
          { name: ALSO_FIELD, value: 'node-b\n\nnode-c\n' },
        ],
      }],
    });
    const answer = await postInPlace({ kind: 'dm' }, { content: 'x' }, 'nonce-sa5', Date.now() + 5000);
    expect(answer).toMatchObject({ ok: true, channelId: DM, askedChannel: DM });
    expect(answer.ok && answer.notice).toEqual({ generation: 7, machine: 'node-a', date: NOTICE.date, tie: true, also: ['node-b', 'node-c'] });
  });
});

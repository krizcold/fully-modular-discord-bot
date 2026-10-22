import fs from 'fs';
import path from 'path';
import { ComponentType, ContainerBuilder, InteractionCallbackResponse, ModalBuilder, TextDisplayBuilder } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmWrite, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { ledgerOf, openLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { ACK_MS, installReplyGate, truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import {
  EPHEMERAL, fakeMessage, notReadyGuild, rawButton, rawCommand, rig, storeGuild, textOf, tick, unknownMessage, V2, type WireCall,
} from '../helpers/gateRig';

// The BT1 close rows the touched-line mutation gate asked for: each tells apart a mutant of the reply gate's truth
// placement that the rule's table (replyGate.test.ts) let through.

afterEach(() => {
  vi.useRealTimers();
});

const row = { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 1, label: 'Vote', custom_id: 'vote' }] };
const TRUTH = truthText('not-ready', false);
const refuse = (doc = 'x.json') => saveDataOutcome(doc, notReadyGuild(), { v: 1 });
const isTruthPost = (c: WireCall) => c.method === 'post' && !c.route.includes('/callback') && textOf(c) === TRUTH;
const patches = (wire: WireCall[]) => wire.filter(c => c.method === 'patch');

type Rest = Record<'post' | 'get', (route: string, options?: any) => Promise<unknown>>;

/** Each followUp answers with the next id from 701 on. */
const followUpIds = (client: any) => {
  const rest = client.rest as Rest;
  const post = rest.post;
  let next = 700;
  rest.post = async (route, options = {}) => {
    const sent = await post(route, options);
    if (route.includes('/callback')) return sent;
    return { ...(sent as object), id: String(++next) };
  };
};

/** A fetch or an edit by id answers with that id. */
const fetchesById = (client: any) => {
  const rest = client.rest as Record<'get' | 'patch', (route: string, options?: any) => Promise<unknown>>;
  for (const method of ['get', 'patch'] as const) {
    const call = rest[method];
    rest[method] = async (route, options = {}) => {
      const sent = await call(route, options);
      const id = /\/messages\/(\d+)$/.exec(route)?.[1];
      return id ? { ...(sent as object), id } : sent;
    };
  }
};

/** Discord's callback response for a withResponse call, naming message 700, loading and public. */
const callbackResponses = (client: any, message: boolean) => {
  const rest = client.rest as Rest;
  const post = rest.post;
  rest.post = async (route, options = {}) => {
    const sent = await post(route, options);
    if (!route.includes('/callback')) return sent;
    if (!String(options.query ?? '').includes('with_response=true')) return sent;
    return {
      interaction: { id: '1', type: 2, activity_instance_id: null, response_message_id: '700', response_message_loading: true, response_message_ephemeral: false },
      resource: { type: options.body.type, ...(message && { message: { ...fakeMessage } }) },
    };
  };
};

describe('the original, as the calls named it', () => {
  it('an edit naming its message as null edits the original: an ephemeral reply takes the truth in place', async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('m1'), async i => {
      await i.reply({ content: 'M', flags: EPHEMERAL });
      refuse();
      await i.editReply({ message: null, content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(wire.at(-1)!.method).toBe('patch');
    expect(wire.at(-1)!.route).toContain('/messages/%40original');
    expect(textOf(wire.at(-1)!)).toBe(TRUTH);
  });

  it("a withResponse reply's message id names the original: an edit by that id takes the truth in place", async () => {
    const { wire, client, emit } = rig();
    callbackResponses(client, true);
    const { error } = await emit(rawCommand('m2'), async i => {
      await i.reply({ content: 'M', flags: EPHEMERAL, withResponse: true });
      refuse();
      await i.editReply({ message: '700', content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(patches(wire).map(c => [c.route.split('/').at(-1), textOf(c)])).toEqual([['700', TRUTH]]);
  });

  it("an ok update of an ephemeral component message makes it the original the member alone sees", async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawButton('m3', EPHEMERAL), async i => {
      await i.update({ content: 'M' });
      refuse();
      await i.editReply({ content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(patches(wire).map(c => [c.route.split('/').at(-1), textOf(c)])).toEqual([['%40original', TRUTH]]);
  });

  it("a followUp whose text is the original's id leaves the original as it was: the truth still goes in place", async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('m4'), async i => {
      await i.reply({ content: 'M', flags: EPHEMERAL, fetchReply: true });
      await i.followUp('700');
      refuse();
      await i.editReply({ content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(patches(wire).map(c => [c.route.split('/').at(-1), textOf(c)])).toEqual([['%40original', TRUTH]]);
  });

  it('after the module deleted its public reply, a refused edit edits nothing', async () => {
    const { wire, emit } = rig();
    await emit(rawCommand('m5'), async i => {
      await i.reply({ content: 'Poll', components: [row] });
      await i.deleteReply();
      refuse();
      await i.editReply({ content: 'P' }).catch(() => undefined);
    });
    expect(patches(wire)).toEqual([]);
    expect(wire.filter(isTruthPost)).toHaveLength(1);
  });

  it('after a modal, the gate knows no original: a refused edit edits nothing and a refused followUp deletes nothing', async () => {
    const { wire, emit } = rig();
    const modal = new ModalBuilder().setCustomId('m').setTitle('M').addComponents({
      type: ComponentType.ActionRow, components: [{ type: ComponentType.TextInput, custom_id: 't', style: 1, label: 'T' }],
    } as never);
    let before = 0;
    const { error } = await emit(rawButton('m6'), async i => {
      await i.showModal(modal);
      before = wire.length;
      refuse();
      await i.editReply({ content: 'P' });
      refuse('y.json');
      await i.followUp({ content: 'S' });
    });
    expect(error).toBeUndefined();
    expect(wire.slice(before).map(c => c.method)).toEqual(['post', 'get', 'post']);
    expect(wire.slice(before).filter(isTruthPost)).toHaveLength(2);
  });

  it("a fetchReply of the original shows its id: an edit by that id takes the truth in place", async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('m7'), async i => {
      await i.reply({ content: 'M', flags: EPHEMERAL });
      await i.fetchReply();
      refuse();
      await i.editReply({ message: '700', content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(patches(wire).map(c => [c.route.split('/').at(-1), textOf(c)])).toEqual([['700', TRUTH]]);
  });

  it('a fetchReply of another message does not make it the original: a refused edit of it leaves it', async () => {
    const { wire, client, emit } = rig();
    fetchesById(client);
    const { error } = await emit(rawCommand('m8'), async i => {
      await i.reply({ content: 'M', flags: EPHEMERAL });
      await i.fetchReply('702');
      refuse();
      await i.editReply({ message: '702', content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(patches(wire)).toEqual([]);
    expect(wire.filter(isTruthPost)).toHaveLength(1);
  });

  it('a fetchReply by the original\'s id reads that message, not the default original', async () => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand('m9'), async i => {
      await i.reply({ content: 'M', flags: EPHEMERAL, fetchReply: true });
      await i.fetchReply('700');
    });
    expect(error).toBeUndefined();
    expect(wire.at(-1)!.method).toBe('get');
    expect(wire.at(-1)!.route).toMatch(/\/messages\/700$/);
  });

  it('an object with no fetchReply is given none', () => {
    const target: Record<string, unknown> = { reply: async () => undefined };
    installReplyGate(target, openLedger('interaction'));
    expect('fetchReply' in target).toBe(false);
  });
});

describe('the stand-in', () => {
  it('a refused edit naming another message, while a stand-in holds the truth, leaves that message', async () => {
    const { wire, client, emit } = rig();
    followUpIds(client);
    await emit(rawCommand('s1'), async i => {
      await i.deferReply();
      refuse();
      await i.editReply({ content: 'Saved!' });
      refuse('y.json');
      await i.editReply({ message: '999', content: 'P' });
    });
    expect(wire.filter(c => c.route.includes('/messages/999') && c.method === 'patch')).toEqual([]);
    expect(wire.filter(isTruthPost)).toHaveLength(2);
  });

  it('the stand-in read or edited never becomes the original: once a second stand-in replaced it, an edit of it leaves the new one', async () => {
    const { wire, client, control, emit } = rig();
    followUpIds(client);
    fetchesById(client);
    await emit(rawCommand('s2'), async i => {
      await i.deferReply();
      refuse();
      await i.editReply({ content: 'Saved!' });
      refuse('y.json');
      await i.editReply({ content: 'Again' });
      await i.fetchReply();
      control.onSend = call => {
        if (call.route.includes('/messages/701')) throw unknownMessage(call.method, call.route);
      };
      refuse('z.json');
      await i.editReply({ content: 'Again 2' });
      refuse('w.json');
      await i.editReply({ message: '701', content: 'P' }).catch(() => undefined);
    });
    expect(wire.filter(c => c.method === 'patch' && c.route.includes('/messages/702'))).toEqual([]);
    expect(wire.filter(isTruthPost)).toHaveLength(3);
  });

  it("the stand-in's truth is plain text, whatever the deleted deferral was", async () => {
    const { wire, client, emit } = rig();
    followUpIds(client);
    await emit(rawCommand('s3'), async i => {
      await i.deferReply();
      refuse();
      await i.editReply({ content: 'Saved!' });
      refuse('y.json');
      await i.editReply({ content: 'Again' });
    });
    expect(wire.at(-1)!.method).toBe('patch');
    expect(wire.at(-1)!.route).toContain('/messages/701');
    expect(wire.at(-1)!.body.content).toBe(TRUTH);
    expect((wire.at(-1)!.body.flags ?? 0) & V2).toBe(0);
  });

  it('a later truth by followUp while a stand-in holds does not replace it: an edit of the original still edits the first', async () => {
    const { wire, client, emit } = rig();
    followUpIds(client);
    await emit(rawCommand('s4'), async i => {
      await i.deferReply();
      refuse();
      await i.editReply({ content: 'Saved!' });
      refuse('y.json');
      await i.followUp({ content: 'S' });
      refuse('z.json');
      await i.editReply({ content: 'E' });
    });
    expect(wire.at(-1)!.method).toBe('patch');
    expect(wire.at(-1)!.route).toMatch(/\/messages\/701$/);
  });

  it('a truth by followUp with no deferral deleted stands in for nothing: an edit of the original edits the original', async () => {
    const { wire, client, emit } = rig();
    followUpIds(client);
    await emit(rawCommand('s5'), async i => {
      await i.deferReply({ flags: EPHEMERAL });
      refuse();
      await i.followUp({ content: 'S' });
      refuse('y.json');
      await i.editReply({ content: 'E' });
    });
    expect(wire.at(-1)!.method).toBe('patch');
    expect(wire.at(-1)!.route).toMatch(/\/messages\/%40original$/);
  });

  it('while a stand-in holds, a followUp is still sent and a delete of another message still goes out', async () => {
    const { wire, client, emit } = rig();
    followUpIds(client);
    let before = 0;
    await emit(rawCommand('s7'), async i => {
      await i.deferReply();
      refuse();
      await i.editReply({ content: 'Saved!' });
      before = wire.length;
      refuse('y.json');
      await i.followUp('701');
      await i.deleteReply('999');
    });
    const after = wire.slice(before);
    expect(after.filter(isTruthPost)).toHaveLength(1);
    expect(after.filter(c => c.method === 'delete').map(c => c.route.split('/').at(-1))).toEqual(['999']);
  });
});

describe('a deferral read back before the delete', () => {
  const fills: Array<[string, object]> = [
    ['an embed', { embeds: [{ description: 'Poll' }] }],
    ['components', { components: [row] }],
    ['an attachment', { files: [{ attachment: Buffer.from('x'), name: 'a.txt' }] }],
  ];
  it.each(fills)('a deferral filled around the gate with %s alone is left', async (_fill, fill) => {
    const { wire, emit } = rig();
    const { error } = await emit(rawCommand(`d1-${_fill.length}`), async i => {
      await i.deferReply();
      await i.webhook.editMessage('@original', fill);
      refuse();
      await i.editReply({ content: 'P' });
    });
    expect(error).toBeUndefined();
    expect(wire.some(c => c.method === 'delete')).toBe(false);
    expect(wire.filter(isTruthPost)).toHaveLength(1);
  });

  it('a deferral read back filled is not read back again before a later truth', async () => {
    const { wire, emit } = rig();
    let before = 0;
    await emit(rawCommand('d2'), async i => {
      await i.deferReply();
      await i.webhook.editMessage('@original', { content: 'Poll' });
      before = wire.length;
      refuse();
      await i.editReply({ content: 'P' });
      refuse('y.json');
      await i.editReply({ content: 'P2' });
    });
    expect(wire.slice(before).map(c => c.method)).toEqual(['get', 'post', 'get', 'post', 'get']);
  });

  it('a delete that fails otherwise than Unknown Message rejects the call, and no truth goes out', async () => {
    const { wire, control, emit } = rig();
    control.onSend = call => {
      if (call.method === 'delete') throw new Error('Discord 500');
    };
    let failed: unknown;
    await emit(rawCommand('d3'), async i => {
      await i.deferReply();
      refuse();
      failed = await i.editReply({ content: 'P' }).then(() => 'resolved', (error: Error) => error.message);
    });
    expect(failed).toBe('Discord 500');
    expect(wire.filter(isTruthPost)).toEqual([]);
  });
});

describe('a truth whose send failed', () => {
  it('an in-place update answered Unknown Message rejects the call, and nothing else goes out', async () => {
    const { wire, control, emit } = rig();
    let armed = true;
    control.onSend = call => {
      if (armed && call.route.includes('/callback')) {
        armed = false;
        throw unknownMessage(call.method, call.route);
      }
    };
    let failed: unknown;
    await emit(rawButton('f1', EPHEMERAL), async i => {
      refuse();
      failed = await i.update({ content: 'P' }).then(() => 'resolved', (error: { code?: number }) => error.code);
    });
    expect(failed).toBe(10008);
    expect(wire).toEqual([]);
  });

  it('an in-place edit answered otherwise than Unknown Message rejects the call, and no followUp goes out', async () => {
    const { wire, control, emit } = rig();
    let failed: unknown;
    await emit(rawCommand('f2'), async i => {
      await i.reply({ content: 'M', flags: EPHEMERAL });
      control.onSend = call => {
        if (call.method === 'patch') throw new Error('Discord 500');
      };
      refuse();
      failed = await i.editReply({ content: 'P' }).then(() => 'resolved', (error: Error) => error.message);
    });
    expect(failed).toBe('Discord 500');
    expect(wire.filter(isTruthPost)).toEqual([]);
  });

  it('a dismissed ephemeral reply is not edited again, nor read back, by a later truth', async () => {
    const { wire, control, emit } = rig();
    let tries = 0;
    let before = 0;
    const { error } = await emit(rawCommand('f3'), async i => {
      await i.reply({ content: 'Working...', flags: EPHEMERAL });
      control.onSend = call => {
        if (call.method === 'patch' && call.route.endsWith('/messages/%40original')) {
          tries += 1;
          throw unknownMessage(call.method, call.route);
        }
      };
      before = wire.length;
      refuse();
      await i.editReply({ content: 'Saved!' });
      refuse('y.json');
      await i.editReply({ content: 'Saved again!' });
    });
    expect(error).toBeUndefined();
    expect(tries).toBe(1);
    expect(wire.slice(before).map(c => [c.method, textOf(c)])).toEqual([['post', TRUTH], ['post', TRUTH], ['get', undefined]]);
  });

  it('a followUp answered Unknown Message with no deferral deleted is told again on the next call, and not logged', async () => {
    const { wire, control, emit } = rig();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let before = 0;
    await emit(rawCommand('f4'), async i => {
      await i.reply({ content: 'Poll', components: [row] });
      let armed = true;
      control.onSend = call => {
        if (armed && call.method === 'post' && !call.route.includes('/callback')) {
          armed = false;
          throw unknownMessage(call.method, call.route);
        }
      };
      before = wire.length;
      refuse();
      await i.followUp({ content: 'S' }).catch(() => undefined);
      await i.followUp({ content: 'S' });
    });
    const logged = warn.mock.calls.some(([line]) => String(line).startsWith("[Truth] Discord refused the truth's followUp"));
    warn.mockRestore();
    expect(logged).toBe(false);
    expect(wire.slice(before).filter(isTruthPost)).toHaveLength(1);
  });

  it('a followUp answered Unknown Message while a stand-in holds is told again on the next call, and not logged', async () => {
    const { wire, client, control, emit } = rig();
    followUpIds(client);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let before = 0;
    await emit(rawCommand('f5'), async i => {
      await i.deferReply();
      refuse();
      await i.editReply({ content: 'Saved!' });
      let armed = true;
      control.onSend = call => {
        if (armed && call.method === 'post' && !call.route.includes('/callback')) {
          armed = false;
          throw unknownMessage(call.method, call.route);
        }
      };
      before = wire.length;
      refuse('y.json');
      await i.followUp({ content: 'S' }).catch(() => undefined);
      await i.followUp({ content: 'S' });
    });
    const logged = warn.mock.calls.some(([line]) => String(line).startsWith("[Truth] Discord refused the truth's followUp"));
    warn.mockRestore();
    expect(logged).toBe(false);
    expect(wire.slice(before).filter(isTruthPost)).toHaveLength(1);
  });
});

describe('the truth payloads and responses', () => {
  it('a V2 truth edit clears the attachments', async () => {
    const { wire, emit } = rig();
    const view = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('M'));
    await emit(rawCommand('r1'), async i => {
      await i.reply({ components: [view], flags: EPHEMERAL | V2 });
      refuse();
      await i.editReply({ content: 'P' });
    });
    const truth = patches(wire)[0];
    expect(textOf(truth)).toBe(TRUTH);
    expect(truth.body.attachments).toEqual([]);
  });

  it("a refused withResponse update resolves with Discord's own callback response, its message left as Discord named it", async () => {
    const { client, emit } = rig();
    callbackResponses(client, false);
    let result: any;
    const { error } = await emit(rawButton('r2'), async i => {
      refuse();
      result = await i.update({ content: 'Saved view', withResponse: true });
    });
    expect(error).toBeUndefined();
    expect(result).toBeInstanceOf(InteractionCallbackResponse);
    expect(result.interaction.responseMessageEphemeral).toBe(false);
    expect(result.interaction.responseMessageLoading).toBe(true);
  });

  it("the gate's own public deferral, edited to an ok payload for a withResponse reply, keeps Discord's interaction fields", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { client, emit } = rig();
    callbackResponses(client, false);
    const { store, options } = await storeGuild();
    store.holding = true;
    let result: any;
    const done = emit(rawCommand('r3'), async i => {
      saveData('x.json', options, { v: 1 });
      vi.advanceTimersByTime(ACK_MS + 100);
      result = await i.reply({ content: 'Saved!', withResponse: true });
    });
    await tick(20);
    store.release();
    const { error } = await done;
    expect(error).toBeUndefined();
    expect(result?.resource?.message?.id).toBe('700');
    expect(result?.interaction?.responseMessageEphemeral).toBe(false);
    expect(result?.interaction?.responseMessageLoading).toBe(true);
  });

  it("the stand-in for the gate's own deleted deferral is named in the response as no longer loading", async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { client, emit } = rig();
    followUpIds(client);
    callbackResponses(client, true);
    const { store, options } = await storeGuild();
    store.holding = true;
    let result: any;
    const done = emit(rawCommand('r4'), async i => {
      saveData('x.json', options, { v: 1 });
      void confirmWrite(ledgerOf(i)!.tickets()[0].ticket, 60_000);
      vi.advanceTimersByTime(ACK_MS + 100);
      const replied = i.reply({ content: 'Poll', withResponse: true });
      await tick(30);
      vi.advanceTimersByTime(10_000);
      result = await replied;
    });
    const { error } = await done;
    store.release();
    expect(error).toBeUndefined();
    expect(result?.interaction?.responseMessageId).toBe('701');
    expect(result?.interaction?.responseMessageLoading).toBe(false);
  });
});

describe('the shutdown handler in the bot', () => {
  it.skipIf(process.env.__STRYKER_ACTIVE_MUTANT__ !== undefined)('its steps close the gateway, flush the totals, drain the writes and exit (clientInitializer.ts)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/bot/internalSetup/clientInitializer.ts'), 'utf8');
    const steps = /const shutdownHandler = stopHandler\(async \(\) => \{([\s\S]*?)\n {2}\}\);/.exec(source)?.[1] ?? '';
    for (const step of ['stopSamplers();', "getIngestService().close('shutting down')", 'metrics.flushTotals();', 'await drainForExit(drainMs);', 'process.exit(0);']) {
      expect(steps).toContain(step);
    }
  });
});

import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { Client, Events, InteractionCollector, InteractionType, type BaseInteraction } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { dropPendingForGuild, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import { DataBackendUnavailableError, initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import {
  appendData,
  appendDataTracked,
  confirmWrite,
  deleteData,
  deleteDataOutcome,
  deleteDataTracked,
  deleteRawAtomic,
  freezeGuildWrites,
  saveData,
  saveDataOutcome,
  saveDataTracked,
  unfreezeGuildWrites,
  writeRawAtomic,
  type WriteTicket,
} from '../../src/bot/internalSetup/utils/dataManager';
import {
  currentLedger,
  INTERACTION_LEDGER_LIFE_MS,
  installInteractionLedgers,
  ledgerOf,
  openLedger,
  runInLedger,
  runSealed,
  withModule,
  type WriteLedger,
} from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { instrument } from '../../src/bot/internalSetup/utils/metrics/instrument';
import { getMetricsCollector } from '../../src/bot/internalSetup/utils/metrics/metricsCollector';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// BT-2, the write ledger (notes/BT.md, "BT-2 design sheet (L0), final"). Every
// write the facade accepts or refuses while an entry's handlers run is recorded
// in that entry's ledger, with its module; nothing else is, and recording
// changes no answer.

const DATA = process.env.DATA_DIR!;
const file = (guildId: string, name: string) => path.join(DATA, guildId, 'm', name);

let guilds = 9600;
const freshGuild = () => String(++guilds);

/** Each entry as [where, sorted modules]: a file path's basename, or ws:<guild> for a working set. */
function shape(ledger: WriteLedger): Array<[string, string[]]> {
  return ledger.tickets()
    .map(({ ticket, modules }): [string, string[]] => [ticket.kind === 'file' ? path.basename(ticket.path) : `ws:${ticket.guildId}`, [...modules].sort()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const causes = (ledger: WriteLedger) => ledger.refusals().map(({ cause, modules }) => [cause, [...modules].sort()]);

// The first facade call in a process builds the metrics collector (the boot
// does it in production); made here outside every ledger.
beforeAll(async () => {
  saveData('warmup.json', { scope: 'global', category: 'bt2' }, {});
  await flushAll();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a ledger records the facade writes made inside its entry: file mode', () => {
  it('records accepted saves, appends and deletes as tickets, one per landing record, with every module that wrote', async () => {
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    const answers = runInLedger(ledger, 'modA', () => [
      saveDataOutcome('a.json', options, { v: 1 }),
      withModule('modB', () => saveDataOutcome('a.json', options, { v: 2 })),
      appendData('log.jsonl', options, 'x\n'),
      saveDataOutcome('b.json', options, { v: 1 }),
      deleteDataOutcome('b.json', options),
    ]);
    expect(answers).toEqual(['saved', 'saved', true, 'saved', 'deleted']);
    expect(shape(ledger)).toEqual([['a.json', ['modA', 'modB']], ['b.json', ['modA']], ['log.jsonl', ['modA']]]);
    for (const { ticket } of ledger.tickets()) expect(await confirmWrite(ticket, 5000)).toBe('ok');
    expect(JSON.parse(fs.readFileSync(file(guildId, 'a.json'), 'utf8'))).toEqual({ v: 2 });
    expect(fs.existsSync(file(guildId, 'b.json'))).toBe(false);
  });

  it('keeps the latest ticket of a landing record', () => {
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    const tickets = runInLedger(ledger, 'modA', () => [1, 2, 3].map(v => saveDataTracked('a.json', options, { v })));
    const last = tickets[2];
    if (last.outcome !== 'saved') throw new Error(`not accepted: ${last.outcome}`);
    expect(ledger.tickets().map(e => e.ticket)).toEqual([last.ticket]);
  });

  it('records a frozen guild as the cause frozen, and an I/O refusal as io, with their modules', () => {
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    freezeGuildWrites(guildId);
    try {
      runInLedger(ledger, 'modA', () => {
        expect(saveData('a.json', options, { v: 1 })).toBe(false);
        expect(appendData('log.jsonl', options, 'x\n')).toBe(false);
        expect(withModule('modB', () => deleteData('a.json', options))).toBe(false);
      });
    } finally {
      unfreezeGuildWrites(guildId);
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    runInLedger(ledger, 'modC', () => expect(saveDataOutcome('c.json', options, circular)).toBe('refused'));
    expect(ledger.tickets()).toEqual([]);
    expect(causes(ledger)).toEqual([['frozen', ['modA', 'modB']], ['io', ['modC']]]);
  });

  it('records nothing for a delete that finds nothing, and the earlier delete\'s ticket for one still queued', async () => {
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    // Never on disk: the queued write becomes a queued delete, which a second delete finds.
    expect(saveData('x.json', options, { v: 1 })).toBe(true);
    expect(deleteData('x.json', options)).toBe(true);
    const ledger = openLedger('interaction');
    const tracked = runInLedger(ledger, 'modA', () => {
      expect(deleteDataOutcome('never.json', options)).toBe('absent');
      return deleteDataTracked('x.json', options);
    });
    if (tracked.outcome !== 'absent' || !tracked.ticket) throw new Error(`the queued delete took no ticket: ${JSON.stringify(tracked)}`);
    expect(ledger.tickets().map(e => e.ticket)).toEqual([tracked.ticket]);
    await flushAll();
    const after = openLedger('interaction');
    runInLedger(after, 'modA', () => expect(deleteDataTracked('x.json', options)).toEqual({ outcome: 'absent' }));
    expect(after.tickets()).toEqual([]);
  });

  it('records the raw paths: an accepted write or delete its ticket, a delete finding a queued delete that ticket, one finding nothing nothing', async () => {
    const raw = path.join(DATA, `_bt2raw_${freshGuild()}`, 'r.json');
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    const first = openLedger('panel');
    runInLedger(first, 'modA', () => expect(writeRawAtomic(raw, '{"v":1}')).toBe(true));
    expect(shape(first)).toEqual([['r.json', ['modA']]]);
    expect(await confirmWrite(first.tickets()[0].ticket, 5000)).toBe('ok');
    runInLedger(first, 'modA', () => expect(deleteRawAtomic(raw)).toBe(true));
    // The write landed, so its entry gave way to the delete's.
    expect(shape(first)).toEqual([['r.json', ['modA']]]);
    expect(await confirmWrite(first.tickets()[0].ticket, 5000)).toBe('ok');
    // Never on disk: a queued write becomes a queued delete, which a second delete finds.
    const unwritten = path.join(path.dirname(raw), 'u.json');
    expect(writeRawAtomic(unwritten, '{}')).toBe(true);
    expect(deleteRawAtomic(unwritten)).toBe(true);
    const second = openLedger('panel');
    runInLedger(second, 'modB', () => expect(deleteRawAtomic(unwritten)).toBe(false));
    expect(shape(second)).toEqual([['u.json', ['modB']]]);
    const queuedDelete = second.tickets()[0].ticket;
    expect(await confirmWrite(queuedDelete, 5000)).toBe('ok');
    const third = openLedger('panel');
    runInLedger(third, 'modB', () => {
      expect(deleteRawAtomic(unwritten)).toBe(false);
      expect(deleteRawAtomic(raw)).toBe(false);
    });
    expect(third.tickets()).toEqual([]);
    expect(third.refusals()).toEqual([]);
  });

  it('keeps a dropped write and the rewrite of its path as two entries, and drops an entry that landed when its path is written again', async () => {
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    runInLedger(ledger, 'modA', () => {
      expect(saveData('x.json', options, { v: 1 })).toBe(true);
      expect(appendData('log.jsonl', options, 'one\n')).toBe(true);
    });
    dropPendingForGuild(guildId);
    runInLedger(ledger, 'modA', () => {
      expect(saveData('x.json', options, { v: 2 })).toBe(true);
      expect(appendData('log.jsonl', options, 'two\n')).toBe(true);
    });
    expect(shape(ledger).map(([where]) => where)).toEqual(['log.jsonl', 'log.jsonl', 'x.json', 'x.json']);
    const answers = await Promise.all(ledger.tickets().map(e => confirmWrite(e.ticket, 5000)));
    expect(answers.sort()).toEqual(['ok', 'ok', 'unavailable', 'unavailable']);
    runInLedger(ledger, 'modA', () => expect(saveData('x.json', options, { v: 3 })).toBe(true));
    const x = ledger.tickets().filter(e => e.ticket.kind === 'file' && path.basename(e.ticket.path) === 'x.json');
    expect(x).toHaveLength(2);
    expect((await Promise.all(x.map(e => confirmWrite(e.ticket, 5000)))).sort()).toEqual(['ok', 'unavailable']);
  });
});

describe('a ledger records the facade writes made inside its entry: the working set', () => {
  it('records saves, appends and deletes as one ticket per set, a set not ready as not-ready, and a throw\'s cause before it is thrown', async () => {
    vi.useFakeTimers();
    const guildId = freshGuild();
    const notReady = freshGuild();
    setRouteOverride(guildId, 'postgres');
    setRouteOverride(notReady, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    runInLedger(ledger, 'modA', () => {
      expect(saveData('x.json', options, { v: 1 })).toBe(true);
      expect(withModule('modB', () => appendData('log.jsonl', options, 'x\n'))).toBe(true);
      expect(deleteData('x.json', options)).toBe(true);
      expect(saveDataOutcome('y.json', { guildId: notReady, category: 'm' }, { v: 1 })).toBe('refused');
    });
    expect(shape(ledger)).toEqual([[`ws:${guildId}`, ['modA', 'modB']]]);
    expect(causes(ledger)).toEqual([['not-ready', ['modA']]]);
    store.mode = 'deposed';
    await vi.advanceTimersByTimeAsync(600);
    expect(await confirmWrite(ledger.tickets()[0].ticket, 1000)).toBe('deposed');
    runInLedger(ledger, 'modC', () => expect(() => saveData('z.json', options, { v: 1 })).toThrow(DataBackendUnavailableError));
    expect(causes(ledger)).toEqual([['not-ready', ['modA']], ['guild-fenced', ['modC']]]);
  });

  it('keeps a replaced set\'s unlanded entry beside the new set\'s: the lost write answers unavailable', async () => {
    vi.useFakeTimers();
    const guildId = freshGuild();
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    runInLedger(ledger, 'modA', () => expect(saveData('x.json', options, { v: 1 })).toBe(true));
    // Evicted before its debounce flush: x.json never lands.
    ws.evict(guildId);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    runInLedger(ledger, 'modB', () => expect(saveData('y.json', options, { v: 1 })).toBe(true));
    await vi.advanceTimersByTimeAsync(600);
    expect(ledger.tickets()).toHaveLength(2);
    const answers = await Promise.all(ledger.tickets().map(e => confirmWrite(e.ticket, 1000)));
    expect(answers.sort()).toEqual(['ok', 'unavailable']);
  });

  it('keeps one entry per set: a replaced set\'s landed entry gives way to the new set\'s', async () => {
    vi.useFakeTimers();
    const guildId = freshGuild();
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    runInLedger(ledger, 'modA', () => expect(saveData('x.json', options, { v: 1 })).toBe(true));
    await vi.advanceTimersByTimeAsync(600);
    expect(await confirmWrite(ledger.tickets()[0].ticket, 1000)).toBe('ok');
    ws.evict(guildId);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    runInLedger(ledger, 'modA', () => expect(saveData('y.json', options, { v: 1 })).toBe(true));
    const entries = ledger.tickets();
    expect(entries).toHaveLength(1);
    expect(entries[0].ticket.kind === 'ws' && entries[0].ticket.set.landedSeq).toBe(0);
  });

  it('records a delete that finds an earlier delete unlanded with that ticket', async () => {
    vi.useFakeTimers();
    const guildId = freshGuild();
    setRouteOverride(guildId, 'postgres');
    const store = new FakeStore();
    store.docs.set(`${guildId}|m/x.json`, '{"x":1}');
    const ws = initWorkingSet(store);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    const options = { guildId, category: 'm' };
    expect(deleteData('x.json', options)).toBe(true);
    const ledger = openLedger('interaction');
    const tracked = runInLedger(ledger, 'modA', () => deleteDataTracked('x.json', options));
    if (tracked.outcome !== 'absent' || !tracked.ticket) throw new Error(`no ticket for the unlanded delete: ${JSON.stringify(tracked)}`);
    expect(ledger.tickets().map(e => e.ticket)).toEqual([tracked.ticket]);
    await vi.advanceTimersByTimeAsync(600);
    expect(await confirmWrite(tracked.ticket, 1000)).toBe('ok');
  });
});

describe('where a ledger records', () => {
  it('records nothing outside every ledger, and only in the innermost ledger when entries nest', () => {
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    const outer = openLedger('interaction');
    const inner = openLedger('interaction');
    expect(saveData('outside.json', options, { v: 1 })).toBe(true);
    expect(currentLedger()).toBeUndefined();
    runInLedger(outer, 'o', () => {
      saveData('a.json', options, { v: 1 });
      runInLedger(inner, 'i', () => saveData('b.json', options, { v: 1 }));
      saveData('c.json', options, { v: 1 });
    });
    expect(shape(outer)).toEqual([['a.json', ['o']], ['c.json', ['o']]]);
    expect(shape(inner)).toEqual([['b.json', ['i']]]);
  });

  it('tags a write or a refusal with no module in scope with the entry\'s kind', () => {
    const guildId = freshGuild();
    const frozen = freshGuild();
    const ledger = openLedger('console');
    freezeGuildWrites(frozen);
    try {
      runInLedger(ledger, null, () => {
        saveData('a.json', { guildId, category: 'm' }, { v: 1 });
        expect(saveData('a.json', { guildId: frozen, category: 'm' }, { v: 1 })).toBe(false);
      });
    } finally {
      unfreezeGuildWrites(frozen);
    }
    expect(shape(ledger)).toEqual([['a.json', ['console']]]);
    expect(causes(ledger)).toEqual([['frozen', ['console']]]);
  });
});

describe('sealing', () => {
  it('seals an interaction ledger 15 minutes after it opened: it records nothing after, and drops its entries', async () => {
    // Only the clock is faked: fake timers run their callbacks outside the async context they were armed in.
    vi.useFakeTimers({ toFake: ['performance'] });
    expect(INTERACTION_LEDGER_LIFE_MS).toBe(15 * 60 * 1000);
    const guildId = freshGuild();
    const frozen = freshGuild();
    const options = { guildId, category: 'm' };
    const ledger = openLedger('interaction');
    let fire: () => void = () => undefined;
    const armed = new Promise<void>(resolve => { fire = resolve; });
    const timerWrites = runInLedger(ledger, 'modA', () => {
      saveData('a.json', options, { v: 1 });
      const early = new Promise<void>(resolve => setTimeout(() => { saveData('b.json', options, { v: 1 }); resolve(); }, 5));
      const late = armed.then(() => new Promise<void>(resolve => setTimeout(() => {
        saveData('c.json', options, { v: 1 });
        saveData('d.json', { guildId: frozen, category: 'm' }, { v: 1 });
        resolve();
      }, 5)));
      return { early, late };
    });
    await timerWrites.early;
    expect(shape(ledger).map(([where]) => where)).toEqual(['a.json', 'b.json']);
    vi.advanceTimersByTime(INTERACTION_LEDGER_LIFE_MS - 1);
    expect(ledger.sealed).toBe(false);
    vi.advanceTimersByTime(1);
    // A reader past the token's life gets nothing, with or without asking whether it is sealed.
    expect(ledger.tickets()).toEqual([]);
    expect(ledger.sealed).toBe(true);
    expect((ledger as unknown as { entries: Map<object, unknown> }).entries.size).toBe(0);
    freezeGuildWrites(frozen);
    try {
      fire();
      await timerWrites.late;
    } finally {
      unfreezeGuildWrites(frozen);
    }
    expect(ledger.tickets()).toEqual([]);
    expect(ledger.refusals()).toEqual([]);
    // A sealed ledger holds nothing: the late write and the late refusal were never kept.
    const held = ledger as unknown as { entries: Map<object, unknown>; refused: Map<string, unknown> };
    expect(held.entries.size).toBe(0);
    expect(held.refused.size).toBe(0);
  });

  it('seals a panel or console ledger when its run returns or throws, and passes its answer and its throw through', async () => {
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    let seen: WriteLedger | undefined;
    let late: Promise<void> = Promise.resolve();
    const answer = await runSealed('panel', null, 'panelMod', async ledger => {
      seen = ledger;
      expect(currentLedger()).toBe(ledger);
      saveData('a.json', options, { v: 1 });
      expect(shape(ledger)).toEqual([['a.json', ['panelMod']]]);
      late = new Promise<void>(resolve => setTimeout(() => { saveData('late.json', options, { v: 1 }); resolve(); }, 5));
      return 'answer';
    });
    expect(answer).toBe('answer');
    expect(seen!.sealed).toBe(true);
    expect(seen!.tickets()).toEqual([]);
    await late;
    expect(seen!.tickets()).toEqual([]);
    const entry = { id: 'console-entry' };
    let thrown: WriteLedger | undefined;
    await expect(runSealed('console', entry, null, async ledger => {
      thrown = ledger;
      expect(ledgerOf(entry)).toBe(ledger);
      saveData('b.json', options, { v: 1 });
      expect(shape(ledger)).toEqual([['b.json', ['console']]]);
      throw new Error('handler failed');
    })).rejects.toThrow('handler failed');
    expect(thrown!.sealed).toBe(true);
  });
});

describe('the emit wrapper on the gateway Client', () => {
  it('passes every other event through with the same arguments, order and answer, in the context it was emitted in', () => {
    expect(Events.InteractionCreate).toBe('interactionCreate');
    const client = new Client({ intents: [] });
    installInteractionLedgers(client);
    const emit = (event: string, ...args: unknown[]) => (client.emit as unknown as (event: string, ...args: unknown[]) => boolean).call(client, event, ...args);
    const seen: unknown[][] = [];
    client.on('messageCreate', (...args: unknown[]) => { seen.push(['first', ...args]); });
    client.on('messageCreate', (...args: unknown[]) => { seen.push(['second', ...args]); });
    expect(emit('messageCreate', 1, 2)).toBe(true);
    expect(seen).toEqual([['first', 1, 2], ['second', 1, 2]]);
    expect(emit('guildCreate', 'x')).toBe(false);
    const guildId = freshGuild();
    const ledger = openLedger('panel');
    client.on('messageUpdate', () => { saveData('from-event.json', { guildId, category: 'm' }, { v: 1 }); });
    runInLedger(ledger, 'modA', () => emit('messageUpdate', {}, {}));
    expect(shape(ledger)).toEqual([['from-event.json', ['modA']]]);
    client.removeAllListeners();
  });

  it('runs interactionCreate listeners inside a ledger keyed to the interaction, its own even inside another entry', () => {
    const client = new Client({ intents: [] });
    installInteractionLedgers(client);
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    client.on(Events.InteractionCreate, interaction => {
      saveData(`${(interaction as unknown as { id: string }).id}.json`, options, { v: 1 });
    });
    const first = { id: 'first' };
    expect(client.emit(Events.InteractionCreate, first as never)).toBe(true);
    expect(shape(ledgerOf(first)!)).toEqual([['first.json', ['interaction']]]);
    const outer = openLedger('panel');
    const second = { id: 'second' };
    runInLedger(outer, 'modA', () => client.emit(Events.InteractionCreate, second as never));
    expect(shape(ledgerOf(second)!)).toEqual([['second.json', ['interaction']]]);
    expect(outer.tickets()).toEqual([]);
    expect(ledgerOf(first)).not.toBe(ledgerOf(second));
    client.removeAllListeners();
  });

  it('is installed by IngestService.buildClient on the process\'s gateway Client', () => {
    const client = new IngestService().buildClient({ intents: [] });
    const guildId = freshGuild();
    client.on(Events.InteractionCreate, () => { saveData('built.json', { guildId, category: 'm' }, { v: 1 }); });
    const interaction = { id: 'built' };
    client.emit(Events.InteractionCreate, interaction as never);
    expect(shape(ledgerOf(interaction)!)).toEqual([['built.json', ['interaction']]]);
    client.removeAllListeners();
  });

  it('characterization: discord.js\'s own InteractionCreate action, and a collector armed in interaction X, record into the interaction they handle', async () => {
    const client = new Client({ intents: [] });
    installInteractionLedgers(client);
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    const raw = (id: string) => ({
      id,
      application_id: '11',
      type: InteractionType.ApplicationCommand,
      token: `token-${id}`,
      version: 1,
      data: { id: '12', name: 'ping', type: 1 },
      user: { id: '13', username: 'user', discriminator: '0', avatar: null, global_name: null },
      app_permissions: '0',
      locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: {},
      context: 1,
    });
    const handled = new Map<string, BaseInteraction>();
    let collector: InteractionCollector<never> | undefined;
    const collected = new Promise<void>(resolve => {
      client.on(Events.InteractionCreate, interaction => {
        handled.set(interaction.id, interaction);
        if (interaction.id !== 'x') return;
        saveData('x.json', options, { v: 1 });
        collector = new InteractionCollector(client as Client<true>, { interactionType: InteractionType.ApplicationCommand });
        collector.on('collect', (other: BaseInteraction) => {
          saveData(`collected-${other.id}.json`, options, { v: 1 });
          resolve();
        });
      });
    });
    (client as unknown as { actions: { InteractionCreate: { handle(data: unknown): void } } }).actions.InteractionCreate.handle(raw('x'));
    (client as unknown as { actions: { InteractionCreate: { handle(data: unknown): void } } }).actions.InteractionCreate.handle(raw('y'));
    await collected;
    collector!.stop();
    expect(shape(ledgerOf(handled.get('x')!)!)).toEqual([['x.json', ['interaction']]]);
    expect(shape(ledgerOf(handled.get('y')!)!)).toEqual([['collected-y.json', ['interaction']]]);
    client.removeAllListeners();
  });
});

describe('characterization: where discord.js await and collector idioms record (input for BT-3)', () => {
  const raw = (id: string, type: InteractionType) => ({
    id,
    application_id: '11',
    type,
    token: `token-${id}`,
    version: 1,
    data: type === InteractionType.ModalSubmit ? { custom_id: 'm', components: [] } : { id: '12', name: 'ping', type: 1 },
    user: { id: '13', username: 'user', discriminator: '0', avatar: null, global_name: null },
    app_permissions: '0',
    locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: {},
    context: 1,
  });
  const drive = (client: Client, id: string, type: InteractionType) =>
    (client as unknown as { actions: { InteractionCreate: { handle(data: unknown): void } } }).actions.InteractionCreate.handle(raw(id, type));

  function setUp() {
    const client = new Client({ intents: [] });
    installInteractionLedgers(client);
    const handled = new Map<string, BaseInteraction>();
    client.on(Events.InteractionCreate, interaction => { handled.set(interaction.id, interaction); });
    const guildId = freshGuild();
    const options = { guildId, category: 'm' };
    const at = (id: string) => shape(ledgerOf(handled.get(id)!)!).map(([where]) => where);
    return { client, handled, options, at };
  }

  it('a write after awaitModalSubmit records in the awaiting interaction\'s ledger, not the modal submit\'s', async () => {
    const { client, options, at } = setUp();
    const done = new Promise<void>(resolve => {
      client.on(Events.InteractionCreate, async interaction => {
        if (interaction.id !== 'x' || !interaction.isChatInputCommand()) return;
        await interaction.awaitModalSubmit({ time: 5000 });
        saveData('after-await.json', options, { v: 1 });
        resolve();
      });
    });
    drive(client, 'x', InteractionType.ApplicationCommand);
    drive(client, 'y', InteractionType.ModalSubmit);
    await done;
    expect(at('x')).toEqual(['after-await.json']);
    expect(at('y')).toEqual([]);
    client.removeAllListeners();
  });

  it('a collector\'s end by its time limit with nothing collected records in the arming interaction\'s ledger; an idle end after a collect, in the last collected one\'s', async () => {
    const { client, options, at } = setUp();
    let timed: Promise<void> = Promise.resolve();
    let idled: Promise<void> = Promise.resolve();
    client.on(Events.InteractionCreate, interaction => {
      if (interaction.id === 'x') {
        const timeLimited = new InteractionCollector(client as Client<true>, { interactionType: InteractionType.ModalSubmit, time: 30 });
        timed = new Promise(resolve => timeLimited.on('end', () => { saveData('end-by-time.json', options, { v: 1 }); resolve(); }));
      }
      if (interaction.id === 'z') {
        const idle = new InteractionCollector(client as Client<true>, { interactionType: InteractionType.ApplicationCommand, idle: 30 });
        idled = new Promise(resolve => idle.on('end', () => { saveData('end-by-idle.json', options, { v: 1 }); resolve(); }));
      }
    });
    drive(client, 'x', InteractionType.ApplicationCommand);
    drive(client, 'z', InteractionType.ApplicationCommand);
    drive(client, 'w', InteractionType.ApplicationCommand);
    await Promise.all([timed, idled]);
    expect(at('x')).toEqual(['end-by-time.json']);
    expect(at('z')).toEqual([]);
    expect(at('w')).toEqual(['end-by-idle.json']);
    client.removeAllListeners();
  });
});

describe('the module frame', () => {
  for (const enabled of [false, true]) {
    it(`instrument() tags the writes made inside fn with metrics ${enabled ? 'on' : 'off'}, and returns and throws as before`, async () => {
      vi.spyOn(getMetricsCollector(), 'isEnabled').mockReturnValue(enabled);
      const guildId = freshGuild();
      const options = { guildId, category: 'm' };
      const ledger = openLedger('interaction');
      const answer = await runInLedger(ledger, null, () => instrument('command', guildId, 'modI', 'cmd', () => {
        saveData('a.json', options, { v: 1 });
        return 42;
      }));
      expect(answer).toBe(42);
      await expect(runInLedger(ledger, null, () => instrument('command', guildId, 'modJ', 'cmd', async () => {
        saveData('b.json', options, { v: 1 });
        throw new Error('boom');
      }))).rejects.toThrow('boom');
      await runInLedger(ledger, 'outerMod', () => instrument('command', guildId, null, 'cmd', () => saveData('c.json', options, { v: 1 })));
      expect(shape(ledger)).toEqual([['a.json', ['modI']], ['b.json', ['modJ']], ['c.json', ['outerMod']]]);
      expect(await instrument('command', guildId, 'modK', 'cmd', () => 'no ledger')).toBe('no ledger');
    });
  }
});

type Step = { op: 'save' | 'saveTracked' | 'append' | 'delete'; key: number; module: string | null; hop: 'none' | 'micro' | 'timer' | 'immediate' | 'then' };

const stepArb: fc.Arbitrary<Step> = fc.record({
  op: fc.constantFrom<Step['op']>('save', 'saveTracked', 'append', 'delete'),
  key: fc.integer({ min: 0, max: 3 }),
  module: fc.constantFrom<string | null>('mA', 'mB', null),
  hop: fc.constantFrom<Step['hop']>('none', 'micro', 'timer', 'immediate', 'then'),
});

/** One accepted write: its path, its module, and its ticket (none for the legacy saveData, which answers a boolean). */
type Written = { path: string; module: string; ticket: WriteTicket | null };

/** Runs one handler's steps in its own guild; answers what each write said, and each write it made. */
async function runHandler(steps: Step[], guildId: string): Promise<{ answers: string[]; written: Written[] }> {
  const options = { guildId, category: 'm' };
  const answers: string[] = [];
  const written: Written[] = [];
  const note = (name: string, module: string | null, accepted: boolean, ticket: WriteTicket | null) => {
    if (accepted) written.push({ path: file(guildId, name), module: module ?? 'interaction', ticket });
  };
  for (const step of steps) {
    const write = () => withModule(step.module, () => {
      const name = step.op === 'append' ? `k${step.key}.jsonl` : `k${step.key}.json`;
      if (step.op === 'save') {
        const saved = saveData(name, options, { k: step.key });
        answers.push(`save:${saved}`);
        note(name, step.module, saved, null);
      } else if (step.op === 'saveTracked') {
        const saved = saveDataTracked(name, options, { k: step.key });
        answers.push(`saveTracked:${saved.outcome}`);
        note(name, step.module, saved.outcome === 'saved', saved.outcome === 'saved' ? saved.ticket : null);
      } else if (step.op === 'append') {
        const appended = appendDataTracked(name, options, `${step.key}\n`);
        answers.push(`append:${appended.outcome}`);
        note(name, step.module, appended.outcome === 'appended', appended.outcome === 'appended' ? appended.ticket : null);
      } else {
        const deleted = deleteDataTracked(name, options);
        answers.push(`delete:${deleted.outcome}`);
        const ticket = 'ticket' in deleted && deleted.ticket ? deleted.ticket : null;
        note(name, step.module, ticket !== null, ticket);
      }
    });
    if (step.hop === 'none') write();
    else if (step.hop === 'micro') { await Promise.resolve(); write(); }
    else if (step.hop === 'timer') await new Promise<void>(resolve => setTimeout(() => { write(); resolve(); }, 0));
    else if (step.hop === 'immediate') await new Promise<void>(resolve => setImmediate(() => { write(); resolve(); }));
    else await Promise.resolve().then(write);
  }
  return { answers, written };
}

const hasLanded = (ticket: WriteTicket) => (ticket.kind === 'file' ? ticket.record.landed >= ticket.seq : ticket.set.landedSeq >= ticket.seq);

function held(ledger: WriteLedger): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { ticket, modules } of ledger.tickets()) {
    if (ticket.kind !== 'file') throw new Error('a working-set ticket in a file-mode run');
    if (!out.has(ticket.path)) out.set(ticket.path, new Set());
    for (const module of modules) out.get(ticket.path)!.add(module);
  }
  return out;
}

describe('properties', () => {
  // A ledger holds only its own handler's writes and modules; every write it recorded has landed (a landed entry gives
  // way when its path is written again) or is covered by an entry naming its module.
  it('concurrent entries each record exactly their own writes, with their modules, and every answer equals a run with no ledger', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.array(stepArb, { minLength: 1, maxLength: 8 }), { minLength: 2, maxLength: 3 }), async programs => {
      const ledgers = programs.map(() => openLedger('interaction'));
      const inLedgers = await Promise.all(programs.map((steps, i) => runInLedger(ledgers[i], null, () => runHandler(steps, freshGuild()))));
      const bare = await Promise.all(programs.map(steps => runHandler(steps, freshGuild())));
      programs.forEach((_, i) => {
        const holds = held(ledgers[i]);
        const own = new Map<string, Set<string>>();
        for (const { path: at, module } of inLedgers[i].written) {
          if (!own.has(at)) own.set(at, new Set());
          own.get(at)!.add(module);
        }
        for (const [at, modules] of holds) {
          expect(own.has(at), `a foreign path: ${at}`).toBe(true);
          for (const module of modules) expect(own.get(at)!.has(module), `a foreign module at ${at}: ${module}`).toBe(true);
        }
        for (const { path: at, module, ticket } of inLedgers[i].written) {
          if (ticket && !hasLanded(ticket)) expect(holds.get(at)?.has(module), `an unlanded write of ${module} at ${at} not held`).toBe(true);
        }
        expect(inLedgers[i].answers).toEqual(bare[i].answers);
      });
    }), { numRuns: 40 });
  });

  it('a ledger\'s entries are all ok exactly when every write it recorded is ok, under drops, landings and rewrites', async () => {
    type Op = { op: 'save' | 'append' | 'delete' | 'drop' | 'settle'; key: number };
    const opArb = fc.record({ op: fc.constantFrom<Op['op']>('save', 'save', 'append', 'delete', 'drop', 'settle'), key: fc.integer({ min: 0, max: 2 }) });
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async ops => {
      const guildId = freshGuild();
      const options = { guildId, category: 'm' };
      const ledger = openLedger('interaction');
      const own: WriteTicket[] = [];
      for (const { op, key } of ops) {
        if (op === 'drop') { dropPendingForGuild(guildId); continue; }
        if (op === 'settle') { await flushAll(); continue; }
        runInLedger(ledger, 'm', () => {
          const result = op === 'save'
            ? saveDataTracked(`k${key}.json`, options, { key })
            : op === 'append'
              ? appendDataTracked(`k${key}.jsonl`, options, `${key}\n`)
              : deleteDataTracked(`k${key}.json`, options);
          if ('ticket' in result && result.ticket) own.push(result.ticket);
        });
      }
      await flushAll();
      const entries = ledger.tickets();
      expect(entries.length).toBeLessThanOrEqual(own.length);
      const allOwn = (await Promise.all(own.map(t => confirmWrite(t, 2000)))).every(a => a === 'ok');
      const allKept = (await Promise.all(entries.map(e => confirmWrite(e.ticket, 2000)))).every(a => a === 'ok');
      expect(allKept).toBe(allOwn);
    }), { numRuns: 60 });
  });
});

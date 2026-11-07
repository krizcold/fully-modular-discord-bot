import { describe, expect, it } from 'vitest';
import { Client, Events } from 'discord.js';

import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { currentLedger, ledgerOf, type WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// NB9 test 23 (43): a discord.js Client built with no interaction hook, the hook set later through the ingest's holder.
// The hook sees each interaction's ledger before any listener, and a listener runs inside that same ledger, so the
// handler's writes are recorded where the hook (the reply gate) reads them.

const emit = (client: Client, event: string, ...args: unknown[]) =>
  (client.emit as unknown as (event: string, ...args: unknown[]) => boolean).call(client, event, ...args);

describe('test 23: the interaction hook holder (43)', () => {
  it('a hook set by adoptClient after the build sees each interaction, and the listener runs in that ledger', () => {
    const ingest = new IngestService();
    const client = ingest.buildClient({ intents: [] });
    const wrapped = client.emit;
    const before = { id: 'i-0' };
    const inListener: Array<WriteLedger | undefined> = [];
    client.on(Events.InteractionCreate, () => { inListener.push(currentLedger()); });
    emit(client, Events.InteractionCreate, before);
    expect(inListener).toHaveLength(1);
    expect(inListener[0]).toBe(ledgerOf(before));

    const seen: Array<{ interaction: object; ledger: WriteLedger }> = [];
    ingest.adoptClient(client, (interaction, ledger) => { seen.push({ interaction, ledger }); });
    expect(client.emit).toBe(wrapped);
    const after = { id: 'i-1' };
    emit(client, Events.InteractionCreate, after);
    expect(seen).toHaveLength(1);
    expect(seen[0].interaction).toBe(after);
    expect(seen[0].ledger).toBe(ledgerOf(after));
    expect(inListener[1]).toBe(seen[0].ledger);
    client.removeAllListeners();
  });

  it('buildClient with a hook installs one wrapper, and adoptClient replaces only the hook', () => {
    const ingest = new IngestService();
    const first: object[] = [];
    const client = ingest.buildClient({ intents: [] }, interaction => { first.push(interaction); });
    const second: object[] = [];
    ingest.adoptClient(client, interaction => { second.push(interaction); });
    emit(client, Events.InteractionCreate, { id: 'i-2' });
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });

  it('adoptClient with another Client throws, and with no Client built', () => {
    const ingest = new IngestService();
    expect(() => ingest.adoptClient(new Client({ intents: [] }), () => undefined)).toThrow();
    ingest.buildClient({ intents: [] });
    expect(() => ingest.adoptClient(new Client({ intents: [] }), () => undefined)).toThrow();
  });
});

// Test 23's last clause (63): the gate the ingest's holder carries holds the reply until the handler's write is
// confirmed, driven through gateRig.ts's rig(), whose Client gets installGatedInteractions as a normal boot's does.
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { withModule } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { EPHEMERAL, callbackType, rawCommand, rig, storeGuild, textOf, tick } from '../helpers/gateRig';
import { InteractionResponseType } from 'discord.js';

describe('test 23: the reply gate through the hook holder (63)', () => {
  it("the reply is held until the handler's write is confirmed, then goes out with its content", async () => {
    const { wire, emit } = rig();
    const { store, options } = await storeGuild();
    store.holding = true;
    let sent: Promise<unknown> | undefined;
    try {
      await emit(rawCommand('nb9-23'), i => withModule('plainmod', async () => {
        saveData('x.json', options, { v: 1 });
        sent = i.reply({ content: 'Saved!', flags: EPHEMERAL });
      }));
      await tick(50);
      expect(wire).toEqual([]);
    } finally {
      store.release();
      await sent;
    }
    expect(wire.map(c => [c.method, callbackType(c), textOf(c)])).toEqual([['post', InteractionResponseType.ChannelMessageWithSource, 'Saved!']]);
  });
});

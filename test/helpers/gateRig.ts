import { Client, ComponentType, Events, InteractionType, MessageFlags, type BaseInteraction } from 'discord.js';
import { expect } from 'vitest';

import { setRouteOverride } from '../../src/bot/internalSetup/utils/dataBackends/routeResolver';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { installGatedInteractions } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { FakeStore, tokenFor } from './fakeStore';

// BT-3's rig: a gateway Client with the reply gate installed, whose REST records every call in order, and
// postgres-routed guilds on a scripted store.

export const EPHEMERAL = MessageFlags.Ephemeral;
export const V2 = MessageFlags.IsComponentsV2;

export interface WireCall {
  method: 'post' | 'patch' | 'delete' | 'get';
  route: string;
  body: any;
}

let guilds = 9800;
export const freshGuild = () => String(++guilds);
export const user = { id: '13', username: 'user', discriminator: '0', avatar: null, global_name: null };
export const base = (id: string) => ({
  id,
  application_id: '11',
  token: `token-${id}`,
  version: 1,
  user,
  app_permissions: '0',
  locale: 'en-US',
  entitlements: [],
  authorizing_integration_owners: {},
  context: 1,
});
export const rawCommand = (id: string) => ({ ...base(id), type: InteractionType.ApplicationCommand, data: { id: '12', name: 'ping', type: 1 } });
export const rawButton = (id: string, messageFlags = 0) => ({
  ...base(id),
  type: InteractionType.MessageComponent,
  data: { custom_id: 'b', component_type: ComponentType.Button },
  message: {
    id: '500', channel_id: '600', author: { ...user, id: '11', username: 'bot' }, content: '', timestamp: new Date(0).toISOString(),
    edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [],
    pinned: false, type: 0, flags: messageFlags, components: [],
  },
});
/** A modal submit; fromMessage when a component opened the modal, so the interaction carries that message. */
export const rawModal = (id: string, fromMessage: boolean) => ({
  ...(fromMessage ? rawButton(id) : base(id)),
  type: InteractionType.ModalSubmit,
  data: { custom_id: 'm', components: [] },
});
export const fakeMessage = { id: '700', channel_id: '600', author: { ...user, id: '11', username: 'bot' }, content: '', timestamp: new Date(0).toISOString(), edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0, flags: 0, components: [] };

/** A gateway Client with the ledgers (and so the gate) installed, whose REST records every call in order. */
export function rig() {
  const client = new Client({ intents: [] });
  installGatedInteractions(client);
  const wire: WireCall[] = [];
  const control = { failNext: null as Error | null, onSend: null as ((call: WireCall) => void) | null };
  const rest = client.rest as unknown as Record<string, (route: string, options?: { body?: unknown }) => Promise<unknown>>;
  for (const method of ['post', 'patch', 'delete', 'get'] as const) {
    rest[method] = async (route, options = {}) => {
      if (control.failNext) {
        const error = control.failNext;
        control.failNext = null;
        throw error;
      }
      const call = { method, route, body: options.body };
      control.onSend?.(call);
      wire.push(call);
      return route.includes('/callback') ? undefined : fakeMessage;
    };
  }
  /** Emits one interaction; the handler runs as its listener, inside its ledger. */
  const emit = (raw: object, handler: (interaction: any) => Promise<void>) => new Promise<{ interaction: any; error?: unknown }>(resolve => {
    const listener = (interaction: BaseInteraction) => {
      client.off(Events.InteractionCreate, listener);
      handler(interaction).then(() => resolve({ interaction }), error => resolve({ interaction, error }));
    };
    client.on(Events.InteractionCreate, listener);
    (client as unknown as { actions: { InteractionCreate: { handle(data: unknown): void } } }).actions.InteractionCreate.handle(raw);
  });
  return { client, wire, control, emit };
}

/** A postgres-routed guild on a scripted store, hydrated and ready. */
export async function storeGuild() {
  const guildId = freshGuild();
  setRouteOverride(guildId, 'postgres');
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  return { guildId, store, options: { guildId, category: 'm' } };
}

/** A postgres-routed guild whose working set is not ready: a save is refused as not-ready. */
export function notReadyGuild() {
  const guildId = freshGuild();
  setRouteOverride(guildId, 'postgres');
  return { guildId, category: 'm' };
}

export const callbackType = (call: WireCall) => call.body?.type;
export const textOf = (call: WireCall): string | undefined => {
  const data = call.route.includes('/callback') ? call.body?.data : call.body;
  if (typeof data?.content === 'string' && data.content) return data.content;
  const display = data?.components?.[0]?.components?.find((c: { type: number }) => c.type === ComponentType.TextDisplay);
  return display?.content;
};
export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));


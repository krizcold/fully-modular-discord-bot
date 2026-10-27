import { Client, ComponentType, DiscordAPIError, Events, InteractionResponseType, InteractionType, MessageFlags, type BaseInteraction } from 'discord.js';
import { expect } from 'vitest';

import { setBackendKind } from './backendKind';
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

export const unknownMessage = (method: string, route: string) =>
  new DiscordAPIError({ code: 10008, message: 'Unknown Message' }, 10008, 404, method.toUpperCase(), route, {});

/** How Discord reads back a deferral: whether it carries MessageFlags.Loading while thinking, and after a fill. */
export interface ReadBack {
  loadingFlag: boolean;
  loadingAfterFill: boolean;
}

const FILL_FIELDS = ['content', 'embeds', 'components', 'attachments', 'poll'] as const;

/** A sent body's content-bearing fields as Discord would hold them in the message. */
function fillOf(body: any): Record<string, unknown> {
  const fill: Record<string, unknown> = {};
  for (const field of FILL_FIELDS) {
    if (body?.[field] !== undefined) fill[field] = body[field];
  }
  if (Array.isArray(fill.attachments)) {
    fill.attachments = (fill.attachments as any[]).map(a => ({ size: 1, url: 'https://cdn/a', proxy_url: 'https://cdn/a', ...a, id: String(a.id) }));
  }
  if (fill.poll) {
    fill.poll = { channel_id: '600', expiry: null, results: null, ...(fill.poll as object), answers: ((fill.poll as any).answers ?? []).map((a: any, i: number) => ({ answer_id: i + 1, ...a })) };
  }
  return fill;
}

/**
 * The original response as Discord holds it, by interaction token: a deferral reads back loading (MessageFlags.Loading
 * unless readBack says otherwise) until an edit of it or the first followUp fills it (bt3_facts 1.4), and then with
 * what the fill wrote; once deleted it answers Unknown Message.
 */
function originalModel(readBack: ReadBack) {
  const originals = new Map<string, { loading: boolean; flags: number; gone: boolean; filled: boolean; fill: Record<string, unknown> }>();
  return (method: WireCall['method'], route: string, body: any): object | undefined => {
    const token = /token-[^/?]+/.exec(route)?.[0];
    if (!token) return undefined;
    const original = route.endsWith('/messages/%40original');
    const state = originals.get(token);
    if (route.includes('/callback')) {
      if (body?.type === InteractionResponseType.DeferredChannelMessageWithSource) {
        originals.set(token, { loading: true, flags: body.data?.flags ?? 0, gone: false, filled: false, fill: {} });
      } else if (body?.type === InteractionResponseType.ChannelMessageWithSource) {
        originals.set(token, { loading: false, flags: body.data?.flags ?? 0, gone: false, filled: true, fill: fillOf(body.data) });
      }
      return undefined;
    }
    if (!state) return undefined;
    if (original && state.gone) throw unknownMessage(method, route);
    if (method === 'delete' && original) state.gone = true;
    else if ((method === 'patch' && original) || (method === 'post' && !route.includes('/messages') && state.loading)) {
      state.loading = false;
      state.filled = true;
      state.fill = { ...state.fill, ...fillOf(body) };
    } else if (method === 'get' && original) {
      const loading = readBack.loadingFlag && (state.loading || (state.filled && readBack.loadingAfterFill));
      return { ...fakeMessage, ...state.fill, flags: loading ? MessageFlags.Loading | state.flags : 0 };
    }
    return undefined;
  };
}

/** A gateway Client with the ledgers (and so the gate) installed, whose REST records every call in order. */
export function rig() {
  const client = new Client({ intents: [] });
  installGatedInteractions(client);
  const wire: WireCall[] = [];
  const control = {
    failNext: null as Error | null,
    onSend: null as ((call: WireCall) => void) | null,
    delayMs: 0,
    readBack: { loadingFlag: true, loadingAfterFill: false } as ReadBack,
  };
  const rest = client.rest as unknown as Record<string, (route: string, options?: { body?: unknown }) => Promise<unknown>>;
  const discord = originalModel(control.readBack);
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
      // A call on the wire for a while: discord.js sets its flags only once it returns.
      if (control.delayMs > 0) await new Promise(resolve => setTimeout(resolve, control.delayMs));
      const held = discord(method, route, options.body);
      return route.includes('/callback') ? undefined : held ?? fakeMessage;
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
  setBackendKind('postgres');
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
  return { guildId, store, options: { guildId, category: 'm' } };
}

/** A postgres-routed guild whose working set is not ready: a save is refused as not-ready. */
export function notReadyGuild() {
  const guildId = freshGuild();
  setBackendKind('postgres');
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


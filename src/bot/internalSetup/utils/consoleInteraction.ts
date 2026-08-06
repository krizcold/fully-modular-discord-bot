/**
 * ConsoleInteraction - a synthetic ChatInputCommandInteraction for `cmd invoke`.
 *
 * Guild/channel/member/user are REAL discord.js cache objects from the connected
 * client (the bot is online); only the reply plumbing is faked so nothing is sent
 * to Discord. The object is duck-typed and cast to Interaction: it is passed to the
 * REAL dispatcher (handleCommands.ts), so every gate (devOnly/testOnly/permissions/
 * tier) and the module callback run exactly as they would for a Discord interaction.
 * Replies are captured and returned to the console as JSON.
 *
 * Not exercised: Discord's own interaction routing and ack tokens. A module that
 * reaches for interaction surface beyond what is implemented here throws a natural
 * error, which handleCommands logs (visible via `smdb logs`).
 */

import { Client, Guild, GuildMember, User } from 'discord.js';

export interface CapturedReply {
  method: 'reply' | 'deferReply' | 'editReply' | 'followUp' | 'deleteReply';
  payload: unknown;
}

export interface ConsoleInvokeResult {
  captured: CapturedReply[];
  replied: boolean;
  deferred: boolean;
}

interface BuildOpts {
  client: Client;
  commandName: string;
  guild: Guild | null;
  guildId: string | null;
  channelId: string | null;
  member: GuildMember | null;
  user: User | { id: string };
  options: Record<string, unknown>;
}

/** Build the CommandInteractionOptionResolver-shaped surface over a flat options map. */
function buildOptions(opts: BuildOpts) {
  const map = opts.options || {};
  const get = (name: string) => (name in map ? map[name] : undefined);
  const str = (name: string) => {
    const v = get(name);
    return v === undefined || v === null ? null : String(v);
  };
  const resolveId = (kind: 'user' | 'channel' | 'role', name: string) => {
    const id = str(name);
    if (!id) return null;
    if (kind === 'user') return opts.client.users.cache.get(id) || { id };
    if (kind === 'channel') return opts.guild?.channels.cache.get(id) || { id };
    return opts.guild?.roles.cache.get(id) || { id };
  };
  return {
    get: (name: string) => (name in map ? { name, value: map[name] } : null),
    getString: (name: string) => str(name),
    getInteger: (name: string) => (get(name) === undefined ? null : Math.trunc(Number(get(name)))),
    getNumber: (name: string) => (get(name) === undefined ? null : Number(get(name))),
    getBoolean: (name: string) => (get(name) === undefined ? null : Boolean(get(name))),
    getUser: (name: string) => resolveId('user', name),
    getMember: (name: string) => {
      const id = str(name);
      return id ? opts.guild?.members.cache.get(id) || null : null;
    },
    getChannel: (name: string) => resolveId('channel', name),
    getRole: (name: string) => resolveId('role', name),
    getMentionable: (name: string) => resolveId('user', name),
    getAttachment: () => null,
    getFocused: () => '',
    getSubcommand: (required = true) => {
      const v = str('_subcommand');
      if (!v && required) throw new Error('console-invoke: no subcommand supplied (pass options._subcommand)');
      return v;
    },
    getSubcommandGroup: (required = false) => {
      const v = str('_subcommandGroup');
      if (!v && required) throw new Error('console-invoke: no subcommand group supplied');
      return v;
    },
    data: Object.entries(map).map(([name, value]) => ({ name, value })),
  };
}

export function buildConsoleInteraction(opts: BuildOpts): {
  interaction: unknown;
  result: ConsoleInvokeResult;
} {
  const result: ConsoleInvokeResult = { captured: [], replied: false, deferred: false };
  const fakeMessage = { id: '0', content: '', edit: async () => fakeMessage, delete: async () => fakeMessage };

  const capture = (method: CapturedReply['method'], payload?: unknown) => {
    result.captured.push({ method, payload: payload ?? null });
    return fakeMessage;
  };

  const interaction = {
    client: opts.client,
    commandName: opts.commandName,
    commandType: 1, // ApplicationCommandType.ChatInput
    id: '0',
    applicationId: opts.client.application?.id || '0',
    token: 'console-invoke',
    createdTimestamp: 0,
    guild: opts.guild,
    guildId: opts.guildId,
    channel: opts.channelId && opts.guild ? opts.guild.channels.cache.get(opts.channelId) || null : null,
    channelId: opts.channelId,
    member: opts.member,
    user: opts.user,
    get replied() {
      return result.replied;
    },
    get deferred() {
      return result.deferred;
    },
    options: buildOptions(opts),

    isChatInputCommand: () => true,
    isCommand: () => true,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isAnySelectMenu: () => false,
    isStringSelectMenu: () => false,
    isRepliable: () => true,
    inGuild: () => Boolean(opts.guildId),
    inCachedGuild: () => Boolean(opts.guild),

    reply: async (payload: unknown) => {
      result.replied = true;
      return capture('reply', payload);
    },
    deferReply: async (payload: unknown) => {
      result.deferred = true;
      return capture('deferReply', payload);
    },
    editReply: async (payload: unknown) => capture('editReply', payload),
    followUp: async (payload: unknown) => capture('followUp', payload),
    deleteReply: async () => {
      capture('deleteReply');
    },
    fetchReply: async () => fakeMessage,
  };

  return { interaction, result };
}

/** Who holds a premium subscription: a server (a guild, in code) or a user. */
export type HolderKind = 'guild' | 'user';
/** The one form a holder takes in the store, in ops and in events: its kind, a colon and its Discord id. */
export type HolderKey = `guild:${string}` | `user:${string}`;

const DISCORD_ID = /^[1-9][0-9]{0,19}$/;
const HOLDER = /^(guild|user):([1-9][0-9]{0,19})$/;

/** A Discord id: an unsigned 64-bit number in decimal with no leading zero, so one server has one key. */
export function isDiscordId(text: unknown): text is string {
  return typeof text === 'string' && DISCORD_ID.test(text);
}

export function notHolderText(text: unknown): string {
  let shown: string;
  try {
    shown = String(text);
  } catch {
    shown = typeof text;
  }
  return `'${shown}' is not a holder: expected guild:<id> or user:<id> with a Discord id.`;
}

export function doesNotSellText(providerName: string, kind: HolderKind): string {
  return `${providerName} does not sell ${kind === 'user' ? 'user' : 'server'} subscriptions.`;
}

function holderOf(kind: HolderKind, id: unknown): HolderKey {
  if (!isDiscordId(id)) throw new Error(notHolderText(`${kind}:${typeof id === 'string' ? id : ''}`));
  return `${kind}:${id}`;
}

export function guildHolder(id: string): HolderKey {
  return holderOf('guild', id);
}

export function userHolder(id: string): HolderKey {
  return holderOf('user', id);
}

export function parseHolder(text: unknown): { kind: HolderKind; id: string; key: HolderKey } | null {
  if (typeof text !== 'string') return null;
  const match = HOLDER.exec(text);
  if (!match) return null;
  return { kind: match[1] as HolderKind, id: match[2], key: text as HolderKey };
}

/** The holder of the server id a provider's service stored; null, never a throw, for anything that is not one. */
export function holderFromWire(serverId: unknown): HolderKey | null {
  return isDiscordId(serverId) ? `guild:${serverId}` : null;
}

/** The server id a provider sends to its service; a provider that sells servers only refuses a user here. */
export function guildIdFor(holder: HolderKey, providerName: string): string {
  const parsed = parseHolder(holder);
  if (!parsed) throw new Error(notHolderText(holder));
  if (parsed.kind === 'user') throw new Error(doesNotSellText(providerName, 'user'));
  return parsed.id;
}

/** "guild 123" or "user 123", as the logs name a holder. */
export function holderWords(key: HolderKey): string {
  const parsed = parseHolder(key);
  return parsed ? `${parsed.kind} ${parsed.id}` : String(key);
}

// The shape of a panel action, a console invoke or a read a panel needs (NB15 decision 8): the checks the web routes
// make on what they accept, shared with the holder, which repeats them on a request row whatever wrote it.

export const PANEL_ACTION_OPS = ['panel:execute', 'panel:button', 'panel:dropdown', 'panel:modal'] as const;
export const ACTION_OPS = [...PANEL_ACTION_OPS, 'command:invoke'] as const;
export const READ_OPS = ['guild:channels', 'guild:roles', 'panel:list', 'panel:live', 'guild:membership'] as const;
export const PANEL_REQUEST_OPS = [...ACTION_OPS, ...READ_OPS] as const;
export type PanelRequestOp = typeof PANEL_REQUEST_OPS[number];

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_MEMBERSHIP_IDS = 100;
const MAX_ID = 9223372036854775807n;

/** Discord's shard formula over a guild id the caller checked. */
export function shardOfGuild(guildId: string, shardCount: number): number {
  return Number((BigInt(guildId) >> 22n) % BigInt(shardCount));
}

export function isPanelRequestOp(op: unknown): op is PanelRequestOp {
  return typeof op === 'string' && (PANEL_REQUEST_OPS as readonly string[]).includes(op);
}

export const isActionOp = (op: string): boolean => (ACTION_OPS as readonly string[]).includes(op);
export const isReadOp = (op: string): boolean => (READ_OPS as readonly string[]).includes(op);

export function validPanelId(panelId: unknown): panelId is string {
  return typeof panelId === 'string' && /^[a-zA-Z0-9._-]+$/.test(panelId) && panelId.length > 0 && panelId.length < 100;
}

export function validInteractionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length < 200 && /^[a-zA-Z0-9._\-/:]+$/.test(id);
}

export const isSnowflake = (id: unknown): id is string => typeof id === 'string' && /^[0-9]{17,19}$/.test(id);

export function validUserId(userId: unknown): userId is string {
  return userId === 'web-ui-owner' || isSnowflake(userId);
}

export function validChannelId(channelId: unknown): boolean {
  return channelId === undefined || channelId === null || channelId === '' || isSnowflake(channelId);
}

/** A guild id the holder check can cast to bigint: 5 to 20 digits, not above the bigint range. */
export function validGuildId(guildId: unknown): guildId is string {
  return typeof guildId === 'string' && /^[0-9]{5,20}$/.test(guildId) && BigInt(guildId) <= MAX_ID;
}

export function validDropdownValues(values: unknown): values is string[] {
  return Array.isArray(values) && values.length <= 25 && values.every(v => typeof v === 'string' && v.length < 100);
}

export interface Actor {
  via: 'owner' | 'member';
  userId: string;
}

/** Why an actor is malformed for this op, or null. */
export function actorRefusal(op: string, actor: unknown): string | null {
  if (!actor || typeof actor !== 'object') return 'no actor';
  const { via, userId } = actor as Record<string, unknown>;
  if (via === 'owner') return validUserId(userId) || (typeof userId === 'string' && /^[0-9]{5,20}$/.test(userId)) ? null : "the actor's user id is not valid";
  if (via === 'member') {
    if (op === 'command:invoke') return 'a member cannot invoke a command';
    return isSnowflake(userId) ? null : "the actor's user id is not valid";
  }
  return "the actor's kind is not valid";
}

/** Why a body is malformed for its op, or null; guildId is the row's. */
export function bodyRefusal(op: PanelRequestOp, body: Record<string, unknown>): string | null {
  const actor = actorRefusal(op, body.actor);
  if (actor) return actor;
  switch (op) {
    case 'panel:execute':
    case 'panel:button':
    case 'panel:dropdown':
    case 'panel:modal':
      if (!validPanelId(body.panelId)) return 'the panel id is not valid';
      if (!validChannelId(body.channelId)) return 'the channel id is not valid';
      if (op === 'panel:button' && !validInteractionId(body.buttonId)) return 'the button id is not valid';
      if (op === 'panel:dropdown') {
        if (!validDropdownValues(body.values)) return 'the dropdown values are not valid';
        if (body.dropdownId !== undefined && body.dropdownId !== null && !validInteractionId(body.dropdownId)) return 'the dropdown id is not valid';
      }
      if (op === 'panel:modal') {
        if (!validInteractionId(body.modalId)) return 'the modal id is not valid';
        if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) return 'the modal fields are not valid';
      }
      return null;
    case 'command:invoke':
      if (typeof body.command !== 'string' || !/^[\w-]{1,64}$/.test(body.command)) return 'the command name is not valid';
      if (body.options !== undefined && (typeof body.options !== 'object' || body.options === null || Array.isArray(body.options))) return 'the options are not valid';
      if (!validChannelId(body.channelId)) return 'the channel id is not valid';
      if (body.force !== undefined && typeof body.force !== 'boolean') return 'force is not valid';
      return null;
    case 'panel:live':
      if (!validPanelId(body.panelId)) return 'the panel id is not valid';
      if (body.haveVersion !== undefined && !(Number.isSafeInteger(body.haveVersion) && (body.haveVersion as number) >= 0)) return 'the version is not valid';
      if (body.haveSince !== undefined && body.haveSince !== null && !(typeof body.haveSince === 'number' && Number.isFinite(body.haveSince))) return 'the since is not valid';
      return null;
    case 'guild:membership': {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MEMBERSHIP_IDS || !ids.every(validGuildId)) return 'the server ids are not valid';
      return null;
    }
    case 'guild:channels':
    case 'guild:roles':
    case 'panel:list':
      return null;
  }
}

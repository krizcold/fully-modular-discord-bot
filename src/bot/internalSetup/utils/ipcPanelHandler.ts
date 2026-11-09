// IPC Panel Handler - Handles IPC messages from Web-UI for panel operations, and the same requests when another
// machine's web UI sends them through a request row (NB15 decision 7: one answer function for both).

import { Status } from 'discord.js';
import { extractModuleNameFromPanel, getPanelManager } from './panelManager';
import { getConfigProperty } from './configManager';
import { admitGuildAction, ENTRY_WAIT_MS, gateCauseText, servedElsewhere } from './dataBackends/boot';
import { getDataReadiness } from './dataBackends/dataReadiness';
import { runSealed } from './dataBackends/writeLedger';
import { ranTruthText, verdictOf } from './dataBackends/replyGate';
import { broadcastWebUIPanelUpdate } from './panel/panelWebUIAdapter';
import { runFromRequest } from './panel/panelPermissions';
import { maintenanceIpcRefusal } from './maintenance';
import { runTracked } from './maintenanceGate';
import { STOPPED_SERVING_TEXT, stoppedServing } from './servingGate';
import { shardOfGuild } from './panelRequestShape';
import { toTransport } from './transportJson';
import { liveAnswer, registerInterest } from '../fleet/panelLive';
import { resolveDataBackend } from '../../../utils/envLoader';

export type AnswerFrom = 'ipc' | 'request';

export const NOT_HELD = { success: false, code: 'not-held', error: "This machine's bot does not run this server." };
export const SERVER_NOT_READY = {
  success: false, ran: false, code: 'not-ready',
  error: 'This server is not ready on the bot that runs it yet; nothing was run. Try again in a moment.',
};
export const CHANNEL_INVALID = {
  success: false, ran: false, code: 'invalid',
  error: "The request for this server was malformed (the channel is not one of this server's channels); nothing was run.",
};
const CHANNEL_FETCH_MS = 5000;
const READ_ONLY_TYPES = ['panel:list', 'dev:check', 'bot:guilds', 'panel:live'];

// Token bucket rate limiting: userId -> { tokens, lastRefill }, one bucket per user for every machine's requests.
// Configurable via config.json: system.rateLimit.bucketCapacity, system.rateLimit.refillRateMs
const tokenBuckets = new Map<string, { tokens: number; lastRefill: number }>();
let lastPrune = -Infinity;
const PRUNE_EVERY_MS = 60_000;

export function consumeToken(userId: string): boolean {
  const bucketCapacity = getConfigProperty<number>('system.rateLimit.bucketCapacity') || 5;
  const refillRateMs = getConfigProperty<number>('system.rateLimit.refillRateMs') || 1000;

  const now = Date.now();
  if (now - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = now;
    const maxAge = getConfigProperty<number>('system.rateLimit.cleanupAgeMs') || 300000;
    for (const [uid, bucket] of tokenBuckets.entries()) {
      if (now - bucket.lastRefill > maxAge) tokenBuckets.delete(uid);
    }
  }

  let bucket = tokenBuckets.get(userId);
  if (!bucket) {
    bucket = { tokens: bucketCapacity, lastRefill: now };
    tokenBuckets.set(userId, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(elapsed / refillRateMs);
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(bucketCapacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now - (elapsed % refillRateMs);
  }

  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }
  return false;
}

/** Tests read and reset the buckets. */
export function _bucketCount(): number {
  return tokenBuckets.size;
}

export function _resetPanelHandler(): void {
  tokenBuckets.clear();
  lastPrune = -Infinity;
  guildWebUi = null;
}

let guildWebUi: boolean | null = null;

/** NB15 decision 3: the last 'control:guild-webui' value this process's web UI sent; null before the first. */
export function guildWebUiEnabled(): boolean | null {
  return guildWebUi;
}

export function noteGuildWebUi(enabled: unknown): void {
  if (typeof enabled === 'boolean') guildWebUi = enabled;
}

/**
 * Set up IPC message handlers for Web-UI panel integration
 */
export function setupPanelIPCHandlers(): void {
  if (!process.send) {
    console.warn('[IPCPanelHandler] process.send not available - IPC handlers not registered');
    // NB15 decision 3: with no web UI parent, no member web panel runs for this process.
    guildWebUi = false;
    return;
  }

  console.log('[IPCPanelHandler] Setting up IPC handlers for panel system');

  process.on('message', async (message: any) => {
    if (message && typeof message === 'object' && message.type === 'control:guild-webui') {
      noteGuildWebUi(message.data?.enabled);
      return;
    }

    // Validate message structure
    if (!validateMessage(message)) {
      return;
    }

    const { type, requestId, data } = message;

    // Only handle panel/bot/guild/dev IPC messages; skip others (handled by reload/toggle handlers)
    const ownedPrefixes = ['panel:', 'dev:', 'bot:', 'guild:'];
    if (!ownedPrefixes.some(p => type.startsWith(p))) return;

    const response = await answerPanelMessage(type, data, 'ipc');
    process.send!({ requestId, data: toTransport(response).answer });
  });
}

/**
 * The answer to one panel, list or guild message, from this machine's web UI ('ipc') or from a request row another
 * machine's web UI wrote ('request'), in one order: the maintenance refusal, NB4's stopped-serving refusal, not-held,
 * the rate limit, then the tracked run with the channel check before the action.
 */
export async function answerPanelMessage(type: string, data: any, from: AnswerFrom): Promise<any> {
  const refusal = maintenanceIpcRefusal(type);
  if (refusal) return refusal;
  const guildId = data?.guildId ? String(data.guildId) : null;
  if (guildId && type !== 'bot:guilds' && type !== 'dev:check') {
    if (stoppedServing()) return { success: false, error: STOPPED_SERVING_TEXT };
    if (servedElsewhere(guildId)) return NOT_HELD;
  }

  if (!READ_ONLY_TYPES.includes(type) && data && data.userId) {
    if (!consumeToken(String(data.userId))) {
      console.warn(`[IPCPanelHandler] Rate limit exceeded for user ${data.userId}`);
      return { success: false, ran: false, error: 'Rate limit exceeded. Please wait before trying again.' };
    }
  }

  const panelManager = getPanelManager();
  const run = async () => {
    if (PANEL_ACTIONS.has(type)) {
      return runTracked(async () => {
        if (guildId && data?.channelId) {
          const wrong = await channelRefusal(panelManager.getClient?.(), guildId, String(data.channelId));
          if (wrong) return wrong;
        }
        return runPanelAction(type, data, panelManager);
      });
    }
    return handleIPCMessage(type, data, panelManager, from);
  };
  try {
    return from === 'request' ? await runFromRequest(run) : await run();
  } catch (error) {
    console.error(`[IPCPanelHandler] Error handling IPC message ${type}:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    (timer as any).unref?.();
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * NB15 decision 7: a channel named with a guild must be one of that guild's. The guild first, since the listener
 * answers before the shards are ready; a channel the cache lacks is asked of Discord, bounded by 5 s.
 */
async function channelRefusal(client: any, guildId: string, channelId: string): Promise<object | null> {
  const guild = client?.guilds?.cache?.get(guildId);
  if (!guild || guild.available === false) return SERVER_NOT_READY;
  const cached = client.channels?.cache?.get(channelId);
  if (cached) return cached.guildId === guildId ? null : CHANNEL_INVALID;
  try {
    const channel = await within(Promise.resolve(client.channels.fetch(channelId)), CHANNEL_FETCH_MS);
    if (!channel) return SERVER_NOT_READY;
    return (channel as { guildId?: unknown }).guildId === guildId ? null : CHANNEL_INVALID;
  } catch (error) {
    return (error as { code?: unknown })?.code === 10003 ? CHANNEL_INVALID : SERVER_NOT_READY;
  }
}

/**
 * Validate incoming IPC message structure
 */
function validateMessage(message: any): boolean {
  if (!message || typeof message !== 'object') {
    console.warn('[IPCPanelHandler] Received invalid IPC message: not an object');
    return false;
  }

  if (!message.type || !message.requestId) {
    console.warn('[IPCPanelHandler] Received malformed IPC message:', {
      hasType: !!message.type,
      hasRequestId: !!message.requestId
    });
    if (message.requestId) {
      process.send!({
        requestId: message.requestId,
        data: {
          success: false,
          error: 'Malformed IPC message: missing type or requestId'
        }
      });
    }
    return false;
  }

  return true;
}


const PANEL_ACTIONS = new Set(['panel:execute', 'panel:button', 'panel:dropdown', 'panel:modal']);

function panelModule(panelManager: any, panelId: unknown): string | null {
  const panel = typeof panelId === 'string' ? panelManager.getPanel?.(panelId) : undefined;
  return panel ? extractModuleNameFromPanel(panel) : null;
}

/**
 * A panel action from the web UI or the CLI (BT-4). Its writes are recorded in its own ledger, sealed once it answers,
 * and the verdict over them is taken first, on every exit: the answer claims success, and the live update goes out,
 * only when every write landed and none was refused; otherwise the answer says the action ran and what happened to its
 * writes. A guild that cannot take writes holds the action first (R1-J2), before its ledger opens, so its writes and
 * its confirmSaved start at admission.
 */
export async function runPanelAction(type: string, data: any, panelManager: any): Promise<any> {
  if (PANEL_ACTIONS.has(type) && data?.guildId) {
    const held = await admitGuildAction(String(data.guildId), performance.now() + ENTRY_WAIT_MS);
    if (held.cause !== 'admit') return { success: false, ran: false, error: gateCauseText(held.cause) };
  }
  return runSealed('panel', null, panelModule(panelManager, data?.panelId), async ledger => {
    let response: any;
    try {
      response = await handleIPCMessage(type, data, panelManager, 'ipc');
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
    const { liveUpdate, ...answer } = response;
    const verdict = await verdictOf([ledger]);
    if (!verdict.ok) {
      if (answer.success === false) console.warn(`[IPCPanelHandler] ${type} failed with its writes not confirmed: ${answer.error}`);
      const failed: Record<string, unknown> = { success: false, ran: true, truth: verdict.answer, partial: verdict.partial, error: ranTruthText(verdict) };
      if (verdict.answer === 'pending' || verdict.answer === 'held') failed.pending = true;
      return failed;
    }
    if (liveUpdate) broadcastWebUIPanelUpdate(liveUpdate.panelId, liveUpdate.response, liveUpdate.guildId);
    return answer;
  });
}

/** Whether a panel may run from a request row (NB15 decision 3): guild scope and not for developers. */
export function runsFromRequest(panel: { panelScope?: string; devOnly?: boolean } | undefined): boolean {
  return !!panel && (panel.panelScope ?? 'guild') === 'guild' && !panel.devOnly;
}

/**
 * NB15 decisions 8 and 14: whether some of the lease's shards (every shard of the client on a JSON bot) are not ready,
 * or hold a guild that is not available, so a list read from the cache may be missing servers.
 */
export function cacheIncomplete(client: any, shardIds?: number[]): boolean {
  const shards: Map<number, { status?: unknown }> | undefined = client?.ws?.shards;
  let ids = shardIds;
  let count = 0;
  if (!ids) {
    const lease = resolveDataBackend() === 'postgres' ? getDataReadiness()?.leasedShards() ?? null : null;
    if (lease) {
      ids = lease.shardIds;
      count = lease.shardCount;
    } else {
      ids = shards ? [...shards.keys()] : [];
      count = typeof client?.options?.shardCount === 'number' ? client.options.shardCount : 0;
    }
  }
  if (ids.length === 0) return true;
  for (const id of ids) {
    const shard = shards?.get(id);
    if (!shard || shard.status !== Status.Ready) return true;
  }
  const watched = new Set(ids);
  for (const guild of client?.guilds?.cache?.values?.() ?? []) {
    if (guild?.available !== false) continue;
    const shardId = typeof guild.shardId === 'number' ? guild.shardId : count > 0 ? shardOfGuild(String(guild.id), count) : null;
    if (shardId === null || watched.has(shardId)) return true;
  }
  return false;
}

/**
 * Handle IPC message and return response
 */
async function handleIPCMessage(type: string, data: any, panelManager: any, from: AnswerFrom): Promise<any> {
  switch (type) {
    case 'panel:list': {
      const panels = panelManager.getWebUIPanelList();
      return {
        success: true,
        panels: from === 'request'
          ? panels.filter((p: { id: string }) => runsFromRequest(panelManager.getPanel?.(p.id)))
          : panels
      };
    }

    case 'panel:live': {
      if (!data || !data.guildId || typeof data.panelId !== 'string') {
        return { success: false, error: 'Missing required fields: guildId and panelId' };
      }
      const since = registerInterest(String(data.guildId), data.panelId);
      const haveVersion = Number.isSafeInteger(data.haveVersion) && data.haveVersion > 0 ? data.haveVersion : 0;
      const haveSince = typeof data.haveSince === 'number' && Number.isFinite(data.haveSince) ? data.haveSince : null;
      return liveAnswer(String(data.guildId), data.panelId, since, haveVersion, haveSince);
    }

    case 'panel:execute':
      if (!data || !data.panelId || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId and userId'
        };
      }
      return await panelManager.executePanelForWebUI(data.panelId, data.userId, data.guildId || null, undefined, data.channelId || null);

    case 'panel:button':
      if (!data || !data.panelId || !data.buttonId || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId, buttonId, and userId'
        };
      }
      return await panelManager.handleWebUIButton(data.panelId, data.buttonId, data.userId, data.guildId || null, undefined, data.channelId || null);

    case 'panel:dropdown':
      if (!data || !data.panelId || !data.values || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId, values, and userId'
        };
      }
      if (!Array.isArray(data.values)) {
        return {
          success: false,
          error: 'Invalid field: values must be an array'
        };
      }
      return await panelManager.handleWebUIDropdown(data.panelId, data.values, data.userId, data.guildId || null, data.dropdownId, undefined, data.channelId || null);

    case 'panel:modal':
      if (!data || !data.panelId || !data.modalId || !data.fields || !data.userId) {
        return {
          success: false,
          error: 'Missing required fields: panelId, modalId, fields, and userId'
        };
      }
      if (typeof data.fields !== 'object') {
        return {
          success: false,
          error: 'Invalid field: fields must be an object'
        };
      }
      return await panelManager.handleWebUIModal(data.panelId, data.modalId, data.fields, data.userId, data.guildId || null, undefined, data.channelId || null);

    case 'dev:check':
      if (!data || !data.userId) {
        return {
          success: false,
          isDev: false,
          error: 'Missing required field: userId'
        };
      }
      try {
        // Get DEVS with correct priority (config.json > env > schema)
        const devs = getConfigProperty<(string | number)[]>('DEVS') || [];

        // Normalize both the userId and devs array to strings for comparison
        const userId = String(data.userId);
        const isDev = Array.isArray(devs) && devs.some(dev => String(dev) === userId);
        return {
          success: true,
          isDev: isDev
        };
      } catch (error) {
        console.error('[IPCPanelHandler] Error checking dev status:', error);
        return {
          success: false,
          isDev: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    case 'bot:guilds':
      try {
        const client = panelManager.getClient();
        if (!client || !client.guilds) {
          return {
            success: false,
            error: 'Bot client not available'
          };
        }

        // Get all guilds the bot is in
        const guilds = client.guilds.cache.map((guild: any) => ({
          id: guild.id,
          name: guild.name,
          icon: guild.icon,
          memberCount: guild.memberCount
        }));

        const answer: Record<string, unknown> = { success: true, guilds };
        if (cacheIncomplete(client)) answer.incomplete = true;
        return answer;
      } catch (error) {
        console.error('[IPCPanelHandler] Error getting bot guilds:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    case 'guild:channels':
      if (!data || !data.guildId) {
        return {
          success: false,
          error: 'Missing required field: guildId'
        };
      }
      try {
        const client = panelManager.getClient();
        if (!client || !client.guilds) {
          return {
            success: false,
            error: 'Bot client not available'
          };
        }

        const guild = client.guilds.cache.get(data.guildId);
        if (!guild) {
          return {
            success: false,
            error: 'Guild not found'
          };
        }

        // Get text channels (type 0), announcement channels (type 5), and forum channels (type 15)
        // Filter out voice channels, categories, and other non-text channels
        const textChannelTypes = [0, 5, 15]; // GuildText, GuildAnnouncement, GuildForum
        const channels = guild.channels.cache
          .filter((channel: any) => textChannelTypes.includes(channel.type))
          .sort((a: any, b: any) => a.position - b.position)
          .map((channel: any) => ({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId: channel.parentId,
            parentName: channel.parent?.name || null
          }));

        return {
          success: true,
          channels
        };
      } catch (error) {
        console.error('[IPCPanelHandler] Error getting guild channels:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    case 'guild:roles':
      if (!data || !data.guildId) {
        return {
          success: false,
          error: 'Missing required field: guildId'
        };
      }
      try {
        const client = panelManager.getClient();
        if (!client || !client.guilds) {
          return {
            success: false,
            error: 'Bot client not available'
          };
        }

        const guild = client.guilds.cache.get(data.guildId);
        if (!guild) {
          return {
            success: false,
            error: 'Guild not found'
          };
        }

        // Get all roles except @everyone, sorted by position (highest first)
        // Filter out managed roles (bot roles, integration roles)
        const roles = guild.roles.cache
          .filter((role: any) => role.id !== guild.id && !role.managed)
          .sort((a: any, b: any) => b.position - a.position)
          .map((role: any) => ({
            id: role.id,
            name: role.name,
            color: role.color,
            position: role.position
          }));

        return {
          success: true,
          roles
        };
      } catch (error) {
        console.error('[IPCPanelHandler] Error getting guild roles:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

    default:
      console.warn(`[IPCPanelHandler] Unknown IPC message type: ${type}`);
      return {
        success: false,
        error: `Unknown IPC message type: ${type}`
      };
  }
}

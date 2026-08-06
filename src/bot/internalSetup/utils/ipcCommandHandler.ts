/**
 * IPC Command Handler - synthetic slash-command execution for `smdb cmd invoke`.
 * Console-exclusive: builds a ConsoleInteraction and runs it through the REAL
 * dispatcher (handleCommands.ts), capturing replies instead of sending to Discord.
 */

import { Client } from 'discord.js';
import handleCommands from '../events/interactionCreate/handleCommands';
import getLocalCommands from './getLocalCommands';
import { getPanelManager } from './panelManager';
import { buildConsoleInteraction } from './consoleInteraction';

interface InvokePayload {
  command?: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  options?: Record<string, unknown>;
  force?: boolean;
}

function commandExists(name: string): boolean {
  const sets = getLocalCommands() as unknown[];
  const flat: Array<{ name?: string }> = [];
  for (const s of sets) {
    if (Array.isArray(s)) flat.push(...s);
    else flat.push(s as { name?: string });
  }
  return flat.some((c) => c && c.name === name);
}

async function handleInvoke(data: InvokePayload): Promise<Record<string, unknown>> {
  const command = (data.command || '').trim();
  if (!command) return { success: false, error: 'command is required' };

  const client = getPanelManager().getClient() as Client | undefined;
  if (!client || !client.isReady()) return { success: false, error: 'bot client not ready' };

  if (!commandExists(command)) return { success: false, error: `no such command: ${command}` };

  const guildId = data.guildId ? String(data.guildId) : null;
  // A sharded node only caches guilds on shards it serves, so cache membership is
  // the faithful ownership gate (this is exactly how Discord routes interactions).
  // Standalone caches all its guilds, so the gate is a natural no-op there.
  const guild = guildId ? client.guilds.cache.get(guildId) || null : null;
  if (guildId && !guild && !data.force) {
    return { success: false, error: `this node does not serve guild ${guildId} (not in cache); pass force to attempt anyway` };
  }

  const userId = data.userId ? String(data.userId) : null;
  const member = userId ? guild?.members.cache.get(userId) || null : guild?.members.me || null;
  const user = userId ? member?.user || client.users.cache.get(userId) || { id: userId } : client.user!;

  const { interaction, result } = buildConsoleInteraction({
    client,
    commandName: command,
    guild,
    guildId,
    channelId: data.channelId ? String(data.channelId) : null,
    member,
    user,
    options: data.options || {},
  });

  const startedAt = Date.now();
  // handleCommands owns its own try/catch: a command-internal throw is logged
  // there (visible via `smdb logs`), not surfaced inline. Pre-dispatch failures
  // (bad command, unserved guild) are returned as errors above.
  await handleCommands(client, interaction as never);
  return {
    success: true,
    command,
    captured: result.captured,
    replied: result.replied,
    deferred: result.deferred,
    durationMs: Date.now() - startedAt,
  };
}

export function setupCommandIPCHandlers(): void {
  if (!process.send) {
    console.warn('[IPCCommandHandler] process.send not available - command invoke IPC not registered');
    return;
  }
  console.log('[IPCCommandHandler] Setting up IPC handler for cmd invoke');

  process.on('message', async (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message as { type?: string; requestId?: string; data?: InvokePayload };
    if (type !== 'command:invoke' || !requestId) return;
    try {
      const response = await handleInvoke(data || {});
      process.send!({ requestId, data: response });
    } catch (error) {
      process.send!({ requestId, data: { success: false, error: error instanceof Error ? error.message : 'Unknown error' } });
    }
  });
}

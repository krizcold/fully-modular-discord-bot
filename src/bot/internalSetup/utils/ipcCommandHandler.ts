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
import { admitGuildAction, ENTRY_WAIT_MS, gateConsoleText } from './dataBackends/boot';
import { isCommandRunnable } from './commandGate';
import { runSealed } from './dataBackends/writeLedger';
import { truthText, verdictOf } from './dataBackends/replyGate';
import { maintenanceIpcRefusal } from './maintenance';
import { runTracked } from './maintenanceGate';

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

export async function handleInvoke(data: InvokePayload): Promise<Record<string, unknown>> {
  const command = (data.command || '').trim();
  if (!command) return { success: false, error: 'command is required' };

  const client = getPanelManager().getClient() as Client | undefined;
  if (!client || !client.isReady()) return { success: false, error: 'bot client not ready' };

  if (!commandExists(command)) return { success: false, error: `no such command: ${command}` };

  const gate = isCommandRunnable(command);
  if (!gate.runnable) {
    return gate.reason === 'disabled'
      ? { success: false, error: `${command} is disabled in Components` }
      : { success: false, error: `can't confirm whether ${command} is enabled: component-config.json cannot be read (${gate.error})` };
  }

  const guildId = data.guildId ? String(data.guildId) : null;
  const guild = guildId ? client.guilds.cache.get(guildId) || null : null;
  if (guildId && !data.force) {
    if (!guild) {
      return { success: false, error: `this bot does not serve guild ${guildId} (not in cache); pass force to attempt anyway` };
    }
  }

  if (guildId) {
    // Held before its ledger opens (R1-J2), so the command's writes and its confirmSaved start at admission.
    const held = await admitGuildAction(guildId, performance.now() + ENTRY_WAIT_MS);
    if (held.cause !== 'admit') return { success: false, error: gateConsoleText(held.cause, guildId) };
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
  // there (visible via `smdb logs`) and recorded as the invoke's outcome, as is
  // a gate's refusal. Its writes are recorded in a ledger keyed to the
  // interaction, judged before it seals: success only when every one landed.
  const verdict = await runSealed('console', interaction as object, null, async ledger => {
    await handleCommands(client, interaction as never);
    return verdictOf([ledger]);
  });
  const outcome = result.outcome;
  const answer: Record<string, unknown> = {
    success: verdict.ok && !outcome,
    command,
    captured: result.captured,
    replied: result.replied,
    deferred: result.deferred,
    durationMs: Date.now() - startedAt,
  };
  if (!verdict.ok) {
    // The truth leads; the command's own error is kept beside it.
    answer.error = truthText(verdict.answer, verdict.partial);
    answer.truth = verdict.answer;
    if (verdict.answer === 'pending' || verdict.answer === 'held') answer.pending = true;
    if (outcome && 'error' in outcome) answer.handlerError = outcome.error;
  } else if (outcome) {
    answer.error = 'refusal' in outcome ? outcome.refusal : outcome.error;
  }
  return answer;
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
    const refusal = maintenanceIpcRefusal(type);
    if (refusal) {
      process.send!({ requestId, data: refusal });
      return;
    }
    try {
      const response = await runTracked(() => handleInvoke(data || {}));
      process.send!({ requestId, data: response });
    } catch (error) {
      process.send!({ requestId, data: { success: false, error: error instanceof Error ? error.message : 'Unknown error' } });
    }
  });
}

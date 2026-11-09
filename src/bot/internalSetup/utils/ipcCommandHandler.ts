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
import { admitGuildAction, ENTRY_WAIT_MS, gateConsoleText, servedElsewhere } from './dataBackends/boot';
import { isCommandRunnable } from './commandGate';
import { runSealed } from './dataBackends/writeLedger';
import { ranTruthText, verdictOf } from './dataBackends/replyGate';
import { maintenanceIpcRefusal } from './maintenance';
import { runTracked } from './maintenanceGate';
import { NOT_HELD, type AnswerFrom } from './ipcPanelHandler';
import { toTransport } from './transportJson';

interface InvokePayload {
  command?: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  options?: Record<string, unknown>;
  force?: boolean;
}

/** A command looked up once for an invoke; command is undefined when no such command exists. */
export interface CommandLookup {
  command: { name?: string; devOnly?: boolean } | undefined;
}

export function findLocalCommand(name: string): { name?: string; devOnly?: boolean } | undefined {
  const flat: Array<{ name?: string; devOnly?: boolean }> = [];
  for (const s of getLocalCommands() as unknown[]) {
    if (Array.isArray(s)) flat.push(...s);
    else flat.push(s as { name?: string });
  }
  return flat.find((c) => c && c.name === name);
}

/** Every answer given before the command's callback started carries ran: false; every other answer ran: true. */
export async function handleInvoke(data: InvokePayload, lookup?: CommandLookup): Promise<Record<string, unknown>> {
  const command = (data.command || '').trim();
  if (!command) return { success: false, ran: false, error: 'command is required' };

  const client = getPanelManager().getClient() as Client | undefined;
  if (!client || !client.isReady()) return { success: false, ran: false, error: 'bot client not ready' };

  if (!(lookup ? lookup.command : findLocalCommand(command))) return { success: false, ran: false, error: `no such command: ${command}` };

  const gate = isCommandRunnable(command);
  if (!gate.runnable) {
    return gate.reason === 'disabled'
      ? { success: false, ran: false, error: `${command} is disabled in Components` }
      : { success: false, ran: false, error: `can't confirm whether ${command} is enabled: component-config.json cannot be read (${gate.error})` };
  }

  const guildId = data.guildId ? String(data.guildId) : null;
  const guild = guildId ? client.guilds.cache.get(guildId) || null : null;
  if (guildId && !data.force) {
    if (!guild) {
      return { success: false, ran: false, error: `this bot does not serve guild ${guildId} (not in cache); pass force to attempt anyway` };
    }
  }

  if (guildId) {
    // Held before its ledger opens (R1-J2), so the command's writes and its confirmSaved start at admission.
    const held = await admitGuildAction(guildId, performance.now() + ENTRY_WAIT_MS);
    if (held.cause !== 'admit') return { success: false, ran: false, error: gateConsoleText(held.cause, guildId) };
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
  const refusedByGate = !!outcome && 'refusal' in outcome;
  const answer: Record<string, unknown> = {
    success: verdict.ok && !outcome,
    ran: !refusedByGate || !verdict.ok,
    command,
    captured: result.captured,
    replied: result.replied,
    deferred: result.deferred,
    durationMs: Date.now() - startedAt,
  };
  if (!verdict.ok) {
    // The truth leads; the command's own error is kept beside it.
    answer.ran = true;
    answer.error = ranTruthText(verdict);
    answer.truth = verdict.answer;
    answer.partial = verdict.partial;
    if (verdict.answer === 'pending' || verdict.answer === 'held') answer.pending = true;
    if (outcome && 'error' in outcome) answer.handlerError = outcome.error;
  } else if (outcome) {
    answer.error = 'refusal' in outcome ? outcome.refusal : outcome.error;
  }
  return answer;
}

/** NB15 decision 7: the maintenance refusal, not-held, then the invoke. No rate limit. */
export async function answerInvokeMessage(data: InvokePayload, _from: AnswerFrom, lookup?: CommandLookup): Promise<Record<string, unknown>> {
  const refusal = maintenanceIpcRefusal('command:invoke');
  if (refusal) return { ...refusal, ran: false };
  const guildId = data?.guildId ? String(data.guildId) : null;
  if (guildId && servedElsewhere(guildId)) return NOT_HELD;
  try {
    return await runTracked(() => handleInvoke(data || {}, lookup));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
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
    const response = await answerInvokeMessage(data || {}, 'ipc');
    process.send!({ requestId, data: toTransport(response).answer });
  });
}

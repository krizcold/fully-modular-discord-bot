import { Client, Interaction } from 'discord.js';
import getLocalCommands from '../../utils/getLocalCommands';
import { getPremiumManager } from '../../utils/premiumManager';
import { instrument } from '../../utils/metrics/instrument';

/** Whether the module's user gate names this command, as handleCommands reads it. */
function userGated(commandObject: any): boolean {
  const gate = commandObject._tierRequirement?.user;
  if (!gate || typeof gate.minPriority !== 'number') return false;
  const listed = Array.isArray(gate.gatedCommands) && gate.gatedCommands.length > 0;
  return !listed || gate.gatedCommands.includes(commandObject.name);
}

/**
 * Autocomplete dispatcher.
 *
 * Mirrors the tier-gating logic from handleCommands so a free-tier guild
 * cannot pull autocomplete suggestions for a premium-only command. Tier
 * rejection silently returns an empty choice list - autocomplete cannot
 * surface error text and we don't want to leak the command's existence.
 */
export default async function handleAutocomplete(client: Client, interaction: Interaction): Promise<void> {
  if (!interaction.isAutocomplete()) return;

  const localCommandsSets = getLocalCommands();
  let localCommands: any[] = [];
  localCommandsSets.forEach((commands: any) => {
    if (Array.isArray(commands)) {
      localCommands = [...localCommands, ...commands];
    } else {
      localCommands.push(commands);
    }
  });

  const commandObject = localCommands.find((cmd) => cmd.name === interaction.commandName);
  if (!commandObject || typeof commandObject.autocomplete !== 'function') {
    if (!interaction.responded) {
      try { await interaction.respond([]); } catch { /* interaction may have expired */ }
    }
    return;
  }

  // Tier gate (parallels handleCommands.ts). Silent - return [] rather than
  // any user-visible message so a gated command's existence stays hidden.
  if (commandObject._moduleName && interaction.guildId) {
    try {
      const pm = getPremiumManager();
      const tierOverrides = pm.getTierOverrides(interaction.guildId, commandObject._moduleName);

      if (tierOverrides._moduleEnabled === false) {
        try { await interaction.respond([]); } catch {}
        return;
      }

      if (Array.isArray(tierOverrides._disabledCommands) && tierOverrides._disabledCommands.includes(commandObject.name)) {
        try { await interaction.respond([]); } catch {}
        return;
      }

      const tr = commandObject._tierRequirement;
      if (tr && typeof tr.minPriority === 'number') {
        const gatedByCommands = Array.isArray(tr.gatedCommands) && tr.gatedCommands.length > 0;
        const commandIsGated = !gatedByCommands || tr.gatedCommands.includes(commandObject.name);
        if (commandIsGated && !pm.hasFeatureAccess(interaction.guildId, tr.minPriority)) {
          try { await interaction.respond([]); } catch {}
          return;
        }
      }
    } catch { /* premium manager not available; allow autocomplete */ }
  }

  if (commandObject._moduleName && userGated(commandObject)) {
    try {
      if (!getPremiumManager().hasUserFeatureAccess(interaction.user.id, commandObject._tierRequirement.user.minPriority)) {
        try { await interaction.respond([]); } catch {}
        return;
      }
    } catch { /* premium manager not available; allow autocomplete */ }
  }

  try {
    const choices = await instrument('autocomplete', interaction.guildId, commandObject._moduleName, interaction.commandName, () =>
      commandObject.autocomplete(client, interaction)
    );
    if (!interaction.responded) {
      await interaction.respond(Array.isArray(choices) ? choices.slice(0, 25) : []);
    }
  } catch (error) {
    console.error('[Autocomplete] Error in autocomplete handler:', error);
    if (!interaction.responded) {
      try { await interaction.respond([]); } catch { /* expired */ }
    }
  }
}

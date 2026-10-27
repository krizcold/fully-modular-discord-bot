import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, CommandInteraction, ContextMenuCommandInteraction, Interaction, PermissionsBitField, MessageFlags } from 'discord.js';
import getLocalCommands from '../../utils/getLocalCommands';
import { getConfigProperty } from '../../utils/configManager';
import { getPremiumManager } from '../../utils/premiumManager';
import { instrument } from '../../utils/metrics/instrument';
import { DataBackendUnavailableError } from '../../utils/dataManager';
import { dataUnavailableMessage } from '../../utils/dataBackends/boot';
import { isCommandRunnable } from '../../utils/commandGate';
import { noteConsoleOutcome } from '../../utils/consoleInteraction';

/** A gate's ephemeral refusal, unawaited as before; on the console it is also the invoke's outcome. */
function refuse(interaction: CommandInteraction, payload: { content: string; components?: any[] }): void {
  interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  noteConsoleOutcome(interaction, { refusal: payload.content });
}

/**
 * Build the components array attached to a tier-blocked reply. When the host
 * has set WEBUI_BASE_URL we surface a Link button to the guild's subscription
 * page so the user can immediately go upgrade. Without WEBUI_BASE_URL we
 * cannot generate a valid link, so we omit the button (the message text
 * still appears).
 */
function buildBlockedReplyComponents(guildId: string): any[] {
  const pm = getPremiumManager();
  const url = pm.getGuildSubscriptionUrl(guildId);
  if (!url) return [];
  const label = pm.getMessages().upgradeButtonLabel || 'Upgrade your tier';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label)
  );
  return [row];
}

const testServer = process.env.GUILD_ID || ''; // Test server ID

export default async function handleCommands(client: Client, interaction: Interaction) {
  if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand()) return;

  // Get commands fresh each time (supports hot-reload; new modules are visible immediately)
  const localCommandsSets = getLocalCommands();
  let localCommands: any[] = [];

  // Flatten the local commands array
  localCommandsSets.forEach((commands: any) => {
    if (Array.isArray(commands)) {
      localCommands = [...localCommands, ...commands];
    } else {
      localCommands.push(commands);
    }
  });

  try {
    const commandObject = localCommands.find(
      (cmd) => cmd.name === interaction.commandName
    );

    if (!commandObject) {
      noteConsoleOutcome(interaction, { refusal: `no such command: ${interaction.commandName}` });
      return;
    }

    const gate = isCommandRunnable(commandObject.name);
    if (!gate.runnable) {
      refuse(interaction, {
        content: gate.reason === 'disabled'
          ? 'This command is switched off.'
          : 'This command cannot run right now: its on/off setting cannot be read.',
      });
      return;
    }

    // Check developer-only condition
    if (commandObject.devOnly) {
      // Get DEVS list with correct priority (config.json > env > schema)
      const devs = getConfigProperty<(string | number)[]>('DEVS') || [];

      // Normalize to strings for comparison
      const userId = String(interaction.user.id);
      const isDevUser = devs.some(dev => String(dev) === userId);

      if (!isDevUser) {
        refuse(interaction, { content: 'Only developers are allowed to run this command.' });
        return;
      }
    }

    // Check test-only condition
    if (commandObject.testOnly) {
      if (interaction.guildId !== testServer) {
        refuse(interaction, { content: 'This command cannot be run here.' });
        return;
      }
    }


    // Check if the bot has required permissions
    if (commandObject.botPermissions?.length) {
      const bot = interaction.guild?.members.me;
      if (bot) {
        for (const permission of commandObject.botPermissions) {
          const permKey = permission as keyof typeof PermissionsBitField.Flags;
          if (!bot.permissions.has(PermissionsBitField.Flags[permKey])) {
            refuse(interaction, { content: "I don't have enough permissions." });
            return;
          }
        }
      }
    }

    // Check premium tier access for module commands
    if (commandObject._moduleName && interaction.guildId) {
      try {
        const pm = getPremiumManager();
        const tierOverrides = pm.getTierOverrides(interaction.guildId, commandObject._moduleName);

        const upgradeComponents = buildBlockedReplyComponents(interaction.guildId);

        if (tierOverrides._moduleEnabled === false) {
          refuse(interaction, { content: pm.getMessages().moduleBlocked, components: upgradeComponents });
          return;
        }

        if (Array.isArray(tierOverrides._disabledCommands) && tierOverrides._disabledCommands.includes(commandObject.name)) {
          refuse(interaction, { content: pm.getMessages().commandBlocked, components: upgradeComponents });
          return;
        }

        // Manifest-driven tier gate (tierRequirement on the module)
        const tr = commandObject._tierRequirement;
        if (tr && typeof tr.minPriority === 'number') {
          const gatedByCommands = Array.isArray(tr.gatedCommands) && tr.gatedCommands.length > 0;
          const commandIsGated = !gatedByCommands || tr.gatedCommands.includes(commandObject.name);
          if (commandIsGated && !pm.hasFeatureAccess(interaction.guildId, tr.minPriority)) {
            refuse(interaction, {
              content: gatedByCommands ? pm.getMessages().commandBlocked : pm.getMessages().moduleBlocked,
              components: upgradeComponents,
            });
            return;
          }
        }
      } catch { /* premium manager not available; allow command */ }
    }

    await instrument('command', interaction.guildId, commandObject._moduleName, interaction.commandName, () =>
      commandObject.callback(client, interaction as CommandInteraction | ContextMenuCommandInteraction)
    );
  } catch (error) {
    console.error(`There was an error running this command:`, error);
    noteConsoleOutcome(interaction, { error: error instanceof Error ? error.message : String(error) });
    // A refused data write must reach the user with its cause, not a silent log.
    if (error instanceof DataBackendUnavailableError) {
      const content = dataUnavailableMessage(error.causeKey);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
        }
      } catch { /* interaction expired */ }
    }
  }
};

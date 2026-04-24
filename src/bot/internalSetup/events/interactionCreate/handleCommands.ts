import { Client, CommandInteraction, ContextMenuCommandInteraction, Interaction, PermissionsBitField, MessageFlags } from 'discord.js';
import getLocalCommands from '../../utils/getLocalCommands';
import { getConfigProperty } from '../../utils/configManager';
import { getPremiumManager } from '../../utils/premiumManager';

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

    if (!commandObject) return;

    // Check developer-only condition
    if (commandObject.devOnly) {
      // Get DEVS list with correct priority (config.json > env > schema)
      const devs = getConfigProperty<(string | number)[]>('DEVS') || [];

      // Normalize to strings for comparison
      const userId = String(interaction.user.id);
      const isDevUser = devs.some(dev => String(dev) === userId);

      if (!isDevUser) {
        interaction.reply({
          content: 'Only developers are allowed to run this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // Check test-only condition
    if (commandObject.testOnly) {
      if (interaction.guildId !== testServer) {
        interaction.reply({
          content: 'This command cannot be run here.',
          flags: MessageFlags.Ephemeral,
        });
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
            interaction.reply({
              content: "I don't have enough permissions.",
              flags: MessageFlags.Ephemeral,
            });
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

        if (tierOverrides._moduleEnabled === false) {
          interaction.reply({
            content: pm.getMessages().moduleBlocked,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (Array.isArray(tierOverrides._disabledCommands) && tierOverrides._disabledCommands.includes(commandObject.name)) {
          interaction.reply({
            content: pm.getMessages().commandBlocked,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Manifest-driven tier gate (tierRequirement on the module)
        const tr = commandObject._tierRequirement;
        if (tr && typeof tr.minPriority === 'number') {
          const gatedByCommands = Array.isArray(tr.gatedCommands) && tr.gatedCommands.length > 0;
          const commandIsGated = !gatedByCommands || tr.gatedCommands.includes(commandObject.name);
          if (commandIsGated && !pm.hasFeatureAccess(interaction.guildId, tr.minPriority)) {
            interaction.reply({
              content: gatedByCommands ? pm.getMessages().commandBlocked : pm.getMessages().moduleBlocked,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }
      } catch { /* premium manager not available; allow command */ }
    }

    await commandObject.callback(client, interaction as CommandInteraction | ContextMenuCommandInteraction);
  } catch (error) {
    console.error(`There was an error running this command:`, error);
  }
};

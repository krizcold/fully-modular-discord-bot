import {
  Client,
  CommandInteraction,
  GatewayIntentBits,
  PermissionsBitField,
} from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';
import { getPanelManager } from '@internal/utils/panelManager';

const updateCheckCommand: CommandOptions = {
  name: 'update-check',
  description: 'Check for bot updates (direct panel access)',
  testOnly: true,
  dm_permission: false,
  requiredIntents: [GatewayIntentBits.Guilds],
  permissionsRequired: [PermissionsBitField.Flags.Administrator],

  callback: async (client: Client, interaction: CommandInteraction) => {
    console.log("[UpdateCheck] Direct update check command executed");

    const panelManager = getPanelManager(client);
    
    // Create context for direct command access
    const context = panelManager.createDirectCommandContext('update_manager', interaction, client);
    
    // Get the update panel directly
    const response = await panelManager.handlePanelInteraction(context);

    await interaction.reply(response);
  },
};

export = updateCheckCommand;
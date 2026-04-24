import {
  Client,
  CommandInteraction,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';
import { getPanelManager } from '@internal/utils/panelManager';
import {
  registerAdminPanelHandlers,
  registerAdminPanelCloseHandler,
  registerCategoryWarningHandlers
} from '@internal/utils/panel/adminPanelHandlers';
import { loadCredentials } from '../../../utils/envLoader';

const systemPanelCommand: CommandOptions = {
  name: 'system-panel',
  description: 'Access system-level administration panels (Owner only)',
  testOnly: true,
  devOnly: true,
  dm_permission: false,
  requiredIntents: [GatewayIntentBits.Guilds],
  permissionsRequired: [PermissionsBitField.Flags.Administrator],

  initialize: (client: Client) => {
    registerAdminPanelHandlers(client, 'system');
    registerAdminPanelCloseHandler(client);
    registerCategoryWarningHandlers(client);
  },

  callback: async (client: Client, interaction: CommandInteraction) => {
    // System panel is strictly main-guild-only (operational security)
    const credentials = loadCredentials();
    const mainGuildId = credentials.MAIN_GUILD_ID || credentials.GUILD_ID;
    if (interaction.guildId !== mainGuildId) {
      await interaction.reply({
        content: ':no_entry_sign: The system panel is only available in the main guild.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const panelManager = getPanelManager(client);
    const systemPanel = panelManager.generateAdminPanel(0, undefined, interaction.guildId, 'system');
    await interaction.reply(systemPanel);
  },
};

export = systemPanelCommand;

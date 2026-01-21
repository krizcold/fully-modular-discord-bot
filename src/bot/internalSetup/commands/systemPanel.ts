import {
  Client,
  CommandInteraction,
  GatewayIntentBits,
  PermissionsBitField,
} from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';
import { getPanelManager } from '@internal/utils/panelManager';
import {
  registerAdminPanelHandlers,
  registerAdminPanelCloseHandler,
  registerCategoryWarningHandlers
} from '@internal/utils/panel/adminPanelHandlers';

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
    const panelManager = getPanelManager(client);
    const systemPanel = panelManager.generateAdminPanel(0, undefined, interaction.guildId, 'system');
    await interaction.reply(systemPanel);
  },
};

export = systemPanelCommand;

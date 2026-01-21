import {
  Client,
  CommandInteraction,
  GatewayIntentBits,
  PermissionsBitField,
  ApplicationIntegrationType,
  InteractionContextType,
} from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';
import { getPanelManager } from '@internal/utils/panelManager';
import {
  registerAdminPanelHandlers,
  registerAdminPanelCloseHandler,
  registerCategoryWarningHandlers
} from '@internal/utils/panel/adminPanelHandlers';

const guildPanelCommand: CommandOptions = {
  name: 'guild-panel',
  description: 'Access guild administration panels',
  testOnly: false,
  dm_permission: false,
  requiredIntents: [GatewayIntentBits.Guilds],
  permissionsRequired: [PermissionsBitField.Flags.Administrator],

  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],

  initialize: (client: Client) => {
    registerAdminPanelHandlers(client, 'guild');
    registerAdminPanelCloseHandler(client);
    registerCategoryWarningHandlers(client);
  },

  callback: async (client: Client, interaction: CommandInteraction) => {
    const panelManager = getPanelManager(client);
    const guildPanel = panelManager.generateAdminPanel(0, undefined, interaction.guildId, 'guild');
    await interaction.reply(guildPanel);
  },
};

export = guildPanelCommand;

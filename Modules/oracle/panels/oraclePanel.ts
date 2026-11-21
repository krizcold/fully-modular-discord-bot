import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, GatewayIntentBits, PermissionFlagsBits, TextDisplayBuilder } from 'discord.js';
import { PanelContext, PanelOptions, PanelResponse } from '@bot/types/panelTypes';
import { createV2Response } from '@internal/utils/panel/v2';
import { nonceOfButton, saveAction } from '../oracleSave';

/** The button's custom id; the act run passes it as --button and appends `:` and the nonce. */
export const BUTTON_ID = 'panel_oracle_btn_act';

const text = (t: string): PanelResponse => {
  const c = new ContainerBuilder();
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(t));
  return createV2Response([c]);
};

const oraclePanel: PanelOptions = {
  id: 'oracle',
  name: 'Oracle Actions',
  description: 'The live tests\' action button: each press saves one oracle doc.',
  category: 'Tests',
  showInAdminPanel: true,
  requiredPermissions: [PermissionFlagsBits.Administrator],
  requiredIntents: [GatewayIntentBits.Guilds],

  callback: async (_context: PanelContext): Promise<PanelResponse> => {
    const c = new ContainerBuilder();
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent('# Oracle actions\nEach press saves one doc for the live tests.'));
    c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(BUTTON_ID).setLabel('Act').setStyle(ButtonStyle.Primary)));
    return createV2Response([c]);
  },

  handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse> => {
    const file = await saveAction(context.guildId, nonceOfButton(buttonId), 'button');
    return text(`Saved ${file}.`);
  },
};

export default oraclePanel;

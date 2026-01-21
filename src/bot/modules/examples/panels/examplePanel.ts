import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  GatewayIntentBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from 'discord.js';
import { PanelOptions, PanelContext, PanelResponse } from '@bot/types/panelTypes';
import { createV2Response, V2Colors } from '@internal/utils/panel/v2';

const examplePanel: PanelOptions = {
  id: 'example_panel',
  name: 'Example Module Panel',
  description: 'Example panel demonstrating module panel capabilities',
  category: 'Examples',
  
  showInAdminPanel: true,
  adminPanelOrder: 10,
  adminPanelIcon: '🎯',
  
  requiredPermissions: [PermissionFlagsBits.Administrator],
  requiredIntents: [GatewayIntentBits.Guilds],
  
  callback: async (context: PanelContext): Promise<PanelResponse> => {
    const container = new ContainerBuilder()
      .setAccentColor(0x9B59B6);

    // Title
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('# Example Module Panel')
    );

    // Description
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('This is an example panel inside the Examples module, demonstrating how modules can have their own panels!')
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );

    // Info fields
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📍 Location:** modules/misc/examples/panels/examplePanel.ts\n` +
        `**📦 Module:** Examples (misc/examples)\n` +
        `**👤 User ID:** ${context.userId}\n` +
        `**🆔 Panel ID:** ${context.panelId}`
      )
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
    );

    // Purpose
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**📝 Purpose:** Demonstrate that modules can include panels alongside commands')
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
    );

    // Features
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '**🔧 Panel Features:**\n' +
        '• Part of a module (auto-loaded)\n' +
        '• Custom categories\n' +
        '• Permission requirements\n' +
        '• Button interactions\n' +
        '• Dynamic content'
      )
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );

    // Buttons
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('panel_example_panel_btn_test')
            .setLabel('Test Button')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🧪'),
          new ButtonBuilder()
            .setCustomId('panel_example_panel_btn_info')
            .setLabel('Panel Info')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('ℹ️'),
          new ButtonBuilder()
            .setCustomId('panel_example_panel_btn_random')
            .setLabel('Random Fact')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🎲')
        )
    );

    return createV2Response([container]);
  },

  handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse> => {
    switch (buttonId) {
      case 'test':
        return await showTestResult(context);

      case 'info':
        return await showPanelInfo(context);

      case 'random':
        return await showRandomFact(context);

      case 'back':
        return await examplePanel.callback(context);

      default: {
        const container = new ContainerBuilder()
          .setAccentColor(V2Colors.danger);
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent('❌ Unknown button action.')
        );
        return createV2Response([container]);
      }
    }
  },
};

async function showTestResult(context: PanelContext): Promise<PanelResponse> {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.success);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# Test Button Result\n**Test Button Clicked Successfully!**')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Info fields
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**✅ Status:** Button interaction working properly\n` +
      `**👤 User:** <@${context.userId}>\n` +
      `**🎯 Panel ID:** ${context.panelId}`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  // Demonstration info
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '**📝 Demonstration:**\n' +
      '• Panel button interactions work correctly\n' +
      '• User-created panels function properly\n' +
      '• The panel system preserves functionality\n' +
      '• Return navigation is maintained'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Back button
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('panel_example_panel_btn_back')
          .setLabel('Back to Panel')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('↩️')
      )
  );

  return createV2Response([container]);
}

async function showPanelInfo(context: PanelContext): Promise<PanelResponse> {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.info);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('# Panel Information\nTechnical details about this panel')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Info fields
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**🔧 Panel System:** Dynamic Admin Panel Framework\n` +
      `**📦 Framework:** Discord.js v14 + TypeScript\n` +
      `**🎯 Custom ID Format:** \`panel_{panelId}_btn_{buttonId}\``
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  // Module structure
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '**📁 Module Structure:**\n' +
      '```\n' +
      'modules/misc/examples/\n' +
      '├── module.json\n' +
      '├── commands/       # 7 example commands\n' +
      '└── panels/         # This panel!\n' +
      '    └── examplePanel.ts\n' +
      '```'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  // Configuration options
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '**⚙️ Configuration Options:**\n' +
      '• `showInAdminPanel`: Include in main list\n' +
      '• `adminPanelOrder`: Sort order\n' +
      '• `category`: Group panels\n' +
      '• `requiredPermissions`: Access control'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Back button
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('panel_example_panel_btn_back')
          .setLabel('Back to Panel')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('↩️')
      )
  );

  return createV2Response([container]);
}

async function showRandomFact(context: PanelContext): Promise<PanelResponse> {
  const facts = [
    "🤖 This bot uses a modular panel system for dynamic admin interfaces!",
    "📊 Module panels are auto-discovered in `modules/{category}/{name}/panels/`.",
    "🔄 The panel system supports pagination for large lists of panels.",
    "⚡ Button interactions are handled automatically by the panel framework.",
    "🎯 Each panel can have its own category and permission requirements.",
    "🔧 Panels support buttons, dropdowns, and modal interactions.",
    "📝 This panel is part of the Examples module - demonstrating module panels!",
    "🔍 The module loader automatically discovers and loads all module panels."
  ];

  const randomFact = facts[Math.floor(Math.random() * facts.length)];

  const container = new ContainerBuilder()
    .setAccentColor(0xE74C3C);

  // Title and fact
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# Random Panel Fact\n\n${randomFact}`)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Buttons
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('panel_example_panel_btn_random')
          .setLabel('Another Fact')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🎲'),
        new ButtonBuilder()
          .setCustomId('panel_example_panel_btn_back')
          .setLabel('Back to Panel')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('↩️')
      )
  );

  return createV2Response([container]);
}

export default examplePanel;
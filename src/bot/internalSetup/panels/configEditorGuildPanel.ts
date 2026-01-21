import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  GatewayIntentBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SectionBuilder,
  AttachmentBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { PanelOptions, PanelContext, PanelResponse } from '../../types/panelTypes';
import { discoverGuildConfigFiles, ConfigFileMetadata } from '../utils/configDiscovery';
import { loadGuildConfig, saveGuildConfig, getMergedConfig } from '../utils/configManager';
import { createV2Response, V2Colors } from '../utils/panel/v2';
import { validateAndSanitizeJson } from '../utils/json';

const ITEMS_PER_PAGE = 8;

interface PanelData {
  selectedFile?: string;
  currentPage?: number;
}

const configEditorGuildPanel: PanelOptions = {
  id: 'config_editor_guild',
  name: 'Guild Config Editor',
  description: 'Edit guild-specific configuration overrides',
  category: 'Advanced',

  showInAdminPanel: true,
  adminPanelOrder: 100,
  adminPanelIcon: '⚙️',

  requiredPermissions: [PermissionFlagsBits.Administrator],
  requiredIntents: [GatewayIntentBits.Guilds],

  callback: async (context: PanelContext): Promise<PanelResponse> => {
    const page = (context.data as PanelData)?.currentPage || 0;
    return await showConfigList(context, page);
  },

  handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse | null> => {
    const guildId = context.guildId;

    if (!guildId) {
      const container = new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Guild Required\nThis panel can only be used in a guild context.')
        );
      return createV2Response([container]);
    }

    // Parse button ID: action or action_param
    const underscoreIndex = buttonId.indexOf('_');
    const action = underscoreIndex > -1 ? buttonId.substring(0, underscoreIndex) : buttonId;
    const param = underscoreIndex > -1 ? buttonId.substring(underscoreIndex + 1) : undefined;

    switch (action) {
      case 'select': {
        // Select a config file to view
        if (!param) {
          return showError('No config file specified.');
        }
        const configFiles = discoverGuildConfigFiles(guildId);
        const metadata = configFiles.find(f => f.id === param);
        if (!metadata) {
          return showError(`Config file '${param}' not found.`);
        }
        const configData = loadGuildConfig(param, guildId);
        context.data = { selectedFile: param } as PanelData;
        return await showConfigView(context, param, configData, metadata);
      }

      case 'page': {
        // Navigate to a different page
        const pageNum = parseInt(param || '0', 10);
        context.data = { currentPage: pageNum } as PanelData;
        return await showConfigList(context, pageNum);
      }

      case 'back':
        // Go back to list
        return await showConfigList(context, 0);

      case 'edit': {
        // Edit a config file
        if (!param) {
          return showError('No config file specified.');
        }
        return await showEditModal(context, param);
      }

      case 'reset': {
        // Show confirmation panel for reset
        if (!param) {
          return showError('No config file specified.');
        }
        return await showResetConfirm(context, param);
      }

      case 'refresh': {
        // Refresh current view
        if (!param) {
          return showError('No config file specified.');
        }
        const configFiles = discoverGuildConfigFiles(guildId);
        const metadata = configFiles.find(f => f.id === param);
        const configData = loadGuildConfig(param, guildId);
        return await showConfigView(context, param, configData, metadata);
      }

      case 'download': {
        if (!param) return showError('No config file specified.');
        return await handleDownload(context, param);
      }

      case 'upload': {
        if (!param) return showError('No config file specified.');
        return await showUploadModal(context, param);
      }

      default:
        return showError('Unknown action.');
    }
  },

  handleModal: async (context: PanelContext, modalId: string): Promise<PanelResponse> => {
    // Extract fileId from modalId (format: action_fileId)
    let action = modalId;
    let fileId: string | undefined;

    const parts = modalId.split('_');
    if (parts.length >= 2) {
      action = parts[0];
      fileId = parts.slice(1).join('_'); // Rejoin in case fileId contains underscores
    }

    if (action !== 'edit' && action !== 'reset' && action !== 'upload') {
      const container = new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Unknown Modal\nThe requested modal action is not recognized.')
        );
      return createV2Response([container]);
    }

    // Handle reset confirmation modal
    if (action === 'reset') {
      if (!fileId || !context.guildId) {
        return showError('Invalid context for reset.');
      }

      const interaction = context.interaction;
      if (!interaction || !('fields' in interaction)) {
        return showError('Invalid interaction.');
      }

      const confirmText = interaction.fields.getTextInputValue('confirm_text');
      if (confirmText.toUpperCase() !== 'RESET') {
        return showError('Reset cancelled. You must type RESET to confirm.');
      }

      // Perform the reset
      saveGuildConfig(fileId, context.guildId, {});

      // Return to config view
      const guildConfigs = discoverGuildConfigFiles(context.guildId);
      const metadata = guildConfigs.find(f => f.id === fileId);
      const configData = loadGuildConfig(fileId, context.guildId);
      return await showConfigView(context, fileId, configData, metadata);
    }

    if (!fileId || !context.guildId) {
      const container = new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Invalid Context\nCannot save config without a selected file or guild context.')
        );
      return createV2Response([container]);
    }

    // Get JSON input from modal
    const interaction = context.interaction;
    if (!interaction || !('fields' in interaction)) {
      const container = new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Invalid Interaction\nThis action requires a valid modal interaction.')
        );
      return createV2Response([container]);
    }

    // Handle upload
    if (action === 'upload') {
      const modalFields = interaction.fields as any;
      const uploadedFiles = modalFields.getUploadedFiles?.('json_file');

      if (!uploadedFiles || uploadedFiles.size === 0) {
        return showError('No file uploaded. Please select a JSON file.');
      }

      const attachment = uploadedFiles.first();
      if (!attachment || !attachment.url) {
        return showError('Could not access uploaded file.');
      }

      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          return showError('Failed to download the uploaded file.');
        }

        const jsonText = await response.text();
        const result = validateAndSanitizeJson(jsonText, { requiredType: 'object' });
        if (!result.valid) {
          return showError(result.error);
        }
        const parsedConfig = result.data;

        // Filter to overrides only
        const guildConfigs = discoverGuildConfigFiles(context.guildId!);
        const schemaMetadata = guildConfigs.find(f => f.id === fileId);
        let overridesOnly: Record<string, any> = {};

        if (schemaMetadata?.schema) {
          for (const [key, value] of Object.entries(parsedConfig)) {
            const schemaField = schemaMetadata.schema.properties[key];
            const defaultValue = schemaField?.default;
            if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
              overridesOnly[key] = value;
            }
          }
        } else {
          overridesOnly = parsedConfig;
        }

        if (Object.keys(overridesOnly).length === 0) {
          let configPath: string;
          if (schemaMetadata && schemaMetadata.moduleName) {
            configPath = path.join('/data', context.guildId!, schemaMetadata.moduleName, fileId);
          } else {
            configPath = path.join('/data', context.guildId!, fileId);
          }
          if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
          }
        } else {
          saveGuildConfig(fileId, context.guildId!, overridesOnly);
        }

        const updatedConfig = loadGuildConfig(fileId, context.guildId!);
        return await showConfigView(context, fileId, updatedConfig, schemaMetadata);

      } catch (error) {
        console.error('[ConfigEditor] Upload error:', error);
        return showError(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const jsonInput = interaction.fields.getTextInputValue('config_json');

    // Validate and sanitize JSON
    const result = validateAndSanitizeJson(jsonInput, { requiredType: 'object' });
    if (!result.valid) {
      return showError(result.error);
    }
    const parsedConfig = result.data;

    // Get schema to filter out defaults (use guild config discovery)
    const guildConfigs = discoverGuildConfigFiles(context.guildId!);
    const schemaMetadata = guildConfigs.find(f => f.id === fileId);
    let overridesOnly: Record<string, any> = {};

    if (schemaMetadata?.schema) {
      // Compare each property to schema defaults and keep only differences
      for (const [key, value] of Object.entries(parsedConfig)) {
        const schemaField = schemaMetadata.schema.properties[key];
        const defaultValue = schemaField?.default;

        // Keep property if it differs from default (or if no default exists)
        if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
          overridesOnly[key] = value;
        }
      }
    } else {
      // No schema - save as-is
      overridesOnly = parsedConfig;
    }

    // Save config (or delete if no overrides)
    try {
      if (Object.keys(overridesOnly).length === 0) {
        // No overrides - delete file if it exists
        // Construct proper path with moduleName
        let configPath: string;
        if (schemaMetadata && schemaMetadata.moduleName) {
          configPath = path.join('/data', context.guildId, schemaMetadata.moduleName, fileId);
        } else {
          configPath = path.join('/data', context.guildId, fileId);
        }

        if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath);
          console.log(`[ConfigEditor] Deleted ${fileId} (no overrides)`);
        }
      } else {
        // Save only overrides
        saveGuildConfig(fileId, context.guildId, overridesOnly);
      }
    } catch (error) {
      const container = new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            '## Save Failed\nFailed to save the configuration file.\n\n' +
            `**Error:** \`${error instanceof Error ? error.message : 'Unknown error'}\``
          )
        );
      return createV2Response([container]);
    }

    // Return to config view with updated data
    const allConfigFiles = discoverGuildConfigFiles(context.guildId);
    const fileMetadata = allConfigFiles.find(f => f.id === fileId);
    const updatedConfig = loadGuildConfig(fileId, context.guildId);
    return await showConfigView(context, fileId, updatedConfig, fileMetadata);
  },
};

// Helper function to show error messages
function showError(message: string): PanelResponse {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Error\n${message}`)
    );
  return createV2Response([container]);
}

// Show paginated list of config files with section buttons
async function showConfigList(context: PanelContext, page: number): Promise<PanelResponse> {
  const guildId = context.guildId;

  if (!guildId) {
    return showError('This panel can only be used in a guild context.');
  }

  const configFiles = discoverGuildConfigFiles(guildId);

  if (configFiles.length === 0) {
    const container = new ContainerBuilder()
      .setAccentColor(V2Colors.warning)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '## Guild Config Editor\n\n' +
          '**No configuration files found.**\n\n' +
          'No modules have defined config schemas yet.\n' +
          'Config files are created when modules define `configSchema` in their module.json.'
        )
      );
    return createV2Response([container]);
  }

  // Calculate pagination
  const totalPages = Math.ceil(configFiles.length / ITEMS_PER_PAGE);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIndex = currentPage * ITEMS_PER_PAGE;
  const pageFiles = configFiles.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const container = new ContainerBuilder()
    .setAccentColor(0x3498DB); // Blue for guild

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Guild Config Editor')
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Guild:** \`${guildId}\``)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Config file sections with buttons
  for (const file of pageFiles) {
    // Check if file has overrides
    const configData = loadGuildConfig(file.id, guildId);
    const overrideCount = Object.keys(configData).length;
    const statusIcon = overrideCount > 0 ? '🟠' : '⚪';
    const statusText = overrideCount > 0 ? `-# *(${overrideCount} override${overrideCount > 1 ? 's' : ''})*` : '-# *(Using defaults)*';

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**${statusIcon} ${file.name}**`),
          new TextDisplayBuilder().setContent(statusText)
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`panel_config_editor_guild_btn_select_${file.id}`)
            .setLabel('Edit')
            .setStyle(overrideCount > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        )
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Info text - split into 2 lines
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '*Guild configs store ONLY overrides.*\n' +
      '*Properties not set use global defaults.*'
    )
  );

  // Always show pagination (DEV.md: buttons disable at boundaries, never hide)
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_guild_btn_page_${currentPage - 1}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId('panel_config_editor_guild_btn_page_info')
        .setLabel(`${currentPage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_guild_btn_page_${currentPage + 1}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1)
    )
  );

  return createV2Response([container]);
}

async function showConfigView(
  context: PanelContext,
  fileId: string,
  configData: any,
  metadata: any
): Promise<PanelResponse> {
  // Get merged config with all possible keys
  const mergedConfig = getMergedConfig(fileId, context.guildId!);

  const overrideCount = Object.keys(configData).length;
  const totalKeys = Object.keys(mergedConfig.properties).length;

  // Determine accent color based on override status
  const accentColor = overrideCount > 0 ? 0xF39C12 : 0x95A5A6; // Orange if customized, gray if defaults

  const container = new ContainerBuilder()
    .setAccentColor(accentColor);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${metadata?.name || fileId}`)
  );

  // File info
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Guild:** \`${context.guildId}\`\n` +
      `**File:** \`${fileId}\`\n` +
      `**Description:** ${metadata?.description || 'No description'}\n` +
      `**Properties:** ${totalKeys} total, **${overrideCount} customized**`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Configuration properties
  if (totalKeys > 0) {
    const entries = Object.entries(mergedConfig.properties);

    // Build property list with visual distinction
    let propList = entries.map(([key, prop]: [string, any]) => {
      const valueStr = JSON.stringify(prop.value);

      if (prop.isSet) {
        return `**\`${key}\`:** ${valueStr}`;
      } else if (prop.source === 'global') {
        return `\`${key}\`: ${valueStr} *(from global)*`;
      } else {
        return `\`${key}\`: ${valueStr} *(default)*`;
      }
    }).join('\n');

    // Truncate if too long
    const maxLength = 1500;
    if (propList.length > maxLength) {
      propList = propList.substring(0, maxLength) + '\n\n*... truncated - use Edit to see all*';
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(propList)
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('*No configuration properties defined.*')
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Row 1: Edit / Upload / Download
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_guild_btn_edit_${fileId}`)
        .setLabel('Edit Config')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_guild_btn_upload_${fileId}`)
        .setLabel('Upload JSON')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_guild_btn_download_${fileId}`)
        .setLabel('Download')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(overrideCount === 0)
    )
  );

  // Row 2: Reset / Refresh / Back
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_guild_btn_reset_${fileId}`)
        .setLabel('Reset to Defaults')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(overrideCount === 0),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_guild_btn_refresh_${fileId}`)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('panel_config_editor_guild_btn_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return createV2Response([container]);
}

async function showEditModal(context: PanelContext, fileId: string): Promise<PanelResponse> {
  const guildConfigs = discoverGuildConfigFiles(context.guildId!);
  const metadata = guildConfigs.find(f => f.id === fileId);

  // Get merged config (includes defaults) so users can see all properties
  const mergedConfig = getMergedConfig(fileId, context.guildId!);
  const editableConfig: Record<string, any> = {};

  for (const [key, prop] of Object.entries(mergedConfig.properties)) {
    editableConfig[key] = (prop as any).value;
  }

  const formattedJson = JSON.stringify(editableConfig, null, 2);

  const modal = new ModalBuilder()
    .setCustomId(`panel_config_editor_guild_modal_edit_${fileId}`)
    .setTitle(`Edit ${metadata?.name || fileId}`.substring(0, 45));

  const jsonInput = new TextInputBuilder()
    .setCustomId('config_json')
    .setLabel('Configuration Overrides (JSON)')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(formattedJson)
    .setPlaceholder('{\n  "property": "value"\n}')
    .setRequired(true)
    .setMaxLength(4000);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(jsonInput);
  modal.addComponents(row);

  // Return modal - panelButtonHandler will show it
  return { modal: modal } as any;
}

async function showResetConfirm(context: PanelContext, fileId: string): Promise<PanelResponse> {
  const guildConfigs = discoverGuildConfigFiles(context.guildId!);
  const metadata = guildConfigs.find(f => f.id === fileId);

  const modal = new ModalBuilder()
    .setCustomId(`panel_config_editor_guild_modal_reset_${fileId}`)
    .setTitle('Confirm Reset to Defaults');

  const confirmInput = new TextInputBuilder()
    .setCustomId('confirm_text')
    .setLabel('Type RESET to confirm')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('RESET')
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(5);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(confirmInput));

  return { modal: modal } as any;
}

async function handleDownload(context: PanelContext, fileId: string): Promise<PanelResponse | null> {
  if (!context.guildId) {
    return showError('No guild context for download.');
  }

  const mergedConfig = getMergedConfig(fileId, context.guildId);
  const configData: Record<string, any> = {};

  for (const [key, prop] of Object.entries(mergedConfig.properties)) {
    configData[key] = (prop as any).value;
  }

  if (Object.keys(configData).length === 0) {
    return showError('No configuration to download.');
  }

  const interaction = context.interaction as any;
  if (!interaction) {
    return showError('Cannot send download in this context.');
  }

  const jsonString = JSON.stringify(configData, null, 2);
  const filename = fileId.endsWith('.json') ? fileId : `${fileId}`;

  const attachment = new AttachmentBuilder(Buffer.from(jsonString, 'utf-8'), {
    name: filename,
    description: `Guild config export from ${fileId}`
  });

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  await interaction.followUp({
    content: `📥 **Download:** \`${filename}\`\n-# Guild config export`,
    files: [attachment],
    flags: MessageFlags.Ephemeral
  });

  return null;
}

async function showUploadModal(context: PanelContext, fileId: string): Promise<PanelResponse> {
  const guildConfigs = discoverGuildConfigFiles(context.guildId!);
  const metadata = guildConfigs.find(f => f.id === fileId);

  const modal = new ModalBuilder()
    .setCustomId(`panel_config_editor_guild_modal_upload_${fileId}`)
    .setTitle(`Upload ${metadata?.name || fileId}`.substring(0, 45));

  const fileUpload = new FileUploadBuilder()
    .setCustomId('json_file')
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);

  const fileLabel = new LabelBuilder()
    .setLabel('JSON File')
    .setDescription('Select a .json config file to upload')
    .setFileUploadComponent(fileUpload);

  modal.addLabelComponents(fileLabel);

  return { modal: modal } as any;
}

export default configEditorGuildPanel;

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
import { PanelOptions, PanelContext, PanelResponse } from '../../types/panelTypes';
import { discoverConfigFiles, ConfigFileMetadata } from '../utils/configDiscovery';
import { loadGlobalConfig, saveGlobalConfig, getMergedConfig } from '../utils/configManager';
import { createV2Response, V2Colors } from '../utils/panel/v2';
import { validateAndSanitizeJson } from '../utils/json';

const ITEMS_PER_PAGE = 8;

interface PanelData {
  selectedFile?: string;
  currentPage?: number;
}

const configEditorGlobalPanel: PanelOptions = {
  id: 'config_editor_global',
  name: 'Global Config Editor',
  description: 'Edit global configuration (affects all guilds)',
  category: 'Advanced',
  panelScope: 'system',
  devOnly: true,

  showInAdminPanel: true,
  adminPanelOrder: 101,
  adminPanelIcon: '🌐',
  mainGuildOnly: true,

  requiredPermissions: [PermissionFlagsBits.Administrator],
  requiredIntents: [GatewayIntentBits.Guilds],

  callback: async (context: PanelContext): Promise<PanelResponse> => {
    const page = (context.data as PanelData)?.currentPage || 0;
    return await showConfigList(context, page);
  },

  handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse | null> => {
    // Parse button ID: action or action_param
    const underscoreIndex = buttonId.indexOf('_');
    const action = underscoreIndex > -1 ? buttonId.substring(0, underscoreIndex) : buttonId;
    const param = underscoreIndex > -1 ? buttonId.substring(underscoreIndex + 1) : undefined;

    switch (action) {
      case 'select': {
        if (!param) return showError('No config file specified.');
        const configFiles = discoverConfigFiles().filter(f => f.category === 'config');
        const metadata = configFiles.find(f => f.id === param);
        if (!metadata) return showError(`Config file '${param}' not found.`);
        const configData = loadGlobalConfig(param);
        context.data = { selectedFile: param } as PanelData;
        return await showConfigView(context, param, configData, metadata);
      }

      case 'page': {
        const pageNum = parseInt(param || '0', 10);
        context.data = { currentPage: pageNum } as PanelData;
        return await showConfigList(context, pageNum);
      }

      case 'back':
        return await showConfigList(context, 0);

      case 'edit': {
        if (!param) return showError('No config file specified.');
        return await showEditModal(context, param);
      }

      case 'reset': {
        // Show confirmation panel for reset
        if (!param) return showError('No config file specified.');
        return await showResetConfirm(context, param);
      }

      case 'refresh': {
        if (!param) return showError('No config file specified.');
        const configFiles = discoverConfigFiles().filter(f => f.category === 'config');
        const metadata = configFiles.find(f => f.id === param);
        const configData = loadGlobalConfig(param);
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
    const underscoreIndex = modalId.indexOf('_');
    const action = underscoreIndex > -1 ? modalId.substring(0, underscoreIndex) : modalId;
    const fileId = underscoreIndex > -1 ? modalId.substring(underscoreIndex + 1) : undefined;

    if (action !== 'edit' && action !== 'reset' && action !== 'upload') {
      return showError('Invalid modal action.');
    }

    if (!fileId) {
      return showError('No config file specified.');
    }

    // Handle reset confirmation modal
    if (action === 'reset') {
      const interaction = context.interaction;
      if (!interaction || !('fields' in interaction)) {
        return showError('Invalid interaction.');
      }

      const confirmText = interaction.fields.getTextInputValue('confirm_text');
      if (confirmText.toUpperCase() !== 'RESET') {
        return showError('Reset cancelled. You must type RESET to confirm.');
      }

      // Perform the reset - delete the file
      const configFiles = discoverConfigFiles().filter(f => f.category === 'config');
      const metadata = configFiles.find(f => f.id === fileId);

      if (metadata?.path && fs.existsSync(metadata.path)) {
        fs.unlinkSync(metadata.path);
      }

      // Return to config view with fresh data
      const configData = loadGlobalConfig(fileId);
      return await showConfigView(context, fileId, configData, metadata);
    }

    const interaction = context.interaction;
    if (!interaction || !('fields' in interaction)) {
      return showError('Invalid interaction.');
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

        // Filter to overrides only (like edit modal)
        const configFiles = discoverConfigFiles().filter(f => f.category === 'config');
        const metadata = configFiles.find(f => f.id === fileId);
        let overridesOnly: Record<string, any> = {};

        if (metadata?.schema) {
          for (const [key, value] of Object.entries(parsedConfig)) {
            const schemaField = metadata.schema.properties[key];
            const defaultValue = schemaField?.default;
            if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
              overridesOnly[key] = value;
            }
          }
        } else {
          overridesOnly = parsedConfig;
        }

        if (Object.keys(overridesOnly).length === 0 && metadata?.path) {
          if (fs.existsSync(metadata.path)) {
            fs.unlinkSync(metadata.path);
          }
        } else {
          saveGlobalConfig(fileId, overridesOnly);
        }

        const updatedConfig = loadGlobalConfig(fileId);
        return await showConfigView(context, fileId, updatedConfig, metadata);

      } catch (error) {
        console.error('[ConfigEditor] Upload error:', error);
        return showError(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const jsonInput = interaction.fields.getTextInputValue('config_json');
    const result = validateAndSanitizeJson(jsonInput, { requiredType: 'object' });
    if (!result.valid) {
      return showError(result.error);
    }
    const parsedConfig = result.data;

    const configFiles = discoverConfigFiles().filter(f => f.category === 'config');
    const metadata = configFiles.find(f => f.id === fileId);
    let overridesOnly: Record<string, any> = {};

    if (metadata?.schema) {
      for (const [key, value] of Object.entries(parsedConfig)) {
        const schemaField = metadata.schema.properties[key];
        const defaultValue = schemaField?.default;
        if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
          overridesOnly[key] = value;
        }
      }
    } else {
      overridesOnly = parsedConfig;
    }

    try {
      if (Object.keys(overridesOnly).length === 0 && metadata?.path) {
        if (fs.existsSync(metadata.path)) {
          fs.unlinkSync(metadata.path);
        }
      } else {
        saveGlobalConfig(fileId, overridesOnly);
      }
    } catch (error) {
      return showError(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Return to config view with updated data
    const updatedConfig = loadGlobalConfig(fileId);
    const updatedMetadata = discoverConfigFiles().filter(f => f.category === 'config').find(f => f.id === fileId);
    return await showConfigView(context, fileId, updatedConfig, updatedMetadata);
  },
};

function showError(message: string): PanelResponse {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Error\n${message}`)
    );
  return createV2Response([container]);
}

async function showConfigList(context: PanelContext, page: number): Promise<PanelResponse> {
  const configFiles = discoverConfigFiles().filter(f => f.category === 'config');

  if (configFiles.length === 0) {
    const container = new ContainerBuilder()
      .setAccentColor(V2Colors.warning)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '## Global Config Editor\n\n' +
          '**No configuration files found.**'
        )
      );
    return createV2Response([container]);
  }

  const totalPages = Math.ceil(configFiles.length / ITEMS_PER_PAGE);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIndex = currentPage * ITEMS_PER_PAGE;
  const pageFiles = configFiles.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const container = new ContainerBuilder()
    .setAccentColor(0xE74C3C);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Global Config Editor')
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('**⚠️ WARNING: Changes affect ALL guilds!**')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  for (const file of pageFiles) {
    const configData = loadGlobalConfig(file.id);
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
            .setCustomId(`panel_config_editor_global_btn_select_${file.id}`)
            .setLabel('Edit')
            .setStyle(overrideCount > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
        )
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '*Global configs provide defaults for all guilds.*\n' +
      '*Individual guilds can override specific properties.*'
    )
  );

  // Always show pagination (DEV.md: buttons disable at boundaries, never hide)
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_global_btn_page_${currentPage - 1}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId('panel_config_editor_global_btn_page_info')
        .setLabel(`${currentPage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_global_btn_page_${currentPage + 1}`)
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
  const mergedConfig = getMergedConfig(fileId);
  const setCount = Object.keys(configData).length;
  const totalKeys = Object.keys(mergedConfig.properties).length;

  const container = new ContainerBuilder()
    .setAccentColor(0xE74C3C);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${metadata?.name || fileId}`)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**File:** \`${fileId}\`\n` +
      `**Scope:** Global (all guilds)\n` +
      `**Properties:** ${totalKeys} total, **${setCount} customized**`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  if (totalKeys > 0) {
    const entries = Object.entries(mergedConfig.properties);
    let propList = entries.map(([key, prop]: [string, any]) => {
      const valueStr = JSON.stringify(prop.value);
      if (prop.isSet) {
        return `**\`${key}\`:** ${valueStr}`;
      } else {
        return `\`${key}\`: ${valueStr} *(default)*`;
      }
    }).join('\n');

    if (propList.length > 1500) {
      propList = propList.substring(0, 1500) + '\n\n*... truncated - use Edit to see all*';
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
        .setCustomId(`panel_config_editor_global_btn_edit_${fileId}`)
        .setLabel('Edit Config')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_global_btn_upload_${fileId}`)
        .setLabel('Upload JSON')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_global_btn_download_${fileId}`)
        .setLabel('Download')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(setCount === 0)
    )
  );

  // Row 2: Reset / Refresh / Back
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_global_btn_reset_${fileId}`)
        .setLabel('Reset to Defaults')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(setCount === 0),
      new ButtonBuilder()
        .setCustomId(`panel_config_editor_global_btn_refresh_${fileId}`)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('panel_config_editor_global_btn_back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return createV2Response([container]);
}

async function showEditModal(context: PanelContext, fileId: string): Promise<PanelResponse> {
  const configFiles = discoverConfigFiles().filter(f => f.category === 'config');
  const metadata = configFiles.find(f => f.id === fileId);
  const mergedConfig = getMergedConfig(fileId, null);
  const editableConfig: Record<string, any> = {};

  for (const [key, prop] of Object.entries(mergedConfig.properties)) {
    editableConfig[key] = (prop as any).value;
  }

  const formattedJson = JSON.stringify(editableConfig, null, 2);

  const modal = new ModalBuilder()
    .setCustomId(`panel_config_editor_global_modal_edit_${fileId}`)
    .setTitle(`Edit ${metadata?.name || fileId}`.substring(0, 45));

  const jsonInput = new TextInputBuilder()
    .setCustomId('config_json')
    .setLabel('Global Configuration (JSON)')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(formattedJson)
    .setPlaceholder('{\n  "property": "value"\n}')
    .setRequired(true)
    .setMaxLength(4000);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(jsonInput));

  // Return modal - panelButtonHandler will show it
  return { modal: modal } as any;
}

async function showResetConfirm(context: PanelContext, fileId: string): Promise<PanelResponse> {
  const modal = new ModalBuilder()
    .setCustomId(`panel_config_editor_global_modal_reset_${fileId}`)
    .setTitle('Confirm Reset to Defaults');

  const confirmInput = new TextInputBuilder()
    .setCustomId('confirm_text')
    .setLabel('Type RESET to confirm (affects ALL guilds)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('RESET')
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(5);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(confirmInput));

  return { modal: modal } as any;
}

async function handleDownload(context: PanelContext, fileId: string): Promise<PanelResponse | null> {
  const mergedConfig = getMergedConfig(fileId);
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
    description: `Global config export from ${fileId}`
  });

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  await interaction.followUp({
    content: `📥 **Download:** \`${filename}\`\n-# Global config export`,
    files: [attachment],
    flags: MessageFlags.Ephemeral
  });

  return null;
}

async function showUploadModal(context: PanelContext, fileId: string): Promise<PanelResponse> {
  const configFiles = discoverConfigFiles().filter(f => f.category === 'config');
  const metadata = configFiles.find(f => f.id === fileId);

  const modal = new ModalBuilder()
    .setCustomId(`panel_config_editor_global_modal_upload_${fileId}`)
    .setTitle(`Upload ${metadata?.name || fileId}`.substring(0, 45));

  const fileUpload = new FileUploadBuilder()
    .setCustomId('json_file')
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);

  const fileLabel = new LabelBuilder()
    .setLabel('JSON File')
    .setDescription('Select a .json config file to upload (affects ALL guilds)')
    .setFileUploadComponent(fileUpload);

  modal.addLabelComponents(fileLabel);

  return { modal: modal } as any;
}

export default configEditorGlobalPanel;

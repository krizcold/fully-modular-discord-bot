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
} from 'discord.js';
import { PanelOptions, PanelContext, PanelResponse } from '../../types/panelTypes';
import { loadGuildData, saveGuildData } from '../utils/dataManager';
import { discoverGuildDataFiles } from '../utils/configDiscovery';
import { createV2Response, V2Colors } from '../utils/panel/v2';
import {
  isDataEmpty,
  getDataItemCount,
  buildJsonEditorView,
  handleJsonEditorButton,
  handleJsonEditorModal,
  JsonEditorConfig,
} from '../utils/json';
import type { DataFileMetadata } from '../../types/moduleTypes';

const MAX_ITEMS_PREVIEW = 3;
const MODULES_PER_PAGE = 5;
const FILES_PER_PAGE = 6;
const PANEL_ID = 'data_browser_guild';

interface PanelData {
  selectedFile?: string;
  selectedModule?: string;
  currentPage?: number;
}

function hasUsefulTemplate(file: DataFileMetadata): boolean {
  if (!file.schema && !file.template) return false;
  const template = file.template || file.schema;
  if (!template) return false;
  if (Array.isArray(template)) return template.length > 0;
  if (typeof template === 'object') return Object.keys(template).length > 0;
  return false;
}

function getFileIcon(file: DataFileMetadata, data: any): string {
  const hasData = !isDataEmpty(data);
  if (hasData) return '📝';
  if (hasUsefulTemplate(file)) return '📑';
  return '📄';
}

function showError(message: string): PanelResponse {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Error\n${message}`)
    );
  return createV2Response([container]);
}

function createEditorConfig(
  fileKey: string,
  guildId: string,
  metadata: DataFileMetadata | undefined
): JsonEditorConfig {
  const parts = fileKey.split('/');
  const displayName = parts.length >= 2 ? parts[parts.length - 1] : fileKey;
  const moduleName = parts.length >= 2 ? parts[0] : 'unknown';
  const icon = metadata ? getFileIcon(metadata, loadGuildData(fileKey, guildId, null)) : '📄';

  const infoLines = [
    `**Module:** \`${moduleName}\``,
    `**File:** \`${displayName}\``,
  ];
  if (metadata?.description) {
    infoLines.push(`**Description:** ${metadata.description}`);
  }

  return {
    panelId: PANEL_ID,
    dataKey: fileKey,
    title: `${icon} ${metadata?.name || displayName}`,
    infoLines,
    getData: () => loadGuildData(fileKey, guildId, null),
    saveData: (data) => { saveGuildData(fileKey, guildId, data); },
    template: metadata?.template,
    fileExists: metadata?.exists ?? (loadGuildData(fileKey, guildId, null) !== null),
    accentColor: 0x3498DB,
    backButtonId: `panel_${PANEL_ID}_btn_backtomodule_${moduleName}`,
    extraButtons: [
      {
        label: 'Delete',
        customId: `panel_${PANEL_ID}_btn_delete_${fileKey}`,
        style: ButtonStyle.Danger,
        disabled: !(metadata?.exists ?? (loadGuildData(fileKey, guildId, null) !== null)),
        row: 2,
      },
    ],
  };
}

const dataBrowserGuildPanel: PanelOptions = {
  id: PANEL_ID,
  name: 'Guild Data Browser',
  description: 'Browse and edit guild-specific data files',
  category: 'Advanced',

  showInAdminPanel: true,
  adminPanelOrder: 102,
  adminPanelIcon: '📊',

  requiredPermissions: [PermissionFlagsBits.Administrator],
  requiredIntents: [GatewayIntentBits.Guilds],

  callback: async (context: PanelContext): Promise<PanelResponse> => {
    const panelData = context.data as PanelData;
    const page = panelData?.currentPage || 0;

    if (panelData?.selectedFile) {
      const guildId = context.guildId!;
      const dataFiles = discoverGuildDataFiles(guildId);
      const metadata = dataFiles.find(f => `${f.moduleName}/${f.id}` === panelData.selectedFile);
      const config = createEditorConfig(panelData.selectedFile, guildId, metadata);
      return createV2Response([buildJsonEditorView(config, context)]);
    }

    if (panelData?.selectedModule) {
      return await showModuleView(context, panelData.selectedModule, page);
    }

    return await showModuleList(context, page);
  },

  handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse | null> => {
    const guildId = context.guildId;
    if (!guildId) {
      return showError('This panel can only be used in a guild context.');
    }

    const panelData = context.data as PanelData;

    // Check if this is a JSON editor button - extract file key from button ID
    // Button format: jsonedit_module/file.json, jsonupload_module/file.json, etc.
    const jsonActions = ['jsonedit', 'jsonupload', 'jsondownload', 'jsonrefresh'];
    for (const action of jsonActions) {
      if (buttonId.startsWith(`${action}_`)) {
        const fileKey = buttonId.substring(action.length + 1);
        const dataFiles = discoverGuildDataFiles(guildId);
        const metadata = dataFiles.find(f => `${f.moduleName}/${f.id}` === fileKey);
        const config = createEditorConfig(fileKey, guildId, metadata);

        const result = await handleJsonEditorButton(config, context, buttonId);
        if (result) return result;
        // If no result, return the editor view
        return createV2Response([buildJsonEditorView(config, context)]);
      }
    }

    const parts = buttonId.split('_');
    const action = parts[0];

    switch (action) {
      case 'module': {
        const moduleName = parts.slice(1).join('_');
        if (!moduleName) return showError('No module specified.');
        context.data = { selectedModule: moduleName, currentPage: 0 } as PanelData;
        return await showModuleView(context, moduleName, 0);
      }

      case 'modulepage': {
        const pageNum = parseInt(parts[parts.length - 1], 10);
        const moduleName = parts.slice(1, -1).join('_');
        if (!moduleName) return showError('No module specified.');
        context.data = { selectedModule: moduleName, currentPage: pageNum } as PanelData;
        return await showModuleView(context, moduleName, pageNum);
      }

      case 'page': {
        const pageNum = parseInt(parts[1] || '0', 10);
        context.data = { currentPage: pageNum } as PanelData;
        return await showModuleList(context, pageNum);
      }

      case 'select': {
        const fileKey = parts.slice(1).join('_');
        if (!fileKey) return showError('No data file specified.');
        const fileParts = fileKey.split('/');
        const moduleName = fileParts.length >= 2 ? fileParts[0] : undefined;
        context.data = { selectedFile: fileKey, selectedModule: moduleName } as PanelData;

        const dataFiles = discoverGuildDataFiles(guildId);
        const metadata = dataFiles.find(f => `${f.moduleName}/${f.id}` === fileKey);
        const config = createEditorConfig(fileKey, guildId, metadata);
        return createV2Response([buildJsonEditorView(config, context)]);
      }

      case 'backtomodule': {
        const moduleName = parts.slice(1).join('_');
        if (moduleName) {
          context.data = { selectedModule: moduleName, currentPage: 0 } as PanelData;
          return await showModuleView(context, moduleName, 0);
        }
        context.data = { currentPage: 0 } as PanelData;
        return await showModuleList(context, 0);
      }

      case 'back': {
        context.data = { currentPage: 0 } as PanelData;
        return await showModuleList(context, 0);
      }

      case 'delete': {
        const fileKey = parts.slice(1).join('_');
        if (!fileKey) return showError('No data file specified.');
        return await showDeleteModal(context, fileKey);
      }

      default:
        return showError('Unknown action.');
    }
  },

  handleModal: async (context: PanelContext, modalId: string): Promise<PanelResponse> => {
    const guildId = context.guildId;
    if (!guildId) {
      return showError('This panel can only be used in a guild context.');
    }

    // Check if this is a JSON editor modal - extract file key from modal ID
    // Modal format: jsonedit_module/file.json, jsonupload_module/file.json
    const jsonActions = ['jsonedit', 'jsonupload'];
    for (const action of jsonActions) {
      if (modalId.startsWith(`${action}_`)) {
        const fileKey = modalId.substring(action.length + 1);
        const dataFiles = discoverGuildDataFiles(guildId);
        const metadata = dataFiles.find(f => `${f.moduleName}/${f.id}` === fileKey);
        const config = createEditorConfig(fileKey, guildId, metadata);

        const result = await handleJsonEditorModal(config, context, modalId);
        if (result) return result;
        // If no result, return the editor view
        return createV2Response([buildJsonEditorView(config, context)]);
      }
    }

    // Handle delete modal
    const parts = modalId.split('_');
    const action = parts[0];
    const fileKey = parts.slice(1).join('_');

    if (action === 'delete' && fileKey) {
      const interaction = context.interaction;
      if (!interaction || !('fields' in interaction)) {
        return showError('Invalid interaction.');
      }

      const confirmText = interaction.fields.getTextInputValue('confirm_text');
      if (confirmText.toUpperCase() !== 'DELETE') {
        return showError('Delete cancelled. You must type DELETE to confirm.');
      }

      try {
        saveGuildData(fileKey, guildId, null);
      } catch (error) {
        return showError(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      const fileParts = fileKey.split('/');
      const moduleName = fileParts.length >= 2 ? fileParts[0] : undefined;
      if (moduleName) {
        context.data = { selectedModule: moduleName, currentPage: 0 } as PanelData;
        return await showModuleView(context, moduleName, 0);
      }
      return await showModuleList(context, 0);
    }

    return showError('Invalid modal action.');
  },
};

function groupByModule(files: DataFileMetadata[]): Map<string, DataFileMetadata[]> {
  const grouped = new Map<string, DataFileMetadata[]>();
  for (const file of files) {
    const moduleName = file.moduleName || 'unknown';
    if (!grouped.has(moduleName)) {
      grouped.set(moduleName, []);
    }
    grouped.get(moduleName)!.push(file);
  }
  return grouped;
}

async function showModuleList(context: PanelContext, page: number): Promise<PanelResponse> {
  const guildId = context.guildId;
  if (!guildId) {
    return showError('This panel can only be used in a guild context.');
  }

  const dataFiles = discoverGuildDataFiles(guildId);

  if (dataFiles.length === 0) {
    const container = new ContainerBuilder()
      .setAccentColor(V2Colors.warning)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '## Guild Data Browser\n\n' +
          '**No data files found.**\n\n' +
          'No modules have defined data schemas for guild-specific data yet.'
        )
      );
    return createV2Response([container]);
  }

  const grouped = groupByModule(dataFiles);
  const moduleNames = Array.from(grouped.keys()).sort();

  const totalPages = Math.ceil(moduleNames.length / MODULES_PER_PAGE);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * MODULES_PER_PAGE;
  const pageModules = moduleNames.slice(startIdx, startIdx + MODULES_PER_PAGE);

  const container = new ContainerBuilder().setAccentColor(0x3498DB);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Guild Data Browser')
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Guild:** \`${guildId}\``)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  for (let i = 0; i < pageModules.length; i++) {
    const moduleName = pageModules[i];
    const moduleFiles = grouped.get(moduleName)!;
    const fileCount = moduleFiles.length;
    const withDataCount = moduleFiles.filter(f => {
      if (!f.exists) return false;
      const data = loadGuildData(`${f.moduleName}/${f.id}`, guildId, null);
      return !isDataEmpty(data);
    }).length;

    if (i > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
    }

    const previewItems = moduleFiles.slice(0, MAX_ITEMS_PREVIEW);
    const previewText = previewItems.map(f => {
      const data = f.exists ? loadGuildData(`${f.moduleName}/${f.id}`, guildId, null) : null;
      const icon = getFileIcon(f, data);
      return `↳ ${icon} ${f.name}`;
    }).join('\n');
    const hasMore = fileCount > MAX_ITEMS_PREVIEW;
    const displayText = hasMore ? `${previewText}\n↳ ...` : previewText;

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**📁 ${moduleName}**`),
          new TextDisplayBuilder().setContent(displayText)
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`panel_${PANEL_ID}_btn_module_${moduleName}`)
            .setLabel(`Open (${withDataCount}/${fileCount})`)
            .setStyle(ButtonStyle.Primary)
        )
    );
  }

  // Always show pagination (DEV.md: buttons disable at boundaries, never hide)
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_${PANEL_ID}_btn_page_${currentPage - 1}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`panel_${PANEL_ID}_btn_page_info`)
        .setLabel(`${currentPage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`panel_${PANEL_ID}_btn_page_${currentPage + 1}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1)
    )
  );

  return createV2Response([container]);
}

async function showModuleView(context: PanelContext, moduleName: string, page: number): Promise<PanelResponse> {
  const guildId = context.guildId;
  if (!guildId) {
    return showError('This panel can only be used in a guild context.');
  }

  const allFiles = discoverGuildDataFiles(guildId);
  const moduleFiles = allFiles.filter(f => f.moduleName === moduleName);

  if (moduleFiles.length === 0) {
    const container = new ContainerBuilder()
      .setAccentColor(V2Colors.warning)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${moduleName}\n\n` +
          '**No data files found for this module.**'
        )
      )
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`panel_${PANEL_ID}_btn_back`)
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary)
        )
      );
    return createV2Response([container]);
  }

  const totalPages = Math.ceil(moduleFiles.length / FILES_PER_PAGE);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * FILES_PER_PAGE;
  const pageFiles = moduleFiles.slice(startIdx, startIdx + FILES_PER_PAGE);

  const container = new ContainerBuilder().setAccentColor(0x3498DB);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${moduleName}`)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Guild:** \`${guildId}\``)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  for (const file of pageFiles) {
    const fileKey = `${file.moduleName}/${file.id}`;
    const data = file.exists ? loadGuildData(fileKey, guildId, null) : null;
    const icon = getFileIcon(file, data);
    const hasData = !isDataEmpty(data);

    let statusText: string;
    let buttonStyle: ButtonStyle;

    if (hasData) {
      const itemCount = getDataItemCount(data);
      statusText = `-# *${itemCount} ${Array.isArray(data) ? 'items' : 'properties'}*`;
      buttonStyle = ButtonStyle.Primary;
    } else if (file.exists) {
      statusText = `-# *empty*`;
      buttonStyle = ButtonStyle.Secondary;
    } else {
      statusText = hasUsefulTemplate(file) ? `-# *template available*` : `-# *not created*`;
      buttonStyle = ButtonStyle.Secondary;
    }

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**${icon} ${file.name}**`),
          new TextDisplayBuilder().setContent(statusText)
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`panel_${PANEL_ID}_btn_select_${fileKey}`)
            .setLabel('View')
            .setStyle(buttonStyle)
        )
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Always show pagination (DEV.md: buttons disable at boundaries, never hide)
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_${PANEL_ID}_btn_modulepage_${moduleName}_${currentPage - 1}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`panel_${PANEL_ID}_btn_page_info`)
        .setLabel(`${currentPage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`panel_${PANEL_ID}_btn_modulepage_${moduleName}_${currentPage + 1}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId(`panel_${PANEL_ID}_btn_back`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return createV2Response([container]);
}

async function showDeleteModal(context: PanelContext, fileKey: string): Promise<PanelResponse> {
  const parts = fileKey.split('/');
  const displayName = parts.length >= 2 ? parts[parts.length - 1] : fileKey;

  const modal = new ModalBuilder()
    .setCustomId(`panel_${PANEL_ID}_modal_delete_${fileKey}`)
    .setTitle('Confirm Delete');

  const confirmInput = new TextInputBuilder()
    .setCustomId('confirm_text')
    .setLabel(`Type DELETE to confirm removing ${displayName}`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('DELETE')
    .setRequired(true)
    .setMinLength(6)
    .setMaxLength(6);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(confirmInput));

  return { modal: modal } as any;
}

export default dataBrowserGuildPanel;

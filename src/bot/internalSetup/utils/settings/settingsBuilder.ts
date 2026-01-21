/**
 * Settings Builder
 *
 * Builds UI components for the Module Settings Panel.
 */

import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  SectionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  FileUploadBuilder,
  LabelBuilder,
} from 'discord.js';
import type {
  SettingsSchema,
  SectionDefinition,
  SettingDefinition,
  MergedSettings,
} from '@bot/types/settingsTypes';
import { COLOR_PRESETS } from '@bot/types/settingsTypes';
import { V2Colors } from '../panel/v2';
import { buildSettingComponent, SettingComponentOptions } from './settingComponents';
import { evaluateConditions } from './settingsValidation';
import { paginate, PAGINATION_DEFAULTS, PaginatedResult } from '../panel/paginationUtils';

/** Max settings per page to stay under 40 component limit
 * Each setting = 3 components (Section + 1 TextDisplay + Button)
 * Fixed overhead = ~19 components
 * Budget: 40 - 19 = 21 / 3 = 7 settings max, use 6 for safety
 */
const SETTINGS_PER_PAGE = 6;

export interface SettingsPanelOptions {
  schema: SettingsSchema;
  settings: MergedSettings;
  currentSection: string;
  currentPage: number;
  moduleName: string;
  category: string;
  panelId: string;
  isDirty?: boolean;
  /** Whether this is the System panel (shows absolute limits, enables hard limit editing) */
  isSystemPanel?: boolean;
  /** Hard limit overrides from global settings */
  hardLimits?: Record<string, import('@bot/types/settingsTypes').HardLimitOverride>;
}

function getSortedSections(schema: SettingsSchema): SectionDefinition[] {
  return [...schema.sections].sort((a, b) => a.order - b.order);
}

function getSettingsForSection(
  schema: SettingsSchema,
  sectionId: string
): Array<{ key: string; definition: SettingDefinition }> {
  const settings: Array<{ key: string; definition: SettingDefinition }> = [];
  for (const [key, definition] of Object.entries(schema.settings)) {
    if (definition.section === sectionId) {
      settings.push({ key, definition });
    }
  }
  return settings.sort((a, b) => a.definition.order - b.definition.order);
}

export function buildSettingsPanel(options: SettingsPanelOptions): ContainerBuilder[] {
  const {
    schema, settings, currentSection, currentPage,
    moduleName, category, panelId,
    isDirty = false, isSystemPanel = false, hardLimits = {},
  } = options;

  // Determine color based on state:
  // - Unsaved changes = success (lime green)
  // - Any customized values (saved) = primary (blue)
  // - All default = secondary (gray)
  let accentColor: number = V2Colors.secondary; // Gray for all defaults

  // Check if any settings are customized (source is 'guild' or 'global')
  const hasCustomized = Object.values(settings.sources).some(
    source => source === 'guild' || source === 'global'
  );
  if (hasCustomized) {
    accentColor = V2Colors.primary; // Blue for customized
  }
  if (isDirty) {
    accentColor = V2Colors.success; // Lime green for unsaved changes
  }

  const container = new ContainerBuilder()
    .setAccentColor(accentColor);

  // Header (combined into single TextDisplay)
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${schema.name} Settings\n-# ${schema.description || 'Configure module settings'}`)
  );
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  // Section selector (only if multiple sections)
  const sortedSections = getSortedSections(schema);
  if (sortedSections.length > 1) {
    const sectionOptions = sortedSections.map(s => {
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel(s.name).setValue(s.id).setDefault(s.id === currentSection);
      if (s.description) opt.setDescription(s.description);
      if (s.icon) opt.setEmoji(s.icon);
      return opt;
    });
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`panel_${panelId}_dropdown_section_${moduleName}_${category}`)
          .setPlaceholder('Select section...')
          .addOptions(sectionOptions)
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  }

  // Section header
  const sectionInfo = sortedSections.find(s => s.id === currentSection);
  if (sectionInfo) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${sectionInfo.icon || ''} ${sectionInfo.name}**`.trim())
    );
  }

  // Get visible settings for this section
  const allSectionSettings = getSettingsForSection(schema, currentSection);
  const visibleSettings = allSectionSettings.filter(({ definition }) => {
    const conditionState = evaluateConditions(definition.conditions, settings.values);
    return conditionState.visible;
  });

  // Pagination using shared utility
  // Button format: panel_{panelId}_btn_nav_{moduleName}_{category}_{prev|next}_{page}
  const navPrefix = `panel_${panelId}_btn_nav_${moduleName}_${category}`;
  const paginated = paginate(visibleSettings, currentPage, {
    itemsPerPage: SETTINGS_PER_PAGE,
    buttonPrefix: navPrefix,
  });

  // Render settings for current page
  for (const { key, definition } of paginated.items) {
    const conditionState = evaluateConditions(definition.conditions, settings.values);

    const componentOptions: SettingComponentOptions = {
      panelId, settingKey: key, definition,
      value: settings.values[key],
      source: settings.sources[key],
      defaultValue: definition.default,
      disabled: conditionState.disabled,
      moduleName, category,
      isSystemPanel,
      hardLimitOverride: hardLimits[key],
    };

    const components = buildSettingComponent(componentOptions);
    for (const component of components) {
      container.addSectionComponents(component);
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  // Pagination controls - always shown, buttons disabled at boundaries
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${navPrefix}_prev_${paginated.currentPage}`)
        .setLabel(PAGINATION_DEFAULTS.prevLabel)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!paginated.hasPrev),
      new ButtonBuilder()
        .setCustomId(`${navPrefix}_page_${paginated.currentPage}`)
        .setLabel(PAGINATION_DEFAULTS.pageFormat(paginated.currentPage + 1, paginated.totalPages))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${navPrefix}_next_${paginated.currentPage}`)
        .setLabel(PAGINATION_DEFAULTS.nextLabel)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!paginated.hasNext)
    )
  );

  // Dirty indicator
  if (isDirty) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# *Unsaved changes*'));
  }

  // Action buttons - single row
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_${panelId}_btn_save_${moduleName}_${category}`)
        .setLabel('Save')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!isDirty),
      new ButtonBuilder()
        .setCustomId(`panel_${panelId}_btn_reset_${moduleName}_${category}`)
        .setLabel('Reset All')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`panel_${panelId}_btn_upload_${moduleName}_${category}`)
        .setLabel('Upload')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`panel_${panelId}_btn_download_${moduleName}_${category}`)
        .setLabel('Download')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return [container];
}

export function buildEditModal(
  panelId: string, settingKey: string, moduleName: string, category: string,
  definition: SettingDefinition, currentValue: any
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_edit_${settingKey}_${moduleName}_${category}`)
    .setTitle(`Edit ${definition.label}`.substring(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(definition.label)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(definition.placeholder || `Enter ${definition.type}...`)
          .setValue(String(currentValue ?? ''))
          .setRequired(definition.validation?.required ?? false)
      )
    );
}

export function buildResetModal(panelId: string, moduleName: string, category: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_reset_${moduleName}_${category}`)
    .setTitle('Confirm Reset to Defaults')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('confirm_text')
          .setLabel('Type RESET to confirm')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('RESET')
          .setRequired(true).setMinLength(5).setMaxLength(5)
      )
    );
}

export function buildUploadModal(panelId: string, moduleName: string, category: string, schemaName: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_upload_${moduleName}_${category}`)
    .setTitle(`Upload ${schemaName} Settings`.substring(0, 45));

  const fileUpload = new FileUploadBuilder()
    .setCustomId('json_file')
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);

  const fileLabel = new LabelBuilder()
    .setLabel('JSON File')
    .setDescription('Select a .json settings file to upload')
    .setFileUploadComponent(fileUpload);

  modal.addLabelComponents(fileLabel);
  return modal;
}

export function buildErrorPanel(message: string): ContainerBuilder[] {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Error\n${message}`));
  return [container];
}

/**
 * Build a select edit modal for select/multiSelect types
 */
export function buildSelectEditModal(
  panelId: string, settingKey: string, moduleName: string, category: string,
  definition: SettingDefinition, currentValue: any
): ModalBuilder {
  const isMulti = definition.type === 'multiSelect';
  const options = definition.options || [];
  const currentValues = isMulti
    ? (Array.isArray(currentValue) ? currentValue : [])
    : (currentValue ? [currentValue] : []);

  const modal = new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_${isMulti ? 'multiselect' : 'select'}_${settingKey}_${moduleName}_${category}`)
    .setTitle(`Edit ${definition.label}`.substring(0, 45));

  const selectOptions = options.map(opt => {
    const optBuilder = new StringSelectMenuOptionBuilder()
      .setLabel(opt.label)
      .setValue(opt.value)
      .setDefault(currentValues.includes(opt.value));
    if (opt.description) optBuilder.setDescription(opt.description);
    return optBuilder;
  });

  if (selectOptions.length > 0) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('value')
      .setPlaceholder(definition.placeholder || 'Select...')
      .addOptions(selectOptions);

    if (isMulti) {
      selectMenu.setMinValues(0).setMaxValues(selectOptions.length);
    }

    const selectLabel = new LabelBuilder()
      .setLabel(definition.label)
      .setDescription(definition.description || 'Select a value')
      .setStringSelectMenuComponent(selectMenu);

    modal.addLabelComponents(selectLabel);
  }

  return modal;
}

/**
 * Build a channel edit modal for channel/multiChannel types
 */
export function buildChannelEditModal(
  panelId: string, settingKey: string, moduleName: string, category: string,
  definition: SettingDefinition
): ModalBuilder {
  const isMulti = definition.type === 'multiChannel';
  const channelTypes = definition.channelTypes || [ChannelType.GuildText];

  const modal = new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_${isMulti ? 'multichannel' : 'channel'}_${settingKey}_${moduleName}_${category}`)
    .setTitle(`Edit ${definition.label}`.substring(0, 45));

  const selectMenu = new ChannelSelectMenuBuilder()
    .setCustomId('value')
    .setPlaceholder(definition.placeholder || 'Select channel...')
    .setChannelTypes(channelTypes);

  if (isMulti) {
    selectMenu.setMinValues(0).setMaxValues(25);
  }

  const selectLabel = new LabelBuilder()
    .setLabel(definition.label)
    .setDescription(definition.description || 'Select a channel')
    .setChannelSelectMenuComponent(selectMenu);

  modal.addLabelComponents(selectLabel);

  return modal;
}

/**
 * Build a role edit modal for role/multiRole types
 */
export function buildRoleEditModal(
  panelId: string, settingKey: string, moduleName: string, category: string,
  definition: SettingDefinition
): ModalBuilder {
  const isMulti = definition.type === 'multiRole';

  const modal = new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_${isMulti ? 'multirole' : 'role'}_${settingKey}_${moduleName}_${category}`)
    .setTitle(`Edit ${definition.label}`.substring(0, 45));

  const selectMenu = new RoleSelectMenuBuilder()
    .setCustomId('value')
    .setPlaceholder(definition.placeholder || 'Select role...');

  if (isMulti) {
    selectMenu.setMinValues(0).setMaxValues(25);
  }

  const selectLabel = new LabelBuilder()
    .setLabel(definition.label)
    .setDescription(definition.description || 'Select a role')
    .setRoleSelectMenuComponent(selectMenu);

  modal.addLabelComponents(selectLabel);

  return modal;
}

/**
 * Build a color edit modal with preset dropdown + custom hex input
 */
export function buildColorEditModal(
  panelId: string, settingKey: string, moduleName: string, category: string,
  definition: SettingDefinition, currentValue: any
): ModalBuilder {
  const currentHex = String(currentValue || '').toUpperCase();

  // Check if current value matches a preset
  const matchingPreset = COLOR_PRESETS.find(p => p.hex.toUpperCase() === currentHex);

  const modal = new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_color_${settingKey}_${moduleName}_${category}`)
    .setTitle(`Edit ${definition.label}`.substring(0, 45));

  // Build dropdown options: "Custom" option first, then presets
  const selectOptions = [
    new StringSelectMenuOptionBuilder()
      .setLabel('Custom Hex')
      .setValue('__custom__')
      .setDescription('Use the custom hex input below')
      .setEmoji('🎨')
      .setDefault(!matchingPreset),
    ...COLOR_PRESETS.map(preset => {
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${preset.hex} - ${preset.name}`)
        .setValue(preset.hex)
        .setEmoji(preset.emoji)
        .setDefault(matchingPreset?.hex === preset.hex);
    }),
  ];

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('color_preset')
    .setPlaceholder('Select a color...')
    .addOptions(selectOptions);

  const selectLabel = new LabelBuilder()
    .setLabel('Color Preset')
    .setDescription('Choose a preset or use custom hex below')
    .setStringSelectMenuComponent(selectMenu);

  modal.addLabelComponents(selectLabel);

  // Custom hex input - only filled if no preset matches
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('custom_hex')
        .setLabel('Custom Hex (overrides preset)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('0xRRGGBB')
        .setValue(matchingPreset ? '' : currentHex)
        .setRequired(false)
        .setMaxLength(8)
    )
  );

  return modal;
}

// ============================================================================
// System Panel Edit Modals (with Hard Limit editing)
// ============================================================================

import type { HardLimitOverride, ValidationRules } from '@bot/types/settingsTypes';

/**
 * Build System panel edit modal for number types
 * Includes Default Value + Hard Limit Min + Hard Limit Max fields
 */
export function buildSystemNumberEditModal(
  panelId: string,
  settingKey: string,
  moduleName: string,
  category: string,
  definition: SettingDefinition,
  currentValue: any,
  currentHardLimits: HardLimitOverride,
  schemaValidation: ValidationRules | undefined
): ModalBuilder {
  const v = schemaValidation || {};

  // Build placeholder with absolute limit info if defined
  let minPlaceholder = 'Leave empty for schema default';
  let maxPlaceholder = 'Leave empty for schema default';

  if (v.absoluteMin !== undefined) {
    minPlaceholder = `Min allowed: ${v.absoluteMin}`;
  }
  if (v.absoluteMax !== undefined) {
    maxPlaceholder = `Max allowed: ${v.absoluteMax}`;
  }

  return new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_sysedit_${settingKey}_${moduleName}_${category}`)
    .setTitle(`System: ${definition.label}`.substring(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Default Value')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(definition.placeholder || `Enter ${definition.type}...`)
          .setValue(String(currentValue ?? ''))
          .setRequired(false)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('hard_min')
          .setLabel(`Hard Limit: Minimum${v.min !== undefined ? ` (Schema: ${v.min})` : ''}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(minPlaceholder)
          .setValue(currentHardLimits.min !== undefined ? String(currentHardLimits.min) : '')
          .setRequired(false)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('hard_max')
          .setLabel(`Hard Limit: Maximum${v.max !== undefined ? ` (Schema: ${v.max})` : ''}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(maxPlaceholder)
          .setValue(currentHardLimits.max !== undefined ? String(currentHardLimits.max) : '')
          .setRequired(false)
      )
    );
}

/**
 * Build System panel edit modal for string types
 * Includes Default Value + Hard Limit MinLength + Hard Limit MaxLength fields
 */
export function buildSystemStringEditModal(
  panelId: string,
  settingKey: string,
  moduleName: string,
  category: string,
  definition: SettingDefinition,
  currentValue: any,
  currentHardLimits: HardLimitOverride,
  schemaValidation: ValidationRules | undefined
): ModalBuilder {
  const v = schemaValidation || {};

  // Build placeholder with absolute limit info if defined
  let minPlaceholder = 'Leave empty for schema default';
  let maxPlaceholder = 'Leave empty for schema default';

  if (v.absoluteMinLength !== undefined) {
    minPlaceholder = `Min allowed: ${v.absoluteMinLength}`;
  }
  if (v.absoluteMaxLength !== undefined) {
    maxPlaceholder = `Max allowed: ${v.absoluteMaxLength}`;
  }

  return new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_sysedit_${settingKey}_${moduleName}_${category}`)
    .setTitle(`System: ${definition.label}`.substring(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Default Value')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder(definition.placeholder || 'Enter value...')
          .setValue(String(currentValue ?? ''))
          .setRequired(false)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('hard_min_length')
          .setLabel(`Hard Limit: Min Length${v.minLength !== undefined ? ` (Schema: ${v.minLength})` : ''}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(minPlaceholder)
          .setValue(currentHardLimits.minLength !== undefined ? String(currentHardLimits.minLength) : '')
          .setRequired(false)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('hard_max_length')
          .setLabel(`Hard Limit: Max Length${v.maxLength !== undefined ? ` (Schema: ${v.maxLength})` : ''}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(maxPlaceholder)
          .setValue(currentHardLimits.maxLength !== undefined ? String(currentHardLimits.maxLength) : '')
          .setRequired(false)
      )
    );
}

/**
 * Build System panel edit modal for multi-select types
 * Includes Hard Limit MinItems + Hard Limit MaxItems fields
 */
export function buildSystemMultiSelectEditModal(
  panelId: string,
  settingKey: string,
  moduleName: string,
  category: string,
  definition: SettingDefinition,
  currentHardLimits: HardLimitOverride,
  schemaValidation: ValidationRules | undefined
): ModalBuilder {
  const v = schemaValidation || {};

  // Build placeholder with absolute limit info if defined
  let minPlaceholder = 'Leave empty for schema default';
  let maxPlaceholder = 'Leave empty for schema default';

  if (v.absoluteMinItems !== undefined) {
    minPlaceholder = `Min allowed: ${v.absoluteMinItems}`;
  }
  if (v.absoluteMaxItems !== undefined) {
    maxPlaceholder = `Max allowed: ${v.absoluteMaxItems}`;
  }

  return new ModalBuilder()
    .setCustomId(`panel_${panelId}_modal_sysedit_${settingKey}_${moduleName}_${category}`)
    .setTitle(`System: ${definition.label}`.substring(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('hard_min_items')
          .setLabel(`Hard Limit: Min Items${v.minItems !== undefined ? ` (Schema: ${v.minItems})` : ''}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(minPlaceholder)
          .setValue(currentHardLimits.minItems !== undefined ? String(currentHardLimits.minItems) : '')
          .setRequired(false)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('hard_max_items')
          .setLabel(`Hard Limit: Max Items${v.maxItems !== undefined ? ` (Schema: ${v.maxItems})` : ''}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(maxPlaceholder)
          .setValue(currentHardLimits.maxItems !== undefined ? String(currentHardLimits.maxItems) : '')
          .setRequired(false)
      )
    );
}

/**
 * Find a color preset by hex value
 */
export function findColorPreset(hex: string): typeof COLOR_PRESETS[0] | undefined {
  return COLOR_PRESETS.find(p => p.hex.toUpperCase() === hex.toUpperCase());
}

/**
 * Format a color value for display
 */
export function formatColorDisplay(hex: string): string {
  const preset = findColorPreset(hex);
  if (preset) {
    return `${preset.emoji} \`${preset.hex}\` ${preset.name}`;
  }
  return `🎨 \`${hex}\` Custom`;
}

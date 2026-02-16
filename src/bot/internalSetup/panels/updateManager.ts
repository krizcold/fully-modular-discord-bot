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
  Client,
} from 'discord.js';
import { PanelOptions, PanelContext, PanelResponse } from '../../types/panelTypes';
import {
  checkForBotUpdates,
  smartBotUpdate,
  requestBotUpdate,
  getBotUpdateStatus,
  getBotBuildStatus,
  checkForAllBotUpdates,
  triggerModuleUpdate,
  triggerAllModuleUpdates,
  CombinedUpdateCheckResult
} from '../utils/botManagerAPI';
import { updatePanelDynamic } from '../utils/panel/persistentPanelResponse';
import { updatePersistentPanelState, removePersistentPanel } from '../utils/panel/persistentPanelStorage';
import { DISCORD_EPHEMERAL_FLAG } from '../../constants';
import { createV2Response, V2Colors } from '../utils/panel/v2';

// Store panel owners for security
const panelOwners = new Map<string, string>(); // messageId -> userId

const updateManagerPanel: PanelOptions = {
  id: 'update_manager',
  name: 'Bot Update Manager',
  description: 'Check for updates and manage bot update process',
  category: 'System',
  panelScope: 'system',
  devOnly: true,

  persistent: true,
  unique: true, // Only ONE instance can be active at once - old panels are deactivated
  persistentWarningMessage: 'Panel will be visible to everyone.',

  showInAdminPanel: true,
  adminPanelOrder: 1,
  adminPanelIcon: '🔄',
  mainGuildOnly: true,

  requiredPermissions: [PermissionFlagsBits.Administrator],
  requiredIntents: [GatewayIntentBits.Guilds],

  callback: async (context: PanelContext): Promise<PanelResponse> => {
    // Return "checking" view immediately
    // Actual update check happens in onPersistentCreated (after panel is stored)
    return buildPanelView(context, 'checking');
  },

  // Called after persistent panel is created and stored
  onPersistentCreated: (client, guildId: string, messageId: string, channelId: string) => {
    // Store panel owner for security checks
    panelOwners.set(messageId, ''); // Will be set on first interaction

    // Trigger async combined update check
    setImmediate(async () => {
      try {
        const combinedCheck = await checkForAllBotUpdates();

        // Create context for updating the panel
        const updateContext: PanelContext = {
          client,
          interaction: null,
          panelId: 'update_manager',
          userId: '',
          guildId,
          accessMethod: 'direct_command',
          navigationStack: []
        };

        const resultResponse = buildPanelView(updateContext, 'main', combinedCheck || {
          success: false,
          lastChecked: new Date().toISOString(),
          baseCode: { checked: false, hasUpdates: false, error: 'Failed to check for updates' },
          modules: { checked: false, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
          summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false }
        });

        // Update the panel message with results
        await updatePanelDynamic(updateContext, 'update_manager', resultResponse);

        if (combinedCheck) {
          await updatePersistentPanelState('update_manager', 'checked', guildId, undefined, {
            lastCheckResult: combinedCheck
          });
        }
      } catch (error) {
        console.error('[UpdateManagerPanel] Auto-check error:', error);
      }
    });
  },

  handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse> => {
    console.log(`[UpdateManagerPanel] Button ${buttonId} pressed by ${context.userId}`);

    // Security check: Only panel owner can interact
    if (context.interaction && 'message' in context.interaction && context.interaction.message) {
      const messageId = context.interaction.message.id;
      const ownerId = panelOwners.get(messageId);

      if (ownerId && ownerId !== context.userId) {
        const errorContainer = new ContainerBuilder()
          .setAccentColor(V2Colors.danger)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('Only the user who opened this panel can interact with it.')
          );
        return createV2Response([errorContainer], true);
      }

      // Store owner if not set (for recovery after bot restart)
      if (!ownerId) {
        panelOwners.set(messageId, context.userId);
      }
    }

    switch (buttonId) {
      case 'architecture':
        return await handleUpdateMode(context, 'basic');
      case 'keep_custom':
        return await handleUpdateMode(context, 'relative');
      case 'everything':
        return await handleUpdateMode(context, 'full');
      case 'check_updates':
        return await handleCheckUpdates(context);
      case 'update_all_modules':
        return await handleUpdateAllModules(context);
      case 'information':
        return buildInformationView(context);
      case 'close':
        return await handleClosePanel(context);
      case 'back_to_main':
        return buildPanelView(context, 'main');
      default:
        // Handle dynamic module update buttons (update_module_{name})
        if (buttonId.startsWith('update_module_')) {
          const moduleName = buttonId.replace('update_module_', '');
          return await handleUpdateSingleModule(context, moduleName);
        }
        return buildPanelView(context, 'main');
    }
  },
};

/**
 * Helper: Get status display with emoji indicator for combined updates
 */
function getStatusDisplay(status: any, isChecking: boolean = false, isUpdating: boolean = false, combinedCheck?: CombinedUpdateCheckResult | null): string {
  if (isUpdating) return '🟡 Updating...';
  if (isChecking) return '🟡 Checking...';
  if (status.inProgress) return '🟡 Update in progress';

  // Check combined update result
  if (combinedCheck) {
    if (!combinedCheck.success) return '🔴 Error';
    if (combinedCheck.summary.hasAnyUpdates) {
      const total = combinedCheck.summary.totalUpdatesAvailable;
      return `🟠 ${total} Update${total > 1 ? 's' : ''} Available`;
    }
    return '🟢 Up to Date';
  }

  // Fall back to persisted status
  if (status.lastError) return '🔴 Error';
  if (status.hasUpdates) return '🟠 Updates Available';
  if (status.lastCheck) return '🟢 Up to Date';
  return '🟢 Ready';
}

/**
 * Helper: Get mode display
 */
function getModeDisplay(status: any): string {
  return status.mode || 'None';
}

/**
 * Helper: Truncate module name for button labels
 * Discord button labels have 80 char limit, but we want shorter for UI
 */
function truncateModuleName(name: string, maxLength: number = 12): string {
  if (name.length <= maxLength) return name;
  return name.substring(0, maxLength - 1) + '…';
}

/**
 * Helper: Format date as "day month, year" (e.g., "1 December 2025")
 */
function formatDate(dateInput: string | number | undefined): string {
  if (!dateInput) return 'Unknown';
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return 'Unknown';

  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  return `${date.getDate()} ${months[date.getMonth()]}, ${date.getFullYear()}`;
}

/**
 * Helper: Get last check display
 */
function getLastCheckDisplay(status: any): string {
  if (!status.lastCheck) return 'Never';
  return formatDate(status.lastCheck);
}

/**
 * Helper: Get release date display
 */
function getReleaseDateDisplay(updateCheck?: any): string {
  if (updateCheck?.latestVersionDate) {
    return formatDate(updateCheck.latestVersionDate);
  }
  return 'Unknown';
}

/**
 * Helper: Get accent color based on status
 */
function getAccentColor(statusDisplay: string): number {
  if (statusDisplay.startsWith('🔴')) return V2Colors.danger; // Red
  if (statusDisplay.startsWith('🟡')) return 0xF1C40F; // Yellow
  if (statusDisplay.startsWith('🟠')) return 0xE67E22; // Orange
  if (statusDisplay.startsWith('🟢') && statusDisplay.includes('Up to Date')) return V2Colors.success; // Green
  return V2Colors.primary; // Blue default
}

/**
 * Build standard action buttons (3 rows)
 * Row 1: Base code update modes
 * Row 2: Module updates (if any available)
 * Row 3: Check/Info/Close
 */
function buildButtons(disabled: boolean = false, combinedCheck?: CombinedUpdateCheckResult | null): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Row 1: Base code update modes
  const row1 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_architecture')
        .setLabel('🔄 Architecture')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_keep_custom')
        .setLabel('🔄 Keep custom')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_everything')
        .setLabel('🔄 Everything')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  rows.push(row1);

  // Row 2: Module updates (only if modules with updates exist)
  if (combinedCheck?.modules.updatesAvailable && combinedCheck.modules.updatesAvailable > 0) {
    const moduleRow = new ActionRowBuilder<ButtonBuilder>();

    // Add "Update All Modules" button
    moduleRow.addComponents(
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_update_all_modules')
        .setLabel(`📦 Update All (${combinedCheck.modules.updatesAvailable})`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled)
    );

    // Add individual module update buttons (max 4 to fit in row)
    const modulesWithUpdates = combinedCheck.modules.updates.filter(u => u.hasUpdate).slice(0, 4);
    for (const mod of modulesWithUpdates) {
      moduleRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`panel_update_manager_btn_update_module_${mod.moduleName}`)
          .setLabel(`📦 ${truncateModuleName(mod.moduleName)}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled)
      );
    }

    rows.push(moduleRow);
  }

  // Row 3: Check/Info/Close
  const row3 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_check_updates')
        .setLabel('🔍 Check Updates')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_information')
        .setLabel('ℹ️ Information')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_close')
        .setLabel('❌ Close')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    );
  rows.push(row3);

  return rows;
}

/**
 * Build information view with ONLY back button
 */
function buildInformationView(context: PanelContext): PanelResponse {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.info);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Bot Update Manager\n**Update Mode Information**')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Architecture mode
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '## Architecture\n' +
      'Only update INTERNAL Events and Commands\n' +
      '• Updates core bot infrastructure\n' +
      '• Preserves all custom modules\n' +
      '• Safest option for custom setups'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  // Keep custom mode
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '## Keep Custom\n' +
      'Update all default Events and Commands, while preserving any custom ones\n' +
      '• Updates default modules to latest version\n' +
      '• Keeps your custom modules intact\n' +
      '• Recommended for most users'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  // Everything mode
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '## Everything\n' +
      'Replaces EVERY Command and Event with new ones (removing any possibly obsolete/custom)\n' +
      '• Complete fresh installation\n' +
      '• Removes all custom modifications\n' +
      '• Data is not lost\n' +
      '• Use when experiencing issues'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Back button
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_back_to_main')
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return createV2Response([container]);
}

/**
 * Handle close panel - deletes the persistent panel message
 */
async function handleClosePanel(context: PanelContext): Promise<PanelResponse> {
  // Delete the persistent panel message and storage
  if (context.interaction && 'message' in context.interaction && context.interaction.message) {
    try {
      // Remove from storage first
      await removePersistentPanel('update_manager', context.guildId || undefined);
      // Delete the Discord message
      await context.interaction.message.delete();
      console.log('[UpdateManagerPanel] Panel closed and deleted');
    } catch (error) {
      console.error('[UpdateManagerPanel] Failed to delete panel:', error);
    }
  }

  // Return null - message already deleted, no response needed
  return null as any;
}

/**
 * Build main panel view with V2 components
 */
function buildPanelView(
  context: PanelContext,
  view: 'main' | 'checking' | 'updating' | 'updating_modules',
  combinedCheck?: CombinedUpdateCheckResult | null
): PanelResponse {
  const status = getBotUpdateStatus();

  // Store panel owner
  if (context.interaction && 'message' in context.interaction && context.interaction.message) {
    panelOwners.set(context.interaction.message.id, context.userId);
  }

  // Determine status display
  const isChecking = view === 'checking';
  const isUpdating = view === 'updating' || view === 'updating_modules';
  const statusDisplay = getStatusDisplay(status, isChecking, isUpdating, combinedCheck);

  // Determine accent color
  const accentColor = getAccentColor(statusDisplay);

  // Build V2 container
  const container = new ContainerBuilder()
    .setAccentColor(accentColor);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Bot Update Manager')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Status grid - using inline format
  const lastChecked = combinedCheck?.lastChecked ? formatDate(combinedCheck.lastChecked) : getLastCheckDisplay(status);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Status:** ${statusDisplay} | **Mode:** ${getModeDisplay(status)}\n` +
      `**Last Check:** ${lastChecked}`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Build details content
  let detailsContent = '';

  if (isChecking) {
    detailsContent = 'Connecting to update server...\nChecking base code updates...\nChecking module updates...';
  } else if (view === 'updating') {
    detailsContent = 'Preparing update environment...\nBacking up current configuration...\nDownloading latest version...';
  } else if (view === 'updating_modules') {
    detailsContent = 'Updating modules...\nBacking up current modules...\nInstalling new versions...';
  } else if (combinedCheck) {
    if (!combinedCheck.success) {
      const baseError = combinedCheck.baseCode.error;
      const moduleErrors = combinedCheck.modules.errors.map(e => e.error).join(', ');
      detailsContent = `Errors occurred:\n${baseError ? `- Base: ${baseError}\n` : ''}${moduleErrors ? `- Modules: ${moduleErrors}` : ''}`;
    } else {
      // Base code section
      detailsContent = '=== Base Code ===\n';
      if (combinedCheck.baseCode.hasUpdates) {
        detailsContent += `Updates available (${combinedCheck.baseCode.commitsBehind || '?'} commits behind)\n`;
      } else {
        detailsContent += 'Up to date\n';
      }

      // Modules section
      detailsContent += '\n=== Modules ===\n';
      detailsContent += `Installed: ${combinedCheck.modules.totalInstalled}\n`;

      if (combinedCheck.modules.updatesAvailable > 0) {
        detailsContent += `Updates available: ${combinedCheck.modules.updatesAvailable}\n`;
        const modulesWithUpdates = combinedCheck.modules.updates.filter(u => u.hasUpdate);
        for (const mod of modulesWithUpdates) {
          detailsContent += `  • ${mod.moduleName}: ${mod.installedVersion} → ${mod.availableVersion}\n`;
        }
      } else if (combinedCheck.modules.totalInstalled === 0) {
        detailsContent += 'No modules installed\n';
      } else {
        detailsContent += 'All modules up to date\n';
      }

      // Errors if any
      if (combinedCheck.modules.errors.length > 0) {
        detailsContent += '\nModule errors:\n';
        for (const err of combinedCheck.modules.errors) {
          detailsContent += `  • ${err.moduleName}: ${err.error}\n`;
        }
      }
    }
  } else if (status.lastError) {
    detailsContent = `Error: ${status.lastError}\n\nPlease check:\n- API configuration\n- Network connectivity`;
  }

  // Details section with code block
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Details:**\n\`\`\`\n${detailsContent || 'No details available. Click "Check Updates" to scan.'}\n\`\`\``
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Buttons disabled only during checking/updating
  const buttonsDisabled = isChecking || isUpdating || status.inProgress;

  // Add button rows to container
  const buttonRows = buildButtons(buttonsDisabled, combinedCheck);
  for (const row of buttonRows) {
    container.addActionRowComponents(row);
  }

  return createV2Response([container]);
}

/**
 * Handle check updates button - checks both base code and modules
 */
async function handleCheckUpdates(context: PanelContext): Promise<PanelResponse> {
  // Return immediate "checking" state
  const checkingResponse = buildPanelView(context, 'checking');

  // Perform combined check in background
  setImmediate(async () => {
    try {
      const combinedCheck = await checkForAllBotUpdates();

      if (!combinedCheck) {
        // Failed to check
        const errorResponse = buildPanelView(context, 'main', {
          success: false,
          lastChecked: new Date().toISOString(),
          baseCode: { checked: false, hasUpdates: false, error: 'Failed to check for updates' },
          modules: { checked: false, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
          summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false }
        });

        await updatePanelDynamic(context, 'update_manager', errorResponse);
      } else {
        const resultResponse = buildPanelView(context, 'main', combinedCheck);

        await updatePanelDynamic(context, 'update_manager', resultResponse);

        await updatePersistentPanelState('update_manager', 'checked', context.guildId || undefined, undefined, {
          lastCheckResult: combinedCheck
        });
      }
    } catch (error) {
      console.error('[UpdateManagerPanel] Error checking updates:', error);

      const errorResponse = buildPanelView(context, 'main', {
        success: false,
        lastChecked: new Date().toISOString(),
        baseCode: { checked: false, hasUpdates: false, error: 'An error occurred' },
        modules: { checked: false, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
        summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false }
      });

      await updatePanelDynamic(context, 'update_manager', errorResponse);
    }
  });

  return checkingResponse;
}

/**
 * Handle update mode button (architecture, keep_custom, everything)
 */
async function handleUpdateMode(context: PanelContext, mode: 'basic' | 'relative' | 'full'): Promise<PanelResponse> {
  const modeNames = {
    basic: 'Architecture',
    relative: 'Keep custom',
    full: 'Everything'
  };

  // Set mode in status
  await updatePersistentPanelState('update_manager', 'updating', context.guildId || undefined);

  // Return immediate "updating" state
  const updatingResponse = buildPanelView(context, 'updating');

  // Trigger update in background
  setImmediate(async () => {
    try {
      const result = await requestBotUpdate(mode);

      if (result.success) {
        await updatePersistentPanelState('update_manager', 'update_triggered', context.guildId || undefined);
      } else {
        await updatePersistentPanelState('update_manager', 'update_complete', context.guildId || undefined);
      }
    } catch (error) {
      console.error('[UpdateManagerPanel] Error during update:', error);
      await updatePersistentPanelState('update_manager', 'update_error', context.guildId || undefined);
    }
  });

  return updatingResponse;
}

/**
 * Handle update all modules button
 */
async function handleUpdateAllModules(context: PanelContext): Promise<PanelResponse> {
  // Return immediate "updating" state
  const updatingResponse = buildPanelView(context, 'updating_modules');

  // Trigger module updates in background
  setImmediate(async () => {
    try {
      const result = await triggerAllModuleUpdates();

      // Re-check for updates after updating
      const newCheck = await checkForAllBotUpdates();

      if (result.success && result.totalUpdated > 0) {
        console.log(`[UpdateManagerPanel] Successfully updated ${result.totalUpdated} module(s)`);
      }

      const resultResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', resultResponse);

      if (newCheck) {
        await updatePersistentPanelState('update_manager', 'modules_updated', context.guildId || undefined, undefined, {
          lastCheckResult: newCheck,
          lastModuleUpdate: {
            updated: result.updated,
            failed: result.failed
          }
        });
      }
    } catch (error) {
      console.error('[UpdateManagerPanel] Error updating modules:', error);

      // Re-check for updates to show current state
      const newCheck = await checkForAllBotUpdates();
      const errorResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', errorResponse);
    }
  });

  return updatingResponse;
}

/**
 * Handle single module update button
 */
async function handleUpdateSingleModule(context: PanelContext, moduleName: string): Promise<PanelResponse> {
  // Return immediate "updating" state
  const updatingResponse = buildPanelView(context, 'updating_modules');

  // Trigger module update in background
  setImmediate(async () => {
    try {
      const result = await triggerModuleUpdate(moduleName);

      // Re-check for updates after updating
      const newCheck = await checkForAllBotUpdates();

      if (result.success) {
        console.log(`[UpdateManagerPanel] Successfully updated ${moduleName} to ${result.newVersion}`);
      } else {
        console.error(`[UpdateManagerPanel] Failed to update ${moduleName}: ${result.error}`);
      }

      const resultResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', resultResponse);

      if (newCheck) {
        await updatePersistentPanelState('update_manager', 'module_updated', context.guildId || undefined, undefined, {
          lastCheckResult: newCheck,
          lastSingleModuleUpdate: result
        });
      }
    } catch (error) {
      console.error('[UpdateManagerPanel] Error updating module:', error);

      // Re-check for updates to show current state
      const newCheck = await checkForAllBotUpdates();
      const errorResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', errorResponse);
    }
  });

  return updatingResponse;
}

export default updateManagerPanel;

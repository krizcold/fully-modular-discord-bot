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
  requestSystemUpdate,
  getBotUpdateStatus,
  checkForAllBotUpdates,
  triggerModuleUpdate,
  triggerAllModuleUpdates,
  CombinedUpdateCheckResult
} from '../utils/botManagerAPI';
import { updatePanelDynamic } from '../utils/panel/persistentPanelResponse';
import { updatePersistentPanelState, removePersistentPanel } from '../utils/panel/persistentPanelStorage';
import { DISCORD_EPHEMERAL_FLAG } from '../../constants';
import { createV2Response, V2Colors } from '../utils/panel/v2';
import { reloadModule, reloadModules } from '../utils/moduleReloader';

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
      case 'update_system':
        return await handleSystemUpdate(context);
      case 'update_modules':
        return await handleUpdateAllModules(context);
      case 'update_everything':
        return await handleUpdateEverything(context);
      case 'check_updates':
        return await handleCheckUpdates(context);
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

// ─── Helper Functions ───

/**
 * Get status display with emoji indicator
 */
function getStatusDisplay(status: any, isChecking: boolean = false, isUpdating: boolean = false, combinedCheck?: CombinedUpdateCheckResult | null): string {
  if (isUpdating) return '🟡 Updating...';
  if (isChecking) return '🟡 Checking...';
  if (status.inProgress) return '🟡 Update in progress';

  if (combinedCheck) {
    if (!combinedCheck.success) return '🔴 Error';
    if (combinedCheck.summary.hasAnyUpdates) {
      const total = combinedCheck.summary.totalUpdatesAvailable;
      return `🟠 ${total} Update${total > 1 ? 's' : ''} Available`;
    }
    return '🟢 Up to Date';
  }

  if (status.lastError) return '🔴 Error';
  if (status.hasUpdates) return '🟠 Updates Available';
  if (status.lastCheck) return '🟢 Up to Date';
  return '🟢 Ready';
}

/**
 * Truncate module name for button labels (Discord 80 char limit)
 */
function truncateModuleName(name: string, maxLength: number = 12): string {
  if (name.length <= maxLength) return name;
  return name.substring(0, maxLength - 1) + '…';
}

/**
 * Format date as "day month, year"
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
 * Get accent color based on status string
 */
function getAccentColor(statusDisplay: string): number {
  if (statusDisplay.startsWith('🔴')) return V2Colors.danger;
  if (statusDisplay.startsWith('🟡')) return 0xF1C40F;
  if (statusDisplay.startsWith('🟠')) return 0xE67E22;
  if (statusDisplay.startsWith('🟢') && statusDisplay.includes('Up to Date')) return V2Colors.success;
  return V2Colors.primary;
}

// ─── Button Builders ───

/**
 * Build action buttons:
 * Row 1: Update System | Update Modules | Update Everything
 * Row 2: Individual module buttons (if updates available)
 * Row 3: Check Updates | Information | Close
 */
function buildButtons(disabled: boolean = false, combinedCheck?: CombinedUpdateCheckResult | null): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  const hasSystemUpdate = combinedCheck?.baseCode.hasUpdates === true;
  const hasModuleUpdates = (combinedCheck?.modules.updatesAvailable || 0) > 0;

  // Row 1: Update System / Update Modules / Update Everything
  const row1 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_update_system')
        .setLabel('⬆️ Update System')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || !hasSystemUpdate),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_update_modules')
        .setLabel('📦 Update Modules')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled || !hasModuleUpdates),
      new ButtonBuilder()
        .setCustomId('panel_update_manager_btn_update_everything')
        .setLabel('🔄 Update Everything')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || !(hasSystemUpdate && hasModuleUpdates))
    );
  rows.push(row1);

  // Row 2: Individual module update buttons (if module updates exist)
  if (hasModuleUpdates && combinedCheck) {
    const moduleRow = new ActionRowBuilder<ButtonBuilder>();
    const modulesWithUpdates = combinedCheck.modules.updates.filter(u => u.hasUpdate).slice(0, 5);
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

  // Row 3: Check / Info / Close
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

// ─── Panel Views ───

/**
 * Build main panel view
 */
export function buildPanelView(
  context: PanelContext,
  view: 'main' | 'checking' | 'updating_system' | 'updating_modules',
  combinedCheck?: CombinedUpdateCheckResult | null
): PanelResponse {
  const status = getBotUpdateStatus();

  // Store panel owner
  if (context.interaction && 'message' in context.interaction && context.interaction.message) {
    panelOwners.set(context.interaction.message.id, context.userId);
  }

  const isChecking = view === 'checking';
  const isUpdating = view === 'updating_system' || view === 'updating_modules';
  const statusDisplay = getStatusDisplay(status, isChecking, isUpdating, combinedCheck);
  const accentColor = getAccentColor(statusDisplay);

  const container = new ContainerBuilder()
    .setAccentColor(accentColor);

  // Title
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Bot Update Manager')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Status line
  const lastChecked = combinedCheck?.lastChecked ? formatDate(combinedCheck.lastChecked) : (status.lastCheck ? formatDate(status.lastCheck) : 'Never');
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Status:** ${statusDisplay}\n` +
      `**Last Check:** ${lastChecked}`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Details section
  let detailsContent = '';

  if (isChecking) {
    detailsContent = 'Connecting to update server...\nChecking base code updates...\nChecking module updates...';
  } else if (view === 'updating_system') {
    detailsContent = 'Requesting system update from Bot Manager...\nThe bot will restart with updated code.';
  } else if (view === 'updating_modules') {
    detailsContent = 'Updating modules via hot-reload...\nNo restart required.';
  } else if (combinedCheck) {
    if (!combinedCheck.success) {
      const baseError = combinedCheck.baseCode.error;
      const moduleErrors = combinedCheck.modules.errors.map(e => e.error).join(', ');
      detailsContent = `Errors occurred:\n${baseError ? `- Base: ${baseError}\n` : ''}${moduleErrors ? `- Modules: ${moduleErrors}` : ''}`;
    } else {
      // Base code section
      detailsContent = '=== System (Base Code) ===\n';
      if (combinedCheck.baseCode.hasUpdates) {
        detailsContent += `Update available (${combinedCheck.baseCode.commitsBehind || '?'} commits behind)\n`;
        detailsContent += 'Requires restart\n';
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
        detailsContent += 'Hot-reload (no restart needed)\n';
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

      // Custom modules note
      detailsContent += '\nCustom modules (modulesDev/) are never affected.';
    }
  } else if (status.lastError) {
    detailsContent = `Error: ${status.lastError}\n\nPlease check:\n- API configuration\n- Network connectivity`;
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**Details:**\n\`\`\`\n${detailsContent || 'No details available. Click "Check Updates" to scan.'}\n\`\`\``
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Buttons disabled during checking/updating
  const buttonsDisabled = isChecking || isUpdating || status.inProgress;
  const buttonRows = buildButtons(buttonsDisabled, combinedCheck);
  for (const row of buttonRows) {
    container.addActionRowComponents(row);
  }

  return createV2Response([container]);
}

/**
 * Build information view
 */
function buildInformationView(context: PanelContext): PanelResponse {
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.info);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Bot Update Manager\n**Update Types**')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '## ⬆️ Update System\n' +
      'Updates the bot\'s base code (core framework, internal events/commands)\n' +
      '• Pulls latest source from the repository\n' +
      '• Rebuilds and restarts the container\n' +
      '• All modules and custom modules are preserved\n' +
      '• **Requires restart**'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '## 📦 Update Modules\n' +
      'Updates AppStore modules to their latest versions\n' +
      '• Downloads and applies module changes\n' +
      '• Hot-reloads modules at runtime\n' +
      '• **No restart needed** — bot stays online\n' +
      '• Custom modules (modulesDev/) are never affected'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '## 🔄 Update Everything\n' +
      'Updates both system and modules in one step\n' +
      '• System update runs first (restart)\n' +
      '• Modules are synced on boot\n' +
      '• Only available when both have updates'
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

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

// ─── Button Handlers ───

/**
 * Handle check updates button
 */
async function handleCheckUpdates(context: PanelContext): Promise<PanelResponse> {
  const checkingResponse = buildPanelView(context, 'checking');

  setImmediate(async () => {
    try {
      const combinedCheck = await checkForAllBotUpdates();
      const resultResponse = buildPanelView(context, 'main', combinedCheck || {
        success: false,
        lastChecked: new Date().toISOString(),
        baseCode: { checked: false, hasUpdates: false, error: 'Failed to check for updates' },
        modules: { checked: false, hasUpdates: false, totalInstalled: 0, updatesAvailable: 0, updates: [], errors: [] },
        summary: { totalUpdatesAvailable: 0, hasAnyUpdates: false }
      });

      await updatePanelDynamic(context, 'update_manager', resultResponse);

      if (combinedCheck) {
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
 * Handle system update button — requests pull + rebuild from Bot Manager
 */
async function handleSystemUpdate(context: PanelContext): Promise<PanelResponse> {
  await updatePersistentPanelState('update_manager', 'updating', context.guildId || undefined);
  const updatingResponse = buildPanelView(context, 'updating_system');

  setImmediate(async () => {
    try {
      const result = await requestSystemUpdate();
      if (result.success) {
        await updatePersistentPanelState('update_manager', 'update_triggered', context.guildId || undefined);

        const successContainer = new ContainerBuilder()
          .setAccentColor(0x2ECC71)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## Bot Update Manager')
          )
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              '**Status:** Update requested\n\n' +
              'The Bot Manager is pulling the latest code and rebuilding.\n' +
              'The bot will restart automatically when the new build is ready.\n' +
              'This panel will refresh after restart.'
            )
          );
        const successResponse = createV2Response([successContainer]);
        await updatePanelDynamic(context, 'update_manager', successResponse);
      } else {
        await updatePersistentPanelState('update_manager', 'update_error', context.guildId || undefined);
        const newCheck = await checkForAllBotUpdates();
        const errorResponse = buildPanelView(context, 'main', newCheck);
        await updatePanelDynamic(context, 'update_manager', errorResponse);
      }
    } catch (error) {
      console.error('[UpdateManagerPanel] Error during system update:', error);
      await updatePersistentPanelState('update_manager', 'update_error', context.guildId || undefined);
      const newCheck = await checkForAllBotUpdates();
      const errorResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', errorResponse);
    }
  });

  return updatingResponse;
}

/**
 * Handle update all modules button — download files + hot-reload
 */
async function handleUpdateAllModules(context: PanelContext): Promise<PanelResponse> {
  const updatingResponse = buildPanelView(context, 'updating_modules');

  setImmediate(async () => {
    try {
      // Step 1: Download module updates via AppStoreManager
      const result = await triggerAllModuleUpdates();

      if (result.success && result.totalUpdated > 0) {
        console.log(`[UpdateManagerPanel] Downloaded ${result.totalUpdated} module update(s), hot-reloading...`);

        // Step 2: Hot-reload the updated modules
        const updatedNames = result.updated.map((u: any) => u.moduleName);
        if (updatedNames.length > 0 && context.client) {
          const reloadResult = await reloadModules(context.client, updatedNames);
          if (reloadResult.success) {
            console.log(`[UpdateManagerPanel] Hot-reloaded ${reloadResult.reloaded.length} module(s)`);
          } else {
            console.warn(`[UpdateManagerPanel] Hot-reload partial: ${reloadResult.reloaded.length} OK, ${reloadResult.failed.length} failed`);
          }
        }
      }

      // Re-check for updates after updating
      const newCheck = await checkForAllBotUpdates();
      const resultResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', resultResponse);

      if (newCheck) {
        await updatePersistentPanelState('update_manager', 'modules_updated', context.guildId || undefined, undefined, {
          lastCheckResult: newCheck,
          lastModuleUpdate: { updated: result.updated, failed: result.failed }
        });
      }
    } catch (error) {
      console.error('[UpdateManagerPanel] Error updating modules:', error);
      const newCheck = await checkForAllBotUpdates();
      const errorResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', errorResponse);
    }
  });

  return updatingResponse;
}

/**
 * Handle update everything — system update first (modules sync on boot via "Update on Reboot")
 */
async function handleUpdateEverything(context: PanelContext): Promise<PanelResponse> {
  await updatePersistentPanelState('update_manager', 'updating', context.guildId || undefined);
  const updatingResponse = buildPanelView(context, 'updating_system');

  setImmediate(async () => {
    try {
      const moduleResult = await triggerAllModuleUpdates();
      if (moduleResult.totalUpdated > 0) {
        console.log(`[UpdateManagerPanel] Updated ${moduleResult.totalUpdated} module(s) before system update`);
      }

      const result = await requestSystemUpdate();
      if (result.success) {
        await updatePersistentPanelState('update_manager', 'update_triggered', context.guildId || undefined);

        const successContainer = new ContainerBuilder()
          .setAccentColor(0x2ECC71)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## Bot Update Manager')
          )
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**Status:** Update requested\n\n` +
              `${moduleResult.totalUpdated > 0 ? `${moduleResult.totalUpdated} module(s) updated. ` : ''}` +
              'The Bot Manager is pulling the latest code and rebuilding.\n' +
              'The bot will restart automatically when the new build is ready.\n' +
              'This panel will refresh after restart.'
            )
          );
        const successResponse = createV2Response([successContainer]);
        await updatePanelDynamic(context, 'update_manager', successResponse);
      } else {
        await updatePersistentPanelState('update_manager', 'update_error', context.guildId || undefined);
        const newCheck = await checkForAllBotUpdates();
        const errorResponse = buildPanelView(context, 'main', newCheck);
        await updatePanelDynamic(context, 'update_manager', errorResponse);
      }
    } catch (error) {
      console.error('[UpdateManagerPanel] Error during combined update:', error);
      await updatePersistentPanelState('update_manager', 'update_error', context.guildId || undefined);
      const newCheck = await checkForAllBotUpdates();
      const errorResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', errorResponse);
    }
  });

  return updatingResponse;
}

/**
 * Handle single module update button — download + hot-reload
 */
async function handleUpdateSingleModule(context: PanelContext, moduleName: string): Promise<PanelResponse> {
  const updatingResponse = buildPanelView(context, 'updating_modules');

  setImmediate(async () => {
    try {
      // Step 1: Download module update
      const result = await triggerModuleUpdate(moduleName);

      if (result.success) {
        console.log(`[UpdateManagerPanel] Downloaded ${moduleName} update, hot-reloading...`);

        // Step 2: Hot-reload the module
        if (context.client) {
          const reloadResult = await reloadModule(context.client, moduleName);
          if (reloadResult.success) {
            console.log(`[UpdateManagerPanel] Hot-reloaded ${moduleName} (${reloadResult.duration}ms)`);
          } else {
            console.warn(`[UpdateManagerPanel] Hot-reload failed for ${moduleName}: ${reloadResult.error}`);
          }
        }
      } else {
        console.error(`[UpdateManagerPanel] Failed to update ${moduleName}: ${result.error}`);
      }

      // Re-check for updates
      const newCheck = await checkForAllBotUpdates();
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
      const newCheck = await checkForAllBotUpdates();
      const errorResponse = buildPanelView(context, 'main', newCheck);
      await updatePanelDynamic(context, 'update_manager', errorResponse);
    }
  });

  return updatingResponse;
}

/**
 * Handle close panel — deletes the persistent panel message
 */
async function handleClosePanel(context: PanelContext): Promise<PanelResponse> {
  if (context.interaction && 'message' in context.interaction && context.interaction.message) {
    try {
      await removePersistentPanel('update_manager', context.guildId || undefined);
      await context.interaction.message.delete();
      console.log('[UpdateManagerPanel] Panel closed and deleted');
    } catch (error) {
      console.error('[UpdateManagerPanel] Failed to delete panel:', error);
    }
  }

  return null as any;
}

export default updateManagerPanel;

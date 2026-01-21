// Panel Web-UI Adapter - Handles panel execution for Web-UI interface

import { Client, ModalBuilder, ButtonInteraction, Guild, GuildMember, User } from 'discord.js';
import { PanelOptions, PanelContext } from '../../../types/panelTypes';
import { serializePanelResponse, SerializedPanelResponse, extractUserIdsFromResponse, resolveUsers, serializeModal } from '../panelSerializer';
import { getAdminPanelList } from './adminPanelUI';
import { PanelManagerConfig, PanelListItem } from '../../../types/panelTypes';
import { loadCredentials } from '../../../../utils/envLoader';
import { parseButtonCustomId } from './panelButtonHandler';
import { checkPanelPermissions } from './panelPermissions';
import type { RegisteredButtonInfo } from '../../../types/commandTypes';

/**
 * Broadcast panel update to all WebSocket clients via IPC
 * This enables real-time updates when Web-UI users interact with panels
 */
function broadcastWebUIPanelUpdate(
  panelId: string,
  serializedResponse: SerializedPanelResponse,
  guildId?: string | null
): void {
  if (!process.send) return;

  try {
    process.send({
      type: 'panel:live_update',
      data: {
        panelId,
        guildId: guildId || null,
        sessionId: null,
        response: serializedResponse
      }
    });
  } catch (error) {
    console.error('[PanelWebUIAdapter] Error broadcasting panel update:', error);
  }
}

/**
 * Modal capture container for Web-UI context
 * Used to capture modals that would be shown via interaction.showModal()
 */
interface ModalCapture {
  modal: ModalBuilder | null;
}

/**
 * Web-UI response type
 */
export interface WebUIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Create a Web-UI context (no Discord interaction)
 * Accepts optional guildId parameter for guild-specific context
 * Accepts optional channelId for channel-required panels
 * Accepts optional navigationStack for nested panel navigation
 * Accepts optional modalCapture to capture modals that would be shown
 */
function createWebUIContext(
  client: Client,
  panelId: string,
  userId: string,
  guildId?: string | null,
  modalFields?: Record<string, string>,
  navigationStack?: string[],
  modalCapture?: ModalCapture,
  channelId?: string | null
): PanelContext {
  // If guildId is explicitly provided, use it
  // Otherwise fall back to MAIN_GUILD_ID for backward compatibility
  let contextGuildId: string | null;
  if (guildId !== undefined) {
    contextGuildId = guildId;
  } else {
    const credentials = loadCredentials();
    contextGuildId = credentials.MAIN_GUILD_ID || credentials.GUILD_ID || null;
  }

  // Get the guild from client cache for role/member validation
  const guild = contextGuildId ? client.guilds.cache.get(contextGuildId) : null;

  // Create mock interaction that supports modal capture
  // This allows panel handlers to call showModal() and have it work in Web-UI
  const interaction: any = {
    // Provide guild for role validation
    guild: guild,

    // Mock member as guild owner for permission checks (Web-UI is admin-only)
    member: guild ? {
      id: guild.ownerId, // Pretend to be owner so all permission checks pass
      roles: {
        highest: {
          position: Infinity, // Highest possible position
          name: 'Web-UI Admin'
        },
        cache: new Map()
      },
      permissions: {
        has: () => true // Has all permissions
      }
    } : null,
    // For modal submissions - allows reading form field values and uploaded files
    fields: modalFields ? {
      getTextInputValue: (customId: string) => {
        return modalFields[customId] || '';
      },
      // Support for entity select menus (role, user, channel selects) from Web-UI
      // Returns a field object with values array for compatibility with Discord.js
      getField: (customId: string) => {
        const value = modalFields[customId];
        if (!value) return null;
        // Return field object with values array (single value wrapped in array)
        return {
          customId,
          type: 6, // RoleSelect type (or other entity select)
          values: [value], // Web-UI sends single value, wrap in array
          value // Also include value directly for text inputs
        };
      },
      // Support for getting string select values (dropdowns)
      getStringSelectValues: (customId: string) => {
        const value = modalFields[customId];
        return value ? [value] : [];
      },
      // Support for file uploads from Web-UI
      // Files are passed as _file_{customId} (content) and _filename_{customId} (name)
      getUploadedFiles: (customId: string) => {
        const fileContent = modalFields[`_file_${customId}`];
        const fileName = modalFields[`_filename_${customId}`];

        if (!fileContent) {
          return null; // No file uploaded
        }

        // Create a mock attachment-like object that matches what Discord provides
        // The URL is a data URL containing the file content
        const mockAttachment = {
          name: fileName || 'upload.json',
          url: `data:application/json;base64,${Buffer.from(fileContent).toString('base64')}`,
          // Also provide the raw content for easier access
          content: fileContent
        };

        // Return a Map-like object with first() method
        const filesMap = new Map([[customId, mockAttachment]]);
        return {
          size: 1,
          first: () => mockAttachment,
          get: (key: string) => filesMap.get(key),
          has: (key: string) => filesMap.has(key),
          [Symbol.iterator]: () => filesMap[Symbol.iterator]()
        };
      }
    } : undefined,

    // For showing modals - captures the modal for Web-UI rendering
    showModal: async (modal: ModalBuilder) => {
      if (modalCapture) {
        modalCapture.modal = modal;
      }
    },

    // Mock other interaction properties that might be checked
    replied: false,
    deferred: false,

    // Mock deferUpdate for compatibility
    deferUpdate: async () => {
      // No-op in Web-UI
    },

    // Mock followUp for compatibility (used for ephemeral error messages in Discord)
    // In Web-UI, errors should be returned in the panel response instead
    followUp: async (options: any) => {
      // No-op in Web-UI - errors should be in panel response
    },

    // Mock reply for compatibility
    reply: async (options: any) => {
      // No-op in Web-UI
    }
  };

  return {
    client,
    interaction,
    panelId,
    userId,
    guildId: contextGuildId,
    channelId: channelId || null,
    accessMethod: 'web_ui',
    navigationStack: navigationStack || []
  };
}

/**
 * Execute a panel callback and serialize the response for Web-UI
 * @param broadcast - If true, broadcast the update to all WebSocket clients
 */
async function executeWebUIPanel(
  panel: PanelOptions,
  context: PanelContext,
  callback: (context: PanelContext) => Promise<any>,
  broadcast: boolean = false
): Promise<WebUIResponse<SerializedPanelResponse>> {
  try {
    const response = await callback(context);

    // Check if panel should be closed (return to panel list in Web-UI)
    if (response && response.closePanel) {
      return {
        success: true,
        data: {
          returnToPanelList: true,
          // Preserve notification for success/error messages when closing
          notification: response.notification
        } as any
      };
    }

    // Extract and resolve user mentions for Web-UI display
    const userIds = extractUserIdsFromResponse(response);
    const resolvedUsersMap = userIds.length > 0
      ? await resolveUsers(context.client, userIds)
      : undefined;

    const serialized = serializePanelResponse(response, resolvedUsersMap);

    // Broadcast update to all WebSocket clients if requested
    // This enables real-time updates for other users viewing the same panel
    if (broadcast && serialized) {
      broadcastWebUIPanelUpdate(context.panelId, serialized, context.guildId);
    }

    return {
      success: true,
      data: serialized
    };
  } catch (error) {
    console.error(`[PanelWebUIAdapter] Error executing panel ${context.panelId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Web-UI Adapter - Provides panel functionality for web interface
 */
export class PanelWebUIAdapter {
  private client: Client;
  private panels: Map<string, PanelOptions>;
  private config: PanelManagerConfig;

  constructor(client: Client, panels: Map<string, PanelOptions>, config: PanelManagerConfig) {
    this.client = client;
    this.panels = panels;
    this.config = config;
  }

  /**
   * Get list of panels for Web-UI (serialized format)
   * Web-UI operates in MAIN_GUILD_ID context, so all panels (including mainGuildOnly) are shown
   * Optionally filter by panel scope (system/guild)
   */
  public getWebUIPanelList(scope?: 'system' | 'guild'): PanelListItem[] {
    // Get MAIN_GUILD_ID to ensure mainGuildOnly panels are shown
    const credentials = loadCredentials();
    const mainGuildId = credentials.MAIN_GUILD_ID || credentials.GUILD_ID;

    // Pass main guild ID and scope filter
    return getAdminPanelList(this.panels, this.config, mainGuildId, scope);
  }

  /**
   * Execute a panel for Web-UI and return serialized response
   */
  public async executePanelForWebUI(
    panelId: string,
    userId: string,
    guildId?: string | null,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    const panel = this.panels.get(panelId);

    if (!panel) {
      return {
        success: false,
        error: `Panel not found: ${panelId}`
      };
    }

    // Create context for permission checking with channelId
    const context = createWebUIContext(this.client, panelId, userId, guildId, undefined, navigationStack, undefined, channelId);

    // Check permissions using the proper permission checker
    if (!checkPanelPermissions(panel, context)) {
      return {
        success: false,
        error: 'You do not have permission to access this panel'
      };
    }

    return await executeWebUIPanel(panel, context, (ctx) => panel.callback(ctx));
  }

  /**
   * Handle button interaction from Web-UI
   * Supports modal capture - if button handler shows a modal, it's captured and returned
   */
  public async handleWebUIButton(
    panelId: string,
    buttonId: string,
    userId: string,
    guildId?: string | null,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    // Special handling for web_ui_refresh button
    if (buttonId === 'web_ui_refresh') {
      return this.handleWebUIReturn(userId, guildId, navigationStack);
    }

    const panel = this.panels.get(panelId);

    if (!panel) {
      return {
        success: false,
        error: `Panel not found: ${panelId}`
      };
    }

    if (!panel.handleButton) {
      return {
        success: false,
        error: 'This panel does not support button interactions'
      };
    }

    // Create modal capture container to catch modals shown by button handler
    const modalCapture: ModalCapture = { modal: null };

    // Create context for permission checking with navigation stack, modal capture, and channelId
    const context = createWebUIContext(this.client, panelId, userId, guildId, undefined, navigationStack, modalCapture, channelId);

    // Check permissions
    if (!checkPanelPermissions(panel, context)) {
      return {
        success: false,
        error: 'You do not have permission to access this panel'
      };
    }

    // Parse the button customId to extract the actual buttonId
    // Web-UI sends full customId like "panel_example_panel_btn_test"
    // We need to extract "test" from it
    let parsedButtonId = buttonId;
    const parsed = parseButtonCustomId(buttonId);
    if (parsed) {
      parsedButtonId = parsed.buttonId;
    } else {
      // If parsing fails, try to extract everything after last 'btn_'
      const btnIndex = buttonId.lastIndexOf('btn_');
      if (btnIndex !== -1) {
        parsedButtonId = buttonId.substring(btnIndex + 4);
      }
    }

    // Update navigation stack - push current panel
    const updatedStack = [...(navigationStack || []), panelId];
    const updatedContext = { ...context, navigationStack: updatedStack };

    try {
      // Execute the button handler
      const response = await panel.handleButton!(updatedContext, parsedButtonId);

      // Check if a modal was captured (button handler called showModal)
      if (modalCapture.modal) {
        const serializedModal = serializeModal(modalCapture.modal);
        return {
          success: true,
          data: {
            modal: serializedModal
          } as SerializedPanelResponse
        };
      }

      // Handle null response (button handler returned null without capturing modal)
      if (!response) {

        // Try to find and execute a registered button handler for this button
        const registeredResult = await this.tryRegisteredButtonHandler(
          buttonId,
          userId,
          guildId,
          panelId,
          modalCapture
        );

        if (registeredResult) {
          return registeredResult;
        }

        // No registered handler found or handler didn't produce result
        // Re-execute the panel to get current state
        return await this.executePanelForWebUI(panelId, userId, guildId, navigationStack);
      }

      // Check if panel should be closed (return to panel list in Web-UI)
      if (response && response.closePanel) {
        return {
          success: true,
          data: {
            returnToPanelList: true,
            // Preserve notification for success/error messages when closing
            notification: response.notification
          } as any
        };
      }

      // No modal captured, serialize the regular panel response
      const userIds = extractUserIdsFromResponse(response);
      const resolvedUsersMap = userIds.length > 0
        ? await resolveUsers(this.client, userIds)
        : undefined;

      const serialized = serializePanelResponse(response, resolvedUsersMap);

      // Broadcast update to all WebSocket clients
      // Button interactions change panel state that should be visible to other users
      if (serialized) {
        broadcastWebUIPanelUpdate(panelId, serialized, guildId);
      }

      return {
        success: true,
        data: serialized
      };
    } catch (error) {
      console.error(`[PanelWebUIAdapter] Error executing button ${parsedButtonId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Handle dropdown interaction from Web-UI
   */
  public async handleWebUIDropdown(
    panelId: string,
    values: string[],
    userId: string,
    guildId?: string | null,
    dropdownId?: string,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    const panel = this.panels.get(panelId);

    if (!panel) {
      return {
        success: false,
        error: `Panel not found: ${panelId}`
      };
    }

    if (!panel.handleDropdown) {
      return {
        success: false,
        error: 'This panel does not support dropdown interactions'
      };
    }

    // Create context for permission checking with navigation stack and channelId
    const context = createWebUIContext(this.client, panelId, userId, guildId, undefined, navigationStack, undefined, channelId);

    // Check permissions
    if (!checkPanelPermissions(panel, context)) {
      return {
        success: false,
        error: 'You do not have permission to access this panel'
      };
    }

    // Parse dropdown customId to extract the type+identifier part
    // Format: panel_{panelId}_dropdown_{type}_{identifier}
    // We need to pass just {type}_{identifier} to the panel handler
    let parsedDropdownId = dropdownId;
    if (dropdownId) {
      const dropdownPrefix = `panel_${panelId}_dropdown_`;
      if (dropdownId.startsWith(dropdownPrefix)) {
        parsedDropdownId = dropdownId.substring(dropdownPrefix.length);
      }
    }

    // Pass both values and parsed dropdownId to the panel handler
    // Broadcast=true: dropdown changes should be visible to other users viewing this panel
    return await executeWebUIPanel(panel, context, (ctx) => panel.handleDropdown!(ctx, values, parsedDropdownId), true);
  }

  /**
   * Handle modal submission from Web-UI
   */
  public async handleWebUIModal(
    panelId: string,
    modalId: string,
    fields: Record<string, string>,
    userId: string,
    guildId?: string | null,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    const panel = this.panels.get(panelId);

    if (!panel) {
      return {
        success: false,
        error: `Panel not found: ${panelId}`
      };
    }

    if (!panel.handleModal) {
      return {
        success: false,
        error: 'This panel does not support modal interactions'
      };
    }

    // Create context with mock interaction that has fields, navigation stack, and channelId
    const context = createWebUIContext(this.client, panelId, userId, guildId, fields, navigationStack, undefined, channelId);

    // Check permissions
    if (!checkPanelPermissions(panel, context)) {
      return {
        success: false,
        error: 'You do not have permission to access this panel'
      };
    }

    // Broadcast=true: modal submissions may change panel state visible to other users
    return await executeWebUIPanel(panel, context, (ctx) => panel.handleModal!(ctx, modalId), true);
  }

  /**
   * Try to execute a registered button handler for buttons not handled by panel.handleButton
   * This supports module buttons like ra_add_role, ra_cancel, etc. that are registered separately
   */
  private async tryRegisteredButtonHandler(
    buttonId: string,
    userId: string,
    guildId: string | null | undefined,
    panelId: string,
    modalCapture: ModalCapture
  ): Promise<WebUIResponse<SerializedPanelResponse> | null> {
    const registeredButtons = this.client.buttonHandlers as Map<string, RegisteredButtonInfo> | undefined;

    if (!registeredButtons || registeredButtons.size === 0) {
      return null;
    }

    // Find a matching handler (exact match or prefix match)
    let handlerInfo: RegisteredButtonInfo | undefined;
    let matchedKey: string | undefined;

    // Check exact match first
    if (registeredButtons.has(buttonId)) {
      handlerInfo = registeredButtons.get(buttonId);
      matchedKey = buttonId;
    } else {
      // Check prefix match
      for (const [prefix, info] of registeredButtons.entries()) {
        if (buttonId.startsWith(prefix) &&
            (buttonId.length === prefix.length || buttonId.charAt(prefix.length) === '_')) {
          handlerInfo = info;
          matchedKey = prefix;
          break;
        }
      }
    }

    if (!handlerInfo || !matchedKey) {
      return null;
    }

    try {
      // Create a mock ButtonInteraction for the registered handler
      const mockInteraction = await this.createMockButtonInteraction(
        buttonId,
        userId,
        guildId || undefined,
        modalCapture
      );

      if (!mockInteraction) {
        return null;
      }

      // Execute the handler
      await handlerInfo.handler(this.client, mockInteraction as unknown as ButtonInteraction, -1);

      // Check if a modal was captured
      if (modalCapture.modal) {
        const serializedModal = serializeModal(modalCapture.modal);
        return {
          success: true,
          data: {
            modal: serializedModal
          } as SerializedPanelResponse
        };
      }

      // If no modal captured, the handler might have updated the message
      // Re-execute the panel to get the new state
      return null;

    } catch (error) {
      console.error(`[PanelWebUIAdapter] Error executing registered handler for ${buttonId}:`, error);
      return null;
    }
  }

  /**
   * Create a mock ButtonInteraction for registered button handlers
   */
  private async createMockButtonInteraction(
    customId: string,
    userId: string,
    guildId?: string,
    modalCapture?: ModalCapture
  ): Promise<Partial<ButtonInteraction> | null> {
    // Get guild if guildId provided
    let guild: Guild | undefined;
    let member: GuildMember | undefined;
    let user: User | undefined;

    try {
      user = await this.client.users.fetch(userId).catch(() => undefined);
    } catch {
      // User not found
    }

    if (guildId) {
      try {
        guild = await this.client.guilds.fetch(guildId).catch(() => undefined);
        if (guild && user) {
          member = await guild.members.fetch(userId).catch(() => undefined);
        }
      } catch {
        // Guild or member not found
      }
    }

    // Create response capture
    let capturedResponse: any = null;

    // Use 'any' type for mock since we don't need full type compliance
    // The mock just needs to work at runtime with the handler functions
    const mockInteraction: any = {
      customId,
      user: user,
      member: member,
      guild: guild,
      guildId: guildId ?? null,
      replied: false,
      deferred: false,
      isButton: () => true,
      inGuild: () => !!guildId,

      // Modal capture
      showModal: async (modal: ModalBuilder) => {
        if (modalCapture) {
          modalCapture.modal = modal;
        }
        return {} as any;
      },

      // Response methods
      deferUpdate: async () => {
        mockInteraction.deferred = true;
        return {} as any;
      },

      deferReply: async () => {
        mockInteraction.deferred = true;
        return {} as any;
      },

      reply: async (options: any) => {
        mockInteraction.replied = true;
        capturedResponse = options;
        return {} as any;
      },

      editReply: async (options: any) => {
        capturedResponse = options;
        return {} as any;
      },

      update: async (options: any) => {
        capturedResponse = options;
        return {} as any;
      },

      followUp: async (options: any) => {
        // No-op in mock - follow-ups are ephemeral messages
        return {} as any;
      },

      // Message mock (for button context)
      message: {
        id: 'mock_message_id',
        createdTimestamp: Date.now(),
        components: [],
      },

      createdTimestamp: Date.now(),

      // Fields mock for modal submissions
      fields: {
        getTextInputValue: (id: string) => '',
        getField: (id: string) => null,
        getStringSelectValues: (id: string) => [],
      },
    };

    return mockInteraction as Partial<ButtonInteraction>;
  }

  /**
   * Handle return button for Web-UI
   * Always returns to panel list (injected return button behavior)
   */
  private async handleWebUIReturn(
    userId: string,
    guildId?: string | null,
    navigationStack?: string[]
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    // Injected return button ALWAYS returns to panel list
    // Individual panels should provide their own navigation buttons if needed
    return {
      success: true,
      data: {
        returnToPanelList: true // Special flag for Web-UI frontend
      } as any
    };
  }
}

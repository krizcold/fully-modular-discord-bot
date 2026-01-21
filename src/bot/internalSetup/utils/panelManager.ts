import { Client } from 'discord.js';
import { getConfigProperty } from './configManager';
import {
  PanelOptions,
  PanelContext,
  PanelResponse,
  PanelManagerConfig,
  PanelListItem
} from '../../types/panelTypes';
import { DISCORD_EPHEMERAL_FLAG } from '../../constants';

import { PanelLoader } from './panel/panelLoader';
import { checkPanelPermissions } from './panel/panelPermissions';
import { generateAdminPanel, getAdminPanelList } from './panel/adminPanelUI';
import { registerPanelButtonHandler } from './panel/panelButtonHandler';
import { registerPanelDropdownHandler } from './panel/panelDropdownHandler';
import { registerPanelModalHandler } from './panel/panelModalHandler';
import {
  injectReturnButtonIfNeeded,
  createReturnButton,
  createPanelError
} from './panel/panelResponseUtils';
import { PanelWebUIAdapter, WebUIResponse } from './panel/panelWebUIAdapter';
import { SerializedPanelResponse } from './panelSerializer';

import {
  createPersistentPanelWarning,
  shouldShowPersistentWarning
} from './panel/persistentPanelWarning';
import {
  createPersistentPanel,
  updatePersistentPanel,
  handlePersistentPanelButton,
  handlePersistentPanelModal,
  shouldBePersistent
} from './panel/persistentPanelResponse';
import { migratePersistentPanels } from './panel/persistentPanelStorage';
import { recoverPersistentPanels } from './panel/persistentPanelRecovery';

/**
 * Main Panel Manager - Orchestrates panel loading, execution, and interactions
 */
export class PanelManager {
  private client: Client;
  private panels: Map<string, PanelOptions> = new Map();
  private config: PanelManagerConfig;
  private loader: PanelLoader;
  private webUIAdapter: PanelWebUIAdapter;

  constructor(client: Client) {
    this.client = client;
    this.config = this.loadConfig();
    this.loader = new PanelLoader(client, this.panels);
    this.webUIAdapter = new PanelWebUIAdapter(client, this.panels, this.config);

    client.panels = this.panels;
    client.panelManager = this;
  }

  /**
   * Load configuration from config.json
   */
  private loadConfig(): PanelManagerConfig {
    return {
      itemsPerPage: getConfigProperty('adminPanel.itemsPerPage'),
      enablePagination: getConfigProperty('adminPanel.enablePagination'),
      defaultCategory: getConfigProperty('adminPanel.defaultCategory')
    };
  }

  /**
   * Load all panels and register button/dropdown/modal handlers
   * Note: Does NOT recover persistent panels - call recoverPanels() after client is ready
   */
  public async loadPanels(): Promise<void> {
    await this.loader.loadPanels();
    this.registerButtonHandler();
    this.registerDropdownHandler();
    this.registerModalHandler();

    await migratePersistentPanels(this.client);
    // Note: recoverPersistentPanels is called separately after client is ready
  }

  /**
   * Recover persistent panels after bot restart
   * Must be called AFTER client is ready (logged in and connected)
   */
  public async recoverPanels(): Promise<void> {
    await recoverPersistentPanels(this.client);
  }

  /**
   * Register Discord button handler for panels
   */
  private registerButtonHandler(): void {
    registerPanelButtonHandler(this.client, this.handleButtonInteraction.bind(this), this.panels);
  }

  /**
   * Register Discord dropdown handler for panels
   */
  private registerDropdownHandler(): void {
    registerPanelDropdownHandler(this.client, this.handleDropdownInteraction.bind(this), this.panels);
  }

  /**
   * Register Discord modal handler for panels
   */
  private registerModalHandler(): void {
    registerPanelModalHandler(this.client, this.handleModalInteraction.bind(this), this.panels);
  }

  /**
   * Register a panel (used for module panels)
   */
  public registerPanel(panel: PanelOptions): void {
    if (!panel || !panel.id) {
      console.error('[PanelManager] Cannot register panel: Invalid panel object');
      return;
    }

    if (this.panels.has(panel.id)) {
      console.warn(`[PanelManager] Panel '${panel.id}' already registered, overwriting`);
    }

    this.panels.set(panel.id, panel);

    if (typeof panel.initialize === 'function') {
      try {
        panel.initialize(this.client);
      } catch (error) {
        console.error(`[PanelManager] Error initializing panel ${panel.id}:`, error);
      }
    }
  }

  /**
   * Get a panel by ID
   */
  public getPanel(id: string): PanelOptions | undefined {
    return this.panels.get(id);
  }

  /**
   * Get list of panels for admin panel
   */
  public getAdminPanelList(guildId?: string | null): PanelListItem[] {
    return getAdminPanelList(this.panels, this.config, guildId);
  }

  /**
   * Generate admin panel UI
   */
  public generateAdminPanel(
    page: number = 0,
    category?: string,
    guildId?: string | null,
    scope?: 'system' | 'guild'
  ): PanelResponse {
    return generateAdminPanel(this.panels, this.config, page, category, guildId, scope);
  }

  /**
   * Handle panel interaction (initial panel execution)
   */
  public async handlePanelInteraction(context: PanelContext): Promise<PanelResponse> {
    const panel = this.getPanel(context.panelId);

    if (!panel) {
      return createPanelError(
        'Panel Not Found',
        `The panel '${context.panelId}' could not be found.`
      );
    }

    if (!checkPanelPermissions(panel, context)) {
      return createPanelError(
        'Access Denied',
        'You do not have permission to access this panel.'
      );
    }

    if (shouldShowPersistentWarning(panel, context)) {
      return createPersistentPanelWarning(panel, context);
    }

    try {
      let response = await panel.callback(context);

      if (shouldBePersistent(panel, context) && context.interaction) {
        await createPersistentPanel(context, panel, response);
      }

      return injectReturnButtonIfNeeded(response, context);
    } catch (error) {
      console.error(`[PanelManager] Error in panel ${context.panelId}:`, error);
      return createPanelError(
        'Panel Error',
        'An error occurred while loading the panel.',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Handle button interaction within a panel
   * Returns null if the handler handled the interaction directly
   */
  public async handleButtonInteraction(context: PanelContext, buttonId: string): Promise<PanelResponse | null> {
    const panel = this.getPanel(context.panelId);

    if (!panel?.handleButton) {
      return createPanelError(
        'Button Not Supported',
        'This panel does not support button interactions.'
      );
    }

    if (!checkPanelPermissions(panel, context)) {
      return createPanelError(
        'Access Denied',
        'You do not have permission to use this panel.'
      );
    }

    try {
      let response: PanelResponse | null;

      if (panel.persistent && context.accessMethod !== 'web_ui') {
        response = await handlePersistentPanelButton(context, panel, buttonId);
      } else {
        response = await panel.handleButton(context, buttonId);
      }

      // null means the handler handled the interaction directly (e.g., file download/upload)
      if (!response) {
        return null;
      }

      return injectReturnButtonIfNeeded(response, context);
    } catch (error) {
      console.error(`[PanelManager] Error in panel button ${context.panelId}/${buttonId}:`, error);
      return createPanelError(
        'Button Error',
        'An error occurred while processing the button interaction.',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Handle dropdown interaction within a panel
   */
  public async handleDropdownInteraction(context: PanelContext, values: string[], dropdownId?: string): Promise<PanelResponse> {
    const panel = this.getPanel(context.panelId);

    if (!panel?.handleDropdown) {
      return createPanelError(
        'Dropdown Not Supported',
        'This panel does not support dropdown interactions.'
      );
    }

    if (!checkPanelPermissions(panel, context)) {
      return createPanelError(
        'Access Denied',
        'You do not have permission to use this panel.'
      );
    }

    try {
      const response = await panel.handleDropdown(context, values, dropdownId);

      return injectReturnButtonIfNeeded(response, context);
    } catch (error) {
      console.error(`[PanelManager] Error in panel dropdown ${context.panelId}:`, error);
      return createPanelError(
        'Dropdown Error',
        'An error occurred while processing the dropdown interaction.',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Handle modal interaction within a panel
   * Returns null if the handler handled the interaction directly
   */
  public async handleModalInteraction(context: PanelContext, modalId: string): Promise<PanelResponse | null> {
    const panel = this.getPanel(context.panelId);

    if (!panel?.handleModal) {
      return createPanelError(
        'Modal Not Supported',
        'This panel does not support modal interactions.'
      );
    }

    if (!checkPanelPermissions(panel, context)) {
      return createPanelError(
        'Access Denied',
        'You do not have permission to use this panel.'
      );
    }

    try {
      let response: PanelResponse | null;

      if (panel.persistent && context.accessMethod !== 'web_ui') {
        response = await handlePersistentPanelModal(context, panel, modalId);
      } else {
        response = await panel.handleModal(context, modalId);
      }

      // null means the handler handled the interaction directly (e.g., file download/upload)
      if (!response) {
        return null;
      }

      return injectReturnButtonIfNeeded(response, context);
    } catch (error) {
      console.error(`[PanelManager] Error in panel modal ${context.panelId}/${modalId}:`, error);
      return createPanelError(
        'Modal Error',
        'An error occurred while processing the modal submission.',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Get manager configuration
   */
  public getConfig(): PanelManagerConfig {
    return { ...this.config };
  }

  /**
   * Get Discord client instance
   */
  public getClient(): Client {
    return this.client;
  }

  /**
   * Create a context for direct command access
   */
  public createDirectCommandContext(panelId: string, interaction: any, client: Client): PanelContext {
    return {
      client,
      interaction,
      panelId,
      userId: interaction.user.id,
      guildId: interaction.guildId || null,
      accessMethod: 'direct_command'
    };
  }

  /**
   * Create return button utility (exposed for external use)
   */
  public createReturnButton(context: PanelContext) {
    return createReturnButton(context);
  }

  /**
   * Web-UI Methods - Delegated to PanelWebUIAdapter
   */

  public getWebUIPanelList(): PanelListItem[] {
    return this.webUIAdapter.getWebUIPanelList();
  }

  public async executePanelForWebUI(
    panelId: string,
    userId: string,
    guildId?: string | null,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    return await this.webUIAdapter.executePanelForWebUI(panelId, userId, guildId, navigationStack, channelId);
  }

  public async handleWebUIButton(
    panelId: string,
    buttonId: string,
    userId: string,
    guildId?: string | null,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    return await this.webUIAdapter.handleWebUIButton(panelId, buttonId, userId, guildId, navigationStack, channelId);
  }

  public async handleWebUIDropdown(
    panelId: string,
    values: string[],
    userId: string,
    guildId?: string | null,
    dropdownId?: string,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    return await this.webUIAdapter.handleWebUIDropdown(panelId, values, userId, guildId, dropdownId, navigationStack, channelId);
  }

  public async handleWebUIModal(
    panelId: string,
    modalId: string,
    fields: Record<string, string>,
    userId: string,
    guildId?: string | null,
    navigationStack?: string[],
    channelId?: string | null
  ): Promise<WebUIResponse<SerializedPanelResponse>> {
    return await this.webUIAdapter.handleWebUIModal(panelId, modalId, fields, userId, guildId, navigationStack, channelId);
  }
}

let panelManagerInstance: PanelManager | null = null;

export function getPanelManager(client?: Client): PanelManager {
  if (!panelManagerInstance && client) {
    panelManagerInstance = new PanelManager(client);
  }
  return panelManagerInstance!;
}

import {
  Client,
  CommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  AnySelectMenuInteraction,
  ModalSubmitInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  GatewayIntentBits,
  ApplicationCommandOptionData,
  PermissionResolvable,
  Locale,
  // V2 Components
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  FileBuilder,
  MessageFlags,
  SeparatorSpacingSize,
} from 'discord.js';

// Re-export V2 components for convenience
export {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  FileBuilder,
  MessageFlags,
  SeparatorSpacingSize,
};

// Panel interaction types (supports all select menu types: string, channel, user, role, mentionable)
export type PanelInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

/**
 * V2 top-level components that can be added to a Container
 * Note: ActionRowBuilder is still used for buttons/selects within containers
 */
export type V2TopLevelComponent = ContainerBuilder;

/**
 * Panel response structure
 *
 * V1 Mode (default): Uses embeds + ActionRows (traditional Discord layout)
 * V2 Mode: Uses ContainerBuilder with V2 components (modern layout)
 *
 * V2 mode is auto-detected when components array contains ContainerBuilder.
 * When in V2 mode, embeds and content are NOT allowed (Discord limitation).
 */
export interface PanelResponse {
  // V1 properties (traditional)
  embeds?: EmbedBuilder[];
  content?: string;

  // Components - accepts both V1 (ActionRowBuilder[]) and V2 (ContainerBuilder[])
  // V2 is auto-detected when array contains ContainerBuilder
  // Using 'any[]' to avoid TypeScript union issues between incompatible builder types
  components?: any[];

  // Flags - use MessageFlags.Ephemeral for ephemeral, MessageFlags.IsComponentsV2 is auto-added for V2
  ephemeral?: boolean; // Deprecated, use flags instead
  flags?: number;

  // Attachments
  files?: any[];

  // Modal response - when set, panel system shows this modal instead of updating message
  // The modal will be shown and no other response properties are used
  modal?: ModalBuilder;

  // Close panel - when true, the panel system will close/delete the panel
  // For Discord: calls interaction.deleteReply() to remove the ephemeral message
  // For Web-UI: returns to panel list
  closePanel?: boolean;

  // Notification - shows a temporary message alongside the panel
  // For Discord: sent via interaction.followUp() as ephemeral (unless silent: true)
  // For Web-UI: displayed as a toast/notification popup (always shown)
  notification?: {
    type: 'error' | 'warning' | 'success' | 'info';
    message: string;
    title?: string;
    // When true, Discord will NOT show the ephemeral followUp message
    // The panel will just close silently using defer+delete
    // Web-UI will still show the notification popup regardless
    silent?: boolean;
  };
}

/**
 * Check if a PanelResponse uses V2 components
 */
export function isV2Response(response: PanelResponse): boolean {
  if (!response.components || response.components.length === 0) return false;
  // Check if first component is a ContainerBuilder
  return response.components[0] instanceof ContainerBuilder;
}

// Panel context passed to handlers
export interface PanelContext {
  client: Client;
  interaction: PanelInteraction | null; // Null when accessed via Web-UI
  panelId: string;
  userId: string;
  guildId?: string | null; // Guild context (null for Web-UI, which uses MAIN_GUILD_ID)
  channelId?: string | null; // Channel context for panels that require a specific channel (Web-UI)
  accessMethod: 'system_panel' | 'guild_panel' | 'direct_command' | 'web_ui'; // How the panel was accessed
  data?: any; // Additional data passed between panel interactions
  navigationStack?: string[]; // Track panel navigation history for nested return buttons
}

// Base panel configuration
export interface PanelOptions {
  // Panel identification
  id: string;
  name: string;
  description: string;
  category?: string;
  
  // Panel scope - determines where panel is accessible
  panelScope?: 'system' | 'guild'; // 'system' = owner-only (update, global configs), 'guild' = per-guild admins (default)

  // Admin panel listing
  showInAdminPanel?: boolean;
  adminPanelOrder?: number;
  adminPanelIcon?: string;

  // Slash command registration (optional)
  registerAsCommand?: boolean;
  commandName?: string;
  commandDescription?: string;
  commandOptions?: ApplicationCommandOptionData[];
  
  // Permissions and access control
  requiredPermissions?: PermissionResolvable[];
  allowedUsers?: string[]; // User IDs
  allowedRoles?: string[]; // Role IDs
  devOnly?: boolean;
  testOnly?: boolean;
  mainGuildOnly?: boolean; // Only available in MAIN_GUILD_ID (e.g., UPDATE panel)
  
  // Technical requirements
  requiredIntents?: GatewayIntentBits[];

  // Web-UI channel requirement
  // If true, Web-UI will show a channel selector and panel will be disabled until a channel is selected
  // The selected channel ID is passed in PanelContext.channelId
  requiresChannel?: boolean;

  // Persistent panel configuration
  persistent?: boolean; // If true, panel messages will persist and can be edited
  persistentWarningMessage?: string; // Custom warning message for persistent panels
  maxActiveInstances?: number; // Maximum number of active persistent panels (default: 1 for system panels, unlimited for guild)
  unique?: boolean; // If true, only ONE instance can be active at a time. Old instances are deactivated when new ones open. Per-guild for guild panels, global for system panels. Web-UI doesn't count.

  // Localization
  name_localizations?: Partial<Record<Locale, string | null>>;
  description_localizations?: Partial<Record<Locale, string | null>>;

  // Panel lifecycle functions
  initialize?: (client: Client) => void;
  
  // Main panel handler - called when panel is first accessed
  callback: (context: PanelContext) => Promise<PanelResponse>;
  
  // Button interaction handlers
  // Return null if the interaction was handled directly (e.g., file downloads)
  handleButton?: (context: PanelContext, buttonId: string) => Promise<PanelResponse | null>;
  
  // Dropdown interaction handlers
  // Optional dropdownId is provided by Web-UI for routing to specific dropdown handlers
  handleDropdown?: (context: PanelContext, values: string[], dropdownId?: string) => Promise<PanelResponse>;
  
  // Modal submission handlers
  handleModal?: (context: PanelContext, modalId: string) => Promise<PanelResponse>;

  // Command interaction handler (if registerAsCommand is true)
  handleCommand?: (client: Client, interaction: CommandInteraction) => Promise<void>;

  // Callback when a persistent panel message is created (for dynamic update registration)
  onPersistentCreated?: (client: Client, guildId: string, messageId: string, channelId: string) => void;
}

// Panel manager configuration
export interface PanelManagerConfig {
  itemsPerPage: number;
  enablePagination: boolean;
  defaultCategory: string;
}

// Panel pagination data
export interface PanelPaginationData {
  currentPage: number;
  totalPages: number;
  itemsPerPage: number;
  totalItems: number;
  category?: string;
}

// Panel list item for admin panel display
export interface PanelListItem {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  order: number;
  scope: 'system' | 'guild'; // Panel scope for filtering
  requiresChannel?: boolean; // If true, Web-UI needs to show channel selector
}

// Persistent panel tracking data
export interface PersistentPanelInstance {
  messageId: string;
  channelId: string;
  userId: string;
  guildId?: string;
  createdAt: number;
  lastUpdated: number;
  state?: string;
  sessionData?: any;
  accessMethod?: 'system_panel' | 'guild_panel' | 'direct_command' | 'web_ui';
}

// Persistent panel storage structure
export interface PersistentPanelStorage {
  [panelId: string]: PersistentPanelInstance | { sessions: { [sessionId: string]: PersistentPanelInstance } };
}

// Augment Discord.js Client with panel handlers
declare module 'discord.js' {
  interface Client {
    panels: Map<string, PanelOptions>;
    panelManager: any; // Will be defined in the panel manager
  }
}
import {
  Client,
  CommandInteraction,
  UserContextMenuCommandInteraction,
  MessageContextMenuCommandInteraction,
  GatewayIntentBits,
  ApplicationCommandType,
  ApplicationCommandOptionData,
  ApplicationIntegrationType,
  InteractionContextType,
  Locale,
  Collection,
  ButtonInteraction,
  StringSelectMenuInteraction,
  AnySelectMenuInteraction,
  ModalSubmitInteraction,
  PermissionResolvable,
  User,
  MessageReaction,
  AutocompleteInteraction
} from 'discord.js';

// Re-export for convenience
export { ApplicationIntegrationType, InteractionContextType };

// --- Giveaway Data Structure ---
export interface Giveaway {
  guildId: string;
  channelId: string;
  messageId: string;
  id: string;
  title: string;
  /** Array of prizes (one per winner for multi-winner giveaways) */
  prizes: string[];
  /** Maps winner userId to their assigned prize (populated when giveaway ends) */
  prizeAssignments?: Record<string, string>;
  /** Set of winner userIds who have claimed their prize */
  claimedPrizes?: string[];
  endTime: number;
  startTime: number;
  creatorId: string;
  entryMode: 'button' | 'reaction' | 'trivia' | 'competition';
  winnerCount: number;
  participants: string[]; // User IDs
  winners: string[]; // User IDs
  ended: boolean;
  cancelled: boolean;
  triviaQuestion?: string;
  triviaAnswer?: string;
  maxTriviaAttempts?: number; // Max attempts for trivia, -1 or 0 for infinite
  reactionIdentifier?: string; // Custom Emoji ID or Unicode character for the handler
  reactionDisplayEmoji?: string; // Emoji string for display (e.g., <:name:id> or unicode char)
  /** For competition mode: show live leaderboard as winners are determined (default: true) */
  liveLeaderboard?: boolean;
  /** For competition mode: tracks order winners answered correctly (userId -> placement 0-indexed) */
  competitionPlacements?: Record<string, number>;
  // Optional fields for future features
  requiredRoles?: string[];
  blockedRoles?: string[];
  scheduledStartTime?: number;
}


/**
 * Interface for defining standard Slash Commands (Type 1)
 * using the bot's custom format.
 */
export interface CommandOptions {
  name: string;
  description: string;
  type?: ApplicationCommandType.ChatInput;

  devOnly?: boolean;
  testOnly?: boolean;
  permissionsRequired?: PermissionResolvable[];
  botPermissions?: PermissionResolvable[];
  requiredIntents?: GatewayIntentBits[];

  /**
   * Whether this command is safe to trigger from message responses.
   * Commands that use ephemeral replies, modals, or panels should NOT set this to true.
   * Only commands that send regular visible messages are safe.
   */
  messageTriggerSafe?: boolean;

  options?: ApplicationCommandOptionData[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  nsfw?: boolean;
  name_localizations?: Partial<Record<Locale, string | null>>;
  description_localizations?: Partial<Record<Locale, string | null>>;

  /**
   * Where the app can be installed for this command.
   * - GuildInstall (0): Traditional guild installation
   * - UserInstall (1): User installs to their account (allows use in any guild/DM)
   * @default [ApplicationIntegrationType.GuildInstall]
   */
  integration_types?: ApplicationIntegrationType[];

  /**
   * Where this command can be used.
   * - Guild (0): In guild channels
   * - BotDM (1): In DMs with the bot
   * - PrivateChannel (2): In DMs and group DMs
   * @default [InteractionContextType.Guild]
   */
  contexts?: InteractionContextType[];

  initialize?: (client: Client) => void;
  callback: (client: Client, interaction: CommandInteraction) => void;
  handleModalSubmit?: (client: Client, interaction: ModalSubmitInteraction) => Promise<void>;
  autocomplete?: (client: Client, interaction: AutocompleteInteraction) => Promise<{ name: string; value: string }[]>;
}


/**
 * Generic Interface for defining Context Menu Commands (User or Message)
 * using the bot's custom format.
 */
export interface ContextMenuCommandOptions<TInteraction extends UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction> {
  name: string;
  type: TInteraction extends UserContextMenuCommandInteraction ? ApplicationCommandType.User : ApplicationCommandType.Message;

  devOnly?: boolean;
  testOnly?: boolean;
  permissionsRequired?: PermissionResolvable[];
  botPermissions?: PermissionResolvable[];
  requiredIntents?: GatewayIntentBits[];

  default_member_permissions?: string | null;
  dm_permission?: boolean;
  nsfw?: boolean;
  name_localizations?: Partial<Record<Locale, string | null>>;

  /**
   * Where the app can be installed for this command.
   * - GuildInstall (0): Traditional guild installation
   * - UserInstall (1): User installs to their account (allows use in any guild/DM)
   * @default [ApplicationIntegrationType.GuildInstall]
   */
  integration_types?: ApplicationIntegrationType[];

  /**
   * Where this command can be used.
   * - Guild (0): In guild channels
   * - BotDM (1): In DMs with the bot
   * - PrivateChannel (2): In DMs and group DMs
   * @default [InteractionContextType.Guild]
   */
  contexts?: InteractionContextType[];

  initialize?: (client: Client) => void;
  callback: (client: Client, interaction: TInteraction) => void;
  handleModalSubmit?: (client: Client, interaction: ModalSubmitInteraction) => Promise<void>;
}


// --- Handler Info Interfaces ---
export type SpecialUserRule =
  | { type: 'user'; id: string; value: number }
  | { type: 'permission'; id: PermissionResolvable; value: number };

export interface RegisteredButtonInfo {
    // Update handler signature to accept userLevel
    handler: (client: Client, interaction: ButtonInteraction, userLevel: number) => Promise<void>;
    timeoutMs: number | null;
    permissionsRequired?: PermissionResolvable[];
    specialUsers?: SpecialUserRule[];
}

export interface RegisteredDropdownInfo<TInteraction extends AnySelectMenuInteraction = AnySelectMenuInteraction> {
    handler: (client: Client, interaction: TInteraction) => Promise<void>;
    timeoutMs: number | null;
}

export interface RegisteredModalInfo {
    handler: (client: Client, interaction: ModalSubmitInteraction) => Promise<void>;
}

export interface RegisteredReactionInfo {
    handler: (client: Client, reaction: MessageReaction, user: User, self: RegisteredReactionInfo) => Promise<void>;
    emojiIdentifier: string; // Unicode char or custom emoji ID
    endTime?: number;
    guildId?: string;
    maxEntries?: number; // Overall max entries for this reaction message (0 or undefined for infinite)
    allowBots?: boolean; // If the handler should process bot reactions (defaults to false)
    collectedUsers: Set<string>; // Users who have successfully triggered this reaction handler
}

export interface RegisteredReactionRemoveInfo {
    handler: (client: Client, reaction: MessageReaction, user: User) => Promise<void>;
    emojiIdentifier: string;
    guildId?: string;
}

// --- Augmentation for Discord.js Client ---

declare module 'discord.js' {
  interface Client {
    buttonHandlers: Map<string, RegisteredButtonInfo>;
    dropdownHandlers: Map<string, RegisteredDropdownInfo>;
    modalHandlers: Map<string, RegisteredModalInfo>;
    reactionHandlers: Map<string, RegisteredReactionInfo>; // Key: messageId
    reactionRemoveHandlers: Map<string, RegisteredReactionRemoveInfo[]>; // Key: messageId
  }
}



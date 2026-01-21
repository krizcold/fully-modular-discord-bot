import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
  GatewayIntentBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SectionBuilder,
  ThumbnailBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { PanelOptions, PanelContext, PanelResponse } from '../../types/panelTypes';
import { createV2Response, V2Colors } from '../utils/panel/v2';
import { loadCredentials } from '../../../utils/envLoader';
import { loadGlobalData, saveGlobalData } from '../utils/dataManager';

// Storage files
const BLACKLIST_FILE = 'guild-blacklist.json';
const NOTES_FILE = 'guild-notes.json';

// Interfaces
interface GuildBlacklist {
  guilds: {
    id: string;
    name: string;
    reason?: string;
    blacklistedAt: string;
    blacklistedBy: string;
  }[];
}

interface GuildNotes {
  notes: {
    [guildId: string]: {
      note: string;
      updatedAt: string;
      updatedBy: string;
    };
  };
}

// In-memory search state (per user)
const searchState = new Map<string, string>();

// Blacklist functions
function loadBlacklist(): GuildBlacklist {
  return loadGlobalData<GuildBlacklist>(BLACKLIST_FILE, { guilds: [] }, 'system');
}

function saveBlacklist(blacklist: GuildBlacklist): void {
  saveGlobalData(BLACKLIST_FILE, blacklist, 'system');
}

function isGuildBlacklisted(guildId: string): boolean {
  const blacklist = loadBlacklist();
  return blacklist.guilds.some(g => g.id === guildId);
}

// Notes functions
function loadNotes(): GuildNotes {
  return loadGlobalData<GuildNotes>(NOTES_FILE, { notes: {} }, 'system');
}

function saveNotes(notes: GuildNotes): void {
  saveGlobalData(NOTES_FILE, notes, 'system');
}

function getGuildNote(guildId: string): string | null {
  const notes = loadNotes();
  return notes.notes[guildId]?.note || null;
}

function setGuildNote(guildId: string, note: string, userId: string): void {
  const notes = loadNotes();
  if (note.trim()) {
    notes.notes[guildId] = {
      note: note.trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: userId,
    };
  } else {
    delete notes.notes[guildId];
  }
  saveNotes(notes);
}

function getSystemGuildIds(): string[] {
  const credentials = loadCredentials();
  const ids: string[] = [];
  if (credentials.GUILD_ID) ids.push(credentials.GUILD_ID);
  if (credentials.MAIN_GUILD_ID && credentials.MAIN_GUILD_ID !== credentials.GUILD_ID) {
    ids.push(credentials.MAIN_GUILD_ID);
  }
  return ids;
}

// Format bot permissions for display
function formatBotPermissions(permissions: PermissionsBitField): string {
  const keyPerms = [
    { flag: PermissionFlagsBits.Administrator, name: 'Admin' },
    { flag: PermissionFlagsBits.ManageGuild, name: 'Manage Server' },
    { flag: PermissionFlagsBits.ManageChannels, name: 'Manage Channels' },
    { flag: PermissionFlagsBits.ManageRoles, name: 'Manage Roles' },
    { flag: PermissionFlagsBits.ManageMessages, name: 'Manage Messages' },
    { flag: PermissionFlagsBits.KickMembers, name: 'Kick' },
    { flag: PermissionFlagsBits.BanMembers, name: 'Ban' },
    { flag: PermissionFlagsBits.ModerateMembers, name: 'Timeout' },
    { flag: PermissionFlagsBits.CreateInstantInvite, name: 'Create Invite' },
  ];

  if (permissions.has(PermissionFlagsBits.Administrator)) {
    return '👑 Administrator (all permissions)';
  }

  const hasPerms = keyPerms
    .filter(p => permissions.has(p.flag))
    .map(p => p.name);

  if (hasPerms.length === 0) {
    return 'Basic permissions only';
  }

  return hasPerms.join(', ');
}

const systemInfoPanel: PanelOptions = {
  id: 'system_info',
  name: 'System Information',
  description: 'View bot system information and statistics',
  category: 'System',
  panelScope: 'system',
  devOnly: true,

  showInAdminPanel: true,
  adminPanelOrder: 2,
  adminPanelIcon: '📊',
  mainGuildOnly: true,

  requiredPermissions: [PermissionFlagsBits.Administrator],
  requiredIntents: [GatewayIntentBits.Guilds],

  callback: async (context: PanelContext): Promise<PanelResponse> => {
    const { client } = context;

    const uptime = process.uptime();
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);
    const uptimeSeconds = Math.floor(uptime % 60);

    const memoryUsage = process.memoryUsage();
    const memoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

    const container = new ContainerBuilder()
      .setAccentColor(0x00D4AA);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## System Information\nCurrent bot system status and statistics')
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🤖 Bot:** ${client.user?.tag || 'Unknown'}\n` +
        `**🆔 ID:** \`${client.user?.id || 'Unknown'}\``
      )
    );

    const userInstallCount = client.application?.approximateUserInstallCount;
    const userInstallDisplay = userInstallCount != null ? ` | **📱 User Installs:** ~${userInstallCount}` : '';

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🌐 Guilds:** ${client.guilds.cache.size}${userInstallDisplay}\n` +
        `**📁 Channels:** ${client.channels.cache.size} cached`
      )
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**⏱️ Uptime:** ${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s\n` +
        `**💾 Memory:** ${memoryMB} MB\n` +
        `**🟢 Node.js:** ${process.version}\n` +
        `**📦 Discord.js:** v14.21\n` +
        `**⚡ Platform:** ${process.platform}\n` +
        `**🔄 PID:** ${process.pid}`
      )
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('panel_system_info_btn_refresh')
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('panel_system_info_btn_detailed')
          .setLabel('Detailed Info')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('panel_system_info_btn_guilds')
          .setLabel('Guild Info')
          .setStyle(ButtonStyle.Secondary)
      )
    );

    return createV2Response([container]);
  },

  handleButton: async (context: PanelContext, buttonId: string): Promise<PanelResponse> => {
    // Handle guild pagination: guilds_page_{number}
    if (buttonId.startsWith('guilds_page_')) {
      const page = parseInt(buttonId.replace('guilds_page_', ''), 10);
      if (!isNaN(page) && page >= 0) {
        return await showGuildList(context, page);
      }
    }

    // Handle filtered guild pagination: guilds_filtered_page_{number}
    if (buttonId.startsWith('guilds_filtered_page_')) {
      const page = parseInt(buttonId.replace('guilds_filtered_page_', ''), 10);
      if (!isNaN(page) && page >= 0) {
        return await showGuildList(context, page, true);
      }
    }

    // Handle guild detail: guild_detail_{guildId}
    if (buttonId.startsWith('guild_detail_')) {
      const guildId = buttonId.replace('guild_detail_', '');
      return await showGuildDetail(context, guildId);
    }

    // Handle guild leave: guild_leave_{guildId}
    if (buttonId.startsWith('guild_leave_')) {
      const guildId = buttonId.replace('guild_leave_', '');
      return await handleGuildLeave(context, guildId);
    }

    // Handle guild blacklist: guild_blacklist_{guildId}
    if (buttonId.startsWith('guild_blacklist_')) {
      const guildId = buttonId.replace('guild_blacklist_', '');
      return await handleGuildBlacklist(context, guildId);
    }

    // Handle confirm actions
    if (buttonId.startsWith('confirm_leave_')) {
      const guildId = buttonId.replace('confirm_leave_', '');
      return await executeGuildLeave(context, guildId);
    }

    if (buttonId.startsWith('confirm_blacklist_')) {
      const guildId = buttonId.replace('confirm_blacklist_', '');
      return await executeGuildBlacklist(context, guildId);
    }

    // Handle unblacklist: unblacklist_{guildId}
    if (buttonId.startsWith('unblacklist_')) {
      const guildId = buttonId.replace('unblacklist_', '');
      return await handleUnblacklist(context, guildId);
    }

    // Handle blacklist pagination: blacklist_page_{number}
    if (buttonId.startsWith('blacklist_page_')) {
      const page = parseInt(buttonId.replace('blacklist_page_', ''), 10);
      if (!isNaN(page) && page >= 0) {
        return await showBlacklist(context, page);
      }
    }

    // Handle show note modal: show_note_modal_{guildId}
    if (buttonId.startsWith('show_note_modal_')) {
      const guildId = buttonId.replace('show_note_modal_', '');
      return await showNoteModal(context, guildId);
    }

    switch (buttonId) {
      case 'refresh':
        return await systemInfoPanel.callback(context);

      case 'detailed':
        return await showDetailedInfo(context);

      case 'guilds':
        // Clear search when going to guild list
        searchState.delete(context.userId);
        return await showGuildList(context, 0);

      case 'blacklist':
        return await showBlacklist(context, 0);

      case 'clear_search':
        searchState.delete(context.userId);
        return await showGuildList(context, 0);

      case 'show_search_modal':
        return await showSearchModal(context);

      default:
        return createV2Response([
          new ContainerBuilder()
            .setAccentColor(V2Colors.danger)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent('## Error\nUnknown button action.')
            )
        ]);
    }
  },

  handleModal: async (context: PanelContext, modalId: string): Promise<PanelResponse> => {
    const interaction = context.interaction;
    if (!interaction || !('fields' in interaction)) {
      return createV2Response([
        new ContainerBuilder()
          .setAccentColor(V2Colors.danger)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## Error\nInvalid interaction.')
          )
      ]);
    }

    // Handle search modal
    if (modalId === 'search') {
      const searchTerm = interaction.fields.getTextInputValue('search_term')?.trim().toLowerCase() || '';
      if (searchTerm) {
        searchState.set(context.userId, searchTerm);
        return await showGuildList(context, 0, true);
      }
      return await showGuildList(context, 0);
    }

    // Handle note modal: note_{guildId}
    if (modalId.startsWith('note_')) {
      const guildId = modalId.replace('note_', '');
      const note = interaction.fields.getTextInputValue('note_content') || '';
      setGuildNote(guildId, note, context.userId);
      return await showGuildDetail(context, guildId);
    }

    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Error\nUnknown modal.')
        )
    ]);
  },
};

async function showDetailedInfo(context: PanelContext): Promise<PanelResponse> {
  const memoryUsage = process.memoryUsage();

  const container = new ContainerBuilder()
    .setAccentColor(0x00D4AA);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## Detailed System Information')
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Memory Details\n` +
      `**Heap Used:** ${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB\n` +
      `**Heap Total:** ${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB\n` +
      `**External:** ${Math.round(memoryUsage.external / 1024 / 1024)} MB\n` +
      `**RSS:** ${Math.round(memoryUsage.rss / 1024 / 1024)} MB`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Process Info\n` +
      `**PID:** ${process.pid}\n` +
      `**PPID:** ${process.ppid}\n` +
      `**Platform:** ${process.platform}\n` +
      `**Architecture:** ${process.arch}`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## Environment\n` +
      `**Node Version:** ${process.version}\n` +
      `**Environment:** ${process.env.NODE_ENV || 'development'}\n` +
      `**Working Directory:** ${process.cwd().split('/').pop()}\n` +
      `**Exec Path:** ${process.execPath.split('/').pop()}`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('panel_system_info_btn_refresh')
        .setLabel('Back to System Info')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return createV2Response([container]);
}

const GUILDS_PER_PAGE = 5;

async function showGuildList(context: PanelContext, page: number = 0, filtered: boolean = false): Promise<PanelResponse> {
  const { client, userId } = context;
  const systemGuildIds = getSystemGuildIds();
  const searchTerm = filtered ? searchState.get(userId) : null;
  const notes = loadNotes();

  let allGuilds = client.guilds.cache
    .map(guild => ({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
      isSystem: systemGuildIds.includes(guild.id),
      hasNote: !!notes.notes[guild.id],
    }))
    .sort((a, b) => {
      // System guilds first, then by member count
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      return b.memberCount - a.memberCount;
    });

  // Apply search filter
  if (searchTerm) {
    allGuilds = allGuilds.filter(g =>
      g.name.toLowerCase().includes(searchTerm) ||
      g.id.includes(searchTerm)
    );
  }

  const totalGuilds = allGuilds.length;
  const totalPages = Math.max(1, Math.ceil(totalGuilds / GUILDS_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * GUILDS_PER_PAGE;
  const pageGuilds = allGuilds.slice(startIdx, startIdx + GUILDS_PER_PAGE);

  const container = new ContainerBuilder()
    .setAccentColor(0x00D4AA);

  // Title with search indicator
  const titleText = searchTerm
    ? `# Search Results\nFound **${totalGuilds}** guild(s) matching "${searchTerm}"`
    : `# Guild Management\nBot is active in **${totalGuilds}** guild(s)`;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(titleText)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  if (pageGuilds.length > 0) {
    for (const guild of pageGuilds) {
      const badges: string[] = [];
      if (guild.isSystem) badges.push('🔒');
      if (guild.hasNote) badges.push('📝');
      const badgeStr = badges.length > 0 ? ' ' + badges.join('') : '';

      const section = new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**${guild.name}**${badgeStr}\n` +
            `-# 👥 ${guild.memberCount.toLocaleString()} members`
          )
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`panel_system_info_btn_guild_detail_${guild.id}`)
            .setLabel('View')
            .setStyle(ButtonStyle.Secondary)
        );

      container.addSectionComponents(section);
    }
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(searchTerm ? 'No guilds match your search.' : 'No guilds found.')
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Footer with page info
  const blacklist = loadBlacklist();
  const blacklistCount = blacklist.guilds.length;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# Page ${currentPage + 1}/${totalPages}` +
      (blacklistCount > 0 ? ` · ${blacklistCount} blacklisted` : '')
    )
  );

  // Navigation buttons
  const pagePrefix = searchTerm ? 'guilds_filtered_page' : 'guilds_page';
  const navRow = new ActionRowBuilder<ButtonBuilder>();

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_system_info_btn_${pagePrefix}_${currentPage - 1}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('panel_system_info_btn_page_indicator')
      .setLabel(`${currentPage + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_system_info_btn_${pagePrefix}_${currentPage + 1}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1)
  );

  // Search button or clear search
  if (searchTerm) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId('panel_system_info_btn_clear_search')
        .setLabel('Clear')
        .setEmoji('✖')
        .setStyle(ButtonStyle.Secondary)
    );
  } else {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId('panel_system_info_btn_show_search_modal')
        .setLabel('Search')
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  container.addActionRowComponents(navRow);

  // Second row for blacklist and back
  const navRow2 = new ActionRowBuilder<ButtonBuilder>();

  if (blacklistCount > 0) {
    navRow2.addComponents(
      new ButtonBuilder()
        .setCustomId('panel_system_info_btn_blacklist')
        .setLabel('Blacklist')
        .setEmoji('🚫')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  navRow2.addComponents(
    new ButtonBuilder()
      .setCustomId('panel_system_info_btn_refresh')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  container.addActionRowComponents(navRow2);

  return createV2Response([container]);
}

async function showGuildDetail(context: PanelContext, guildId: string): Promise<PanelResponse> {
  const { client } = context;
  const guild = client.guilds.cache.get(guildId);
  const systemGuildIds = getSystemGuildIds();
  const isSystemGuild = systemGuildIds.includes(guildId);

  if (!guild) {
    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Error\nGuild not found or bot is no longer a member.')
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('panel_system_info_btn_guilds')
              .setLabel('Back to Guild List')
              .setStyle(ButtonStyle.Secondary)
          )
        )
    ]);
  }

  const container = new ContainerBuilder()
    .setAccentColor(isSystemGuild ? V2Colors.warning : 0x00D4AA);

  // Title section with guild icon
  const systemBadge = isSystemGuild ? ' 🔒' : '';
  const guildIcon = guild.iconURL({ size: 128 });

  if (guildIcon) {
    const titleSection = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${guild.name}${systemBadge}`)
      )
      .setThumbnailAccessory(
        new ThumbnailBuilder().setURL(guildIcon)
      );
    container.addSectionComponents(titleSection);
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${guild.name}${systemBadge}`)
    );
  }

  if (isSystemGuild) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# This is a system guild and cannot be left or blacklisted.')
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Guild info
  const owner = await guild.fetchOwner().catch(() => null);
  const createdAt = Math.floor(guild.createdTimestamp / 1000);
  const joinedAt = guild.joinedTimestamp ? Math.floor(guild.joinedTimestamp / 1000) : null;
  const botMember = guild.members.me;
  const botPermissions = botMember?.permissions;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**🆔 ID:** \`${guild.id}\`\n` +
      `**👑 Owner:** ${owner ? `${owner.user.tag}` : 'Unknown'}\n` +
      `**👥 Members:** ${guild.memberCount.toLocaleString()}\n` +
      `**📁 Channels:** ${guild.channels.cache.size}\n` +
      `**😀 Emojis:** ${guild.emojis.cache.size}\n` +
      `**📅 Created:** <t:${createdAt}:R>\n` +
      (joinedAt ? `**🤖 Bot Joined:** <t:${joinedAt}:R>` : '')
    )
  );

  // Bot permissions
  if (botPermissions) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🔐 Bot Permissions:** ${formatBotPermissions(botPermissions)}`
      )
    );
  }

  // Guild note
  const note = getGuildNote(guildId);
  if (note) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**📝 Note:**\n${note}`)
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  // Action buttons row
  const actionRow = new ActionRowBuilder<ButtonBuilder>();

  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_system_info_btn_show_note_modal_${guildId}`)
      .setLabel(note ? 'Edit Note' : 'Add Note')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary)
  );

  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_system_info_btn_guild_leave_${guildId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isSystemGuild)
  );

  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_system_info_btn_guild_blacklist_${guildId}`)
      .setLabel('Blacklist')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isSystemGuild)
  );

  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId('panel_system_info_btn_guilds')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  container.addActionRowComponents(actionRow);

  return createV2Response([container]);
}

async function handleGuildLeave(context: PanelContext, guildId: string): Promise<PanelResponse> {
  const { client } = context;
  const guild = client.guilds.cache.get(guildId);
  const systemGuildIds = getSystemGuildIds();

  if (!guild) {
    return showGuildList(context, 0);
  }

  if (systemGuildIds.includes(guildId)) {
    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Error\nCannot leave a system guild.')
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`panel_system_info_btn_guild_detail_${guildId}`)
              .setLabel('Back')
              .setStyle(ButtonStyle.Secondary)
          )
        )
    ]);
  }

  // Confirmation dialog
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ⚠️ Leave Guild?\n\n` +
      `Are you sure you want to leave **${guild.name}**?\n\n` +
      `This will remove the bot from this server. You will need to re-invite the bot to rejoin.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_system_info_btn_confirm_leave_${guildId}`)
        .setLabel('Yes, Leave Guild')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`panel_system_info_btn_guild_detail_${guildId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return createV2Response([container]);
}

async function handleGuildBlacklist(context: PanelContext, guildId: string): Promise<PanelResponse> {
  const { client } = context;
  const guild = client.guilds.cache.get(guildId);
  const systemGuildIds = getSystemGuildIds();

  if (!guild) {
    return showGuildList(context, 0);
  }

  if (systemGuildIds.includes(guildId)) {
    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Error\nCannot blacklist a system guild.')
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`panel_system_info_btn_guild_detail_${guildId}`)
              .setLabel('Back')
              .setStyle(ButtonStyle.Secondary)
          )
        )
    ]);
  }

  // Confirmation dialog
  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🚫 Blacklist Guild?\n\n` +
      `Are you sure you want to blacklist **${guild.name}**?\n\n` +
      `This will:\n` +
      `• Leave the guild immediately\n` +
      `• Prevent the bot from being added back\n\n` +
      `You can remove guilds from the blacklist later.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_system_info_btn_confirm_blacklist_${guildId}`)
        .setLabel('Yes, Blacklist Guild')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`panel_system_info_btn_guild_detail_${guildId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return createV2Response([container]);
}

async function executeGuildLeave(context: PanelContext, guildId: string): Promise<PanelResponse> {
  const { client } = context;
  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    return showGuildList(context, 0);
  }

  const guildName = guild.name;

  try {
    await guild.leave();

    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.success)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ✅ Left Guild\n\n` +
            `Successfully left **${guildName}**.`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('panel_system_info_btn_guilds')
              .setLabel('Back to Guild List')
              .setStyle(ButtonStyle.Secondary)
          )
        )
    ]);
  } catch (error) {
    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.danger)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ❌ Failed to Leave\n\n` +
            `Could not leave **${guildName}**.\n\n` +
            `-# ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('panel_system_info_btn_guilds')
              .setLabel('Back to Guild List')
              .setStyle(ButtonStyle.Secondary)
          )
        )
    ]);
  }
}

async function executeGuildBlacklist(context: PanelContext, guildId: string): Promise<PanelResponse> {
  const { client, userId } = context;
  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    return showGuildList(context, 0);
  }

  const guildName = guild.name;

  // Add to blacklist
  const blacklist = loadBlacklist();
  if (!blacklist.guilds.some(g => g.id === guildId)) {
    blacklist.guilds.push({
      id: guildId,
      name: guildName,
      blacklistedAt: new Date().toISOString(),
      blacklistedBy: userId,
    });
    saveBlacklist(blacklist);
  }

  // Leave the guild
  try {
    await guild.leave();

    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.success)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🚫 Guild Blacklisted\n\n` +
            `Successfully blacklisted and left **${guildName}**.\n\n` +
            `The bot will automatically leave if someone tries to add it back.`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('panel_system_info_btn_guilds')
              .setLabel('Back to Guild List')
              .setStyle(ButtonStyle.Secondary)
          )
        )
    ]);
  } catch (error) {
    return createV2Response([
      new ContainerBuilder()
        .setAccentColor(V2Colors.warning)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ⚠️ Blacklisted (Leave Failed)\n\n` +
            `Added **${guildName}** to blacklist but failed to leave.\n\n` +
            `-# ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('panel_system_info_btn_guilds')
              .setLabel('Back to Guild List')
              .setStyle(ButtonStyle.Secondary)
          )
        )
    ]);
  }
}

async function showBlacklist(context: PanelContext, page: number = 0): Promise<PanelResponse> {
  const blacklist = loadBlacklist();
  const ITEMS_PER_PAGE = 5;

  const totalItems = blacklist.guilds.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * ITEMS_PER_PAGE;
  const pageItems = blacklist.guilds.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const container = new ContainerBuilder()
    .setAccentColor(V2Colors.danger);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# Blacklisted Guilds\n` +
      `${totalItems} guild(s) are blocked from using this bot.`
    )
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  if (pageItems.length > 0) {
    for (const item of pageItems) {
      const blacklistedAt = new Date(item.blacklistedAt);
      const timestamp = Math.floor(blacklistedAt.getTime() / 1000);

      const section = new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**${item.name}**\n` +
            `-# ID: \`${item.id}\` · <t:${timestamp}:R>`
          )
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`panel_system_info_btn_unblacklist_${item.id}`)
            .setLabel('Remove')
            .setStyle(ButtonStyle.Secondary)
        );

      container.addSectionComponents(section);
    }
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('No blacklisted guilds.')
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# Page ${currentPage + 1}/${totalPages}`)
  );

  // Navigation
  const navRow = new ActionRowBuilder<ButtonBuilder>();

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_system_info_btn_blacklist_page_${currentPage - 1}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('panel_system_info_btn_blacklist_page_indicator')
      .setLabel(`${currentPage + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_system_info_btn_blacklist_page_${currentPage + 1}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1)
  );

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('panel_system_info_btn_guilds')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  container.addActionRowComponents(navRow);

  return createV2Response([container]);
}

async function handleUnblacklist(context: PanelContext, guildId: string): Promise<PanelResponse> {
  const blacklist = loadBlacklist();
  const guildEntry = blacklist.guilds.find(g => g.id === guildId);

  if (!guildEntry) {
    return showBlacklist(context, 0);
  }

  // Remove from blacklist
  blacklist.guilds = blacklist.guilds.filter(g => g.id !== guildId);
  saveBlacklist(blacklist);

  return createV2Response([
    new ContainerBuilder()
      .setAccentColor(V2Colors.success)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ✅ Removed from Blacklist\n\n` +
          `**${guildEntry.name}** has been removed from the blacklist.\n\n` +
          `The bot can now be added to this server again.`
        )
      )
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('panel_system_info_btn_blacklist')
            .setLabel('Back to Blacklist')
            .setStyle(ButtonStyle.Secondary)
        )
      )
  ]);
}

// Modal functions
async function showSearchModal(context: PanelContext): Promise<PanelResponse> {
  const modal = new ModalBuilder()
    .setCustomId('panel_system_info_modal_search')
    .setTitle('Search Guilds');

  const searchInput = new TextInputBuilder()
    .setCustomId('search_term')
    .setLabel('Guild Name or ID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Enter guild name to search...')
    .setRequired(true)
    .setMaxLength(100);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(searchInput)
  );

  return { modal: modal } as any;
}

async function showNoteModal(context: PanelContext, guildId: string): Promise<PanelResponse> {
  const { client } = context;
  const guild = client.guilds.cache.get(guildId);
  const existingNote = getGuildNote(guildId) || '';

  const modal = new ModalBuilder()
    .setCustomId(`panel_system_info_modal_note_${guildId}`)
    .setTitle(`Note: ${guild?.name?.slice(0, 35) || 'Guild'}`);

  const noteInput = new TextInputBuilder()
    .setCustomId('note_content')
    .setLabel('Note')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Add a note about this guild...')
    .setRequired(false)
    .setMaxLength(500);

  if (existingNote) {
    noteInput.setValue(existingNote);
  }

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput)
  );

  return { modal: modal } as any;
}

export default systemInfoPanel;

// Export for use by guildCreate event
export { isGuildBlacklisted, loadBlacklist, saveBlacklist };

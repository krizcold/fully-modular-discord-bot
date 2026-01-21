// Panel Serializer - Converts Discord components to Web-UI format

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  ModalBuilder,
  Client,
  // V2 Components
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  FileBuilder,
  MessageFlags,
} from 'discord.js';
import { PanelResponse, isV2Response } from '../../types/panelTypes';
import { DISCORD_EPHEMERAL_FLAG } from '../../constants';

/**
 * Extract all Discord user mention IDs from text
 * Matches: <@userId> and <@!userId>
 */
export function extractUserMentions(text: string): string[] {
  if (!text) return [];
  const mentionRegex = /<@!?(\d+)>/g;
  const ids: string[] = [];
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    if (!ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/**
 * Extract user IDs from a PanelResponse (content + all embeds)
 */
export function extractUserIdsFromResponse(response: PanelResponse): string[] {
  const ids: string[] = [];

  // From content
  if (response.content) {
    ids.push(...extractUserMentions(response.content));
  }

  // From embeds
  if (response.embeds) {
    for (const embed of response.embeds) {
      const data = embed.toJSON();
      if (data.title) ids.push(...extractUserMentions(data.title));
      if (data.description) ids.push(...extractUserMentions(data.description));
      if (data.fields) {
        for (const field of data.fields) {
          ids.push(...extractUserMentions(field.name));
          ids.push(...extractUserMentions(field.value));
        }
      }
      if (data.footer?.text) ids.push(...extractUserMentions(data.footer.text));
      if (data.author?.name) ids.push(...extractUserMentions(data.author.name));
    }
  }

  // Deduplicate
  return [...new Set(ids)];
}

/**
 * Resolve user IDs to user objects using Discord client
 */
export async function resolveUsers(client: Client, userIds: string[]): Promise<Record<string, ResolvedUser>> {
  const resolved: Record<string, ResolvedUser> = {};

  for (const id of userIds) {
    try {
      const user = await client.users.fetch(id);
      resolved[id] = {
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.username,
        avatarURL: user.displayAvatarURL({ size: 64 })
      };
    } catch (error) {
      // User not found or API error - use fallback
      resolved[id] = {
        id,
        username: `Unknown`,
        displayName: `Unknown User`
      };
    }
  }

  return resolved;
}

export interface SerializedEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  author?: {
    name?: string;
    iconURL?: string;
    url?: string;
  };
  footer?: {
    text?: string;
    iconURL?: string;
  };
  thumbnail?: {
    url?: string;
  };
  image?: {
    url?: string;
  };
  timestamp?: string;
  url?: string;
}

/**
 * Serialized emoji info for Web-UI rendering
 * - Unicode emojis: only name is set (contains the unicode char)
 * - Custom Discord emojis: name, id, and optionally animated are set
 */
export interface SerializedEmoji {
  name?: string;      // Unicode char or custom emoji name
  id?: string;        // Custom emoji snowflake ID (for CDN URL)
  animated?: boolean; // Whether custom emoji is animated (gif vs png)
}

export interface SerializedButton {
  type: 'button';
  customId?: string;
  label?: string;
  style: number;
  emoji?: SerializedEmoji;
  url?: string;
  disabled?: boolean;
}

export interface SerializedSelectMenu {
  type: 'select';
  customId: string;
  placeholder?: string;
  options: Array<{
    label: string;
    value: string;
    description?: string;
    emoji?: SerializedEmoji;
    default?: boolean;
  }>;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}

export interface SerializedTextInput {
  type: 'text_input';
  customId: string;
  label: string;
  style: number; // 1 = Short, 2 = Paragraph
  value?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface SerializedFileUpload {
  type: 'file_upload';
  customId: string;
  label: string;
  description?: string;
  required?: boolean;
  minValues?: number;
  maxValues?: number;
  accept?: string; // File type filter (e.g., '.json')
}

export type SerializedComponent = SerializedButton | SerializedSelectMenu | SerializedTextInput | SerializedFileUpload;

export interface SerializedActionRow {
  type: 'action_row';
  components: SerializedComponent[];
}

export interface SerializedModal {
  type: 'modal';
  customId: string;
  title: string;
  components: SerializedActionRow[];
}

export interface ResolvedUser {
  id: string;
  username: string;
  displayName?: string;
  avatarURL?: string;
}

// ============================================================================
// V2 Serialization Types
// ============================================================================

export interface SerializedTextDisplay {
  type: 'text_display';
  content: string;
}

export interface SerializedSeparator {
  type: 'separator';
  spacing?: number;
  divider?: boolean;
}

export interface SerializedThumbnail {
  type: 'thumbnail';
  url: string;
  description?: string;
}

export interface SerializedMediaGalleryItem {
  url: string;
  description?: string;
}

export interface SerializedMediaGallery {
  type: 'media_gallery';
  items: SerializedMediaGalleryItem[];
}

export interface SerializedFile {
  type: 'file';
  url: string;
  filename?: string;
}

export interface SerializedSection {
  type: 'section';
  textDisplays: SerializedTextDisplay[];
  accessory?: SerializedButton | SerializedThumbnail;
}

export type SerializedV2Component =
  | SerializedTextDisplay
  | SerializedSeparator
  | SerializedSection
  | SerializedActionRow
  | SerializedMediaGallery
  | SerializedFile;

export interface SerializedContainer {
  type: 'container';
  accentColor?: number;
  components: SerializedV2Component[];
}

// ============================================================================
// Main Response Interface
// ============================================================================

export interface SerializedPanelResponse {
  // V1 properties
  content?: string;
  embeds?: SerializedEmbed[];
  components?: SerializedActionRow[];
  modal?: SerializedModal;
  ephemeral?: boolean;
  resolvedUsers?: Record<string, ResolvedUser>;

  // V2 properties
  isV2?: boolean;
  containers?: SerializedContainer[];

  // Notification (toast/popup) for Web-UI
  notification?: {
    type: 'error' | 'warning' | 'success' | 'info';
    message: string;
    title?: string;
  };
}

/**
 * Serialize a Discord EmbedBuilder to plain JSON
 */
export function serializeEmbed(embed: EmbedBuilder): SerializedEmbed {
  const data = embed.toJSON();

  return {
    title: data.title,
    description: data.description,
    color: data.color,
    fields: data.fields,
    author: data.author,
    footer: data.footer,
    thumbnail: data.thumbnail,
    image: data.image,
    timestamp: data.timestamp,
    url: data.url
  };
}

/**
 * Type for Discord button JSON representation
 */
interface ButtonJSONData {
  custom_id?: string;
  label?: string;
  style: number;
  emoji?: { name?: string; id?: string; animated?: boolean };
  url?: string;
  disabled?: boolean;
}

/**
 * Serialize a Discord ButtonBuilder to plain JSON
 */
function serializeButton(button: ButtonBuilder): SerializedButton {
  const data = button.toJSON() as ButtonJSONData;

  // Build emoji object with full info for Web-UI rendering
  let emoji: SerializedEmoji | undefined;
  if (data.emoji) {
    emoji = {
      name: data.emoji.name,
      id: data.emoji.id,
      animated: data.emoji.animated,
    };
  }

  return {
    type: 'button',
    customId: data.custom_id,
    label: data.label,
    style: data.style,
    emoji,
    url: data.url,
    disabled: data.disabled
  };
}

/**
 * Serialize a Discord StringSelectMenuBuilder to plain JSON
 */
function serializeSelectMenu(menu: StringSelectMenuBuilder): SerializedSelectMenu {
  const data = menu.toJSON();

  return {
    type: 'select',
    customId: data.custom_id,
    placeholder: data.placeholder,
    options: data.options.map(opt => {
      // Build emoji object with full info for Web-UI rendering
      let emoji: SerializedEmoji | undefined;
      if (opt.emoji) {
        emoji = {
          name: (opt.emoji as any).name,
          id: (opt.emoji as any).id,
          animated: (opt.emoji as any).animated,
        };
      }
      return {
        label: opt.label,
        value: opt.value,
        description: opt.description,
        emoji,
        default: opt.default
      };
    }),
    minValues: data.min_values,
    maxValues: data.max_values,
    disabled: data.disabled
  };
}

/**
 * Serialize a Discord TextInputBuilder to plain JSON
 */
function serializeTextInput(input: TextInputBuilder): SerializedTextInput {
  const data = input.toJSON();

  return {
    type: 'text_input',
    customId: data.custom_id,
    label: data.label || '',
    style: data.style,
    value: data.value,
    placeholder: data.placeholder,
    required: data.required,
    minLength: data.min_length,
    maxLength: data.max_length
  };
}

/**
 * Serialize a Discord ModalBuilder to plain JSON
 * Handles both ActionRow components (TextInput) and Label components (FileUpload)
 */
export function serializeModal(modal: ModalBuilder): SerializedModal {
  const data = modal.toJSON();
  const components: SerializedActionRow[] = [];

  for (const row of data.components) {
    const serializedComponents: SerializedComponent[] = [];

    const rowType = (row as any).type as number;
    const labelData = row as any;

    // Handle ActionRow with nested components (TextInput)
    if ('components' in row && rowType === 1) { // ActionRow type
      for (const component of (row as any).components) {
        if (component.type === 4) { // TextInput type
          const textInput = new TextInputBuilder(component);
          serializedComponents.push(serializeTextInput(textInput));
        }
      }
    }
    // Handle Label components - they store the inner component in a 'component' property
    // The component's type determines what kind of input it is
    else if (labelData.component) {
      const innerComponent = labelData.component;
      const componentType = innerComponent.type;

      // ComponentType.FileUpload = 18
      if (componentType === 18) {
        serializedComponents.push({
          type: 'file_upload',
          customId: innerComponent.custom_id || 'file_upload',
          label: labelData.label || 'File',
          description: labelData.description,
          required: innerComponent.required ?? true,
          minValues: innerComponent.min_values ?? 1,
          maxValues: innerComponent.max_values ?? 1,
          accept: '.json' // Default to JSON files for config uploads
        } as SerializedFileUpload);
      }
      // ComponentType.StringSelect = 3
      else if (componentType === 3) {
        serializedComponents.push({
          type: 'select',
          customId: innerComponent.custom_id,
          placeholder: innerComponent.placeholder,
          options: innerComponent.options?.map((opt: any) => ({
            label: opt.label,
            value: opt.value,
            description: opt.description,
            default: opt.default
          })) || [],
          minValues: innerComponent.min_values,
          maxValues: innerComponent.max_values,
          disabled: innerComponent.disabled
        });
      }
      // ComponentType.RoleSelect = 6
      else if (componentType === 6) {
        serializedComponents.push({
          type: 'role_select',
          customId: innerComponent.custom_id || 'role_id',
          label: labelData.label || 'Select Role',
          description: labelData.description,
          placeholder: innerComponent.placeholder,
          required: true,
          minValues: innerComponent.min_values ?? 1,
          maxValues: innerComponent.max_values ?? 1,
        } as any);
      }
      // ComponentType.UserSelect = 5
      else if (componentType === 5) {
        serializedComponents.push({
          type: 'user_select',
          customId: innerComponent.custom_id || 'user_id',
          label: labelData.label || 'Select User',
          description: labelData.description,
          placeholder: innerComponent.placeholder,
          required: true,
          minValues: innerComponent.min_values ?? 1,
          maxValues: innerComponent.max_values ?? 1,
        } as any);
      }
      // ComponentType.ChannelSelect = 8
      else if (componentType === 8) {
        serializedComponents.push({
          type: 'channel_select',
          customId: innerComponent.custom_id || 'channel_id',
          label: labelData.label || 'Select Channel',
          description: labelData.description,
          placeholder: innerComponent.placeholder,
          required: true,
          minValues: innerComponent.min_values ?? 1,
          maxValues: innerComponent.max_values ?? 1,
        } as any);
      }
      // ComponentType.TextInput = 4 (text input in label)
      else if (componentType === 4) {
        const textInput = new TextInputBuilder(innerComponent);
        serializedComponents.push(serializeTextInput(textInput));
      }
    }

    // Only add row if it has components
    if (serializedComponents.length > 0) {
      components.push({
        type: 'action_row',
        components: serializedComponents
      });
    }
  }

  return {
    type: 'modal',
    customId: data.custom_id,
    title: data.title,
    components
  };
}

/**
 * Serialize a Discord ActionRowBuilder to plain JSON
 */
export function serializeActionRow(row: ActionRowBuilder<any>): SerializedActionRow {
  const components: SerializedComponent[] = [];

  for (const component of row.components) {
    if (component instanceof ButtonBuilder) {
      components.push(serializeButton(component));
    } else if (component instanceof StringSelectMenuBuilder) {
      components.push(serializeSelectMenu(component));
    } else if (component instanceof TextInputBuilder) {
      components.push(serializeTextInput(component));
    }
  }

  return {
    type: 'action_row',
    components
  };
}

// ============================================================================
// V2 Serialization Functions
// ============================================================================

/**
 * Serialize a TextDisplayBuilder to plain JSON
 */
function serializeTextDisplay(textDisplay: TextDisplayBuilder): SerializedTextDisplay {
  const data = textDisplay.toJSON();
  return {
    type: 'text_display',
    content: (data as any).content || '',
  };
}

/**
 * Serialize a SeparatorBuilder to plain JSON
 */
function serializeSeparator(separator: SeparatorBuilder): SerializedSeparator {
  const data = separator.toJSON();
  return {
    type: 'separator',
    spacing: (data as any).spacing,
    divider: (data as any).divider,
  };
}

/**
 * Serialize a ThumbnailBuilder to plain JSON
 */
function serializeThumbnail(thumbnail: ThumbnailBuilder): SerializedThumbnail {
  const data = thumbnail.toJSON();
  return {
    type: 'thumbnail',
    url: (data as any).url || (data as any).media?.url || '',
    description: (data as any).description,
  };
}

/**
 * Serialize a SectionBuilder to plain JSON
 */
function serializeSection(section: SectionBuilder): SerializedSection {
  const data = section.toJSON() as any;
  const textDisplays: SerializedTextDisplay[] = [];

  // Sections contain text_display components
  if (data.components) {
    for (const comp of data.components) {
      if (comp.type === 12) { // TextDisplay type
        textDisplays.push({
          type: 'text_display',
          content: comp.content || '',
        });
      }
    }
  }

  // Handle accessory (button or thumbnail)
  let accessory: SerializedButton | SerializedThumbnail | undefined;
  if (data.accessory) {
    if (data.accessory.type === 2) { // Button type
      accessory = {
        type: 'button',
        customId: data.accessory.custom_id,
        label: data.accessory.label,
        style: data.accessory.style,
        emoji: data.accessory.emoji ? {
          name: data.accessory.emoji.name,
          id: data.accessory.emoji.id,
          animated: data.accessory.emoji.animated,
        } : undefined,
        disabled: data.accessory.disabled,
      };
    } else if (data.accessory.type === 11) { // Thumbnail type
      accessory = {
        type: 'thumbnail',
        url: data.accessory.media?.url || data.accessory.url || '',
        description: data.accessory.description,
      };
    }
  }

  return {
    type: 'section',
    textDisplays,
    accessory,
  };
}

/**
 * Serialize a MediaGalleryBuilder to plain JSON
 */
function serializeMediaGallery(gallery: MediaGalleryBuilder): SerializedMediaGallery {
  const data = gallery.toJSON() as any;
  const items: SerializedMediaGalleryItem[] = [];

  if (data.items) {
    for (const item of data.items) {
      items.push({
        url: item.media?.url || item.url || '',
        description: item.description,
      });
    }
  }

  return {
    type: 'media_gallery',
    items,
  };
}

/**
 * Serialize a FileBuilder to plain JSON
 */
function serializeFile(file: FileBuilder): SerializedFile {
  const data = file.toJSON() as any;
  return {
    type: 'file',
    url: data.file?.url || '',
    filename: data.file?.filename,
  };
}

/**
 * Serialize a ContainerBuilder to plain JSON
 */
function serializeContainer(container: ContainerBuilder): SerializedContainer {
  const data = container.toJSON() as any;
  const components: SerializedV2Component[] = [];

  if (data.components) {
    for (const comp of data.components) {
      switch (comp.type) {
        case 10: // TextDisplay (ComponentType.TextDisplay = 10)
          components.push({
            type: 'text_display',
            content: comp.content || '',
          });
          break;
        case 14: // Separator (ComponentType.Separator = 14)
          components.push({
            type: 'separator',
            spacing: comp.spacing,
            divider: comp.divider,
          });
          break;
        case 9: // Section (ComponentType.Section = 9)
          // Re-construct section data for serialization
          const sectionTextDisplays: SerializedTextDisplay[] = [];
          if (comp.components) {
            for (const innerComp of comp.components) {
              if (innerComp.type === 10) { // TextDisplay = 10
                sectionTextDisplays.push({
                  type: 'text_display',
                  content: innerComp.content || '',
                });
              }
            }
          }
          let sectionAccessory: SerializedButton | SerializedThumbnail | undefined;
          if (comp.accessory) {
            if (comp.accessory.type === 2) {
              sectionAccessory = {
                type: 'button',
                customId: comp.accessory.custom_id,
                label: comp.accessory.label,
                style: comp.accessory.style,
                emoji: comp.accessory.emoji ? {
                  name: comp.accessory.emoji.name,
                  id: comp.accessory.emoji.id,
                  animated: comp.accessory.emoji.animated,
                } : undefined,
                disabled: comp.accessory.disabled,
              };
            } else if (comp.accessory.type === 11) {
              sectionAccessory = {
                type: 'thumbnail',
                url: comp.accessory.media?.url || comp.accessory.url || '',
                description: comp.accessory.description,
              };
            }
          }
          components.push({
            type: 'section',
            textDisplays: sectionTextDisplays,
            accessory: sectionAccessory,
          });
          break;
        case 1: // ActionRow
          const rowComponents: SerializedComponent[] = [];
          if (comp.components) {
            for (const rowComp of comp.components) {
              if (rowComp.type === 2) { // Button
                rowComponents.push({
                  type: 'button',
                  customId: rowComp.custom_id,
                  label: rowComp.label,
                  style: rowComp.style,
                  emoji: rowComp.emoji ? {
                    name: rowComp.emoji.name,
                    id: rowComp.emoji.id,
                    animated: rowComp.emoji.animated,
                  } : undefined,
                  url: rowComp.url,
                  disabled: rowComp.disabled,
                });
              } else if (rowComp.type === 3) { // StringSelectMenu
                rowComponents.push({
                  type: 'select',
                  customId: rowComp.custom_id,
                  placeholder: rowComp.placeholder,
                  options: (rowComp.options || []).map((opt: any) => ({
                    label: opt.label,
                    value: opt.value,
                    description: opt.description,
                    emoji: opt.emoji ? {
                      name: opt.emoji.name,
                      id: opt.emoji.id,
                      animated: opt.emoji.animated,
                    } : undefined,
                    default: opt.default,
                  })),
                  minValues: rowComp.min_values,
                  maxValues: rowComp.max_values,
                  disabled: rowComp.disabled,
                });
              }
            }
          }
          components.push({
            type: 'action_row',
            components: rowComponents,
          });
          break;
        case 12: // MediaGallery (ComponentType.MediaGallery = 12)
          const galleryItems: SerializedMediaGalleryItem[] = [];
          if (comp.items) {
            for (const item of comp.items) {
              galleryItems.push({
                url: item.media?.url || item.url || '',
                description: item.description,
              });
            }
          }
          components.push({
            type: 'media_gallery',
            items: galleryItems,
          });
          break;
        case 13: // File (ComponentType.File = 13)
          components.push({
            type: 'file',
            url: comp.file?.url || '',
            filename: comp.file?.filename,
          });
          break;
      }
    }
  }

  return {
    type: 'container',
    accentColor: data.accent_color,
    components,
  };
}

// ============================================================================
// Main Serialization Function
// ============================================================================

/**
 * Serialize a complete PanelResponse to Web-UI format
 * Supports both V1 (embeds + ActionRows) and V2 (Containers) formats
 * @param response - The panel response to serialize
 * @param resolvedUsers - Optional map of resolved user data for mentions
 */
export function serializePanelResponse(
  response: PanelResponse,
  resolvedUsers?: Record<string, ResolvedUser>
): SerializedPanelResponse {
  // Check if this is a V2 response
  const v2 = isV2Response(response);

  const serialized: SerializedPanelResponse = {};

  if (v2) {
    // V2 serialization
    serialized.isV2 = true;
    serialized.containers = response.components?.map(comp => {
      if (comp instanceof ContainerBuilder) {
        return serializeContainer(comp);
      }
      // Fallback: shouldn't happen in V2 mode
      return serializeContainer(comp as ContainerBuilder);
    }) || [];
  } else {
    // V1 serialization (traditional)
    serialized.content = response.content;

    if (response.embeds) {
      serialized.embeds = response.embeds.map(embed => serializeEmbed(embed));
    }

    if (response.components) {
      serialized.components = response.components.map(row => serializeActionRow(row as ActionRowBuilder<any>));
    }
  }

  // Handle modal responses for Web-UI
  if ((response as any).modal) {
    const modalData = (response as any).modal;

    // If it's already a plain object (from Web-UI panels), use it directly
    if (modalData && typeof modalData === 'object' && !(modalData instanceof ModalBuilder)) {
      serialized.modal = modalData;
    }
    // If it's a ModalBuilder instance, serialize it
    else if (modalData instanceof ModalBuilder) {
      serialized.modal = serializeModal(modalData);
    }
  }

  // Check if ephemeral (works for both V1 and V2)
  const flags = response.flags || 0;
  const hasEphemeral = (flags & 64) !== 0 || response.ephemeral;
  if (hasEphemeral) {
    serialized.ephemeral = true;
  }

  // Include resolved users for mention display
  if (resolvedUsers && Object.keys(resolvedUsers).length > 0) {
    serialized.resolvedUsers = resolvedUsers;
  }

  // Include notification for Web-UI toast/popup
  if (response.notification) {
    serialized.notification = response.notification;
  }

  return serialized;
}

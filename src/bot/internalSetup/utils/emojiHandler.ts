/**
 * Centralized emoji parsing and resolution for all modules.
 * Handles custom emojis (guild/global), standard emoji shortcodes, and Unicode emojis.
 *
 * Features:
 * - Case-sensitive matching with case-insensitive fallback
 * - Standard emoji shortcodes via node-emoji (:cd: -> 💿)
 * - Guild emoji lookup with global fallback
 * - Translation layer: stores original input, computes display format
 */

import { Client, Guild } from 'discord.js';
import * as nodeEmoji from 'node-emoji';
import * as discordEmoji from 'discord-emoji-converter';

/**
 * Result of emoji parsing
 */
export interface EmojiParseResult {
  success: boolean;
  identifier?: string;    // Stored value (emoji ID for custom, unicode for standard)
  displayEmoji?: string;  // Display format (<:name:id> for custom, unicode for standard)
  errorMessage?: string;
}

/**
 * Parse a single emoji input (for emoji-only fields)
 *
 * Handles multiple input formats:
 * - Custom emoji: <:name:id>, <a:name:id>
 * - Name with ID: name:id, :name:id
 * - Shortcode: :name:
 * - Bare name: name (for emoji-only mode)
 * - Unicode: 🎉
 *
 * @param emojiInput - The raw emoji input string
 * @param client - Discord client for emoji cache
 * @param guild - Optional guild for guild-specific lookup
 */
export function parseEmoji(
  emojiInput: string,
  client: Client,
  guild?: Guild | null
): EmojiParseResult {
  const trimmed = emojiInput.trim();
  if (!trimmed) {
    return { success: false, errorMessage: 'No emoji provided.' };
  }

  // Pattern: <:name:id> or <a:name:id> (animated) - full Discord format
  const customEmojiRegex = /^<(a?):([a-zA-Z0-9_]+):(\d+)>$/;
  const customMatch = trimmed.match(customEmojiRegex);
  if (customMatch) {
    return resolveEmojiById(customMatch[3], client);
  }

  // Pattern: <name:id> - partial format without colon after <
  const partialCustomRegex = /^<([a-zA-Z0-9_]+):(\d+)>$/;
  const partialMatch = trimmed.match(partialCustomRegex);
  if (partialMatch) {
    return resolveEmojiById(partialMatch[2], client);
  }

  // Pattern: name:id or :name:id or :name:id: - name with numeric ID
  const nameWithIdRegex = /^:?([a-zA-Z0-9_]+):(\d+):?$/;
  const nameIdMatch = trimmed.match(nameWithIdRegex);
  if (nameIdMatch) {
    return resolveEmojiById(nameIdMatch[2], client);
  }

  // Pattern: :name: (shortcode - could be standard or custom emoji)
  const shortcodeRegex = /^:([a-zA-Z0-9_-]+):$/;
  const shortcodeMatch = trimmed.match(shortcodeRegex);
  if (shortcodeMatch) {
    return resolveShortcode(shortcodeMatch[1], client, guild);
  }

  // Pattern: :name or name: (partial colons - strip and treat as bare name)
  const partialColonRegex = /^:?([a-zA-Z0-9_-]+):?$/;
  const partialColonMatch = trimmed.match(partialColonRegex);
  if (partialColonMatch) {
    const name = partialColonMatch[1];
    // Only process if it's a valid name (not just colons)
    if (name && /^[a-zA-Z0-9_-]+$/.test(name)) {
      return resolveShortcode(name, client, guild);
    }
  }

  // Assume Unicode emoji (directly pasted)
  // Unicode emojis can be up to 14 characters (with modifiers/ZWJ sequences)
  if (trimmed.length > 0 && trimmed.length <= 14) {
    return {
      success: true,
      identifier: trimmed,
      displayEmoji: trimmed
    };
  }

  return {
    success: false,
    errorMessage: `Emoji not found. Check the spelling or use a different emoji.`
  };
}

/**
 * Resolve emoji by ID from client cache
 */
function resolveEmojiById(emojiId: string, client: Client): EmojiParseResult {
  const emoji = client.emojis.cache.get(emojiId);

  if (!emoji) {
    return {
      success: false,
      errorMessage: `Custom emoji not found. The bot may not have access to it.`
    };
  }

  if (!emoji.available) {
    return {
      success: false,
      errorMessage: `Custom emoji is unavailable (server may have lost boost level).`
    };
  }

  return {
    success: true,
    identifier: emoji.id,
    displayEmoji: emoji.toString()
  };
}

/**
 * Resolve emoji by name (shortcode)
 * Tries: node-emoji -> discord-emoji-converter -> case-sensitive custom -> case-insensitive custom
 */
function resolveShortcode(
  name: string,
  client: Client,
  guild?: Guild | null
): EmojiParseResult {
  // Try node-emoji first (e.g., :cd: -> 💿)
  let standardEmoji = nodeEmoji.get(name);
  if (!standardEmoji || standardEmoji.startsWith(':')) {
    standardEmoji = nodeEmoji.get(name.toLowerCase());
  }
  if (standardEmoji && !standardEmoji.startsWith(':')) {
    return {
      success: true,
      identifier: standardEmoji,
      displayEmoji: standardEmoji
    };
  }

  // Try discord-emoji-converter (has Discord's shortcode names like :frame_photo:)
  try {
    const discordResult = discordEmoji.getEmoji(name);
    if (discordResult && typeof discordResult === 'string') {
      return {
        success: true,
        identifier: discordResult,
        displayEmoji: discordResult
      };
    }
  } catch {
    // getEmoji throws if not found, continue to custom emoji lookup
  }

  // Try custom emoji: case-sensitive first
  let foundEmoji = guild?.emojis.cache.find(e => e.name === name);
  if (!foundEmoji) {
    foundEmoji = client.emojis.cache.find(e => e.name === name && e.available);
  }

  // Fallback: case-insensitive
  if (!foundEmoji) {
    const nameLower = name.toLowerCase();
    foundEmoji = guild?.emojis.cache.find(e => e.name?.toLowerCase() === nameLower);
    if (!foundEmoji) {
      foundEmoji = client.emojis.cache.find(e => e.name?.toLowerCase() === nameLower && e.available);
    }
  }

  if (foundEmoji && foundEmoji.available) {
    return {
      success: true,
      identifier: foundEmoji.id,
      displayEmoji: foundEmoji.toString()
    };
  }

  return {
    success: false,
    errorMessage: `Emoji :${name}: not found. Check the spelling or use a different emoji.`
  };
}

/**
 * Resolve emoji shortcodes within text content
 *
 * For text with embedded emojis, only :name: format is recognized.
 * This avoids false positives with words.
 *
 * @param content - Text content that may contain :emoji: shortcodes
 * @param client - Discord client for emoji cache
 * @param guild - Optional guild for guild-specific lookup
 * @returns Text with shortcodes replaced by display emojis
 */
export function resolveEmojisInText(
  content: string,
  client: Client,
  guild?: Guild | null
): string {
  // Match :name: but NOT inside already-formatted custom emojis <:name:id>
  // Negative lookbehind for < (or <a) and negative lookahead for digits>
  const shortcodePattern = /(?<!<a?)(?<!<):([a-zA-Z0-9_-]+):(?!\d+>)/g;

  return content.replace(shortcodePattern, (match, name) => {
    // Try node-emoji first
    let standardEmoji = nodeEmoji.get(name);
    if (!standardEmoji || standardEmoji.startsWith(':')) {
      standardEmoji = nodeEmoji.get(name.toLowerCase());
    }
    if (standardEmoji && !standardEmoji.startsWith(':')) {
      return standardEmoji;
    }

    // Try discord-emoji-converter
    try {
      const discordResult = discordEmoji.getEmoji(name);
      if (discordResult && typeof discordResult === 'string') {
        return discordResult;
      }
    } catch {
      // Continue to custom emoji lookup
    }

    // Try custom emoji: case-sensitive
    let foundEmoji = guild?.emojis.cache.find(e => e.name === name);
    if (!foundEmoji) {
      foundEmoji = client.emojis.cache.find(e => e.name === name && e.available);
    }

    // Fallback: case-insensitive
    if (!foundEmoji) {
      const nameLower = name.toLowerCase();
      foundEmoji = guild?.emojis.cache.find(e => e.name?.toLowerCase() === nameLower);
      if (!foundEmoji) {
        foundEmoji = client.emojis.cache.find(e => e.name?.toLowerCase() === nameLower && e.available);
      }
    }

    if (foundEmoji && foundEmoji.available) {
      return foundEmoji.toString();
    }

    // Not found - keep original text
    return match;
  });
}

/**
 * Get display format from an emoji identifier
 * Used for retrieving display format from stored identifier
 *
 * @param identifier - Stored emoji identifier (ID for custom, unicode for standard)
 * @param client - Discord client for emoji cache
 * @returns Display format string
 */
export function getEmojiDisplay(identifier: string, client: Client): string {
  // If it's a numeric ID, look up custom emoji
  if (/^\d+$/.test(identifier)) {
    const emoji = client.emojis.cache.get(identifier);
    return emoji ? emoji.toString() : `:unknown_emoji:`;
  }

  // Otherwise it's a unicode emoji or text - return as-is
  return identifier;
}

/**
 * Validate that a stored emoji identifier is still available
 *
 * @param identifier - Stored emoji identifier
 * @param client - Discord client for emoji cache
 * @returns true if emoji is available
 */
export function isEmojiAvailable(identifier: string, client: Client): boolean {
  // Custom emoji ID
  if (/^\d+$/.test(identifier)) {
    const emoji = client.emojis.cache.get(identifier);
    return emoji?.available ?? false;
  }

  // Unicode emoji - always available
  return true;
}

/**
 * Check if a string is a valid Discord emoji format for use in components
 * (buttons, reactions, etc.)
 *
 * @param emoji - The emoji string to validate
 * @returns true if it's a valid Discord emoji format
 */
export function isValidEmojiFormat(emoji: string | undefined | null): boolean {
  if (!emoji) return false;

  // Custom emoji format: <:name:id> or <a:name:id>
  if (/^<a?:[a-zA-Z0-9_]+:\d+>$/.test(emoji)) {
    return true;
  }

  // Unicode emoji: short string that's NOT just alphanumeric/punctuation
  // Real emojis contain special unicode characters
  if (emoji.length <= 8 && !/^[a-zA-Z0-9_:<>]+$/.test(emoji)) {
    return true;
  }

  return false;
}

// Regex patterns for emoji detection
const CUSTOM_EMOJI_PATTERN = /<a?:[a-zA-Z0-9_]+:\d+>/g;
const UNICODE_EMOJI_PATTERN = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu;

/**
 * Calculate visual length of text, accounting for emojis.
 * Custom Discord emojis (<:name:id>) and unicode emojis count as 2 characters.
 *
 * @param text - Text to measure
 * @param emojiWidth - Visual width of emojis (default: 2)
 * @returns Visual character count
 */
export function getVisualLength(text: string, emojiWidth: number = 2): number {
  if (!text) return 0;

  let visualLength = 0;
  let remaining = text;

  // Process text character by character, handling emojis specially
  while (remaining.length > 0) {
    // Check for custom Discord emoji at current position
    const customMatch = remaining.match(/^<a?:[a-zA-Z0-9_]+:\d+>/);
    if (customMatch) {
      visualLength += emojiWidth;
      remaining = remaining.slice(customMatch[0].length);
      continue;
    }

    // Check for unicode emoji at current position
    const unicodeMatch = remaining.match(/^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
    if (unicodeMatch) {
      visualLength += emojiWidth;
      remaining = remaining.slice(unicodeMatch[0].length);
      continue;
    }

    // Regular character
    visualLength += 1;
    remaining = remaining.slice(1);
  }

  return visualLength;
}

/**
 * Truncate text to a maximum visual length, respecting emoji boundaries.
 * Never breaks emoji strings in half.
 *
 * @param text - Text to truncate
 * @param maxVisualLength - Maximum visual length
 * @param suffix - Suffix to add when truncated (default: '...')
 * @param emojiWidth - Visual width of emojis (default: 2)
 * @returns Truncated text with suffix if needed
 */
export function truncateWithEmojis(
  text: string,
  maxVisualLength: number,
  suffix: string = '...',
  emojiWidth: number = 2
): string {
  if (!text) return '';

  const suffixLength = suffix.length;
  let visualLength = 0;
  let result = '';
  let remaining = text;

  while (remaining.length > 0) {
    // Check for custom Discord emoji at current position
    const customMatch = remaining.match(/^<a?:[a-zA-Z0-9_]+:\d+>/);
    if (customMatch) {
      const newLength = visualLength + emojiWidth;
      // Check if adding this emoji would exceed limit (accounting for suffix)
      if (newLength > maxVisualLength - suffixLength && result.length > 0) {
        return result + suffix;
      }
      if (newLength > maxVisualLength) {
        return result + suffix;
      }
      visualLength = newLength;
      result += customMatch[0];
      remaining = remaining.slice(customMatch[0].length);
      continue;
    }

    // Check for unicode emoji at current position
    const unicodeMatch = remaining.match(/^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
    if (unicodeMatch) {
      const newLength = visualLength + emojiWidth;
      if (newLength > maxVisualLength - suffixLength && result.length > 0) {
        return result + suffix;
      }
      if (newLength > maxVisualLength) {
        return result + suffix;
      }
      visualLength = newLength;
      result += unicodeMatch[0];
      remaining = remaining.slice(unicodeMatch[0].length);
      continue;
    }

    // Regular character
    const newLength = visualLength + 1;
    if (newLength > maxVisualLength - suffixLength && remaining.length > 1) {
      return result + suffix;
    }
    if (newLength > maxVisualLength) {
      return result + suffix;
    }
    visualLength = newLength;
    result += remaining[0];
    remaining = remaining.slice(1);
  }

  // No truncation needed
  return result;
}

/**
 * Convert custom Discord emoji format to shortcode format for plain text contexts.
 * Use this for dropdowns and other places that can't render custom emojis.
 *
 * - `<:name:123456>` → `:name:`
 * - `<a:name:123456>` → `:name:`
 * - Unicode emojis are kept as-is (they render in dropdowns)
 *
 * @param text - Text containing Discord emoji format
 * @returns Text with custom emojis converted to shortcodes
 */
export function simplifyEmojisForPlainText(text: string): string {
  if (!text) return '';

  // Convert <:name:id> and <a:name:id> to :name:
  return text.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, ':$1:');
}

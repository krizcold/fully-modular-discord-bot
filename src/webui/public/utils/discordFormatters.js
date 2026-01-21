/**
 * Discord Formatters - Utilities for rendering Discord-specific content in Web-UI
 *
 * Handles:
 * - Custom Discord emojis (<:name:id> and <a:name:id>)
 * - Discord timestamps (<t:timestamp:format>)
 * - Discord mentions (<@userId>, <@&roleId>, <#channelId>)
 */

/**
 * Render a Discord emoji (unicode or custom)
 * @param {object|string} emoji - Emoji object {name, id, animated} or unicode string
 * @param {string} key - React key for the element
 * @returns React element for the emoji
 */
function renderDiscordEmoji(emoji, key) {
  if (!emoji) return null;

  // Handle string (legacy format or unicode)
  if (typeof emoji === 'string') {
    // Check if it's a custom Discord emoji format: <:name:id> or <a:name:id>
    const customMatch = emoji.match(/^<(a)?:(\w+):(\d+)>$/);
    if (customMatch) {
      const animated = !!customMatch[1];
      const id = customMatch[3];
      const ext = animated ? 'gif' : 'png';
      return React.createElement('img', {
        key: key,
        src: `https://cdn.discordapp.com/emojis/${id}.${ext}`,
        alt: customMatch[2],
        className: 'discord-emoji'
      });
    }
    // Otherwise it's a unicode emoji or plain text
    return React.createElement('span', { key: key }, emoji);
  }

  // Handle emoji object {name, id, animated}
  if (emoji.id) {
    // Custom Discord emoji - render as CDN image
    const ext = emoji.animated ? 'gif' : 'png';
    return React.createElement('img', {
      key: key,
      src: `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`,
      alt: emoji.name || 'emoji',
      className: 'discord-emoji'
    });
  }

  // Unicode emoji (name contains the unicode char)
  if (emoji.name) {
    return React.createElement('span', { key: key }, emoji.name);
  }

  return null;
}

/**
 * Parse text and replace Discord emoji formats with rendered emojis
 * Handles: <:name:id> (static) and <a:name:id> (animated)
 * @param {string} text - Text containing Discord emoji formats
 * @returns Array of React elements/strings with emojis rendered
 */
function parseDiscordEmojis(text) {
  if (!text || typeof text !== 'string') return text;

  // Match Discord custom emoji format: <:name:id> or <a:name:id>
  const emojiRegex = /<(a)?:(\w+):(\d+)>/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let keyCounter = 0;

  while ((match = emojiRegex.exec(text)) !== null) {
    // Add text before the emoji
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    // Add the emoji as an image
    const animated = !!match[1];
    const name = match[2];
    const id = match[3];
    const ext = animated ? 'gif' : 'png';

    parts.push(
      React.createElement('img', {
        key: `emoji-${keyCounter++}`,
        src: `https://cdn.discordapp.com/emojis/${id}.${ext}`,
        alt: `:${name}:`,
        title: `:${name}:`,
        className: 'discord-emoji'
      })
    );

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  // If no emojis found, return original text
  if (parts.length === 0) {
    return text;
  }

  return parts;
}

/**
 * Format a Discord timestamp
 * @param {number} timestamp - Unix timestamp in seconds
 * @param {string} format - Discord timestamp format character
 * @returns Formatted date/time string
 */
function formatDiscordTimestamp(timestamp, format) {
  const date = new Date(timestamp * 1000);

  switch (format) {
    case 't': // Short time (e.g., 9:30 PM)
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    case 'T': // Long time (e.g., 9:30:00 PM)
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

    case 'd': // Short date (e.g., 11/28/2024)
      return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' });

    case 'D': // Long date (e.g., November 28, 2024)
      return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

    case 'f': // Short date/time (e.g., November 28, 2024 9:30 PM)
      return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) +
        ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    case 'F': // Long date/time (e.g., Thursday, November 28, 2024 9:30 PM)
      return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) +
        ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    case 'R': // Relative time (e.g., 2 hours ago, in 3 days)
      return getRelativeTimeString(date);

    default: // Default to short date/time
      return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) +
        ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
}

/**
 * Get relative time string (e.g., "2 hours ago", "in 3 days")
 * @param {Date} date - Date to compare to now
 * @returns Relative time string
 */
function getRelativeTimeString(date) {
  const now = new Date();
  const diffMs = date - now;
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);
  const diffMonth = Math.round(diffDay / 30);
  const diffYear = Math.round(diffDay / 365);

  // Use Intl.RelativeTimeFormat if available
  if (typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

    if (Math.abs(diffSec) < 60) {
      return rtf.format(diffSec, 'second');
    } else if (Math.abs(diffMin) < 60) {
      return rtf.format(diffMin, 'minute');
    } else if (Math.abs(diffHour) < 24) {
      return rtf.format(diffHour, 'hour');
    } else if (Math.abs(diffDay) < 30) {
      return rtf.format(diffDay, 'day');
    } else if (Math.abs(diffMonth) < 12) {
      return rtf.format(diffMonth, 'month');
    } else {
      return rtf.format(diffYear, 'year');
    }
  }

  // Fallback for browsers without Intl.RelativeTimeFormat
  const abs = Math.abs;
  const past = diffMs < 0;
  const prefix = past ? '' : 'in ';
  const suffix = past ? ' ago' : '';

  if (abs(diffSec) < 60) {
    return `${prefix}${abs(diffSec)} second${abs(diffSec) !== 1 ? 's' : ''}${suffix}`;
  } else if (abs(diffMin) < 60) {
    return `${prefix}${abs(diffMin)} minute${abs(diffMin) !== 1 ? 's' : ''}${suffix}`;
  } else if (abs(diffHour) < 24) {
    return `${prefix}${abs(diffHour)} hour${abs(diffHour) !== 1 ? 's' : ''}${suffix}`;
  } else if (abs(diffDay) < 30) {
    return `${prefix}${abs(diffDay)} day${abs(diffDay) !== 1 ? 's' : ''}${suffix}`;
  } else if (abs(diffMonth) < 12) {
    return `${prefix}${abs(diffMonth)} month${abs(diffMonth) !== 1 ? 's' : ''}${suffix}`;
  } else {
    return `${prefix}${abs(diffYear)} year${abs(diffYear) !== 1 ? 's' : ''}${suffix}`;
  }
}

/**
 * Parse text and replace Discord timestamp formats with formatted dates
 * Handles: <t:timestamp> and <t:timestamp:format>
 * @param {string} text - Text containing Discord timestamp formats
 * @returns Array of React elements/strings with timestamps rendered
 */
function parseDiscordTimestamps(text) {
  if (!text || typeof text !== 'string') return text;

  // Match Discord timestamp format: <t:timestamp> or <t:timestamp:format>
  const timestampRegex = /<t:(\d+)(?::([tTdDfFR]))?>/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let keyCounter = 0;

  while ((match = timestampRegex.exec(text)) !== null) {
    // Add text before the timestamp
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    // Parse and format the timestamp
    const timestamp = parseInt(match[1], 10);
    const format = match[2] || 'f'; // Default to short date/time
    const formatted = formatDiscordTimestamp(timestamp, format);

    // Render as a styled span with tooltip showing full date
    const fullDate = new Date(timestamp * 1000).toLocaleString();
    parts.push(
      React.createElement('span', {
        key: `ts-${keyCounter++}`,
        className: 'discord-timestamp',
        title: fullDate
      }, formatted)
    );

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  // If no timestamps found, return original text
  if (parts.length === 0) {
    return text;
  }

  return parts;
}

/**
 * Parse text and replace Discord mention formats with styled mentions
 * Handles: <@userId>, <@!userId>, <@&roleId>, <#channelId>
 * @param {string} text - Text containing Discord mention formats
 * @returns Array of React elements/strings with mentions rendered
 */
function parseDiscordMentions(text) {
  if (!text || typeof text !== 'string') return text;

  // Match Discord mention formats:
  // <@userId> or <@!userId> - user mention
  // <@&roleId> - role mention
  // <#channelId> - channel mention
  const mentionRegex = /<(@!?|@&|#)(\d+)>/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let keyCounter = 0;

  while ((match = mentionRegex.exec(text)) !== null) {
    // Add text before the mention
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    const type = match[1];
    const id = match[2];

    // Determine mention type and styling
    let prefix, className;
    if (type === '@' || type === '@!') {
      prefix = '@';
      className = 'discord-mention discord-mention-user';
    } else if (type === '@&') {
      prefix = '@';
      className = 'discord-mention discord-mention-role';
    } else if (type === '#') {
      prefix = '#';
      className = 'discord-mention discord-mention-channel';
    }

    // Show shortened ID (first 4 and last 4 digits)
    const shortId = id.length > 10 ? `${id.slice(0, 4)}...${id.slice(-4)}` : id;

    parts.push(
      React.createElement('span', {
        key: `mention-${keyCounter++}`,
        className: className,
        title: `ID: ${id}`
      }, `${prefix}${shortId}`)
    );

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  // If no mentions found, return original text
  if (parts.length === 0) {
    return text;
  }

  return parts;
}

/**
 * Parse all Discord formatting in text (mentions, timestamps, emojis)
 * @param {string} text - Text to parse
 * @returns Array of React elements/strings
 */
function parseDiscordFormatting(text) {
  if (!text || typeof text !== 'string') return text;

  // First pass: parse mentions
  let parts = parseDiscordMentions(text);

  // If no mentions were found, parts is still a string
  if (typeof parts === 'string') {
    parts = [parts];
  }

  // Second pass: parse timestamps in string parts
  let result = [];
  parts.forEach((part) => {
    if (typeof part === 'string') {
      const tsParts = parseDiscordTimestamps(part);
      if (Array.isArray(tsParts)) {
        result.push(...tsParts);
      } else {
        result.push(tsParts);
      }
    } else {
      result.push(part);
    }
  });

  // Third pass: parse emojis in string parts
  const finalResult = [];
  result.forEach((part) => {
    if (typeof part === 'string') {
      const emojiParts = parseDiscordEmojis(part);
      if (Array.isArray(emojiParts)) {
        finalResult.push(...emojiParts);
      } else {
        finalResult.push(emojiParts);
      }
    } else {
      finalResult.push(part);
    }
  });

  return finalResult.length === 1 && typeof finalResult[0] === 'string' ? finalResult[0] : finalResult;
}

// CSS styles for Discord formatting (injected once)
(function injectDiscordFormatterStyles() {
  if (document.getElementById('discord-formatter-styles')) return;

  const style = document.createElement('style');
  style.id = 'discord-formatter-styles';
  style.textContent = `
    .discord-emoji {
      width: 1.375em;
      height: 1.375em;
      vertical-align: -0.3em;
      object-fit: contain;
    }

    .discord-timestamp {
      background: rgba(88, 101, 242, 0.15);
      border-radius: 3px;
      padding: 0 2px;
      color: #5865F2;
      cursor: help;
    }

    .discord-inline-code {
      background: rgba(88, 101, 242, 0.2);
      padding: 2px 5px;
      border-radius: 3px;
      color: #5865F2 !important;
      font-size: 0.9em;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    }

    .discord-mention {
      background: rgba(88, 101, 242, 0.3);
      border-radius: 3px;
      padding: 0 4px;
      font-weight: 500;
      cursor: default;
    }

    .discord-mention-user {
      color: #5865F2;
    }

    .discord-mention-role {
      color: #EB459E;
    }

    .discord-mention-channel {
      color: #5865F2;
    }
  `;
  document.head.appendChild(style);
})();

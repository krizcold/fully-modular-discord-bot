// Panel Components - Embed and ActionRow renderers for Discord-style panel content

// Simple markdown parser for Discord-style formatting
// resolvedUsers is an optional map of userId -> { username, displayName, avatarURL }
function parseMarkdown(text, resolvedUsers) {
  if (!text) return text;

  // Convert string to ensure we're working with text
  text = String(text);

  // First, handle code blocks (```code```) - must be done before inline parsing
  const codeBlockRegex = /```(?:(\w+)\n)?([\s\S]*?)```/g;
  let segments = [];
  let lastIndex = 0;
  let codeBlockMatch;

  while ((codeBlockMatch = codeBlockRegex.exec(text)) !== null) {
    // Add text before the code block
    if (codeBlockMatch.index > lastIndex) {
      segments.push({ type: 'text', content: text.substring(lastIndex, codeBlockMatch.index) });
    }
    // Add the code block
    segments.push({
      type: 'codeblock',
      language: codeBlockMatch[1] || '',
      content: codeBlockMatch[2]
    });
    lastIndex = codeBlockMatch.index + codeBlockMatch[0].length;
  }

  // Add remaining text after last code block
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.substring(lastIndex) });
  }

  // If no code blocks found, treat entire text as one segment
  if (segments.length === 0) {
    segments.push({ type: 'text', content: text });
  }

  // Second pass: split text segments by lines and identify headings and subtext
  const expandedSegments = [];
  segments.forEach(segment => {
    if (segment.type !== 'text') {
      expandedSegments.push(segment);
      return;
    }

    // Split by lines to detect headings and subtext
    const lines = segment.content.split('\n');
    lines.forEach((line, idx) => {
      // Check for headings (# , ## , ### ) at start of line - Discord style
      const h1Match = line.match(/^#\s+(.*)$/);
      const h2Match = line.match(/^##\s+(.*)$/);
      const h3Match = line.match(/^###\s+(.*)$/);
      // Check for subtext (-#) at start of line
      const subtextMatch = line.match(/^-#\s*(.*)$/);

      if (h3Match) {
        expandedSegments.push({ type: 'h3', content: h3Match[1] });
      } else if (h2Match) {
        expandedSegments.push({ type: 'h2', content: h2Match[1] });
      } else if (h1Match) {
        expandedSegments.push({ type: 'h1', content: h1Match[1] });
      } else if (subtextMatch) {
        expandedSegments.push({ type: 'subtext', content: subtextMatch[1] });
      } else {
        expandedSegments.push({ type: 'text', content: line });
      }
      // Add newline marker between lines (not after last)
      if (idx < lines.length - 1) {
        expandedSegments.push({ type: 'newline' });
      }
    });
  });

  segments = expandedSegments;

  // Process each segment
  let result = [];
  let keyCounter = 0;

  // Helper function to parse inline markdown with support for nested formatting
  function parseInlineMarkdown(textContent, depth = 0) {
    // Prevent infinite recursion
    if (depth > 3) return [textContent];

    // Normalize backtick-like characters to standard backtick
    textContent = textContent.replace(/[ʻˋ′'`]/g, '`');

    const parts = [];
    let currentIndex = 0;

    // Combined regex to match all markdown patterns (including spoilers ||text||)
    const markdownRegex = /(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(__(.+?)__)|(_(.+?)_)|(`(.+?)`)|(\|\|(.+?)\|\|)/g;

    let match;
    while ((match = markdownRegex.exec(textContent)) !== null) {
      // Add text before the match
      if (match.index > currentIndex) {
        parts.push(textContent.substring(currentIndex, match.index));
      }

      // Determine which pattern was matched and create appropriate element
      // Recursively parse inner content for nested formatting (except for code which is literal)
      if (match[1]) {
        // Bold italic (***text***)
        const inner = parseInlineMarkdown(match[2], depth + 1);
        parts.push(<strong key={keyCounter++}><em>{inner}</em></strong>);
      } else if (match[3]) {
        // Bold (**text**)
        const inner = parseInlineMarkdown(match[4], depth + 1);
        parts.push(<strong key={keyCounter++}>{inner}</strong>);
      } else if (match[5]) {
        // Italic (*text*)
        const inner = parseInlineMarkdown(match[6], depth + 1);
        parts.push(<em key={keyCounter++}>{inner}</em>);
      } else if (match[7]) {
        // Bold alternative (__text__)
        const inner = parseInlineMarkdown(match[8], depth + 1);
        parts.push(<strong key={keyCounter++}>{inner}</strong>);
      } else if (match[9]) {
        // Italic alternative (_text_)
        const inner = parseInlineMarkdown(match[10], depth + 1);
        parts.push(<em key={keyCounter++}>{inner}</em>);
      } else if (match[11]) {
        // Inline code (`text`) - NO recursion, code content is literal
        parts.push(
          <code key={keyCounter++} style={{
            background: '#1a1a1a',
            padding: '2px 4px',
            borderRadius: '3px',
            color: '#5865F2',
            fontSize: '0.9em'
          }}>
            {match[12]}
          </code>
        );
      } else if (match[13]) {
        // Spoiler (||text||) - click to reveal
        const inner = parseInlineMarkdown(match[14], depth + 1);
        parts.push(
          <SpoilerText key={keyCounter++}>{inner}</SpoilerText>
        );
      }

      currentIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (currentIndex < textContent.length) {
      parts.push(textContent.substring(currentIndex));
    }

    // If no markdown was found, return original text
    if (parts.length === 0) {
      parts.push(textContent);
    }

    return parts;
  }

  segments.forEach((segment, segIndex) => {
    if (segment.type === 'codeblock') {
      // Render code block
      result.push(
        <pre key={`cb-${segIndex}`} style={{
          background: '#1a1a1a',
          padding: '12px',
          borderRadius: '6px',
          margin: '8px 0',
          overflow: 'auto',
          fontSize: '0.85em',
          lineHeight: '1.4'
        }}>
          <code style={{ color: '#e0e0e0' }}>{segment.content}</code>
        </pre>
      );
    } else if (segment.type === 'newline') {
      // Render line break
      result.push(<br key={`br-${segIndex}`} />);
    } else if (segment.type === 'h1') {
      // Render heading 1 (# ) - Large bold text like Discord
      const innerParts = parseInlineMarkdown(segment.content);
      result.push(
        <span key={`h1-${segIndex}`} style={{
          fontSize: '1.5em',
          fontWeight: 'bold',
          display: 'block',
          marginTop: '8px',
          marginBottom: '4px',
          color: '#fff'
        }}>
          {innerParts}
        </span>
      );
    } else if (segment.type === 'h2') {
      // Render heading 2 (## ) - Medium bold text
      const innerParts = parseInlineMarkdown(segment.content);
      result.push(
        <span key={`h2-${segIndex}`} style={{
          fontSize: '1.25em',
          fontWeight: 'bold',
          display: 'block',
          marginTop: '6px',
          marginBottom: '3px',
          color: '#fff'
        }}>
          {innerParts}
        </span>
      );
    } else if (segment.type === 'h3') {
      // Render heading 3 (### ) - Small bold text
      const innerParts = parseInlineMarkdown(segment.content);
      result.push(
        <span key={`h3-${segIndex}`} style={{
          fontSize: '1.1em',
          fontWeight: 'bold',
          display: 'block',
          marginTop: '4px',
          marginBottom: '2px',
          color: '#fff'
        }}>
          {innerParts}
        </span>
      );
    } else if (segment.type === 'subtext') {
      // Render subtext (-# format) with parsed markdown inside
      const innerParts = parseInlineMarkdown(segment.content);
      result.push(
        <span key={`st-${segIndex}`} style={{ fontSize: '0.8em', color: '#999', display: 'block' }}>
          {innerParts}
        </span>
      );
    } else {
      // Parse inline markdown for text segments
      const parts = parseInlineMarkdown(segment.content);
      result.push(...parts);
    }
  });

  // If result is empty, return original text
  if (result.length === 0) {
    return text;
  }

  // Parse Discord custom emojis in string parts: <:name:id> or <a:name:id>
  const partsWithEmojis = [];
  result.forEach((part, i) => {
    if (typeof part === 'string') {
      const emojiRegex = /<(a)?:(\w+):(\d+)>/g;
      let lastIdx = 0;
      let emojiMatch;
      let hasEmoji = false;

      while ((emojiMatch = emojiRegex.exec(part)) !== null) {
        hasEmoji = true;
        if (emojiMatch.index > lastIdx) {
          partsWithEmojis.push(part.substring(lastIdx, emojiMatch.index));
        }
        const animated = !!emojiMatch[1];
        const name = emojiMatch[2];
        const id = emojiMatch[3];
        const ext = animated ? 'gif' : 'png';
        partsWithEmojis.push(
          <img
            key={`emoji-${i}-${emojiMatch.index}`}
            src={`https://cdn.discordapp.com/emojis/${id}.${ext}`}
            alt={`:${name}:`}
            title={`:${name}:`}
            style={{ width: '1.375em', height: '1.375em', verticalAlign: '-0.3em', objectFit: 'contain' }}
          />
        );
        lastIdx = emojiMatch.index + emojiMatch[0].length;
      }
      if (hasEmoji && lastIdx < part.length) {
        partsWithEmojis.push(part.substring(lastIdx));
      }
      if (!hasEmoji) {
        partsWithEmojis.push(part);
      }
    } else {
      partsWithEmojis.push(part);
    }
  });

  // Parse Discord timestamps in string parts: <t:timestamp> or <t:timestamp:format>
  const partsWithTimestamps = [];
  partsWithEmojis.forEach((part, i) => {
    if (typeof part === 'string') {
      const tsRegex = /<t:(\d+)(?::([tTdDfFR]))?>/g;
      let lastIdx = 0;
      let tsMatch;
      let hasTs = false;

      while ((tsMatch = tsRegex.exec(part)) !== null) {
        hasTs = true;
        if (tsMatch.index > lastIdx) {
          partsWithTimestamps.push(part.substring(lastIdx, tsMatch.index));
        }
        const timestamp = parseInt(tsMatch[1], 10);
        const format = tsMatch[2] || 'f';
        const date = new Date(timestamp * 1000);
        let formatted;

        switch (format) {
          case 't': formatted = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); break;
          case 'T': formatted = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }); break;
          case 'd': formatted = date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' }); break;
          case 'D': formatted = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); break;
          case 'F': formatted = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); break;
          case 'R':
            const diff = Math.round((date - new Date()) / 1000);
            const absDiff = Math.abs(diff);
            if (absDiff < 60) formatted = diff < 0 ? `${absDiff} seconds ago` : `in ${absDiff} seconds`;
            else if (absDiff < 3600) formatted = diff < 0 ? `${Math.round(absDiff/60)} minutes ago` : `in ${Math.round(absDiff/60)} minutes`;
            else if (absDiff < 86400) formatted = diff < 0 ? `${Math.round(absDiff/3600)} hours ago` : `in ${Math.round(absDiff/3600)} hours`;
            else formatted = diff < 0 ? `${Math.round(absDiff/86400)} days ago` : `in ${Math.round(absDiff/86400)} days`;
            break;
          default: formatted = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) + ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        }

        partsWithTimestamps.push(
          <span
            key={`ts-${i}-${tsMatch.index}`}
            title={date.toLocaleString()}
            style={{ background: 'rgba(88, 101, 242, 0.15)', borderRadius: '3px', padding: '0 2px', color: '#5865F2' }}
          >
            {formatted}
          </span>
        );
        lastIdx = tsMatch.index + tsMatch[0].length;
      }
      if (hasTs && lastIdx < part.length) {
        partsWithTimestamps.push(part.substring(lastIdx));
      }
      if (!hasTs) {
        partsWithTimestamps.push(part);
      }
    } else {
      partsWithTimestamps.push(part);
    }
  });

  // Parse Discord mentions in string parts: <@userId>, <@!userId>, <@&roleId>, <#channelId>
  const partsWithMentions = [];
  partsWithTimestamps.forEach((part, i) => {
    if (typeof part === 'string') {
      const mentionRegex = /<(@!?|@&|#)(\d+)>/g;
      let lastIdx = 0;
      let mentionMatch;
      let hasMention = false;

      while ((mentionMatch = mentionRegex.exec(part)) !== null) {
        hasMention = true;
        if (mentionMatch.index > lastIdx) {
          partsWithMentions.push(part.substring(lastIdx, mentionMatch.index));
        }
        const type = mentionMatch[1];
        const id = mentionMatch[2];

        // Determine mention type and styling
        let prefix, bgColor, textColor;
        if (type === '@' || type === '@!') {
          prefix = '@';
          bgColor = 'rgba(88, 101, 242, 0.3)';
          textColor = '#5865F2';
        } else if (type === '@&') {
          prefix = '@';
          bgColor = 'rgba(235, 69, 158, 0.3)';
          textColor = '#EB459E';
        } else if (type === '#') {
          prefix = '#';
          bgColor = 'rgba(88, 101, 242, 0.3)';
          textColor = '#5865F2';
        }

        // Look up resolved username if available, otherwise use shortened ID
        let displayName;
        if (resolvedUsers && resolvedUsers[id]) {
          displayName = resolvedUsers[id].displayName || resolvedUsers[id].username;
        } else {
          // Fallback to shortened ID
          displayName = id.length > 10 ? `${id.slice(0, 4)}...${id.slice(-4)}` : id;
        }

        partsWithMentions.push(
          <span
            key={`mention-${i}-${mentionMatch.index}`}
            title={`ID: ${id}`}
            style={{ background: bgColor, borderRadius: '3px', padding: '0 4px', color: textColor, fontWeight: 500 }}
          >
            {prefix}{displayName}
          </span>
        );
        lastIdx = mentionMatch.index + mentionMatch[0].length;
      }
      if (hasMention && lastIdx < part.length) {
        partsWithMentions.push(part.substring(lastIdx));
      }
      if (!hasMention) {
        partsWithMentions.push(part);
      }
    } else {
      partsWithMentions.push(part);
    }
  });

  return <span>{partsWithMentions}</span>;
}

// Spoiler Text Component - Click to reveal hidden content
function SpoilerText({ children }) {
  const { useState } = React;
  const [revealed, setRevealed] = useState(false);

  return (
    <span
      onClick={() => setRevealed(!revealed)}
      style={{
        backgroundColor: revealed ? 'rgba(255, 255, 255, 0.1)' : '#1a1a1a',
        color: revealed ? 'inherit' : 'transparent',
        borderRadius: '3px',
        padding: '0 4px',
        cursor: 'pointer',
        transition: 'all 0.1s ease',
        userSelect: revealed ? 'auto' : 'none'
      }}
      title={revealed ? 'Click to hide' : 'Click to reveal spoiler'}
    >
      {children}
    </span>
  );
}

// Embed Component - Renders Discord embed
function PanelEmbed({ embed, resolvedUsers }) {
  return (
    <div style={{
      background: '#2a2a2a',
      border: `4px solid ${embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : '#5865F2'}`,
      borderRadius: '4px',
      padding: '16px',
      marginBottom: '15px'
    }}>
      {embed.title && (
        <h3 style={{color: '#e0e0e0', marginBottom: '10px', fontSize: '1.1rem'}}>
          {embed.title}
        </h3>
      )}

      {embed.description && (
        <p style={{color: '#ccc', marginBottom: '10px', fontSize: '0.95rem', lineHeight: '1.5'}}>
          {parseMarkdown(embed.description, resolvedUsers)}
        </p>
      )}

      {embed.fields && embed.fields.map((field, i) => (
        <div key={i} style={{
          marginBottom: '10px',
          display: field.inline ? 'inline-block' : 'block',
          width: field.inline ? '48%' : '100%',
          marginRight: field.inline ? '2%' : '0'
        }}>
          <div style={{color: '#5865F2', fontWeight: '600', fontSize: '0.9rem', marginBottom: '4px'}}>
            {parseMarkdown(field.name, resolvedUsers)}
          </div>
          <div style={{color: '#ccc', fontSize: '0.85rem', lineHeight: '1.4'}}>
            {parseMarkdown(field.value, resolvedUsers)}
          </div>
        </div>
      ))}

      {embed.footer && (
        <div style={{color: '#999', fontSize: '0.75rem', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #333'}}>
          {embed.footer.text}
        </div>
      )}
    </div>
  );
}

// Action Row Component - Renders buttons and dropdowns
function PanelActionRow({ row, onButton, onDropdown, disabled }) {
  const { useState, useMemo } = React;

  // Get initial dropdown values from component defaults
  // Using useMemo to compute this once per row change
  const initialDropdownValues = useMemo(() => {
    const values = {};
    row.components?.forEach((comp, idx) => {
      if (comp.type === 'select' && comp.options) {
        const defaultOpt = comp.options.find(o => o.default);
        values[idx] = defaultOpt?.value || '';
      }
    });
    return values;
  }, [row]);

  const [dropdownValues, setDropdownValues] = useState(initialDropdownValues);

  // Parse button customId: panel_{panelId}_btn_{buttonId}
  // Matches bot-side parsing logic in panelManager.ts
  function parseButtonId(customId) {
    if (!customId) return '';
    const parts = customId.split('_');
    const btnIndex = parts.indexOf('btn');
    if (btnIndex === -1 || btnIndex === parts.length - 1) {
      return customId; // Fallback to full customId if format is invalid
    }
    // Everything after 'btn' is the button ID
    return parts.slice(btnIndex + 1).join('_');
  }

  return (
    <div style={{marginBottom: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
      {row.components.map((comp, i) => {
        if (comp.type === 'button') {
          const style = comp.style;
          let className = 'btn';
          if (style === 1) className += ' btn-primary';
          else if (style === 2) className += ' btn-secondary';
          else if (style === 3) className += ' btn-success';
          else if (style === 4) className += ' btn-danger';

          return (
            <button
              key={i}
              onClick={() => !disabled && comp.customId && onButton(parseButtonId(comp.customId))}
              className={className}
              disabled={disabled || comp.disabled}
              style={{marginRight: 0, marginBottom: 0}}
            >
              {comp.emoji && (
                typeof comp.emoji === 'object' && comp.emoji.id
                  ? <img
                      src={`https://cdn.discordapp.com/emojis/${comp.emoji.id}.${comp.emoji.animated ? 'gif' : 'png'}`}
                      alt={comp.emoji.name || 'emoji'}
                      style={{ width: '1.2em', height: '1.2em', verticalAlign: '-0.2em', marginRight: '4px', objectFit: 'contain' }}
                    />
                  : <span style={{ marginRight: '4px' }}>{typeof comp.emoji === 'string' ? comp.emoji : comp.emoji.name}</span>
              )}
              {comp.label}
            </button>
          );
        } else if (comp.type === 'select') {
          // Get the current value from options (server-provided default) or local state
          const defaultOption = comp.options?.find(o => o.default);
          const currentValue = defaultOption?.value || dropdownValues[i] || '';

          return (
            <select
              key={i}
              value={currentValue}
              onChange={e => {
                const newValue = e.target.value;
                // Update local state to show the new selection immediately
                setDropdownValues(prev => ({ ...prev, [i]: newValue }));
                if (newValue) {
                  // Pass both values and customId for proper routing
                  onDropdown([newValue], comp.customId);
                }
              }}
              disabled={disabled || comp.disabled}
              style={{
                padding: '10px',
                background: '#1a1a1a',
                border: '1px solid #444',
                borderRadius: '5px',
                color: '#e0e0e0',
                fontSize: '0.95rem',
                cursor: 'pointer',
                flex: '1',
                minWidth: '200px'
              }}
            >
              <option value="">{comp.placeholder || 'Select an option...'}</option>
              {comp.options.map((opt, j) => {
                // For <option> elements, we can only use text (no images)
                // Handle emoji objects by extracting text representation
                let emojiText = '';
                if (opt.emoji) {
                  if (typeof opt.emoji === 'string') {
                    emojiText = opt.emoji + ' ';
                  } else if (opt.emoji.id) {
                    // Custom Discord emoji - show :name: since we can't render images
                    emojiText = `:${opt.emoji.name}: `;
                  } else if (opt.emoji.name) {
                    // Unicode emoji
                    emojiText = opt.emoji.name + ' ';
                  }
                }
                return (
                  <option key={j} value={opt.value}>
                    {emojiText}{opt.label}
                  </option>
                );
              })}
            </select>
          );
        }
        return null;
      })}
    </div>
  );
}

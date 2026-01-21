// Status Indicator Component
function StatusIndicator({ isSet, optional }) {
  if (isSet) {
    return <span style={{ color: '#43B581', marginRight: '6px' }}>✓</span>;
  }
  if (optional) {
    return <span style={{ color: '#999', marginRight: '6px' }}>○</span>;
  }
  return <span style={{ color: '#FAA61A', marginRight: '6px' }}>⚠</span>;
}

// Bot Credentials Section Component
function BotCredentialsSection({ credentials, onChange, instructions, setupStatus }) {
  const credStatus = setupStatus?.credentials || {};

  return (
    <div className="credentials-section">
      <div className="credentials-form">
        <h3 style={{marginBottom: '20px', color: '#5865F2'}}>Bot Credentials</h3>

        <div className="form-group">
          <label>
            <StatusIndicator isSet={credStatus.DISCORD_TOKEN?.set} />
            Discord Bot Token
          </label>
          <input
            type="password"
            value={credentials.DISCORD_TOKEN || ''}
            onChange={e => onChange('DISCORD_TOKEN', e.target.value)}
            placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXX..."
            required
          />
        </div>

        {/* Side by side Guild IDs */}
        <div className="form-row">
          <div className="form-group" style={{flex: 1}}>
            <label>
              <StatusIndicator isSet={credStatus.GUILD_ID?.set} />
              Guild ID (Test Server)
            </label>
            <input
              type="text"
              value={credentials.GUILD_ID || ''}
              onChange={e => onChange('GUILD_ID', e.target.value)}
              placeholder="123456789012345678"
              required
            />
            <small>Your test/development server</small>
          </div>

          <div className="form-group" style={{flex: 1}}>
            <label>
              <StatusIndicator isSet={credStatus.MAIN_GUILD_ID?.set} optional />
              Main Guild ID (Optional)
            </label>
            <input
              type="text"
              value={credentials.MAIN_GUILD_ID || ''}
              onChange={e => onChange('MAIN_GUILD_ID', e.target.value)}
              placeholder="Leave empty to use Guild ID"
            />
            <small>Production server (defaults to Guild ID)</small>
          </div>
        </div>

        <div className="form-group">
          <label>
            <StatusIndicator isSet={credStatus.CLIENT_ID?.set} />
            Application (Client) ID
          </label>
          <input
            type="text"
            value={credentials.CLIENT_ID || ''}
            onChange={e => onChange('CLIENT_ID', e.target.value)}
            placeholder="123456789012345678"
            required
          />
        </div>
      </div>

      <div className="credentials-instructions">
        <h3 style={{
          color: '#5865F2',
          marginBottom: '15px',
          paddingBottom: '10px',
          borderBottom: '1px solid #333'
        }}>
          Setup Guide: Bot Credentials
        </h3>
        {instructions && (
          <>
            {instructions.DISCORD_TOKEN && (
              <InstructionCard
                key="DISCORD_TOKEN"
                title={instructions.DISCORD_TOKEN.title}
                steps={instructions.DISCORD_TOKEN.steps}
                example={instructions.DISCORD_TOKEN.example}
              />
            )}
            {instructions.GUILD_ID && (
              <InstructionCard
                key="GUILD_ID"
                title={instructions.GUILD_ID.title}
                steps={instructions.GUILD_ID.steps}
                example={instructions.GUILD_ID.example}
              />
            )}
            {instructions.MAIN_GUILD_ID && (
              <InstructionCard
                key="MAIN_GUILD_ID"
                title={instructions.MAIN_GUILD_ID.title}
                steps={instructions.MAIN_GUILD_ID.steps}
                example={instructions.MAIN_GUILD_ID.example}
              />
            )}
            {instructions.CLIENT_ID && (
              <InstructionCard
                key="CLIENT_ID"
                title={instructions.CLIENT_ID.title}
                steps={instructions.CLIENT_ID.steps}
                example={instructions.CLIENT_ID.example}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Instruction Card Component
function InstructionCard({ title, steps, example }) {
  const [expanded, setExpanded] = React.useState(false);
  const [copiedUrl, setCopiedUrl] = React.useState(null);

  // Handle copying URL to clipboard
  function handleCopyUrl(url) {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  }

  // Convert URLs in text to clickable links or copy buttons
  function renderTextWithLinks(text) {
    // Check if this is a URL that should be copied (redirect URI, callback, etc.)
    const copyPatterns = [
      /Add this redirect URI: (https?:\/\/[^\s]+)/,
      /Your callback URL: (https?:\/\/[^\s]+)/,
      /callback URL[:\s]+(https?:\/\/[^\s]+)/i
    ];

    for (const pattern of copyPatterns) {
      const match = text.match(pattern);
      if (match) {
        const url = match[1];
        const prefix = text.substring(0, match.index + text.match(/[^:]+:/)[0].length);

        return (
          <span>
            {prefix}
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              marginLeft: '8px',
              padding: '4px 8px',
              background: '#1a1a1a',
              borderRadius: '4px',
              border: '1px solid #444',
              verticalAlign: 'middle'
            }}>
              <code style={{color: '#5865F2', marginRight: '8px', fontSize: '0.9em'}}>
                {url}
              </code>
              <button
                type="button"
                onClick={() => handleCopyUrl(url)}
                style={{
                  background: copiedUrl === url ? '#57F287' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  borderRadius: '3px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: copiedUrl === url ? '#000' : '#999',
                  fontSize: '0.85em',
                  transition: 'all 0.2s'
                }}
                title="Copy to clipboard"
              >
                {copiedUrl === url ? '✓ Copied' : '📋 Copy'}
              </button>
            </div>
          </span>
        );
      }
    }

    // Check if it's a navigable URL (like Discord Developer Portal)
    const navigableUrls = [
      'discord.com/developers/applications',
      'discord.dev',
      'discord.com/docs'
    ];

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);

    return parts.map((part, index) => {
      if (part.match(urlRegex)) {
        const isNavigable = navigableUrls.some(navUrl => part.includes(navUrl));

        if (isNavigable) {
          return (
            <a
              key={index}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              style={{color: '#5865F2', textDecoration: 'underline'}}
            >
              {part}
            </a>
          );
        } else {
          // Non-navigable URL - show as code with copy button
          return (
            <span key={index} style={{
              display: 'inline-flex',
              alignItems: 'center',
              margin: '0 4px',
              padding: '2px 6px',
              background: '#1a1a1a',
              borderRadius: '4px',
              border: '1px solid #444',
              verticalAlign: 'middle'
            }}>
              <code style={{color: '#5865F2', marginRight: '6px', fontSize: '0.9em'}}>
                {part}
              </code>
              <button
                type="button"
                onClick={() => handleCopyUrl(part)}
                style={{
                  background: copiedUrl === part ? '#57F287' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '1px 4px',
                  borderRadius: '2px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: copiedUrl === part ? '#000' : '#999',
                  fontSize: '0.8em'
                }}
                title="Copy to clipboard"
              >
                {copiedUrl === part ? '✓' : '📋'}
              </button>
            </span>
          );
        }
      }
      return part;
    });
  }

  return (
    <div className="instruction-card">
      <div
        className="instruction-header"
        onClick={() => setExpanded(!expanded)}
        style={{cursor: 'pointer'}}
      >
        <h4>{title}</h4>
        <span>{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <div className="instruction-content">
          <ol style={{ paddingLeft: '20px', margin: '10px 0' }}>
            {steps.map((step, i) => (
              <li key={i}>
                {renderTextWithLinks(step)}
              </li>
            ))}
          </ol>
          {example && (
            <div className="instruction-example">
              Example: <code>{example}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
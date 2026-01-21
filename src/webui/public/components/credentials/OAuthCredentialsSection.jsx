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

// OAuth / Guild Web-UI Credentials Section Component
function OAuthCredentialsSection({ credentials, onChange, instructions, onGenerateSecret, setupStatus }) {
  const isEnabled = credentials.ENABLE_GUILD_WEBUI === true || credentials.ENABLE_GUILD_WEBUI === 'true';
  const [copiedUrl, setCopiedUrl] = React.useState(null);
  const credStatus = setupStatus?.credentials || {};

  // Get the callback URL from instructions
  const callbackUrl = React.useMemo(() => {
    return instructions?.OAUTH_CALLBACK_URL?.example || `${window.location.origin}/auth/discord/callback`;
  }, [instructions]);

  // Handle copying URL to clipboard
  function handleCopyUrl(url) {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  }

  // Auto-fill callback URL when OAuth is enabled
  React.useEffect(() => {
    if (isEnabled && !credentials.OAUTH_CALLBACK_URL) {
      onChange('OAUTH_CALLBACK_URL', callbackUrl);
    }
  }, [isEnabled, callbackUrl]);

  return (
    <div className="credentials-section">
      <div className="credentials-form">
        <h3 style={{marginBottom: '20px', color: '#FAA61A'}}>
          Guild Web-UI Authentication
        </h3>

        {/* Toggle at the top */}
        <div className="form-group" style={{
          background: '#2a2a2a',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '20px'
        }}>
          <label style={{display: 'flex', alignItems: 'center', cursor: 'pointer', marginBottom: '5px'}}>
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={e => onChange('ENABLE_GUILD_WEBUI', e.target.checked)}
              style={{marginRight: '10px', width: '20px', height: '20px'}}
            />
            <span style={{fontSize: '1.1rem'}}>Enable Guild Web-UI</span>
          </label>
          <small>Allow guild administrators to manage their guilds via /guild interface with Discord OAuth login</small>
        </div>

        {/* Guild Web-UI Access URL - Show when enabled */}
        {isEnabled && (
          <div className="form-group" style={{
            background: '#1a3a1a',
            border: '1px solid #43B581',
            padding: '15px',
            borderRadius: '8px',
            marginBottom: '20px'
          }}>
            <div style={{marginBottom: '10px', color: '#43B581', fontWeight: 'bold'}}>
              Guild Web-UI Access
            </div>
            <div style={{display: 'flex', gap: '10px', alignItems: 'center'}}>
              <input
                type="text"
                value={`${window.location.origin}/guild`}
                readOnly
                style={{flex: 1, background: '#2a2a2a', opacity: 0.9}}
              />
              <button
                type="button"
                onClick={() => handleCopyUrl(`${window.location.origin}/guild`)}
                className="btn btn-secondary"
                style={{
                  marginRight: 0,
                  background: copiedUrl === `${window.location.origin}/guild` ? '#57F287' : undefined,
                  color: copiedUrl === `${window.location.origin}/guild` ? '#000' : undefined
                }}
              >
                {copiedUrl === `${window.location.origin}/guild` ? '✓ Copied!' : '📋 Copy'}
              </button>
              <a
                href="/guild"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary"
                style={{marginRight: 0}}
              >
                🔗 Open
              </a>
            </div>
            <small style={{color: '#aaa'}}>
              Share this URL with guild administrators. They'll login with Discord OAuth and access panels for their guilds.
            </small>
          </div>
        )}

        {isEnabled && (
          <>
            <div className="form-group">
              <label>
                <StatusIndicator isSet={credStatus.DISCORD_CLIENT_ID?.set} />
                Discord OAuth Client ID
              </label>
              <input
                type="text"
                value={credentials.DISCORD_CLIENT_ID || ''}
                onChange={e => onChange('DISCORD_CLIENT_ID', e.target.value)}
                placeholder="987654321098765432"
                required={isEnabled}
              />
              <small>OAuth application Client ID (should be different from bot's Client ID)</small>
            </div>

            <div className="form-group">
              <label>
                <StatusIndicator isSet={credStatus.DISCORD_CLIENT_SECRET?.set} />
                Discord OAuth Client Secret
              </label>
              <input
                type="password"
                value={credentials.DISCORD_CLIENT_SECRET || ''}
                onChange={e => onChange('DISCORD_CLIENT_SECRET', e.target.value)}
                placeholder="AbCdEf123456_XXXXXXXXXXXXX"
                required={isEnabled}
              />
              <small>OAuth application secret (keep this secure!)</small>
            </div>

            <div className="form-group">
              <label>OAuth Callback URL (Auto-generated)</label>
              <div style={{display: 'flex', gap: '10px'}}>
                <input
                  type="text"
                  value={callbackUrl}
                  readOnly
                  style={{flex: 1, background: '#2a2a2a', opacity: 0.8}}
                />
                <button
                  type="button"
                  onClick={() => handleCopyUrl(callbackUrl)}
                  className="btn btn-secondary"
                  style={{
                    marginRight: 0,
                    background: copiedUrl === callbackUrl ? '#57F287' : undefined,
                    color: copiedUrl === callbackUrl ? '#000' : undefined
                  }}
                >
                  {copiedUrl === callbackUrl ? '✓ Copied!' : '📋 Copy'}
                </button>
              </div>
              <small>This URL is automatically generated. Copy it to your Discord OAuth2 settings.</small>
            </div>

            <div className="form-group">
              <label>
                <StatusIndicator isSet={credStatus.SESSION_SECRET?.set} />
                Session Secret
              </label>
              <div style={{display: 'flex', gap: '10px'}}>
                <input
                  type="text"
                  value={credentials.SESSION_SECRET || ''}
                  onChange={e => onChange('SESSION_SECRET', e.target.value)}
                  placeholder="Generate or enter a secure random string"
                  required={isEnabled}
                  style={{flex: 1}}
                />
                <button
                  type="button"
                  onClick={onGenerateSecret}
                  className="btn btn-secondary"
                  style={{marginRight: 0}}
                >
                  🎲 Generate
                </button>
              </div>
              <small>Used to encrypt user sessions (min 16 characters)</small>
            </div>
          </>
        )}
      </div>

      <div className="credentials-instructions">
        <h3 style={{
          color: '#FAA61A',
          marginBottom: '15px',
          paddingBottom: '10px',
          borderBottom: '1px solid #333'
        }}>
          Setup Guide: OAuth Authentication
        </h3>
        {instructions && isEnabled && (
          <>
            {instructions.DISCORD_CLIENT_ID && (
              <InstructionCard
                title={instructions.DISCORD_CLIENT_ID.title}
                steps={instructions.DISCORD_CLIENT_ID.steps}
                example={instructions.DISCORD_CLIENT_ID.example}
              />
            )}
            {instructions.DISCORD_CLIENT_SECRET && (
              <InstructionCard
                title={instructions.DISCORD_CLIENT_SECRET.title}
                steps={instructions.DISCORD_CLIENT_SECRET.steps}
                example={instructions.DISCORD_CLIENT_SECRET.example}
              />
            )}
            {instructions.OAUTH_CALLBACK_URL && (
              <InstructionCard
                title={instructions.OAUTH_CALLBACK_URL.title}
                steps={instructions.OAUTH_CALLBACK_URL.steps}
                example={instructions.OAUTH_CALLBACK_URL.example}
              />
            )}
            {instructions.SESSION_SECRET && (
              <InstructionCard
                title={instructions.SESSION_SECRET.title}
                steps={instructions.SESSION_SECRET.steps}
                example={instructions.SESSION_SECRET.example}
              />
            )}
          </>
        )}
        {!isEnabled && (
          <div className="instruction-placeholder">
            <p style={{color: '#999', textAlign: 'center', padding: '20px'}}>
              Enable Guild Web-UI to see OAuth setup instructions
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Instruction Card Component with enhanced URL handling
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
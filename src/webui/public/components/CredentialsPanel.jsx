// Credentials Panel Component (Refactored)
function CredentialsPanel({ setupStatus, onUpdate, onUpdateAndRestart }) {
  const { useState, useEffect } = React;

  // Initialize with empty strings, not objects
  const [credentials, setCredentials] = useState({
    DISCORD_TOKEN: '',
    CLIENT_ID: '',
    GUILD_ID: '',
    MAIN_GUILD_ID: '',
    ENABLE_GUILD_WEBUI: false,
    DISCORD_CLIENT_ID: '',
    DISCORD_CLIENT_SECRET: '',
    OAUTH_CALLBACK_URL: '',
    SESSION_SECRET: ''
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Generate dynamic instructions based on current URL
  const [instructions] = useState(() => {
    // Get the current URL for OAuth callback
    const currentUrl = window.location.origin;
    const callbackUrl = `${currentUrl}/auth/discord/callback`;

    return {
      DISCORD_TOKEN: {
        title: 'Discord Bot Token',
        steps: [
          'Go to https://discord.com/developers/applications',
          'Select your application (or create a new one)',
          'Navigate to the "Bot" section in the left sidebar',
          'Under the "Token" section, click "Reset Token" or "Copy" if visible',
          'Copy the token and paste it here',
          '⚠️ NEVER share your bot token with anyone!'
        ],
        example: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXX...'
      },
      CLIENT_ID: {
        title: 'Discord Application (Client) ID',
        steps: [
          'Go to https://discord.com/developers/applications',
          'Select your application',
          'On the "General Information" page, find "APPLICATION ID"',
          'Click "Copy" and paste it here'
        ],
        example: '123456789012345678'
      },
      GUILD_ID: {
        title: 'Discord Server (Guild) ID',
        steps: [
          'Open Discord and go to User Settings',
          'Navigate to "Advanced" and enable "Developer Mode"',
          'Right-click on your test/development server icon',
          'Click "Copy Server ID" and paste it here',
          'This is your test server for command registration'
        ],
        example: '123456789012345678'
      },
      MAIN_GUILD_ID: {
        title: 'Main Guild ID (Optional)',
        steps: [
          '⚠️ This field is OPTIONAL',
          'Use this if you have a separate production server',
          'Right-click on your main/production server icon',
          'Click "Copy Server ID" and paste it here',
          'If left empty, it will default to Guild ID',
          'Web-UI panels and mainGuildOnly features use this server'
        ],
        example: '987654321098765432 (or leave empty)'
      },
      DISCORD_CLIENT_ID: {
        title: 'Discord OAuth Application',
        steps: [
          'Go to https://discord.com/developers/applications',
          'Click "New Application" (top right)',
          '⚠️ Create a SEPARATE app for OAuth - do NOT use your bot application',
          'Name it something like "YourBot OAuth" to distinguish it',
          'Go to "OAuth2" section in the left sidebar',
          'Under "Redirects", click "Add Redirect"',
          `Add this redirect URI: ${callbackUrl}`,
          'Scroll down to "OAuth2 URL Generator" and select scopes: identify, guilds, guilds.members.read',
          'Save all changes',
          'Copy the "CLIENT ID" from the top of the OAuth2 page',
          'Paste the CLIENT ID here'
        ],
        example: '987654321098765432'
      },
      DISCORD_CLIENT_SECRET: {
        title: 'Client Secret',
        steps: [
          'Still in the OAuth2 section of your OAuth app',
          'Find the "CLIENT SECRET" section',
          'Click "Reset Secret" button (or "Copy" if visible)',
          '⚠️ Copy immediately - it only shows once!',
          'Paste the secret here',
          '⚠️ Keep this secure - never share or commit to git'
        ],
        example: 'AbCdEf123456_XXXXXXXXXXXXX'
      },
      OAUTH_CALLBACK_URL: {
        title: 'OAuth Callback URL',
        steps: [
          'The callback URL has been automatically generated',
          `Your callback URL: ${callbackUrl}`,
          'This field will be populated automatically when Guild Web-UI is enabled'
        ],
        example: callbackUrl
      },
      SESSION_SECRET: {
        title: 'Session Secret',
        steps: [
          'Click the "Generate" button to create a secure random secret',
          'This encrypts user login sessions',
          'The secret will be generated automatically',
          '⚠️ Keep this secure - changing it logs out all users'
        ],
        example: 'Click Generate to create'
      }
    };
  });

  // Load existing credentials when setupStatus changes
  useEffect(() => {
    if (setupStatus?.credentials) {
      // Load non-sensitive values to show current state
      const creds = setupStatus.credentials;
      setCredentials(prev => ({
        ...prev,
        // Load Guild Web-UI settings (non-sensitive)
        ENABLE_GUILD_WEBUI: creds.ENABLE_GUILD_WEBUI?.value === 'true',
        OAUTH_CALLBACK_URL: creds.OAUTH_CALLBACK_URL?.value && !creds.OAUTH_CALLBACK_URL.value.startsWith('[')
          ? creds.OAUTH_CALLBACK_URL.value
          : prev.OAUTH_CALLBACK_URL
        // Sensitive values (DISCORD_CLIENT_SECRET, SESSION_SECRET, etc.) are NOT loaded for security
      }));
    }
  }, [setupStatus]);

  // Handle field changes
  const handleFieldChange = (field, value) => {
    setCredentials(prev => ({
      ...prev,
      [field]: value
    }));
  };

  // Generate secure session secret
  function generateSessionSecret() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
    let secret = '';
    for (let i = 0; i < 32; i++) {
      secret += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setCredentials({...credentials, SESSION_SECRET: secret});
    setSuccess('Session secret generated! Remember to save it.');
  }

  // Save credentials
  async function handleSave(andStart = false) {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await api.post('/setup/credentials', credentials);
      if (res.success) {
        setSuccess(andStart ? 'Credentials saved' : 'Credentials saved successfully');
        if (andStart) {
          await onUpdateAndRestart();
        } else {
          await onUpdate();
        }
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const isConfigured = setupStatus?.configured;

  return (
    <div className="credentials-panel">
      <div className="credentials-header">
        <h2>Credentials</h2>
        <p style={{color: '#999', marginBottom: '20px'}}>
          {isConfigured
            ? 'Manage your Discord bot credentials and settings'
            : 'Complete the initial setup to activate your bot'}
        </p>
        {error && <div className="error-message">{error}</div>}
        {success && <div className="success-message">{success}</div>}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); handleSave(false); }}>
        {/* Bot Credentials Section */}
        <BotCredentialsSection
          credentials={credentials}
          onChange={handleFieldChange}
          instructions={instructions}
          setupStatus={setupStatus}
        />

        <div className="section-divider" />

        {/* OAuth Credentials Section */}
        <OAuthCredentialsSection
          credentials={credentials}
          onChange={handleFieldChange}
          instructions={instructions}
          onGenerateSecret={generateSessionSecret}
          setupStatus={setupStatus}
        />

        {/* Action Buttons */}
        <div className="credentials-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Saving...' : isConfigured ? 'Update Credentials' : 'Save Credentials'}
          </button>
          <button
            type="button"
            onClick={() => handleSave(true)}
            className="btn btn-success"
            disabled={loading}
          >
            {isConfigured ? 'Update & Restart' : 'Save & Start Bot'}
          </button>
        </div>
      </form>
    </div>
  );
}
// Credentials Panel Component (Refactored)
function CredentialsPanel({ setupStatus, isBotRunning, onUpdate, onUpdateAndRestart }) {
  const { useState, useEffect, useMemo } = React;

  const EMPTY_CREDS = {
    DISCORD_TOKEN: '',
    CLIENT_ID: '',
    GUILD_ID: '',
    MAIN_GUILD_ID: '',
    ENABLE_GUILD_WEBUI: false,
    DISCORD_CLIENT_ID: '',
    DISCORD_CLIENT_SECRET: '',
    OAUTH_CALLBACK_URL: '',
    SESSION_SECRET: ''
  };

  const [credentials, setCredentials] = useState({ ...EMPTY_CREDS });
  // Baseline = values that are currently persisted, used to detect dirty state.
  const [baseline, setBaseline] = useState({ ...EMPTY_CREDS });

  const [loading, setLoading] = useState(false);

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
          'Web-UI panels and system-scope features use this server'
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

  // Load existing credentials when setupStatus changes. The baseline mirrors
  // what's currently persisted so we can detect dirty state on save.
  useEffect(() => {
    if (setupStatus?.credentials) {
      const creds = setupStatus.credentials;
      const enableGuildWebUI = creds.ENABLE_GUILD_WEBUI?.value === 'true';
      const callbackUrl = creds.OAUTH_CALLBACK_URL?.value && !creds.OAUTH_CALLBACK_URL.value.startsWith('[')
        ? creds.OAUTH_CALLBACK_URL.value
        : '';
      const mainGuildId = (creds.MAIN_GUILD_ID?.set && setupStatus.guildIds?.MAIN_GUILD_ID) || '';

      const loaded = {
        ...EMPTY_CREDS,
        // Only non-sensitive fields come back from the server; secrets stay empty.
        ENABLE_GUILD_WEBUI: enableGuildWebUI,
        OAUTH_CALLBACK_URL: callbackUrl,
        MAIN_GUILD_ID: mainGuildId,
      };
      setCredentials(prev => ({ ...loaded, ...dirtyOverlay(prev, baseline) }));
      setBaseline(loaded);
    }
  }, [setupStatus]);

  /** Keep any user-typed edits when a new baseline arrives (avoid wiping in-flight edits). */
  function dirtyOverlay(current, previousBaseline) {
    const out = {};
    for (const key of Object.keys(current)) {
      if (current[key] !== previousBaseline[key]) out[key] = current[key];
    }
    return out;
  }

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
    showToast('Session secret generated! Remember to save it.', 'success');
  }

  // Save credentials
  async function handleSave(andStart = false) {
    setLoading(true);

    // Capture prior Guild Web-UI state before the save. Only then can we decide
    // whether session invalidation is something users would actually care about.
    const wasGuildWebUIEnabled = baseline.ENABLE_GUILD_WEBUI === true;

    try {
      const res = await api.post('/setup/credentials', credentials);
      if (res.success) {
        const reload = res.reload || {};
        const changes = Array.isArray(reload.changes) ? reload.changes : [];

        if (!changes.length) {
          showToast('No changes to save.', 'info');
        } else {
          showToast('Settings saved.', 'success');
          if (reload.oauthReconfigured) {
            showToast('Guild Web-UI reconfigured live; no restart needed.', 'success');
          }
          // Only warn about session invalidation when Guild Web-UI was already
          // serving sessions before this save; otherwise there are no sessions
          // to log out and the warning is just noise.
          if (reload.sessionSecretChanged && wasGuildWebUIEnabled) {
            showToast('SESSION_SECRET changed: active Guild Web-UI sessions will be logged out on the next bot restart.', 'warning', { sticky: true });
          }
          if (reload.botCredentialsChanged && !isManaged) {
            showToast('Bot credentials changed: restart the bot to apply.', 'warning', { sticky: true });
          }
        }

        if (andStart) {
          await onUpdateAndRestart();
        } else {
          await onUpdate();
        }
      } else {
        showToast(res.error, 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  const isConfigured = setupStatus?.configured;
  const isManaged = setupStatus?.deploymentMode === 'managed';

  // ── Dirty-state tracking ──
  // Secrets (DISCORD_CLIENT_SECRET, SESSION_SECRET, DISCORD_TOKEN) never come
  // back from the server for security, so we treat any non-empty value as an
  // intended change. Non-secret fields diff against the baseline.
  const SECRET_FIELDS = ['DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'];
  const BOT_RESTART_FIELDS = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
  const GUILD_WEBUI_FIELDS = ['ENABLE_GUILD_WEBUI', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'OAUTH_CALLBACK_URL', 'SESSION_SECRET'];

  function fieldDirty(key) {
    if (SECRET_FIELDS.includes(key)) {
      // Secret is dirty only when user typed something
      return !!credentials[key] && credentials[key].trim() !== '';
    }
    return credentials[key] !== baseline[key];
  }

  const dirtyFields = useMemo(
    () => Object.keys(credentials).filter(fieldDirty),
    [credentials, baseline]
  );
  const hasAnyChanges = dirtyFields.length > 0;
  const botCredsDirty = dirtyFields.some(f => BOT_RESTART_FIELDS.includes(f));
  const guildCredsDirty = dirtyFields.some(f => GUILD_WEBUI_FIELDS.includes(f));

  // Primary save: disabled when nothing has changed.
  const saveDisabled = loading || !hasAnyChanges;

  // Secondary save-and-(re)start: depends on bot state + what changed.
  // - Bot not running: always available as "Save & Start Bot" (boots the bot).
  // - Bot running: only meaningful if bot-level creds changed ("Save & Restart Bot");
  //   Guild Web-UI cred changes hot-reload and do NOT need a restart.
  const startRestartLabel = !isConfigured
    ? 'Save & Start Bot'
    : isBotRunning
      ? 'Save & Restart Bot'
      : 'Save & Start Bot';
  const startRestartDisabled = loading || (isBotRunning && !botCredsDirty);
  // Hide the button entirely when bot is running + no bot-cred changes AND user has other
  // (guild-webui-only) changes; the plain "Save" button covers that case without the
  // restart confusion. We keep it visible but disabled for discoverability.

  return (
    <div className="credentials-panel">
      <div className="credentials-header">
        <h2>Credentials</h2>
        <p style={{color: '#999', marginBottom: '20px'}}>
          {isConfigured
            ? 'Manage your Discord bot credentials and settings'
            : 'Complete the initial setup to activate your bot'}
        </p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); handleSave(false); }}>
        {/* Bot Credentials Section */}
        <BotCredentialsSection
          credentials={credentials}
          onChange={handleFieldChange}
          instructions={instructions}
          setupStatus={setupStatus}
          isManaged={isManaged}
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saveDisabled}
            title={!hasAnyChanges ? 'No changes to save' : undefined}
          >
            {loading ? 'Saving...' : isConfigured ? 'Save Changes' : 'Save Credentials'}
          </button>
          <button
            type="button"
            onClick={() => handleSave(true)}
            className="btn btn-success"
            disabled={startRestartDisabled}
            title={
              startRestartDisabled && isBotRunning && !botCredsDirty
                ? 'No bot credentials changed. Guild Web-UI credentials apply without a restart; use "Save Changes" instead.'
                : isManaged
                  ? 'Saves credentials and restarts the bot process. The Bot Manager auto-restarts it.'
                  : undefined
            }
          >
            {startRestartLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
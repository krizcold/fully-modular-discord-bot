// Guild Selector Component - Select which guild to manage

const { useState, useEffect } = React;

function GuildSelector({ user, onGuildSelected, onLogout }) {
  const [guilds, setGuilds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadGuilds();
  }, []);

  const loadGuilds = async () => {
    try {
      setLoading(true);
      setError(null);

      const result = await guildApi.getGuilds();

      if (result.success) {
        setGuilds(result.guilds || []);
      } else {
        setError(result.error || 'Failed to load guilds');
      }
    } catch (err) {
      console.error('Error loading guilds:', err);
      setError('Failed to load guilds');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await guildApi.logout();
      window.location.reload();
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const getGuildIcon = (guild) => {
    // Special handling for System Panels pseudo-guild
    if (guild.id === 'system') {
      return null;
    }

    if (guild.icon) {
      return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`;
    }
    return null;
  };

  const getGuildPlaceholder = (guild) => {
    // Special icon for System Panels
    if (guild.id === 'system') {
      return '⚙️';
    }
    return guild.name.charAt(0).toUpperCase();
  };

  if (loading) {
    return (
      <div className="guild-selector-loading">
        <div className="spinner"></div>
        <p>Loading your guilds...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="guild-selector-error">
        <h2>Error Loading Guilds</h2>
        <p>{error}</p>
        <button onClick={loadGuilds}>Retry</button>
        <button onClick={handleLogout}>Logout</button>
      </div>
    );
  }

  if (guilds.length === 0) {
    return (
      <div className="guild-selector-empty">
        <h2>No Guilds Available</h2>
        <p>You don't have administrator access to any guilds where this bot is present.</p>
        <p>To use this panel, you must:</p>
        <ul>
          <li>Be an administrator in a Discord server</li>
          <li>Ensure the bot is added to that server</li>
        </ul>
        <button onClick={handleLogout}>Logout</button>
      </div>
    );
  }

  return (
    <div className="guild-selector">
      <div className="guild-selector-header">
        <div className="user-info">
          {user.avatar ? (
            <img
              src={`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`}
              alt={user.username}
              className="user-avatar"
            />
          ) : (
            <div className="user-avatar-placeholder">
              {(user.username || 'U').charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <strong>{user.username || 'Unknown User'}</strong>
            {user.discriminator && user.discriminator !== '0' && <span>#{user.discriminator}</span>}
          </div>
        </div>
        <button onClick={handleLogout} className="logout-button">Logout</button>
      </div>

      <div className="guild-selector-content">
        <h2>Select a Guild to Manage</h2>
        <p>Choose which server you want to configure:</p>

        <div className="guild-list">
          {guilds.map(guild => (
            <div
              key={guild.id}
              className="guild-card"
              onClick={() => onGuildSelected(guild)}
            >
              {getGuildIcon(guild) ? (
                <img
                  src={getGuildIcon(guild)}
                  alt={guild.name}
                  className="guild-icon"
                />
              ) : (
                <div className="guild-icon-placeholder" style={guild.id === 'system' ? {
                  background: 'linear-gradient(135deg, #5865F2, #4752C4)',
                  fontSize: '2rem'
                } : {}}>
                  {getGuildPlaceholder(guild)}
                </div>
              )}
              <div className="guild-info">
                <strong>{guild.name}</strong>
                <span className="guild-id">ID: {guild.id}</span>
              </div>
              <div className="guild-arrow">→</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

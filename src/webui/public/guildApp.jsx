// Guild App - Main application for guild Web-UI

const { useState } = React;

function GuildApp() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [selectedGuild, setSelectedGuild] = useState(null);

  const handleAuthenticated = (userData, permissionsData) => {
    setUser(userData);
    setPermissions(permissionsData);
    setAuthenticated(true);
  };

  const handleGuildSelected = (guild) => {
    setSelectedGuild(guild);
  };

  const handleBackToGuilds = () => {
    setSelectedGuild(null);
  };

  const handleLogout = () => {
    setAuthenticated(false);
    setUser(null);
    setPermissions(null);
    setSelectedGuild(null);
  };

  // Show login screen if not authenticated
  if (!authenticated) {
    return <OAuthLogin onAuthenticated={handleAuthenticated} />;
  }

  // Show guild selector if no guild selected
  if (!selectedGuild) {
    return (
      <GuildSelector
        user={user}
        onGuildSelected={handleGuildSelected}
        onLogout={handleLogout}
      />
    );
  }

  // Show guild panels panel
  return (
    <GuildPanelsPanel
      guild={selectedGuild}
      user={user}
      onBack={handleBackToGuilds}
    />
  );
}

// Mount app
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<GuildApp />);

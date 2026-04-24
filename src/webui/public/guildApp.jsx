// Guild App: Main application for guild Web-UI

const { useState, useEffect } = React;

function GuildApp() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [selectedGuild, setSelectedGuild] = useState(null);
  const [activeTab, setActiveTab] = useState('panels');
  const [subData, setSubData] = useState(null);

  const handleAuthenticated = (userData, permissionsData) => {
    setUser(userData);
    setPermissions(permissionsData);
    setAuthenticated(true);
  };

  const handleGuildSelected = (guild) => {
    setSelectedGuild(guild);
    setActiveTab('panels');
    setSubData(null);
  };

  const handleBackToGuilds = () => {
    setSelectedGuild(null);
    setActiveTab('panels');
    setSubData(null);
  };

  const handleLogout = () => {
    setAuthenticated(false);
    setUser(null);
    setPermissions(null);
    setSelectedGuild(null);
    setSubData(null);
  };

  // Load subscription state (tiers/providers/subs) once per guild;
  // used for tab visibility AND passed to GuildSubscriptionPanel.
  useEffect(() => {
    if (!selectedGuild) return;
    let cancelled = false;
    guildApi.getSubscription(selectedGuild.id)
      .then(res => { if (!cancelled && res?.success) setSubData(res); })
      .catch(() => { /* ignore; tab will stay hidden */ });
    return () => { cancelled = true; };
  }, [selectedGuild && selectedGuild.id]);

  const refreshSub = () => {
    if (!selectedGuild) return Promise.resolve();
    return guildApi.getSubscription(selectedGuild.id)
      .then(res => { if (res?.success) setSubData(res); })
      .catch(() => {});
  };

  // Subscription tab visibility:
  //  - show if bot has at least one non-Free tier defined, OR
  //  - this guild already has an active manual or paid subscription (show so they can manage it).
  const hasNonFreeTiers = subData ? Object.keys(subData.tiers || {}).some(id => id !== 'free') : false;
  const hasGuildSubscription = subData ? !!(subData.subscriptions && (subData.subscriptions.manual || subData.subscriptions.paid)) : false;
  const showSubscriptionTab = hasNonFreeTiers || hasGuildSubscription;

  // If user is on Subscription and it just got hidden, fall back to Panels.
  useEffect(() => {
    if (activeTab === 'subscription' && !showSubscriptionTab) setActiveTab('panels');
  }, [showSubscriptionTab, activeTab]);

  if (!authenticated) return <OAuthLogin onAuthenticated={handleAuthenticated} />;
  if (!selectedGuild) return <GuildSelector user={user} onGuildSelected={handleGuildSelected} onLogout={handleLogout} />;

  const tabStyle = (active) => ({
    background: 'transparent',
    color: active ? '#fff' : '#9a9a9a',
    border: 'none',
    borderBottom: active ? '2px solid #5865F2' : '2px solid transparent',
    padding: '12px 22px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.92rem',
    transition: 'color 0.15s, border-color 0.15s',
    marginBottom: '-1px',
  });

  return (
    <div>
      {/* Persistent top header: bot identity + current guild + user + back */}
      <div style={{
        background: '#2c2f33',
        padding: '14px 24px',
        borderBottom: '1px solid #1a1b1d',
        display: 'flex', alignItems: 'center', gap: '16px',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, color: '#fff', fontSize: '1.1rem', letterSpacing: '0.2px' }}>
            Guild Management
          </h1>
          <div style={{
            color: '#8a8a8a', fontSize: '0.8rem', marginTop: '2px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            <strong style={{ color: '#ccc' }}>{selectedGuild.name}</strong>
            <span> · {user?.username}</span>
          </div>
        </div>
        <button onClick={handleBackToGuilds} style={{
          background: '#40444b', color: '#ddd', border: 'none',
          padding: '8px 14px', borderRadius: '6px', cursor: 'pointer',
          fontSize: '0.82rem', flexShrink: 0,
        }}>← Guilds</button>
      </div>

      {/* Tab bar directly under the header */}
      <div style={{
        background: '#232528',
        borderBottom: '1px solid #1a1b1d',
        padding: '0 24px',
        display: 'flex', gap: '2px',
      }}>
        <button style={tabStyle(activeTab === 'panels')} onClick={() => setActiveTab('panels')}>
          Panels
        </button>
        {showSubscriptionTab && (
          <button style={tabStyle(activeTab === 'subscription')} onClick={() => setActiveTab('subscription')}>
            Subscription
          </button>
        )}
      </div>

      {activeTab === 'panels' && (
        <GuildPanelsPanel guild={selectedGuild} user={user} />
      )}
      {activeTab === 'subscription' && showSubscriptionTab && (
        <GuildSubscriptionPanel guild={selectedGuild} subData={subData} onRefresh={refreshSub} />
      )}
    </div>
  );
}

// Mount app
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<GuildApp />);

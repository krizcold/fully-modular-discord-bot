// Guild App: Main application for guild Web-UI

const { useState, useEffect } = React;

const GUILD_TABS = ['panels', 'subscription'];

/**
 * Parse /guild, /guild/{guildId}, /guild/{guildId}/{tab} into structured
 * routing state. Falls back to legacy `?guildId=` query param for
 * backwards compat with any pre-existing share links.
 */
function parseGuildRoute() {
  const segments = (window.location.pathname || '/').split('/').filter(Boolean);
  let guildId;
  let tab = 'panels';
  if (segments[0] === 'guild') {
    if (segments[1]) guildId = decodeURIComponent(segments[1]);
    if (segments[2] && GUILD_TABS.includes(segments[2])) tab = segments[2];
  }
  if (!guildId) {
    const query = new URLSearchParams(window.location.search).get('guildId');
    if (query) guildId = query;
  }
  return { guildId, tab };
}

function pushGuildUrl(guildId, tab) {
  const path = guildId
    ? `/guild/${encodeURIComponent(guildId)}${tab && tab !== 'panels' ? `/${tab}` : ''}`
    : '/guild';
  if (window.location.pathname !== path) {
    // Strip query params we want to consume-and-clear (subscribe=...).
    // Anything else (auth ?hash= for example) stays.
    const params = new URLSearchParams(window.location.search);
    params.delete('subscribe');
    params.delete('session');
    params.delete('guildId');
    const qs = params.toString();
    window.history.pushState({}, '', path + (qs ? '?' + qs : '') + window.location.hash);
  }
}

function GuildApp() {
  const initialRoute = parseGuildRoute();
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [selectedGuild, setSelectedGuild] = useState(null);
  const [activeTab, setActiveTabState] = useState(initialRoute.tab);
  const [subData, setSubData] = useState(null);

  // Tab change wrapper: keep URL in sync so refresh-restores-state works.
  const setActiveTab = (tab) => {
    setActiveTabState(tab);
    if (selectedGuild) pushGuildUrl(selectedGuild.id, tab);
  };

  // Back/forward: re-derive guild + tab from the URL.
  useEffect(() => {
    const onPopState = () => {
      const route = parseGuildRoute();
      setActiveTabState(route.tab);
      // Guild change via back-button: clear selection so GuildSelector
      // re-runs auto-select against the (new) URL guildId.
      if (selectedGuild && route.guildId && route.guildId !== selectedGuild.id) {
        setSelectedGuild(null);
      } else if (selectedGuild && !route.guildId) {
        setSelectedGuild(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [selectedGuild]);

  const handleAuthenticated = (userData, permissionsData) => {
    setUser(userData);
    setPermissions(permissionsData);
    setAuthenticated(true);
  };

  const handleGuildSelected = (guild) => {
    setSelectedGuild(guild);
    setSubData(null);
    // Tab pick: respect whatever the URL says. Subscribe-return URLs land
    // on /guild/{id}/subscription so the route already encodes intent.
    // Pre-existing legacy `?subscribe=success` query is also honoured.
    const route = parseGuildRoute();
    const params = new URLSearchParams(window.location.search);
    const subscribeOutcome = params.get('subscribe');
    const tab = subscribeOutcome === 'success' || subscribeOutcome === 'cancel'
      ? 'subscription'
      : route.tab;
    setActiveTabState(tab);
    pushGuildUrl(guild.id, tab);
  };

  const handleBackToGuilds = () => {
    setSelectedGuild(null);
    setActiveTabState('panels');
    setSubData(null);
    pushGuildUrl(null, 'panels');
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
  //  - this guild already has an active or queued subscription (show so they can manage it).
  const hasNonFreeTiers = subData ? Object.keys(subData.tiers || {}).some(id => id !== 'free') : false;
  const hasGuildSubscription = subData
    ? !!(subData.subscriptions && (subData.subscriptions.active || (Array.isArray(subData.subscriptions.paused) && subData.subscriptions.paused.length > 0)))
    : false;
  const showSubscriptionTab = hasNonFreeTiers || hasGuildSubscription;

  // If user is on Subscription and it just got hidden, fall back to Panels.
  // Important: only act AFTER subData has loaded. Without the subData
  // guard this effect fires on mount (subData=null -> showSubscriptionTab
  // computes false) and bounces a deep link like /guild/X/subscription
  // straight to /guild/X. Wait until we actually know whether the tab
  // is applicable for this guild.
  useEffect(() => {
    if (!subData) return;
    if (activeTab === 'subscription' && !showSubscriptionTab) setActiveTab('panels');
  }, [subData, showSubscriptionTab, activeTab]);

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

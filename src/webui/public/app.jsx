const { useState, useEffect } = React;

// Main App Component
function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [status, setStatus] = useState(null);
  const [setupStatus, setSetupStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Load initial data and set up WebSocket subscriptions
  useEffect(() => {
    // Load initial data
    loadData();

    // Subscribe to WebSocket events for real-time updates
    const unsubscribeStatus = wsClient.on('bot:status', (data) => {
      console.log('[WebSocket] Bot status update:', data);
      setStatus(data);
    });

    const unsubscribeLog = wsClient.on('bot:log', (data) => {
      console.log('[WebSocket] New log:', data.line);
      setLogs((prevLogs) => {
        const newLogs = [...prevLogs, data.line];
        // Keep last 50 logs to match polling behavior
        return newLogs.slice(-50);
      });
    });

    const unsubscribeStartup = wsClient.on('bot:startup', (data) => {
      console.log('[WebSocket] Bot started:', data);
      setStatus(data);
      setSuccess('Bot started successfully!');
      setTimeout(() => setSuccess(null), 3000);
    });

    const unsubscribeShutdown = wsClient.on('bot:shutdown', (data) => {
      console.log('[WebSocket] Bot shutdown:', data);
      loadData(); // Reload to get updated status
    });

    const unsubscribeCrash = wsClient.on('bot:crash', (data) => {
      console.log('[WebSocket] Bot crashed:', data);
      setError('Bot has crashed! Check logs for details.');
      loadData(); // Reload to get crash status
    });

    const unsubscribeConnection = wsClient.on('_connection', (data) => {
      console.log('[WebSocket] Connection status:', data.connected);
      if (data.connected) {
        // Reload data when WebSocket reconnects
        loadData();
      }
    });

    // Cleanup subscriptions on unmount
    return () => {
      unsubscribeStatus();
      unsubscribeLog();
      unsubscribeStartup();
      unsubscribeShutdown();
      unsubscribeCrash();
      unsubscribeConnection();
    };
  }, []);

  async function loadData() {
    try {
      const [statusRes, setupRes, logsRes] = await Promise.all([
        api.get('/bot/status'),
        api.get('/setup/status'),
        api.get('/bot/logs?limit=50')
      ]);

      setStatus(statusRes.status);
      setSetupStatus(setupRes);
      setLogs(logsRes.logs.current);
      setLoading(false);
      setError(null);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  async function startBot() {
    try {
      setLoading(true);
      const res = await api.post('/bot/start');
      if (res.success) {
        setSuccess('Bot started successfully!');
        await loadData();
      } else {
        setError(res.error || 'Failed to start bot');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function restartBot(skipConfirmation = false) {
    if (!skipConfirmation && !confirm('Restart the bot?')) return;
    try {
      setLoading(true);
      const res = await api.post('/bot/restart');
      if (res.success) {
        setSuccess('Bot restarted successfully!');
        await loadData();
      } else {
        setError(res.error || 'Failed to restart bot');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function startOrRestartBot() {
    // If bot is already running, restart it (with confirmation)
    if (status?.running) {
      await restartBot();
    } else {
      // If bot is not running, start it (no confirmation needed)
      await startBot();
    }
  }

  async function shutdownBot(emergency = false) {
    const msg = emergency
      ? 'This will restart the entire container (bot + Web-UI). You will briefly lose access. Are you sure?'
      : 'Are you sure you want to stop the bot? Web-UI will remain accessible.';
    if (!confirm(msg)) return;
    try {
      setLoading(true);
      await api.post('/bot/shutdown', { emergency });
      setSuccess(emergency ? 'Container restarting...' : 'Bot stopped successfully');
      await loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !status) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div>
      <div className="header" style={{ textAlign: 'center', position: 'relative' }}>
        <h1 style={{ margin: '0', padding: '20px 0', color: '#a0a0a0' }}>Discord Bot System Settings</h1>
        {status && (
          <span className={`status-badge ${status.running ? 'running' : status.crashed ? 'crashed' : 'stopped'}`}
                style={{ position: 'absolute', right: '20px', top: '50%', transform: 'translateY(-50%)' }}>
            {status.running ? '● Online' : status.crashed ? '⚠ Crashed' : '○ Offline'}
          </span>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}
      {success && <div className="success-message">{success}</div>}

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={`tab ${activeTab === 'panels' ? 'active' : ''}`}
          onClick={() => setActiveTab('panels')}
        >
          Panels
        </button>
        <button
          className={`tab ${activeTab === 'credentials' ? 'active' : ''}`}
          onClick={() => setActiveTab('credentials')}
        >
          Credentials
        </button>
        <button
          className={`tab ${activeTab === 'config' ? 'active' : ''}`}
          onClick={() => setActiveTab('config')}
        >
          Config
        </button>
        <button
          className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          Logs
        </button>
        <button
          className={`tab ${activeTab === 'update' ? 'active' : ''}`}
          onClick={() => setActiveTab('update')}
        >
          Update
        </button>
        <button
          className={`tab ${activeTab === 'appstore' ? 'active' : ''}`}
          onClick={() => setActiveTab('appstore')}
        >
          App Store
        </button>
      </div>

      <div className="tab-content">
        {activeTab === 'dashboard' && (
          <BotControlPanel
            status={status}
            onStart={startBot}
            onRestart={restartBot}
            onShutdown={shutdownBot}
            loading={loading}
            configured={setupStatus?.configured}
          />
        )}

        {activeTab === 'panels' && <PanelsPanel />}

        {activeTab === 'credentials' && (
          <CredentialsPanel
            setupStatus={setupStatus}
            onUpdate={loadData}
            onUpdateAndRestart={async () => {
              await loadData();
              // Full server restart to pick up OAuth/session changes
              try {
                await api.post('/bot/restart-server');
                // Server will restart, page will reconnect
              } catch (err) {
                // Fallback to bot restart if server restart fails
                console.warn('Server restart failed, falling back to bot restart:', err);
                await startOrRestartBot();
              }
            }}
          />
        )}

        {activeTab === 'config' && <ConfigPanel />}

        {activeTab === 'logs' && <LogsPanel api={api} wsClient={wsClient} />}

        {activeTab === 'update' && <UpdatePanel api={api} wsClient={wsClient} />}

        {activeTab === 'appstore' && <AppStorePanel />}
      </div>
    </div>
  );
}

// Render
ReactDOM.render(<App />, document.getElementById('root'));

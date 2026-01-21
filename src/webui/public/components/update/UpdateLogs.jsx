function UpdateLogs({ api, wsClient }) {
  const [activeTab, setActiveTab] = React.useState('bot');
  const [logs, setLogs] = React.useState({
    bot: [],
    webui: []
  });
  const [autoScroll, setAutoScroll] = React.useState(true);
  const logContainerRef = React.useRef(null);

  const logSources = [
    { id: 'bot', label: 'Bot' },
    { id: 'webui', label: 'Web-UI' }
  ];

  const fetchLogs = React.useCallback(async (source) => {
    try {
      if (source === 'bot') {
        const response = await api.get('/bot/logs?limit=200');
        if (response.success && response.logs) {
          setLogs(prev => ({
            ...prev,
            bot: response.logs.current || []
          }));
        }
      } else if (source === 'webui') {
        const response = await api.get('/bot/logs/webui?limit=200');
        if (response.success && response.logs) {
          setLogs(prev => ({
            ...prev,
            webui: response.logs || []
          }));
        }
      }
    } catch (error) {
      console.error(`Error fetching ${source} logs:`, error);
    }
  }, [api]);

  React.useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, activeTab, autoScroll]);

  React.useEffect(() => {
    if (!wsClient) return;

    const unsubscribe = wsClient.on('bot:log', (data) => {
      setLogs(prev => ({
        ...prev,
        bot: [...prev.bot, data.line].slice(-200)
      }));
    });

    return unsubscribe;
  }, [wsClient]);

  React.useEffect(() => {
    fetchLogs(activeTab);
  }, [activeTab, fetchLogs]);

  const currentLogs = logs[activeTab] || [];

  return (
    <div className="update-logs-section">
      <div className="logs-header">
        <h3>System Logs</h3>
        <label className="auto-scroll-toggle">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
      </div>

      <div className="tabs" style={{ marginBottom: '10px' }}>
        {logSources.map(source => (
          <button
            key={source.id}
            className={`tab ${activeTab === source.id ? 'active' : ''}`}
            onClick={() => setActiveTab(source.id)}
          >
            {source.label}
            {logs[source.id].length > 0 && ` (${logs[source.id].length})`}
          </button>
        ))}
      </div>

      <div className="logs-container" ref={logContainerRef}>
        {currentLogs.length === 0 ? (
          <div className="logs-empty">Waiting for logs...</div>
        ) : (
          currentLogs.map((log, i) => {
            const isError = typeof log === 'string' && (
              log.includes('[ERROR]') || log.includes('Error')
            );
            const isWarning = typeof log === 'string' && (
              log.includes('[WARN]') || log.includes('Warning')
            );

            return (
              <div
                key={i}
                className={`log-line ${isError ? 'error' : ''} ${isWarning ? 'warning' : ''}`}
              >
                {log}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

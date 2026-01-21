function LogsPanel({ api, wsClient }) {
  const [activeTab, setActiveTab] = React.useState('bot');
  const [logs, setLogs] = React.useState({
    bot: [],
    webui: []
  });
  const [loading, setLoading] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const logContainerRef = React.useRef(null);

  const logSources = [
    { id: 'bot', label: 'Bot' },
    { id: 'webui', label: 'Web-UI' }
  ];

  const sanitizeLog = (log) => {
    if (typeof log !== 'string') return '';
    return log
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  };

  const fetchLogs = React.useCallback(async (source) => {
    setLoading(true);
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
    } finally {
      setLoading(false);
    }
  }, [api]);

  const downloadLogs = () => {
    const currentLogs = logs[activeTab] || [];
    const content = currentLogs.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTab}-logs-${new Date().toISOString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const clearLogs = async () => {
    try {
      const response = await api.post('/bot/logs/clear');
      if (response.success) {
        setLogs({ bot: [], webui: [] });
      }
    } catch (error) {
      console.error('Error clearing logs:', error);
    }
  };

  React.useEffect(() => {
    fetchLogs(activeTab);
  }, [activeTab, fetchLogs]);

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
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, activeTab, autoScroll]);

  const currentLogs = logs[activeTab] || [];

  return (
    <div className="card">
      <div className="logs-header">
        <h2>System Logs</h2>
        <div className="logs-controls">
          <label className="auto-scroll-toggle">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <button
            className="btn btn-sm"
            onClick={() => fetchLogs(activeTab)}
            disabled={loading}
          >
            Refresh
          </button>
          <button
            className="btn btn-sm"
            onClick={downloadLogs}
            disabled={currentLogs.length === 0}
          >
            Download
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={clearLogs}
            disabled={currentLogs.length === 0}
          >
            Clear All
          </button>
        </div>
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
        {loading ? (
          <div className="logs-empty">Loading logs...</div>
        ) : currentLogs.length === 0 ? (
          <div className="logs-empty">No logs available</div>
        ) : (
          currentLogs.map((log, i) => {
            const sanitized = sanitizeLog(log);
            const isError = log.includes('[ERROR]') || log.includes('Error');
            const isWarning = log.includes('[WARN]') || log.includes('Warning');

            return (
              <div
                key={i}
                className={`log-line ${isError ? 'error' : ''} ${isWarning ? 'warning' : ''}`}
                dangerouslySetInnerHTML={{ __html: sanitized }}
              />
            );
          })
        )}
      </div>

    </div>
  );
}

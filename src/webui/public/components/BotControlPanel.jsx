// Bot Control Panel Component
function BotControlPanel({ status, onStart, onRestart, onShutdown, loading, configured }) {
  if (!status) return null;

  const uptimeStr = status.uptime > 0
    ? `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m ${status.uptime % 60}s`
    : 'N/A';

  // Check if bot can be started (must be configured)
  const canStart = configured !== false;

  return (
    <div className="card">
      <h2>Bot Control</h2>

      {/* Setup Required Banner */}
      {!canStart && (
        <div style={{
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          border: '1px solid #5865F2',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '20px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '2em', marginBottom: '10px' }}>Setup Required</div>
          <p style={{ color: '#999', marginBottom: '15px' }}>
            Before you can start the bot, you need to configure your Discord credentials.
          </p>
          <p style={{ color: '#5865F2' }}>
            Go to the <strong>Credentials</strong> tab to complete the initial setup.
          </p>
        </div>
      )}

      <div className="grid">
        <div className="info-item">
          <span className="info-label">Status</span>
          <span className="info-value">{status.running ? 'Running' : 'Stopped'}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Uptime</span>
          <span className="info-value">{uptimeStr}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Process ID</span>
          <span className="info-value">{status.processId || 'N/A'}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Crashed</span>
          <span className="info-value">{status.crashed ? 'Yes' : 'No'}</span>
        </div>
      </div>

      <div style={{marginTop: '20px'}}>
        {!status.running && (
          <button
            onClick={onStart}
            className="btn btn-success"
            disabled={loading || !canStart}
            title={!canStart ? 'Configure credentials first' : ''}
            style={!canStart ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          >
            Start Bot
          </button>
        )}

        {status.running && (
          <>
            <button onClick={onRestart} className="btn btn-primary" disabled={loading}>
              Restart Bot
            </button>
            <button onClick={() => onShutdown(false)} className="btn btn-warning" disabled={loading}>
              Stop Bot
            </button>
            <button onClick={() => onShutdown(true)} className="btn btn-danger" disabled={loading}>
              Restart Container
            </button>
          </>
        )}
      </div>
    </div>
  );
}

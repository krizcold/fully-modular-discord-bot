// Bot Control Panel Component
function BotControlPanel({ status, onStart, onRestart, onShutdown, loading, configured, pendingContainerRestart, containerRestarting }) {
  const [restarting, setRestarting] = React.useState(false);

  if (!status) return null;

  const uptimeStr = status.uptime > 0
    ? `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m ${status.uptime % 60}s`
    : 'N/A';

  // Check if bot can be started (must be configured)
  const canStart = configured !== false;

  // Clear restarting state when bot comes back up
  React.useEffect(() => {
    if (restarting && status.running) {
      setRestarting(false);
    }
  }, [status.running, restarting]);

  async function handleRestart() {
    setRestarting(true);
    await onRestart(true); // skipConfirmation = true, we handle it here
  }

  const isBusy = loading || restarting;

  return (
    <div className="card">
      <h2>Bot Control</h2>

      {/* Pending Container Restart Banner */}
      {pendingContainerRestart && (
        <div style={{
          background: '#2d2000',
          border: '1px solid #f0a000',
          borderRadius: '8px',
          padding: '14px 18px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <span style={{ fontSize: '1.3em' }}>⚠</span>
          <span style={{ color: '#f0a000', fontSize: '0.9rem' }}>
            Changes pending — restart the container to apply newly installed modules or updates.
          </span>
        </div>
      )}

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
          <span className="info-value">{containerRestarting ? 'Container restarting...' : restarting ? 'Restarting...' : status.running ? 'Running' : 'Stopped'}</span>
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
        {containerRestarting ? (
          <button className="btn btn-danger" disabled>
            Container restarting...
          </button>
        ) : restarting ? (
          <button className="btn btn-primary" disabled>
            Restarting...
          </button>
        ) : !status.running ? (
          <button
            onClick={onStart}
            className="btn btn-success"
            disabled={isBusy || !canStart}
            title={!canStart ? 'Configure credentials first' : ''}
            style={!canStart ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          >
            Start Bot
          </button>
        ) : (
          <>
            <button onClick={handleRestart} className="btn btn-primary" disabled={isBusy}>
              Restart Bot
            </button>
            <button onClick={() => onShutdown(false)} className="btn btn-warning" disabled={isBusy}>
              Stop Bot
            </button>
            <button onClick={() => onShutdown(true)} className="btn btn-danger" disabled={isBusy}
              title={pendingContainerRestart ? 'Restart required to apply pending changes' : ''}
              style={pendingContainerRestart ? { animation: 'pulse 2s infinite' } : {}}
            >
              {pendingContainerRestart ? '⚠ ' : ''}Restart Container
            </button>
          </>
        )}
      </div>
    </div>
  );
}

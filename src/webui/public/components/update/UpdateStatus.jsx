// Update Status Component
function UpdateStatus({ api, status, onRefresh }) {
  const [loading, setLoading] = React.useState(false);
  const [updateMode, setUpdateMode] = React.useState('relative');
  const [showUpdateConfirm, setShowUpdateConfirm] = React.useState(false);
  const [updateInfo, setUpdateInfo] = React.useState(null);

  const updateModes = [
    { value: 'basic', label: 'Basic', description: 'Core infrastructure only (internalSetup, utils, types)' },
    { value: 'relative', label: 'Relative', description: 'Core + missing files (preserves existing modules)' },
    { value: 'full', label: 'Full', description: 'Complete replacement (resets all modules)' }
  ];

  const clearCrashHistory = async () => {
    if (!confirm('Are you sure you want to clear crash history? This will also disable safe mode.')) {
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/update/clear-crash-history');
      if (res.success) {
        alert('Crash history cleared');
        onRefresh();
      }
    } catch (error) {
      alert('Failed to clear crash history: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const checkForUpdates = async () => {
    setLoading(true);
    try {
      const result = await api.post('/update/check');

      if (result.success) {
        if (result.hasUpdates) {
          // Show update confirmation dialog with mode selection
          setUpdateInfo(result);
          setShowUpdateConfirm(true);
        } else {
          alert(result.message || 'System is up to date');
        }
      } else {
        alert(result.error || 'Failed to check for updates');
      }
    } catch (error) {
      alert('Failed to check for updates: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const triggerUpdate = async () => {
    setLoading(true);
    setShowUpdateConfirm(false);
    try {
      const updateResult = await api.post('/update/trigger', { mode: updateMode });
      if (updateResult.success) {
        alert('Update started! The system will restart shortly.');
        setTimeout(() => onRefresh(), 3000);
      } else {
        alert('Failed to trigger update: ' + (updateResult.error || 'Unknown error'));
      }
    } catch (error) {
      alert('Failed to trigger update: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  if (!status) return <div>Loading status...</div>;

  return (
    <div className="status-section">
      <div className="update-actions">
        <button
          className="btn btn-primary"
          onClick={checkForUpdates}
          disabled={loading}
        >
          🔍 Check for Updates
        </button>
        <button
          className="btn btn-secondary"
          onClick={onRefresh}
          disabled={loading}
        >
          🔄 Refresh Status
        </button>
      </div>

      <div className="status-grid">
        <div className="status-item">
          <strong>Bot Status:</strong>
          <span className={status.bot?.running ? 'status-running' : 'status-stopped'}>
            {status.bot?.running ? '🟢 Running' : '🔴 Stopped'}
          </span>
        </div>
        <div className="status-item">
          <strong>Safe Mode:</strong>
          <span className={status.safety?.safeMode ? 'status-warning' : 'status-ok'}>
            {status.safety?.safeMode ? '⚠️ Enabled' : '✅ Disabled'}
          </span>
        </div>
        <div className="status-item">
          <strong>Crash Count:</strong>
          <span>{status.safety?.crashHistory?.length || 0}</span>
        </div>
        <div className="status-item">
          <strong>Update Available:</strong>
          <span>{status.safety?.updateAvailable ? '🆕 Yes' : '✅ No'}</span>
        </div>
      </div>

      {status.safety?.crashHistory?.length > 0 && (
        <div className="crash-history">
          <h3>Recent Crashes</h3>
          <div className="crash-list">
            {status.safety.crashHistory.slice(-5).map((crash, i) => (
              <div key={i} className="crash-item">
                <span>{formatTimestamp(crash.timestamp)}</span>
                <span>Exit Code: {crash.exitCode}</span>
                {crash.signal && <span>Signal: {crash.signal}</span>}
              </div>
            ))}
          </div>
          <button
            className="btn btn-danger btn-sm"
            onClick={clearCrashHistory}
            disabled={loading}
          >
            Clear Crash History
          </button>
        </div>
      )}

      {showUpdateConfirm && (
        <div className="update-modal-overlay">
          <div className="update-modal">
            <h3>Update Available</h3>

            {updateInfo && (
              <div className="update-info">
                <p><strong>{updateInfo.message}</strong></p>
                {updateInfo.currentVersion && updateInfo.latestVersion && (
                  <p>
                    Current: <code>{updateInfo.currentVersion}</code> →
                    Latest: <code>{updateInfo.latestVersion}</code>
                  </p>
                )}
                {updateInfo.commitsBehind > 0 && (
                  <p>{updateInfo.commitsBehind} commit{updateInfo.commitsBehind > 1 ? 's' : ''} behind</p>
                )}
              </div>
            )}

            <div className="update-mode-selector">
              <label><strong>Update Mode:</strong></label>
              <div className="mode-options">
                {updateModes.map(mode => (
                  <label key={mode.value} className={`mode-option ${updateMode === mode.value ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="updateMode"
                      value={mode.value}
                      checked={updateMode === mode.value}
                      onChange={(e) => setUpdateMode(e.target.value)}
                    />
                    <div className="mode-content">
                      <span className="mode-label">{mode.label}</span>
                      <span className="mode-description">{mode.description}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="update-modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setShowUpdateConfirm(false)}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={triggerUpdate}
                disabled={loading}
              >
                {loading ? 'Updating...' : 'Start Update'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .update-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .update-modal {
          background: #2a2a2a;
          border-radius: 8px;
          padding: 1.5rem;
          max-width: 500px;
          width: 90%;
          border: 1px solid #444;
        }

        .update-modal h3 {
          margin: 0 0 1rem 0;
          color: #fff;
        }

        .update-info {
          background: #1a1a1a;
          padding: 1rem;
          border-radius: 4px;
          margin-bottom: 1rem;
        }

        .update-info p {
          margin: 0.5rem 0;
        }

        .update-info code {
          background: #333;
          padding: 0.2rem 0.4rem;
          border-radius: 3px;
          font-family: monospace;
        }

        .update-mode-selector {
          margin-bottom: 1.5rem;
        }

        .update-mode-selector > label {
          display: block;
          margin-bottom: 0.5rem;
          color: #ccc;
        }

        .mode-options {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .mode-option {
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
          padding: 0.75rem;
          background: #1a1a1a;
          border: 2px solid #333;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .mode-option:hover {
          border-color: #555;
        }

        .mode-option.selected {
          border-color: #007acc;
          background: rgba(0, 122, 204, 0.1);
        }

        .mode-option input[type="radio"] {
          margin-top: 0.25rem;
        }

        .mode-content {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .mode-label {
          font-weight: bold;
          color: #fff;
        }

        .mode-description {
          font-size: 0.85rem;
          color: #999;
        }

        .update-modal-actions {
          display: flex;
          gap: 0.75rem;
          justify-content: flex-end;
        }
      `}} />
    </div>
  );
}
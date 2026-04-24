// Update Status Component: Three-button layout (System / Modules / Everything)
function UpdateStatus({ api, status, onRefresh }) {
  const [loading, setLoading] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState(null);
  const [actionMessage, setActionMessage] = React.useState(null);

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
    setActionMessage(null);
    try {
      const result = await api.post('/update/check-all');
      if (result.success) {
        setCheckResult(result);
      } else {
        setActionMessage({ type: 'error', text: result.error || 'Failed to check for updates' });
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: 'Failed to check for updates: ' + error.message });
    } finally {
      setLoading(false);
    }
  };

  const pollForNewBuild = () => {
    const currentBuildId = window.BOT_BUILD?.buildId;
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/build-info.js?_=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;
        const text = await res.text();
        const match = text.match(/"buildId"\s*:\s*"([^"]+)"/);
        const newBuildId = match ? match[1] : null;
        if (newBuildId && newBuildId !== currentBuildId) {
          clearInterval(poll);
          clearTimeout(safety);
          window.location.reload();
        }
      } catch (_) { /* server down during rebuild, keep polling */ }
    }, 3000);
    const safety = setTimeout(() => clearInterval(poll), 10 * 60 * 1000);
  };

  const triggerSystemUpdate = async () => {
    if (!confirm('This will pull the latest code and restart the bot. Continue?')) return;
    setLoading(true);
    setActionMessage(null);
    try {
      const result = await api.post('/update/trigger');
      if (result.success) {
        setActionMessage({ type: 'success', text: 'System update started. This page will reload automatically when the new build is live.' });
        pollForNewBuild();
      } else {
        setActionMessage({ type: 'error', text: result.error || 'Failed to trigger system update' });
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: 'Failed to trigger system update: ' + error.message });
    } finally {
      setLoading(false);
    }
  };

  const triggerModuleUpdate = async () => {
    setLoading(true);
    setActionMessage(null);
    try {
      // Combined: download module files + hot-reload in one call
      const result = await api.post('/update/modules-and-reload');
      if (result.success) {
        const downloaded = result.download?.totalUpdated || 0;
        const reloaded = result.reload?.reloaded?.length || 0;
        setActionMessage({ type: 'success', text: `Updated ${downloaded} module(s), hot-reloaded ${reloaded}. No restart needed.` });
        // Re-check to refresh state
        const recheck = await api.post('/update/check-all');
        if (recheck.success) setCheckResult(recheck);
      } else {
        setActionMessage({ type: 'error', text: result.error || result.message || 'Failed to update modules' });
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: 'Failed to update modules: ' + error.message });
    } finally {
      setLoading(false);
    }
  };

  const triggerUpdateEverything = async () => {
    if (!confirm('This will update modules and then restart the bot with new system code. Continue?')) return;
    setLoading(true);
    setActionMessage(null);
    try {
      // Update modules first (download only; no hot-reload since we're restarting anyway)
      await api.post('/update/modules');
      // Then trigger system update (restart; modules will load fresh on boot)
      const result = await api.post('/update/trigger');
      if (result.success) {
        setActionMessage({ type: 'success', text: 'Modules updated. System update started; this page will reload when the new build is live.' });
        pollForNewBuild();
      } else {
        setActionMessage({ type: 'error', text: result.error || 'Module update succeeded but system update failed' });
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: 'Failed: ' + error.message });
    } finally {
      setLoading(false);
    }
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  if (!status) return <div>Loading status...</div>;

  const hasSystemUpdate = checkResult?.baseCode?.hasUpdates === true;
  const hasModuleUpdates = (checkResult?.modules?.updatesAvailable || 0) > 0;
  const modulesWithUpdates = checkResult?.modules?.updates?.filter(u => u.hasUpdate) || [];

  return (
    <div className="status-section">
      {/* Action message */}
      {actionMessage && (
        <div className={`action-message action-message-${actionMessage.type}`}>
          {actionMessage.text}
        </div>
      )}

      {/* Check + Refresh buttons */}
      <div className="update-actions">
        <button className="btn btn-primary" onClick={checkForUpdates} disabled={loading}>
          {loading ? 'Checking...' : 'Check for Updates'}
        </button>
        <button className="btn btn-secondary" onClick={onRefresh} disabled={loading}>
          Refresh Status
        </button>
      </div>

      {/* Status grid */}
      <div className="status-grid">
        <div className="status-item">
          <strong>Bot Status:</strong>
          <span className={status.bot?.running ? 'status-running' : 'status-stopped'}>
            {status.bot?.running ? 'Running' : 'Stopped'}
          </span>
        </div>
        <div className="status-item">
          <strong>Safe Mode:</strong>
          <span className={status.safety?.safeMode ? 'status-warning' : 'status-ok'}>
            {status.safety?.safeMode ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <div className="status-item">
          <strong>Crash Count:</strong>
          <span>{status.safety?.crashHistory?.length || 0}</span>
        </div>
      </div>

      {/* Combined update check results */}
      {checkResult && (
        <div className="update-check-results">
          <h3>Update Status</h3>

          {/* System section */}
          <div className={`update-section ${hasSystemUpdate ? 'has-updates' : 'up-to-date'}`}>
            <div className="update-section-header">
              <strong>System (Base Code)</strong>
              <span className={`update-badge ${hasSystemUpdate ? 'badge-warning' : 'badge-ok'}`}>
                {hasSystemUpdate ? `${checkResult.baseCode.commitsBehind || '?'} commits behind` : 'Up to date'}
              </span>
            </div>
            {hasSystemUpdate && <p className="update-note">Requires restart</p>}
          </div>

          {/* Modules section */}
          <div className={`update-section ${hasModuleUpdates ? 'has-updates' : 'up-to-date'}`}>
            <div className="update-section-header">
              <strong>Modules</strong>
              <span className={`update-badge ${hasModuleUpdates ? 'badge-warning' : 'badge-ok'}`}>
                {hasModuleUpdates ? `${checkResult.modules.updatesAvailable} update(s)` : checkResult.modules.totalInstalled === 0 ? 'None installed' : 'Up to date'}
              </span>
            </div>
            {modulesWithUpdates.length > 0 && (
              <ul className="module-update-list">
                {modulesWithUpdates.map(mod => (
                  <li key={mod.moduleName}>
                    <span className="module-name">{mod.moduleName}</span>
                    <span className="module-versions">{mod.installedVersion} &rarr; {mod.availableVersion}</span>
                  </li>
                ))}
              </ul>
            )}
            {hasModuleUpdates && <p className="update-note">Hot-reload (no restart needed)</p>}
          </div>

          <p className="custom-modules-note">Custom modules (modulesDev/) are never affected by updates.</p>

          {/* Update action buttons */}
          <div className="update-action-buttons">
            <button
              className="btn btn-primary"
              onClick={triggerSystemUpdate}
              disabled={loading || !hasSystemUpdate}
              title={hasSystemUpdate ? 'Pull latest code and restart' : 'No system update available'}
            >
              Update System
            </button>
            <button
              className="btn btn-success"
              onClick={triggerModuleUpdate}
              disabled={loading || !hasModuleUpdates}
              title={hasModuleUpdates ? 'Update modules (no restart)' : 'No module updates available'}
            >
              Update Modules
            </button>
            <button
              className="btn btn-secondary"
              onClick={triggerUpdateEverything}
              disabled={loading || !(hasSystemUpdate && hasModuleUpdates)}
              title={hasSystemUpdate && hasModuleUpdates ? 'Update modules then restart with new system code' : 'Both system and module updates required'}
            >
              Update Everything
            </button>
          </div>
        </div>
      )}

      {/* Crash history */}
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

      <style dangerouslySetInnerHTML={{__html: `
        .action-message {
          padding: 0.75rem 1rem;
          border-radius: 6px;
          margin-bottom: 1rem;
          font-size: 0.9rem;
        }
        .action-message-success {
          background: rgba(46, 204, 113, 0.15);
          border: 1px solid rgba(46, 204, 113, 0.3);
          color: #2ecc71;
        }
        .action-message-error {
          background: rgba(231, 76, 60, 0.15);
          border: 1px solid rgba(231, 76, 60, 0.3);
          color: #e74c3c;
        }
        .update-check-results {
          margin-top: 1rem;
        }
        .update-check-results h3 {
          margin: 0 0 0.75rem 0;
          color: #fff;
          font-size: 1rem;
        }
        .update-section {
          background: #1a1a1a;
          border-radius: 6px;
          padding: 0.75rem 1rem;
          margin-bottom: 0.5rem;
          border-left: 3px solid #444;
        }
        .update-section.has-updates {
          border-left-color: #e67e22;
        }
        .update-section.up-to-date {
          border-left-color: #2ecc71;
        }
        .update-section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .update-badge {
          font-size: 0.8rem;
          padding: 0.15rem 0.5rem;
          border-radius: 10px;
        }
        .badge-warning {
          background: rgba(230, 126, 34, 0.2);
          color: #e67e22;
        }
        .badge-ok {
          background: rgba(46, 204, 113, 0.2);
          color: #2ecc71;
        }
        .update-note {
          margin: 0.25rem 0 0 0;
          font-size: 0.78rem;
          color: #888;
        }
        .module-update-list {
          list-style: none;
          padding: 0;
          margin: 0.5rem 0 0 0;
        }
        .module-update-list li {
          display: flex;
          justify-content: space-between;
          padding: 0.25rem 0;
          font-size: 0.85rem;
          color: #ccc;
        }
        .module-name {
          font-weight: 500;
        }
        .module-versions {
          color: #888;
          font-family: monospace;
          font-size: 0.8rem;
        }
        .custom-modules-note {
          font-size: 0.78rem;
          color: #666;
          margin: 0.5rem 0 1rem 0;
          font-style: italic;
        }
        .update-action-buttons {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .update-action-buttons .btn {
          flex: 1;
          min-width: 120px;
        }
        .btn-success {
          background: #2ecc71;
          color: #fff;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          cursor: pointer;
        }
        .btn-success:hover:not(:disabled) {
          background: #27ae60;
        }
        .btn-success:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}} />
    </div>
  );
}

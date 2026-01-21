// Update Backups Component
function UpdateBackups({ api, backups, onRefresh }) {
  const [loading, setLoading] = React.useState(false);

  const createBackup = async () => {
    const description = prompt('Enter backup description (optional):');
    setLoading(true);
    try {
      const res = await api.post('/update/backup', { description });
      if (res.success) {
        alert('Backup created successfully');
        onRefresh();
      }
    } catch (error) {
      alert('Failed to create backup: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const restoreBackup = async (timestamp) => {
    if (!confirm('Are you sure you want to restore from this backup? Current source will be replaced.')) {
      return;
    }
    setLoading(true);
    try {
      const res = await api.post(`/update/rollback/${timestamp}`);
      if (res.success) {
        alert(res.message || 'Rollback successful');
        onRefresh();
      }
    } catch (error) {
      alert('Failed to restore backup: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteBackup = async (timestamp) => {
    if (!confirm('Are you sure you want to delete this backup?')) {
      return;
    }
    setLoading(true);
    try {
      const res = await api.delete(`/update/backup/${timestamp}`);
      if (res.success) {
        onRefresh();
      }
    } catch (error) {
      alert('Failed to delete backup: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  return (
    <div className="backups-section">
      <div className="backups-header">
        <button
          className="btn btn-primary"
          onClick={createBackup}
          disabled={loading}
        >
          ➕ Create Backup
        </button>
        <button
          className="btn btn-sm"
          onClick={onRefresh}
          disabled={loading}
        >
          🔄 Refresh
        </button>
        {loading && <span className="loading-indicator">Loading...</span>}
      </div>

      <div className="backups-list">
        {backups.length === 0 ? (
          <div className="no-backups">No backups available</div>
        ) : (
          backups.map(backup => (
            <div key={backup.timestamp} className="backup-item">
              <div className="backup-info">
                <div className="backup-header">
                  <strong>{backup.description}</strong>
                  <span className={`backup-type ${backup.type}`}>
                    {backup.type === 'automatic' ? '🤖 Auto' : '👤 Manual'}
                  </span>
                </div>
                <div className="backup-details">
                  <span>📅 {formatTimestamp(backup.timestamp)}</span>
                  <span>📦 Version: {backup.version}</span>
                  <span>💾 Size: {formatBytes(backup.size)}</span>
                  {backup.updateMode && <span>🔄 Mode: {backup.updateMode}</span>}
                </div>
              </div>
              <div className="backup-actions">
                <button
                  className="btn btn-sm btn-warning"
                  onClick={() => restoreBackup(backup.timestamp)}
                  disabled={loading}
                >
                  ↩️ Restore
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => deleteBackup(backup.timestamp)}
                  disabled={loading}
                >
                  🗑️ Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
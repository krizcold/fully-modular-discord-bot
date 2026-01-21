// Main Update Panel Component - Modularized
function UpdatePanel({ api, wsClient }) {
  const [status, setStatus] = React.useState(null);
  const [backups, setBackups] = React.useState([]);
  const [activeSection, setActiveSection] = React.useState('status');

  /**
   * Load update status and backups
   */
  const loadData = React.useCallback(async () => {
    try {
      // Load status
      const statusRes = await api.get('/update/status');
      if (statusRes.success) {
        setStatus(statusRes);
      }

      // Load backups
      const backupsRes = await api.get('/update/backups');
      if (backupsRes.success) {
        setBackups(backupsRes.backups || []);
      }
    } catch (error) {
      console.error('Error loading update data:', error);
    }
  }, [api]);

  // Load data on mount
  React.useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="card update-panel">
      <h2>🔧 Update Management</h2>

      <div className="section-tabs">
        <button
          className={`tab ${activeSection === 'status' ? 'active' : ''}`}
          onClick={() => setActiveSection('status')}
        >
          📊 Status
        </button>
        <button
          className={`tab ${activeSection === 'backups' ? 'active' : ''}`}
          onClick={() => setActiveSection('backups')}
        >
          💾 Backups ({backups.length})
        </button>
      </div>

      <div className="section-content">
        {activeSection === 'status' && (
          <UpdateStatus
            api={api}
            status={status}
            onRefresh={loadData}
          />
        )}

        {activeSection === 'backups' && (
          <UpdateBackups
            api={api}
            backups={backups}
            onRefresh={loadData}
          />
        )}
      </div>
    </div>
  );
}
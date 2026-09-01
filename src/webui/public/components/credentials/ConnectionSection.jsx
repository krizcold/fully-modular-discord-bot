// Co-worker Connection page: the only locally-editable settings on a fleet
// co-worker (everything else mirrors the master via sync). Posts to
// /api/setup/credentials; the server accepts connection fields only.
function ConnectionSection({ setupStatus, isBotRunning, onUpdate, onUpdateAndRestart }) {
  const { useState, useEffect, useMemo } = React;

  const EMPTY_FIELDS = {
    DISCORD_TOKEN: '',
    MASTER_URLS: '',
    CONTROL_SECRET: '',
    NODE_NAME: '',
    FLEET_SHARD_CAPACITY: '',
    BOT_NODE_ROLE: 'co-worker',
  };
  const SECRET_FIELDS = ['DISCORD_TOKEN', 'CONTROL_SECRET'];

  const [fields, setFields] = useState({ ...EMPTY_FIELDS });
  const [baseline, setBaseline] = useState({ ...EMPTY_FIELDS });
  const [loading, setLoading] = useState(false);
  const [selfUrlCopied, setSelfUrlCopied] = useState(false);

  const connection = setupStatus?.connection || {};

  useEffect(() => {
    const loaded = {
      ...EMPTY_FIELDS,
      // Secrets never come back from the server; non-secrets show current values.
      MASTER_URLS: connection.MASTER_URLS || '',
      NODE_NAME: connection.NODE_NAME || '',
      FLEET_SHARD_CAPACITY: connection.FLEET_SHARD_CAPACITY || '',
      BOT_NODE_ROLE: connection.BACKUP_MASTER === '1' ? 'backup-master' : 'co-worker',
    };
    setFields(prev => {
      const overlay = {};
      for (const key of Object.keys(prev)) {
        if (prev[key] !== baseline[key]) overlay[key] = prev[key];
      }
      return { ...loaded, ...overlay };
    });
    setBaseline(loaded);
  }, [setupStatus]);

  const handleChange = (key, value) => setFields(prev => ({ ...prev, [key]: value }));

  function fieldDirty(key) {
    if (SECRET_FIELDS.includes(key)) return !!fields[key] && fields[key].trim() !== '';
    return fields[key] !== baseline[key];
  }

  const dirtyFields = useMemo(
    () => Object.keys(fields).filter(fieldDirty),
    [fields, baseline]
  );
  const hasAnyChanges = dirtyFields.length > 0;
  const saveDisabled = loading || !hasAnyChanges;

  async function handleSave(andRestart = false) {
    setLoading(true);
    try {
      const res = await api.post('/setup/credentials', fields);
      if (res.success) {
        showToast('Connection settings saved. Restart the bot to apply.', 'success');
        if (andRestart) {
          await onUpdateAndRestart();
        } else {
          await onUpdate();
        }
      } else {
        showToast(res.error || 'Failed to save connection settings', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  const maskedPlaceholder = (isSet) => (isSet ? 'Set (leave blank to keep)' : 'Not set');

  return (
    <div className="credentials-panel">
      <div className="credentials-header">
        <h2>Connection</h2>
        <p style={{ color: '#999', marginBottom: '20px' }}>
          This node is a fleet co-worker. Modules, App Store state, config and
          global settings are synced from the master; only the connection
          settings below are edited here.
        </p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); handleSave(false); }}>
        <div className="credentials-section">
          <div className="credentials-form">
            <h3 style={{ marginBottom: '20px', color: '#5865F2' }}>Fleet Connection</h3>

            <div className="form-group">
              <label>
                <StatusIndicator isSet={!!connection.DISCORD_TOKEN_SET} />
                Discord Bot Token
              </label>
              <input
                type="password"
                value={fields.DISCORD_TOKEN || ''}
                onChange={e => handleChange('DISCORD_TOKEN', e.target.value)}
                placeholder={maskedPlaceholder(connection.DISCORD_TOKEN_SET)}
              />
              <small>Must be the same bot token as the master</small>
            </div>

            <div className="form-group">
              <label>
                <StatusIndicator isSet={fields.BOT_NODE_ROLE === 'backup-master'} optional />
                Fleet Role
              </label>
              <select
                value={fields.BOT_NODE_ROLE || 'co-worker'}
                onChange={e => handleChange('BOT_NODE_ROLE', e.target.value)}
              >
                <option value="co-worker">Co-worker</option>
                <option value="backup-master">Backup Master</option>
              </select>
              <small>Backup Master adds the Promote button on this node (postgres mode), so it can take over when the master dies</small>
            </div>

            {fields.BOT_NODE_ROLE === 'backup-master' && connection.SELF_URL && (
              <div className="form-group">
                <label>This Node's URL</label>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={connection.SELF_URL}
                    readOnly
                    style={{ flex: 1, background: '#2a2a2a', opacity: 0.9 }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ marginRight: 0 }}
                    onClick={() => {
                      navigator.clipboard.writeText(connection.SELF_URL);
                      setSelfUrlCopied(true);
                      setTimeout(() => setSelfUrlCopied(false), 2000);
                    }}
                  >
                    {selfUrlCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <small>Add it to every worker's Master Candidates, after the master's, so a failover to this node needs no rewiring. Each node skips its own URL, so one list works everywhere</small>
              </div>
            )}

            <div className="form-group">
              <label>
                <StatusIndicator isSet={!!(connection.MASTER_URLS && connection.MASTER_URLS !== '')} />
                Master Candidates
              </label>
              <input
                type="text"
                value={fields.MASTER_URLS || ''}
                onChange={e => handleChange('MASTER_URLS', e.target.value)}
                placeholder="wss://master...,wss://backup... (ordered, comma-separated)"
              />
              <small>Ordered list tried on reconnect, the master first. Copy from the master's Usage tab (Connect a worker); list every promotable node so failover needs no reconfiguration</small>
            </div>

            <div className="form-group">
              <label>
                <StatusIndicator isSet={!!connection.CONTROL_SECRET_SET} />
                Control Secret
              </label>
              <input
                type="password"
                value={fields.CONTROL_SECRET || ''}
                onChange={e => handleChange('CONTROL_SECRET', e.target.value)}
                placeholder={maskedPlaceholder(connection.CONTROL_SECRET_SET)}
              />
              <small>Must match the master's CONTROL_SECRET</small>
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label>
                  <StatusIndicator isSet={!!(connection.NODE_NAME && connection.NODE_NAME !== '')} optional />
                  Node Name (Optional)
                </label>
                <input
                  type="text"
                  value={fields.NODE_NAME || ''}
                  onChange={e => handleChange('NODE_NAME', e.target.value)}
                  placeholder="Defaults to the hostname"
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>
                  <StatusIndicator isSet={!!(connection.FLEET_SHARD_CAPACITY && connection.FLEET_SHARD_CAPACITY !== '')} optional />
                  Shard Capacity (Optional)
                </label>
                <input
                  type="text"
                  value={fields.FLEET_SHARD_CAPACITY || ''}
                  onChange={e => handleChange('FLEET_SHARD_CAPACITY', e.target.value)}
                  placeholder="1"
                />
                <small>Max shards this node will serve</small>
              </div>
            </div>
          </div>

          <div className="credentials-instructions">
            <h3 style={{
              color: '#5865F2',
              marginBottom: '15px',
              paddingBottom: '10px',
              borderBottom: '1px solid #333'
            }}>
              Co-worker Node
            </h3>
            <p style={{ color: '#999', fontSize: '0.9rem', lineHeight: 1.6 }}>
              A co-worker registers with its master over the control channel,
              waits for a shard lease, and mirrors the master's modules and
              configuration before loading anything. App Store, Dev Modules,
              global config and credentials are managed on the master's Web-UI.
            </p>
            <p style={{ color: '#999', fontSize: '0.9rem', lineHeight: 1.6 }}>
              Changes here apply on the next bot restart.
            </p>
          </div>
        </div>

        <div className="credentials-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saveDisabled}
            style={disabledButtonStyle(saveDisabled)}
            title={!hasAnyChanges ? 'No changes to save' : undefined}
          >
            {loading ? 'Saving…' : 'Save Changes'}
          </button>
          <button
            type="button"
            onClick={() => handleSave(true)}
            className="btn btn-success"
            disabled={loading || !hasAnyChanges}
            style={disabledButtonStyle(loading || !hasAnyChanges)}
          >
            {isBotRunning ? 'Save & Restart Bot' : 'Save & Start Bot'}
          </button>
        </div>
      </form>
    </div>
  );
}

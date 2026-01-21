// Config Panel Component
function ConfigPanel() {
  const { useState, useEffect } = React;

  const [configFiles, setConfigFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('config.json');
  const [selectedFileType, setSelectedFileType] = useState('config'); // 'config' or 'data'
  const [config, setConfig] = useState(null);
  const [configText, setConfigText] = useState('');
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [jsonError, setJsonError] = useState(null);
  const [initialized, setInitialized] = useState(true);
  const [initMessage, setInitMessage] = useState('');
  const [guildContext, setGuildContext] = useState('system');
  const [guildContextOptions, setGuildContextOptions] = useState([]);

  useEffect(() => {
    loadGuildContextOptions();
  }, []);

  useEffect(() => {
    if (guildContextOptions.length > 0) {
      loadConfigFiles();
    }
  }, [guildContext, guildContextOptions]);

  useEffect(() => {
    if (selectedFile) {
      loadConfig(selectedFile);
      loadBackups(selectedFile);
    }
  }, [selectedFile]);

  async function loadGuildContextOptions() {
    try {
      const res = await api.get('/setup/status');
      if (res.success && res.guildIds) {
        const testGuildId = res.guildIds.GUILD_ID;
        const mainGuildId = res.guildIds.MAIN_GUILD_ID;

        const options = [];

        // System context (no guild)
        options.push({
          value: 'system',
          label: 'System Config',
          guildId: null
        });

        // Test guild
        if (testGuildId) {
          options.push({
            value: 'test',
            label: `Test Guild [${testGuildId}]`,
            guildId: testGuildId
          });
        }

        // Main guild (only if different from test)
        if (mainGuildId && mainGuildId !== testGuildId) {
          options.push({
            value: 'main',
            label: `Main Guild [${mainGuildId}]`,
            guildId: mainGuildId
          });
        }

        setGuildContextOptions(options);

        // Default to system context
        setGuildContext('system');
      }
    } catch (err) {
      console.error('Failed to load guild context options:', err);
    }
  }

  async function loadConfigFiles() {
    try {
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      const res = await api.get(`/config/list${guildId ? `?guildId=${guildId}` : ''}`);
      if (res.success) {
        setConfigFiles(res.files);
        setError(null);
      } else {
        setError(res.error || 'Failed to load config files');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadConfig(fileId) {
    // Guard against null/undefined fileId
    if (!fileId) {
      setConfig(null);
      setConfigText('');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      const selectedInfo = configFiles.find(f => f.id === fileId);
      const isDataFile = selectedInfo?.category === 'data';

      // Use different endpoint based on file type
      const endpoint = isDataFile
        ? `/config/data/get?file=${encodeURIComponent(fileId)}${guildId ? `&guildId=${guildId}` : ''}`
        : `/config/get?file=${encodeURIComponent(fileId)}${guildId ? `&guildId=${guildId}` : ''}`;

      const res = await api.get(endpoint);

      if (res.success) {
        const content = isDataFile ? res.data : res.config;
        setConfig(content);
        setConfigText(JSON.stringify(content, null, 2));
        setInitialized(res.initialized !== false || res.exists !== false);
        setInitMessage(res.message || '');
        setError(null);
      } else {
        setError(res.error || 'Failed to load file');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadBackups(fileId) {
    try {
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      const res = await api.get(`/config/backups?file=${encodeURIComponent(fileId)}${guildId ? `&guildId=${guildId}` : ''}`);
      if (res.success) {
        setBackups(res.backups);
      }
    } catch (err) {
      console.error('Failed to load backups:', err);
    }
  }

  function handleConfigChange(text) {
    setConfigText(text);

    // Validate JSON
    try {
      JSON.parse(text);
      setJsonError(null);
    } catch (e) {
      setJsonError(e.message);
    }
  }

  async function handleSave() {
    if (jsonError) {
      setError('Cannot save: JSON is invalid');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const parsedConfig = JSON.parse(configText);
      const selectedInfo = configFiles.find(f => f.id === selectedFile);
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;
      const isDataFile = selectedInfo?.category === 'data';

      // For config files with schemas, filter out defaults
      // For data files, save as-is (no filtering)
      let dataToSave = parsedConfig;
      if (!isDataFile && selectedInfo?.moduleName && selectedInfo?.schema) {
        dataToSave = {};

        // Only include values that differ from schema defaults
        for (const [key, value] of Object.entries(parsedConfig)) {
          const defaultValue = selectedInfo.default?.[key];
          if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
            dataToSave[key] = value;
          }
        }

        // If all values are defaults, save empty object
        if (Object.keys(dataToSave).length === 0) {
          dataToSave = {};
        }
      }

      // Use different endpoint and payload based on file type
      const endpoint = isDataFile ? '/config/data/update' : '/config/update';
      const payload = isDataFile
        ? { file: selectedFile, data: dataToSave, guildId }
        : { file: selectedFile, config: dataToSave, guildId };

      const res = await api.post(endpoint, payload);

      if (res.success) {
        let message;
        if (isDataFile) {
          message = 'Data file saved successfully.';
        } else if (selectedInfo?.moduleName) {
          message = 'Module config saved (only overrides stored).';
        } else {
          message = 'Config saved successfully.';
        }
        setSuccess(message + ' Backup created.');
        setConfig(parsedConfig); // Keep full config in state
        setInitialized(true);
        setInitMessage('');
        await loadBackups(selectedFile);

        // For module configs, reload to get merged config
        if (!isDataFile && selectedInfo?.moduleName) {
          await loadConfig(selectedFile);
        }
      } else {
        setError(res.error || 'Failed to save file');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRestore(filename) {
    if (!confirm(`Restore config from backup "${filename}"?`)) return;

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      const res = await api.post('/config/restore', {
        file: selectedFile,
        filename,
        guildId: guildId
      });

      if (res.success) {
        setSuccess('Config restored successfully');
        await loadConfig(selectedFile);
        await loadBackups(selectedFile);
      } else {
        setError(res.error || 'Failed to restore config');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !config) {
    return <div className="loading">Loading config...</div>;
  }

  const selectedFileInfo = configFiles.find(f => f.id === selectedFile);

  return (
    <div>
      <div className="card">
        <h2>⚙️ Config Editor</h2>
        <p style={{marginBottom: '15px', color: '#999'}}>
          Edit bot configuration files. Changes are automatically backed up.
        </p>

        {error && <div className="error-message">{error}</div>}
        {success && <div className="success-message">{success}</div>}

        {!initialized && initMessage && (
          <div style={{
            background: '#FAA61A',
            color: '#1a1a1a',
            padding: '12px',
            borderRadius: '5px',
            marginBottom: '15px',
            fontWeight: '600'
          }}>
            ℹ️ {initMessage}
          </div>
        )}

        {/* Guild Context Selector */}
        {guildContextOptions.length > 1 && (
          <div className="form-group" style={{marginBottom: '20px'}}>
            <label>Guild Context</label>
            <select
              value={guildContext}
              onChange={e => setGuildContext(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                background: '#1a1a1a',
                border: '2px solid #5865F2',
                borderRadius: '5px',
                color: '#e0e0e0',
                fontSize: '1rem',
                cursor: 'pointer'
              }}
            >
              {guildContextOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* File Type Selector */}
        <div className="tabs" style={{ marginBottom: '10px' }}>
          <button
            className={`tab ${selectedFileType === 'config' ? 'active' : ''}`}
            onClick={() => {
              setSelectedFileType('config');
              const configFile = configFiles.find(f => f.category === 'config');
              if (configFile) {
                setSelectedFile(configFile.id);
              } else {
                setSelectedFile(null);
                setConfig(null);
                setConfigText('');
                setError('No config files available for this context');
              }
            }}
          >
            Config Files
          </button>
          <button
            className={`tab ${selectedFileType === 'data' ? 'active' : ''}`}
            onClick={() => {
              setSelectedFileType('data');
              const dataFile = configFiles.find(f => f.category === 'data');
              if (dataFile) {
                setSelectedFile(dataFile.id);
              } else {
                setSelectedFile(null);
                setConfig(null);
                setConfigText('');
                setError('No data files available for this context');
              }
            }}
          >
            Data Files
          </button>
        </div>

        {/* Single Filtered Dropdown */}
        <div className="form-group" style={{marginBottom: '20px'}}>
          <label>{selectedFileType === 'config' ? 'Config Files' : 'Data Files'}</label>
          <select
            value={selectedFile}
            onChange={e => setSelectedFile(e.target.value)}
            style={{
              width: '100%',
              padding: '10px',
              background: '#1a1a1a',
              border: selectedFileType === 'data' ? '2px solid #3498DB' : '2px solid #5865F2',
              borderRadius: '5px',
              color: '#e0e0e0',
              fontSize: '1rem',
              cursor: 'pointer'
            }}
          >
            {configFiles.filter(f => f.category === selectedFileType).map(file => (
              <option key={file.id} value={file.id}>
                {file.name} {file.exists ? '✓' : '✗'}
              </option>
            ))}
          </select>
        </div>

        {selectedFileInfo && (
          <div style={{
            marginBottom: '15px',
            padding: '10px',
            background: '#1a1a1a',
            borderRadius: '4px',
            borderLeft: selectedFileInfo.category === 'data'
              ? '3px solid #3498DB'
              : selectedFileInfo.moduleName
              ? '3px solid #FAA61A'
              : '3px solid #5865F2'
          }}>
            <div style={{color: '#e0e0e0', fontSize: '0.95rem', marginBottom: '4px'}}>
              <strong>{selectedFileInfo.name}</strong>
              <span style={{
                marginLeft: '10px',
                padding: '2px 8px',
                background: selectedFileInfo.category === 'data' ? '#3498DB' : '#5865F2',
                color: '#fff',
                borderRadius: '3px',
                fontSize: '0.8rem',
                fontWeight: 'bold'
              }}>
                {selectedFileInfo.category === 'data' ? 'DATA' : 'CONFIG'}
              </span>
              {selectedFileInfo.moduleName && (
                <span style={{
                  marginLeft: '5px',
                  padding: '2px 8px',
                  background: '#FAA61A',
                  color: '#1a1a1a',
                  borderRadius: '3px',
                  fontSize: '0.8rem',
                  fontWeight: 'bold'
                }}>
                  Module: {selectedFileInfo.moduleName}
                </span>
              )}
            </div>
            <div style={{color: '#999', fontSize: '0.85rem'}}>
              {selectedFileInfo.description}
            </div>
            {selectedFileInfo.category === 'config' && !selectedFileInfo.exists && selectedFileInfo.schema && (
              <div style={{
                color: '#FAA61A',
                fontSize: '0.85rem',
                marginTop: '6px',
                fontStyle: 'italic'
              }}>
                📋 Using schema defaults - Save to create override file
              </div>
            )}
            {selectedFileInfo.category === 'data' && !selectedFileInfo.exists && selectedFileInfo.template && (
              <div style={{
                color: '#3498DB',
                fontSize: '0.85rem',
                marginTop: '6px',
                fontStyle: 'italic'
              }}>
                📋 Using template defaults - Save to create data file
              </div>
            )}
            <div style={{color: '#666', fontSize: '0.8rem', marginTop: '4px', fontFamily: 'monospace'}}>
              {selectedFileInfo.path}
            </div>
          </div>
        )}

        <div className="form-group">
          <label>Configuration (JSON)</label>
          <textarea
            value={configText}
            onChange={e => handleConfigChange(e.target.value)}
            style={{
              width: '100%',
              minHeight: '400px',
              padding: '12px',
              background: '#1a1a1a',
              border: jsonError ? '2px solid #F04747' : '1px solid #444',
              borderRadius: '5px',
              color: '#e0e0e0',
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: '0.9rem',
              resize: 'vertical'
            }}
          />
          {jsonError && (
            <small style={{color: '#F04747', display: 'block', marginTop: '5px'}}>
              ⚠️ JSON Error: {jsonError}
            </small>
          )}
        </div>

        <button
          onClick={handleSave}
          className="btn btn-primary"
          disabled={saving || !!jsonError}
        >
          {saving ? 'Saving...' : '💾 Save Config'}
        </button>
      </div>

      <div className="card">
        <h3>📦 Backups</h3>
        <p style={{marginBottom: '15px', color: '#999', fontSize: '0.9rem'}}>
          Backups are created automatically when saving. Last 10 backups are kept.
        </p>

        {backups.length === 0 ? (
          <div style={{color: '#999', fontSize: '0.9rem'}}>No backups available</div>
        ) : (
          <div style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
            {backups.map(backup => (
              <div key={backup.filename} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px',
                background: '#1a1a1a',
                borderRadius: '4px',
                border: '1px solid #333'
              }}>
                <div>
                  <div style={{color: '#e0e0e0', fontSize: '0.9rem'}}>{backup.filename}</div>
                  <div style={{color: '#999', fontSize: '0.8rem'}}>
                    {new Date(backup.timestamp).toLocaleString()} • {(backup.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button
                  onClick={() => handleRestore(backup.filename)}
                  className="btn btn-warning"
                  style={{marginRight: 0}}
                  disabled={loading}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

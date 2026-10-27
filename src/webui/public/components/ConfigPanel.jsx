// Config Panel Component. On a co-worker node the system/global context is
// read-only (synced from the master); guild contexts list this node's owned
// guilds and stay editable.
// A file's row key: data files are module-qualified, since two modules may
// each hold an x.json; config ids are unique.
function configFileKey(file) {
  return file.category === 'data' && file.moduleName ? `${file.moduleName}/${file.id}` : file.id;
}

function ConfigPanel({ isCoWorker }) {
  const { useState, useEffect, useRef } = React;

  const [configFiles, setConfigFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('config.json');
  const [selectedFileType, setSelectedFileType] = useState('config'); // 'config' or 'data'
  const [config, setConfig] = useState(null);
  const [configText, setConfigText] = useState('');
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  function setError(msg) { if (msg) showToast(msg, 'error'); }
  function setSuccess(msg) { if (msg) showToast(msg, 'success'); }
  const [jsonError, setJsonError] = useState(null);
  const [initialized, setInitialized] = useState(true);
  const [initMessage, setInitMessage] = useState('');
  const [guildContext, setGuildContext] = useState('system');
  const [guildContextOptions, setGuildContextOptions] = useState([]);
  const [booting, setBooting] = useState(true);
  const [listing, setListing] = useState(false);
  // The list load the file list came from ({ ctx, seq }), and the load the
  // editor content came from ({ fileKey, guildId, ctx, seq }): a Save or
  // Restore writes only to the file and guild its content was loaded from.
  const [filesStamp, setFilesStamp] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const seqRef = useRef(0);
  const latestList = useRef(null);
  const latestLoad = useRef(null);
  const latestBackups = useRef(null);
  // The selection as of the last render, for answers that arrive later.
  const selRef = useRef({});
  selRef.current = { file: selectedFile, ctx: guildContext, type: selectedFileType };

  const guildIdOf = ctx => guildContextOptions.find(o => o.value === ctx)?.guildId || null;
  const findFile = (files, key) => files.find(f => configFileKey(f) === key);

  useEffect(() => {
    loadGuildContextOptions();
  }, []);

  useEffect(() => {
    if (guildContextOptions.length > 0) {
      // The previous context's list says nothing about this one.
      clearEditor();
      setConfigFiles([]);
      loadConfigFiles(guildContext);
    }
  }, [guildContext, guildContextOptions]);

  // A new file list (a context switch, or the re-read after a save) or a new
  // selection reloads the selected file and its backups.
  useEffect(() => {
    if (!filesStamp || filesStamp.ctx !== guildContext) return;
    if (selectedFile) {
      loadConfig(selectedFile);
      loadBackups(selectedFile);
    }
  }, [selectedFile, filesStamp]);

  function clearEditor() {
    latestLoad.current = null;
    latestBackups.current = null;
    setLoaded(null);
    setConfig(null);
    setConfigText('');
    setJsonError(null);
    setBackups([]);
    setLoading(false);
    setLoadFailed(false);
  }

  async function loadGuildContextOptions() {
    if (isCoWorker) {
      // Owned guilds from this node's fleet state: that is the co-worker's
      // own-guilds data browser (config routes take arbitrary guildIds).
      const options = [{ value: 'system', label: 'System Config (synced from master)', guildId: null }];
      try {
        const fleetRes = await api.get('/fleet/state');
        const guildMap = (fleetRes && fleetRes.guildMap) || {};
        for (const guildId of Object.keys(guildMap).sort()) {
          options.push({ value: `guild:${guildId}`, label: `Guild [${guildId}]`, guildId });
        }
      } catch (err) {
        console.error('Failed to load owned guilds:', err);
      }
      setGuildContextOptions(options);
      setGuildContext('system');
      setBooting(false);
      return;
    }
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
        setBooting(false);
        return;
      }
    } catch (err) {
      console.error('Failed to load guild context options:', err);
    }
    // The guild ids are unknown: the system context still works.
    setGuildContextOptions([{ value: 'system', label: 'System Config', guildId: null }]);
    setGuildContext('system');
    setBooting(false);
  }

  // Each load takes a stamp and lands only while it is the latest of its kind,
  // so a late answer never replaces a newer one or lands under another file.
  async function loadConfigFiles(ctx) {
    const stamp = { ctx, seq: ++seqRef.current };
    latestList.current = stamp;
    setListing(true);
    setListFailed(false);
    // A failed list shows no file at all, so nothing stale stays on screen to save or delete.
    const failed = message => {
      setConfigFiles([]);
      clearEditor();
      setListFailed(true);
      setError(message);
    };
    try {
      const guildId = guildIdOf(ctx);
      const res = await api.get(`/config/list${guildId ? `?guildId=${guildId}` : ''}`);
      if (latestList.current !== stamp) return null;
      if (res.success) {
        setConfigFiles(res.files);
        const selected = selRef.current.file;
        if (!selected || !findFile(res.files, selected)) {
          const first = res.files.find(f => f.category === selRef.current.type);
          setSelectedFile(first ? configFileKey(first) : null);
          if (!first) clearEditor();
        }
        setFilesStamp(stamp);
        return res.files;
      }
      failed(res.error || 'Failed to load config files');
    } catch (err) {
      if (latestList.current === stamp) failed(err.message);
    } finally {
      if (latestList.current === stamp) setListing(false);
    }
    return null;
  }

  async function loadConfig(fileKey) {
    const guildId = guildIdOf(guildContext);
    const stamp = { fileKey, guildId, ctx: guildContext, seq: ++seqRef.current };
    latestLoad.current = stamp;
    setLoaded(null);
    setConfig(null);
    setConfigText('');
    setJsonError(null);
    setLoadFailed(false);
    setLoading(true);
    try {
      const selectedInfo = findFile(configFiles, fileKey);
      const isDataFile = selectedInfo?.category === 'data';

      // Use different endpoint based on file type
      const endpoint = isDataFile
        ? `/config/data/get?file=${encodeURIComponent(fileKey)}${guildId ? `&guildId=${guildId}` : ''}`
        : `/config/get?file=${encodeURIComponent(fileKey)}${guildId ? `&guildId=${guildId}` : ''}`;

      const res = await api.get(endpoint);
      if (latestLoad.current !== stamp) return;

      if (res.success) {
        const content = isDataFile ? res.data : res.config;
        setConfig(content);
        setConfigText(JSON.stringify(content, null, 2));
        setInitialized(isDataFile ? res.exists !== false : res.initialized !== false);
        setInitMessage(res.message || '');
        if (res.notice) showToast(res.notice, 'warning');
        setLoaded(stamp);
      } else {
        setLoadFailed(true);
        setError(res.error || 'Failed to load file');
      }
    } catch (err) {
      if (latestLoad.current !== stamp) return;
      setLoadFailed(true);
      setError(err.message);
    } finally {
      if (latestLoad.current === stamp) setLoading(false);
    }
  }

  async function loadBackups(fileKey) {
    const guildId = guildIdOf(guildContext);
    const stamp = { fileKey, guildId, seq: ++seqRef.current };
    latestBackups.current = stamp;
    setBackups([]);
    try {
      const category = findFile(configFiles, fileKey)?.category === 'data' ? 'data' : 'config';
      const res = await api.get(`/config/backups?file=${encodeURIComponent(fileKey)}${guildId ? `&guildId=${guildId}` : ''}&category=${category}`);
      if (latestBackups.current !== stamp) return;
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

  // The loaded content's stamp when it belongs to the current selection, else null.
  function stampForSelection() {
    if (!loaded || loading || saving || listing) return null;
    if (loaded.fileKey !== selectedFile || loaded.ctx !== guildContext || loaded.guildId !== guildIdOf(guildContext)) return null;
    return loaded;
  }

  async function handleSave() {
    if (jsonError) {
      setError('Cannot save: JSON is invalid');
      return;
    }
    const stamp = stampForSelection();
    if (!stamp) {
      setError('Nothing was saved: the editor does not hold content loaded for this file and guild yet; wait for it to load, then save.');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const parsedConfig = JSON.parse(configText);
      const selectedInfo = findFile(configFiles, stamp.fileKey);
      const guildId = stamp.guildId;
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
        ? { file: stamp.fileKey, data: dataToSave, guildId }
        : { file: stamp.fileKey, config: dataToSave, guildId };

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
        const backupNote = res.backupCreated ? ' Backup created.' : '';
        setSuccess(res.pending ? `${isDataFile ? 'Data file' : 'Config'} accepted: ${res.message}${backupNote}` : message + backupNote);
        setInitialized(true);
        setInitMessage('');
        // The list re-read reloads the file and its backups as the server now holds them.
        await loadConfigFiles(stamp.ctx);
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
    const stamp = stampForSelection();
    if (!stamp) {
      setError('Nothing was restored: the file is not loaded for this guild yet; wait for it to load, then restore.');
      return;
    }
    if (!confirm(`Restore config from backup "${filename}"?`)) return;

    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const res = await api.post('/config/restore', {
        file: stamp.fileKey,
        filename,
        guildId: stamp.guildId,
        category: findFile(configFiles, stamp.fileKey)?.category === 'data' ? 'data' : 'config'
      });

      if (res.success) {
        const backupNote = res.backupCreated ? ' The replaced version was backed up.' : '';
        setSuccess(res.pending ? `Restore accepted: ${res.message}${backupNote}` : `Config restored successfully.${backupNote}`);
        await loadConfigFiles(stamp.ctx);
      } else {
        setError(res.error || 'Failed to restore config');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function refreshAfterDelete() {
    // A file no longer listed gives way to the first of its kind.
    await loadConfigFiles(guildContext);
  }

  async function handleDeleteFile() {
    // Only the file and guild the editor loaded, as for a Save.
    const stamp = stampForSelection();
    if (!stamp || !stamp.guildId) {
      setError('Nothing was deleted: the file is not loaded for this guild yet; wait for it to load, then delete.');
      return;
    }
    const guildId = stamp.guildId;

    const selectedInfo = findFile(configFiles, stamp.fileKey);
    if (!confirm(`Delete data file "${selectedInfo?.name || stamp.fileKey}" for guild ${guildId}?`)) return;

    try {
      setSaving(true);
      const res = await api.post('/config/data/delete', { file: stamp.fileKey, guildId });
      if (res.success) {
        setSuccess(res.pending ? `Delete accepted: ${res.message}` : 'Data file deleted');
        await refreshAfterDelete();
      } else {
        setError(res.error || 'Failed to delete data file');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteGuildData() {
    const currentContext = guildContextOptions.find(o => o.value === guildContext);
    const guildId = currentContext?.guildId || null;
    if (!guildId) return;

    if (!confirm(`Delete ALL data for guild ${guildId}? This removes every data file stored for this guild. Deleted data is kept restorable for 14 days (the graveyard) before it is permanently removed.`)) return;

    try {
      setSaving(true);
      const res = await api.post('/config/data/delete-guild', { guildId });
      if (res.success) {
        setSuccess(res.pending ? `Delete accepted: ${res.message}` : 'All data for this guild was deleted');
        await refreshAfterDelete();
      } else {
        setError(res.error || 'Failed to delete guild data');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (booting) {
    return <FirstLoadPlaceholder label="Loading config…" />;
  }

  const busy = loading || saving || listing;
  const selectedFileInfo = findFile(configFiles, selectedFile);
  // Backups and Restore only for a file whose content loaded for this selection.
  const showBackups = !loadFailed && !!loaded && loaded.fileKey === selectedFile && loaded.ctx === guildContext;
  const readOnlyContext = !!isCoWorker && guildContext === 'system';
  const currentGuildId = guildContextOptions.find(o => o.value === guildContext)?.guildId || null;

  return (
    <div>
      <div className="card">
        <h2>⚙️ Config Editor</h2>
        <p style={{marginBottom: '15px', color: '#999'}}>
          {readOnlyContext
            ? 'Browse this node\'s configuration. Global config is read-only here.'
            : 'Edit bot configuration files. Changes are automatically backed up.'}
        </p>

        {readOnlyContext && (
          <div style={{
            background: 'rgba(88, 101, 242, 0.12)',
            border: '1px solid #5865F2',
            color: '#a0c0f0',
            padding: '10px 14px',
            borderRadius: '6px',
            marginBottom: '15px',
            fontSize: '0.9rem'
          }}>
            Synced from master - global configuration mirrors the master node
            and is edited on its Web-UI. Guild contexts for guilds this node
            serves remain editable below.
          </div>
        )}


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
              disabled={busy}
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
            disabled={busy}
            onClick={() => {
              setSelectedFileType('config');
              const configFile = configFiles.find(f => f.category === 'config');
              if (configFile) {
                setSelectedFile(configFileKey(configFile));
              } else {
                setSelectedFile(null);
                clearEditor();
                // A list that failed to load says so below; it never says the context has no files.
                if (!listFailed) setError('No config files available for this context');
              }
            }}
          >
            Config Files
          </button>
          <button
            className={`tab ${selectedFileType === 'data' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => {
              setSelectedFileType('data');
              const dataFile = configFiles.find(f => f.category === 'data');
              if (dataFile) {
                setSelectedFile(configFileKey(dataFile));
              } else {
                setSelectedFile(null);
                clearEditor();
                if (!listFailed) setError('No data files available for this context');
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
            value={selectedFile || ''}
            onChange={e => setSelectedFile(e.target.value)}
            disabled={busy}
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
              <option key={configFileKey(file)} value={configFileKey(file)}>
                {file.name} {file.exists ? '✓' : '✗'}
              </option>
            ))}
          </select>
          {listFailed && (
            <small style={{color: '#F04747', display: 'block', marginTop: '5px'}}>
              The file list for this context could not be loaded, so no file is shown for it.
            </small>
          )}
          {listFailed && (
            <button
              onClick={() => loadConfigFiles(guildContext)}
              className="btn btn-primary"
              style={{marginTop: '8px'}}
              disabled={busy}
            >
              Load the file list again
            </button>
          )}
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
          <label>{readOnlyContext ? 'Configuration (JSON, read-only)' : 'Configuration (JSON)'}</label>
          <textarea
            value={configText}
            onChange={e => handleConfigChange(e.target.value)}
            readOnly={readOnlyContext}
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

        {!readOnlyContext && (
          <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap'}}>
            <button
              onClick={handleSave}
              className="btn btn-primary"
              disabled={busy || !!jsonError || !showBackups}
              style={disabledButtonStyle(busy || !!jsonError || !showBackups)}
            >
              {saving ? 'Saving…' : '💾 Save Config'}
            </button>
            {currentGuildId && showBackups && selectedFileInfo?.category === 'data' && selectedFileInfo?.exists && (
              <button
                onClick={handleDeleteFile}
                className="btn btn-danger"
                disabled={busy}
                style={disabledButtonStyle(busy)}
              >
                🗑️ Delete File
              </button>
            )}
          </div>
        )}

        {!readOnlyContext && currentGuildId && selectedFileType === 'data' && (
          <div style={{marginTop: '20px', paddingTop: '15px', borderTop: '1px solid #333'}}>
            <button
              onClick={handleDeleteGuildData}
              className="btn btn-danger"
              disabled={busy}
              style={disabledButtonStyle(busy)}
            >
              🗑️ Delete all data for this guild
            </button>
            <div style={{color: '#999', fontSize: '0.85rem', marginTop: '6px'}}>
              Removes every data file for this guild. Deleted data stays restorable for 14 days.
            </div>
          </div>
        )}
      </div>

      {!isCoWorker && (
      <div className="card">
        <h3>📦 Backups</h3>
        <p style={{marginBottom: '15px', color: '#999', fontSize: '0.9rem'}}>
          Backups are created automatically when saving. Last 10 backups are kept.
        </p>

        {!showBackups ? (
          <div style={{color: '#999', fontSize: '0.9rem'}}>{busy ? 'Loading…' : 'Backups show once the file has loaded.'}</div>
        ) : backups.length === 0 ? (
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
                    {backup.beforeRestore ? ' • saved before a restore' : ''}
                    {backup.damaged ? ' • damaged (not valid JSON), cannot be restored' : ''}
                    {backup.unreadable ? ' • could not be read just now, so it was not checked' : ''}
                    {backup.legacy ? ' • older backup, kept outside the last-10 rotation' : ''}
                    {backup.shared ? (backup.unchecked
                      ? ' • named by the file name alone, and which file it belongs to cannot be checked here, so it cannot be restored here'
                      : ' • named by the file name alone, which another file also has, so it cannot be restored here') : ''}
                  </div>
                </div>
                {!backup.damaged && !backup.shared && (
                  <button
                    onClick={() => handleRestore(backup.filename)}
                    className="btn btn-warning"
                    style={{marginRight: 0}}
                    disabled={busy}
                  >
                    Restore
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

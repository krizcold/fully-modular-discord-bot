// App Store Panel Component - Browse, install, and manage modules
const { useState, useEffect, useRef } = React;

function AppStorePanel() {
  const [view, setView] = useState('modules'); // 'modules', 'repos', 'premium', 'detail'
  const [modules, setModules] = useState([]);
  const [installed, setInstalled] = useState({});
  const [repositories, setRepositories] = useState([]);
  const [tiers, setTiers] = useState({});
  const [guildAssignments, setGuildAssignments] = useState({});
  const [selectedModule, setSelectedModule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [installJobs, setInstallJobs] = useState({}); // moduleName -> job
  const hasLoadedOnce = useRef(false);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const onPending = job => setInstallJobs(prev => ({ ...prev, [job.moduleName]: job }));
    const onRemove = job => setInstallJobs(prev => { const n = { ...prev }; delete n[job.moduleName]; return n; });
    const onCompleted = job => {
      setInstallJobs(prev => { const n = { ...prev }; delete n[job.moduleName]; return n; });
      loadData();
      if (job.kind === 'install') {
        if (job.skipped) return;
        if (job.loaded === false) {
          showToast(`${job.moduleName} installed, but failed to hot-load. Restart the bot to activate it.`, 'warning', { sticky: true });
        } else {
          showToast(`${job.moduleName} installed.`, 'success');
        }
      } else {
        if (job.skipped) return;
        if (job.unloaded === false) showToast(`${job.moduleName} uninstalled. Changes apply on next bot start.`, 'info');
        else showToast(`${job.moduleName} uninstalled.`, 'success');
      }
    };
    const onFailed = job => {
      setInstallJobs(prev => ({ ...prev, [job.moduleName]: job }));
      const label = job.kind === 'install' ? 'Install' : 'Uninstall';
      showToast(`${label} failed for ${job.moduleName}: ${job.error || 'unknown error'}`, 'error');
    };

    const unsubs = [];
    for (const kind of ['install', 'uninstall']) {
      unsubs.push(wsClient.on(`appstore:${kind}:queued`, onPending));
      unsubs.push(wsClient.on(`appstore:${kind}:started`, onPending));
      unsubs.push(wsClient.on(`appstore:${kind}:cancelled`, onRemove));
      unsubs.push(wsClient.on(`appstore:${kind}:completed`, onCompleted));
      unsubs.push(wsClient.on(`appstore:${kind}:failed`, onFailed));
    }
    unsubs.push(wsClient.on('bot:startup', () => loadData()));
    return () => unsubs.forEach(u => u && u());
  }, []);

  async function loadData() {
    try {
      if (!hasLoadedOnce.current) setLoading(true);
      const res = await api.get('/appstore/bundle');

      setModules(res.modules || []);
      // Convert installed array to object keyed by module name
      const installedArr = res.installed || [];
      const installedMap = Array.isArray(installedArr)
        ? installedArr.reduce((acc, m) => { acc[m.name] = m; return acc; }, {})
        : installedArr;
      setInstalled(installedMap);
      setRepositories(res.repositories || []);
      setTiers(res.tiers || {});
      setGuildAssignments(res.guildAssignments || {});

      // Hydrate queue only on first load. WS events are authoritative after that;
      // overwriting with a stale HTTP snapshot would race-flip job states.
      if (!hasLoadedOnce.current) {
        const queue = Array.isArray(res.installQueue) ? res.installQueue : [];
        const jobMap = {};
        for (const j of queue) {
          if (j.status === 'queued' || j.status === 'running' || j.status === 'failed') {
            jobMap[j.moduleName] = j;
          }
        }
        setInstallJobs(jobMap);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      hasLoadedOnce.current = true;
    }
  }

  function showSuccess(message) {
    showToast(message, 'success');
  }
  function setError(message) {
    if (message) showToast(message, 'error');
  }

  // Get unique categories
  const categories = ['all', ...new Set(modules.map(m => m.category || 'misc'))];

  // Filter modules
  const filteredModules = categoryFilter === 'all'
    ? modules
    : modules.filter(m => (m.category || 'misc') === categoryFilter);

  if (loading) {
    return <div className="loading">Loading App Store...</div>;
  }

  return (
    <div className="panel">
      {/* Navigation */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <button
          className={`button ${view === 'modules' ? 'primary' : ''}`}
          onClick={() => { setView('modules'); setSelectedModule(null); }}
          style={{
            background: view === 'modules' ? 'linear-gradient(135deg, #5865F2, #4752C4)' : '#40444b',
            border: 'none'
          }}
        >
          Browse Modules
        </button>
        <button
          className={`button ${view === 'commands' ? 'primary' : ''}`}
          onClick={() => setView('commands')}
          style={{
            background: view === 'commands' ? 'linear-gradient(135deg, #5865F2, #4752C4)' : '#40444b',
            border: 'none'
          }}
        >
          Commands
        </button>
        <button
          className={`button ${view === 'repos' ? 'primary' : ''}`}
          onClick={() => setView('repos')}
          style={{
            background: view === 'repos' ? 'linear-gradient(135deg, #5865F2, #4752C4)' : '#40444b',
            border: 'none'
          }}
        >
          Repositories
        </button>
        <button
          className={`button ${view === 'premium' ? 'primary' : ''}`}
          onClick={() => setView('premium')}
          style={{
            background: view === 'premium' ? 'linear-gradient(135deg, #5865F2, #4752C4)' : '#40444b',
            border: 'none'
          }}
        >
          Premium Tiers
        </button>
      </div>

      {/* Module Detail View */}
      {view === 'detail' && selectedModule && (
        <ModuleDetailView
          module={selectedModule}
          installed={installed[selectedModule.name]}
          installJob={installJobs[selectedModule.name]}
          onBack={() => { setView('modules'); setSelectedModule(null); }}
          onInstall={() => { loadData(); }}
          onUninstall={loadData}
          onSaveCredentials={loadData}
          showSuccess={showSuccess}
          setError={setError}
        />
      )}

      {/* Modules View */}
      {view === 'modules' && (
        <ModulesView
          modules={filteredModules}
          installed={installed}
          installJobs={installJobs}
          categories={categories}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          onSelectModule={(m) => { setSelectedModule(m); setView('detail'); }}
          onModuleChanged={loadData}
          repositories={repositories}
        />
      )}

      {/* Commands View */}
      {view === 'commands' && (
        <CommandsView showSuccess={showSuccess} setError={setError} />
      )}

      {/* Repositories View */}
      {view === 'repos' && (
        <RepositoriesView
          repositories={repositories}
          onRefresh={loadData}
          showSuccess={showSuccess}
          setError={setError}
        />
      )}

      {/* Premium Tiers View */}
      {view === 'premium' && (
        <PremiumTiersView
          tiers={tiers}
          guildAssignments={guildAssignments}
          onRefresh={loadData}
          showSuccess={showSuccess}
          setError={setError}
        />
      )}
    </div>
  );
}

// Modules View Component
function ModulesView({ modules, installed, installJobs, categories, categoryFilter, onCategoryChange, onSelectModule, onModuleChanged, repositories }) {
  const installedCount = Object.keys(installed).length;
  const [autoCleanup, setAutoCleanup] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [moduleUpdates, setModuleUpdates] = useState(null); // { moduleName: ModuleUpdateCheck }
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    api.get('/appstore/config')
      .then(res => { if (res.success) { setAutoCleanup(!!res.autoCleanup); setAutoUpdate(res.autoUpdate === true); } })
      .catch(() => {})
      .finally(() => setConfigLoaded(true));
  }, []);

  async function toggleCleanup() {
    const newVal = !autoCleanup;
    setAutoCleanup(newVal);
    try { await api.put('/appstore/config', { autoCleanup: newVal }); } catch { setAutoCleanup(!newVal); }
  }

  async function toggleAutoUpdate() {
    const newVal = !autoUpdate;
    setAutoUpdate(newVal);
    try { await api.put('/appstore/config', { autoUpdate: newVal }); } catch { setAutoUpdate(!newVal); }
  }

  async function checkModuleUpdates() {
    setChecking(true);
    try {
      const res = await api.post('/update/check-all');
      if (res.success && res.modules?.updates) {
        const updateMap = {};
        for (const u of res.modules.updates) {
          if (u.hasUpdate) updateMap[u.moduleName] = u;
        }
        setModuleUpdates(updateMap);
      }
    } catch (err) {
      console.error('Failed to check module updates:', err);
    } finally {
      setChecking(false);
    }
  }

  async function updateAllModules() {
    setUpdating(true);
    try {
      const res = await api.post('/update/modules-and-reload');
      if (res.success) {
        setModuleUpdates({});
        onModuleChanged();
      }
    } catch (err) {
      console.error('Failed to update modules:', err);
    } finally {
      setUpdating(false);
    }
  }

  async function updateSingleModule(moduleName) {
    setUpdating(true);
    try {
      const res = await api.post(`/update/module-and-reload/${moduleName}`);
      if (res.success) {
        setModuleUpdates(prev => {
          if (!prev) return prev;
          const next = { ...prev };
          delete next[moduleName];
          return next;
        });
        onModuleChanged();
      }
    } catch (err) {
      console.error(`Failed to update ${moduleName}:`, err);
    } finally {
      setUpdating(false);
    }
  }

  const updatesAvailable = moduleUpdates ? Object.keys(moduleUpdates).length : 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0 }}>App Store</h2>
          <p style={{ color: '#999', margin: '5px 0 0 0' }}>
            {modules.length} modules available | {installedCount} installed
            {updatesAvailable > 0 && <span style={{ color: '#e67e22', fontWeight: 600 }}> | {updatesAvailable} update{updatesAvailable !== 1 ? 's' : ''}</span>}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          {/* Config Toggles */}
          {configLoaded && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} title="When enabled, modules are periodically checked for updates and hot-reloaded automatically.">
                <span style={{ color: '#888', fontSize: '0.78rem' }}>Auto-Update Modules</span>
                <ToggleSwitch checked={autoUpdate} onChange={toggleAutoUpdate} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} title="When enabled, orphan commands are automatically removed from Discord after module changes (install, uninstall, update, reload). Keep disabled if running multiple bot instances sharing the same application.">
                <span style={{ color: '#888', fontSize: '0.78rem' }}>Auto Cleanup</span>
                <ToggleSwitch checked={autoCleanup} onChange={toggleCleanup} />
              </div>
            </>
          )}

          {/* Update buttons */}
          <button
            onClick={checkModuleUpdates}
            disabled={checking || updating}
            style={{
              background: '#5865F2', color: '#fff', border: 'none', padding: '5px 12px',
              borderRadius: '6px', fontSize: '0.78rem', cursor: checking ? 'wait' : 'pointer',
              opacity: checking || updating ? 0.6 : 1
            }}
          >{checking ? 'Checking...' : 'Check Updates'}</button>

          {updatesAvailable > 0 && (
            <button
              onClick={updateAllModules}
              disabled={updating}
              style={{
                background: '#2ecc71', color: '#fff', border: 'none', padding: '5px 12px',
                borderRadius: '6px', fontSize: '0.78rem', cursor: updating ? 'wait' : 'pointer',
                opacity: updating ? 0.6 : 1
              }}
            >{updating ? 'Updating...' : `Update All (${updatesAvailable})`}</button>
          )}

          {/* Category Filter */}
          <select
            value={categoryFilter}
            onChange={(e) => onCategoryChange(e.target.value)}
            style={{
              padding: '8px 15px',
              background: '#2a2a2a',
              border: '1px solid #444',
              borderRadius: '6px',
              color: '#e0e0e0',
              fontSize: '0.9rem'
            }}
          >
            {categories.map(cat => (
              <option key={cat} value={cat}>
                {cat === 'all' ? 'All Categories' : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {repositories.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '40px',
          background: '#2a2a2a',
          borderRadius: '8px',
          border: '1px dashed #555'
        }}>
          <h3 style={{ color: '#888' }}>No Repositories Added</h3>
          <p style={{ color: '#666' }}>Add a repository to browse available modules.</p>
        </div>
      ) : modules.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '40px',
          background: '#2a2a2a',
          borderRadius: '8px'
        }}>
          <p style={{ color: '#888' }}>No modules available. Try refreshing repositories.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '15px' }}>
          {modules.map(module => (
            <ModuleCard
              key={module.name}
              module={module}
              installed={!!installed[module.name]}
              installedEntry={installed[module.name] || null}
              installJob={installJobs?.[module.name] || null}
              updateInfo={moduleUpdates?.[module.name] || null}
              onClick={() => onSelectModule(module)}
              onInstall={onModuleChanged}
              onUninstall={onModuleChanged}
              onUpdate={() => updateSingleModule(module.name)}
              updating={updating}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Toggle switch helper
function ToggleSwitch({ checked, onChange }) {
  return (
    <label style={{ position: 'relative', display: 'inline-block', width: '36px', height: '20px', cursor: 'pointer', flexShrink: 0 }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ display: 'none' }} />
      <span style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        background: checked ? '#3ba55d' : '#555', borderRadius: '10px', transition: '0.2s'
      }}>
        <span style={{
          position: 'absolute', left: checked ? '18px' : '2px', top: '2px',
          width: '16px', height: '16px', background: '#fff', borderRadius: '50%', transition: '0.2s'
        }}></span>
      </span>
    </label>
  );
}

// Module Card Component
function CommandsView({ showSuccess, setError }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(new Set(['_internal']));

  useEffect(() => {
    api.get('/appstore/components')
      .then(res => { if (res.success) setData(res.modules); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function toggleComponent(moduleName, type, name, currentEnabled) {
    try {
      await api.put(`/appstore/components/${moduleName}/${type}/${name}`, { enabled: !currentEnabled });
      const res = await api.get('/appstore/components');
      if (res.success) setData(res.modules);
      showSuccess(`${name} ${!currentEnabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleExpand(name) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  if (loading) return <div className="loading">Loading components...</div>;
  if (!data || data.length === 0) return <p style={{ color: '#888' }}>No components found. Components appear here after the bot starts.</p>;

  const totalCommands = data.reduce((sum, m) => sum + m.commands.length, 0);
  const totalEvents = data.reduce((sum, m) => sum + m.events.length, 0);
  const totalPanels = data.reduce((sum, m) => sum + m.panels.length, 0);

  return (
    <div>
      <div style={{ marginBottom: '15px', color: '#888', fontSize: '0.85rem' }}>
        {data.length} modules &middot; {totalCommands} commands &middot; {totalEvents} events &middot; {totalPanels} panels
      </div>
      {data.map(mod => {
        const isExpanded = expanded.has(mod.name);
        const componentCount = mod.commands.length + mod.events.length + mod.panels.length;
        if (componentCount === 0) return null;
        const isInternal = mod.name === '_internal';

        return (
          <div key={mod.name} style={{ background: '#2c2f33', borderRadius: '8px', marginBottom: '8px', overflow: 'hidden', border: isInternal ? '1px solid #3a3a3a' : 'none' }}>
            <div
              onClick={() => toggleExpand(mod.name)}
              style={{
                padding: '12px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: isExpanded ? '1px solid #444' : 'none'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ color: '#fff', fontWeight: 600 }}>{mod.displayName}</span>
                <span style={{ color: isInternal ? '#5865F2' : '#666', fontSize: '0.75rem', background: isInternal ? 'rgba(88,101,242,0.15)' : 'transparent', padding: isInternal ? '1px 8px' : '0', borderRadius: '8px' }}>
                  {isInternal ? 'CORE' : mod.category}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                {mod.commands.length > 0 && <span style={{ color: '#2dd4a8', fontSize: '0.75rem' }}>{mod.commands.length} cmd</span>}
                {mod.events.length > 0 && <span style={{ color: '#5865F2', fontSize: '0.75rem' }}>{mod.events.length} evt</span>}
                {mod.panels.length > 0 && <span style={{ color: '#fbbf24', fontSize: '0.75rem' }}>{mod.panels.length} pnl</span>}
                <span style={{ color: '#666', fontSize: '0.8rem' }}>{isExpanded ? '▾' : '▸'}</span>
              </div>
            </div>

            {isExpanded && (
              <div style={{ padding: '12px 16px' }}>
                {mod.commands.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ color: '#2dd4a8', fontSize: '0.78rem', fontWeight: 600, marginBottom: '8px' }}>Commands</div>
                    {mod.commands.map(cmd => (
                      <div key={cmd.name} style={{ padding: '8px 0', borderBottom: '1px solid #3a3a3a' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ color: '#e0e0e0', fontFamily: 'monospace', fontSize: '0.88rem', fontWeight: 600 }}>/{cmd.name}</span>
                            {cmd.testOnly && <span style={{ color: '#fbbf24', fontSize: '0.68rem', background: 'rgba(251,191,36,0.12)', padding: '1px 6px', borderRadius: '6px' }}>TEST</span>}
                            {cmd.devOnly && <span style={{ color: '#ed4245', fontSize: '0.68rem', background: 'rgba(237,66,69,0.12)', padding: '1px 6px', borderRadius: '6px' }}>DEV</span>}
                          </div>
                          <ToggleSwitch checked={cmd.enabled} onChange={() => toggleComponent(mod.name, 'command', cmd.name, cmd.enabled)} />
                        </div>
                        {cmd.description && <div style={{ color: '#888', fontSize: '0.8rem', marginTop: '3px' }}>{cmd.description}</div>}
                        {cmd.options && cmd.options.length > 0 && (
                          <div style={{ marginTop: '6px', paddingLeft: '12px', borderLeft: '2px solid #3a3a3a' }}>
                            {cmd.options.map(opt => (
                              <div key={opt.name} style={{ display: 'flex', alignItems: 'baseline', gap: '6px', padding: '2px 0', fontSize: '0.78rem' }}>
                                <span style={{ color: '#2dd4a8', fontFamily: 'monospace' }}>{opt.name}</span>
                                <span style={{ color: '#555', fontSize: '0.7rem' }}>{opt.type}</span>
                                {opt.required && <span style={{ color: '#ed4245', fontSize: '0.68rem' }}>required</span>}
                                {opt.description && <span style={{ color: '#666' }}>- {opt.description}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {mod.events.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ color: '#5865F2', fontSize: '0.78rem', fontWeight: 600, marginBottom: '8px' }}>Events</div>
                    {mod.events.map(evt => (
                      <div key={evt.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #3a3a3a' }}>
                        <div>
                          <span style={{ color: '#e0e0e0', fontFamily: 'monospace', fontSize: '0.85rem' }}>{evt.name}</span>
                          {evt.handlerCount > 1 && <span style={{ color: '#666', marginLeft: '8px', fontSize: '0.72rem' }}>{evt.handlerCount} handlers</span>}
                          {evt.handlers && <div style={{ color: '#666', fontSize: '0.72rem', marginTop: '2px' }}>{evt.handlers.join(', ')}</div>}
                        </div>
                        <ToggleSwitch checked={evt.enabled} onChange={() => toggleComponent(mod.name, 'event', evt.name, evt.enabled)} />
                      </div>
                    ))}
                  </div>
                )}

                {mod.panels.length > 0 && (
                  <div>
                    <div style={{ color: '#fbbf24', fontSize: '0.78rem', fontWeight: 600, marginBottom: '8px' }}>Panels</div>
                    {mod.panels.map(panel => (
                      <div key={panel.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #3a3a3a' }}>
                        <div>
                          <span style={{ color: '#e0e0e0', fontSize: '0.85rem' }}>{panel.name}</span>
                          <span style={{ color: '#555', marginLeft: '8px', fontSize: '0.7rem', background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: '6px' }}>{panel.scope}</span>
                          {panel.description && <div style={{ color: '#666', fontSize: '0.72rem', marginTop: '2px' }}>{panel.description}</div>}
                        </div>
                        <ToggleSwitch checked={panel.enabled} onChange={() => toggleComponent(mod.name, 'panel', panel.id, panel.enabled)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ModuleCard({ module, installed, installedEntry, installJob, updateInfo, onClick, onInstall, onUninstall, onUpdate, updating }) {
  const hasUpdate = !!updateInfo;
  const jobKind = installJob?.kind || null;
  const jobStatus = installJob?.status || null;
  const needsRestart = installed && installedEntry && installedEntry.loaded === false;
  const borderColor = hasUpdate ? '#e67e22' : needsRestart ? '#f5af19' : installed ? '#3ba55d' : jobStatus === 'running' ? '#5865F2' : jobStatus === 'queued' ? '#888' : jobStatus === 'failed' ? '#ed4245' : '#444';

  async function handleInstall(e) {
    e.stopPropagation();
    try {
      await api.post(`/appstore/modules/${module.name}/install`, { repoId: module.repoId });
    } catch (err) {
      showToast(err.message || 'Install request failed', 'error');
    }
  }

  async function handleUninstall(e) {
    e.stopPropagation();
    try {
      await api.delete(`/appstore/modules/${module.name}`);
    } catch (err) {
      showToast(err.message || 'Uninstall request failed', 'error');
    }
  }

  async function handleCancel(e) {
    e.stopPropagation();
    const kind = jobKind || 'install';
    try {
      await api.delete(`/appstore/modules/${module.name}/${kind}`);
    } catch (err) {
      showToast(err.message || 'Cancel failed', 'error');
    }
  }

  return (
    <div
      onClick={onClick}
      style={{
        background: '#2c2f33',
        border: `${installed || hasUpdate ? '2px' : '1px'} solid ${borderColor}`,
        borderRadius: '10px',
        padding: '15px',
        cursor: 'pointer',
        transition: 'all 0.2s ease'
      }}
      onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
      onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: '0 0 5px 0', color: '#fff' }}>
            {module.displayName || module.name}
          </h3>
          <span style={{
            fontSize: '0.75rem',
            color: '#888',
            background: '#1a1a1a',
            padding: '2px 8px',
            borderRadius: '10px'
          }}>
            {module.category || 'misc'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
          {module.premium && (
            <span style={{
              background: 'linear-gradient(135deg, #f5af19, #f12711)',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px',
              fontSize: '0.7rem',
              fontWeight: 'bold'
            }}>PREMIUM</span>
          )}
          {installJob && jobStatus === 'queued' ? (
            <>
              <span style={{
                background: 'rgba(136, 136, 136, 0.15)',
                color: '#aaa',
                border: '1px solid rgba(136, 136, 136, 0.3)',
                padding: '3px 8px',
                borderRadius: '4px',
                fontSize: '0.7rem'
              }}>Queued</span>
              <button
                onClick={handleCancel}
                style={{
                  background: 'rgba(248, 113, 113, 0.15)',
                  color: '#f87171',
                  border: '1px solid rgba(248, 113, 113, 0.3)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '0.7rem',
                  cursor: 'pointer'
                }}
              >Cancel</button>
            </>
          ) : installJob && jobStatus === 'running' ? (
            <span style={{
              background: jobKind === 'uninstall' ? 'rgba(237, 66, 69, 0.15)' : 'rgba(88, 101, 242, 0.15)',
              color: jobKind === 'uninstall' ? '#ed4245' : '#5865F2',
              border: jobKind === 'uninstall' ? '1px solid rgba(237, 66, 69, 0.3)' : '1px solid rgba(88, 101, 242, 0.3)',
              padding: '3px 8px',
              borderRadius: '4px',
              fontSize: '0.7rem'
            }}>{jobKind === 'uninstall' ? 'Uninstalling...' : 'Installing...'}</span>
          ) : installJob && jobStatus === 'failed' ? (
            <button
              onClick={jobKind === 'uninstall' ? handleUninstall : handleInstall}
              title={installJob?.error || (jobKind === 'uninstall' ? 'Uninstall failed' : 'Install failed')}
              style={{
                background: 'rgba(237, 66, 69, 0.15)',
                color: '#ed4245',
                border: '1px solid rgba(237, 66, 69, 0.3)',
                padding: '3px 8px',
                borderRadius: '4px',
                fontSize: '0.7rem',
                cursor: 'pointer'
              }}
            >Retry</button>
          ) : installed ? (
            <>
              {hasUpdate ? (
                <span style={{
                  background: '#e67e22',
                  color: '#fff',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '0.7rem'
                }}>UPDATE</span>
              ) : needsRestart ? (
                <span
                  title="Module files are installed but the bot has not loaded them. Restart the bot to activate."
                  style={{
                    background: '#f5af19',
                    color: '#000',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '0.7rem',
                    fontWeight: 'bold'
                  }}
                >NEEDS RESTART</span>
              ) : (
                <span style={{
                  background: '#3ba55d',
                  color: '#fff',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '0.7rem'
                }}>INSTALLED</span>
              )}
              {hasUpdate && (
                <button
                  onClick={(e) => { e.stopPropagation(); onUpdate && onUpdate(); }}
                  disabled={updating}
                  style={{
                    background: 'rgba(230, 126, 34, 0.15)',
                    color: '#e67e22',
                    border: '1px solid rgba(230, 126, 34, 0.3)',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '0.7rem',
                    cursor: updating ? 'not-allowed' : 'pointer',
                    opacity: updating ? 0.5 : 1
                  }}
                >{updating ? '...' : 'Update'}</button>
              )}
              <button
                onClick={handleUninstall}
                style={{
                  background: 'rgba(248, 113, 113, 0.15)',
                  color: '#f87171',
                  border: '1px solid rgba(248, 113, 113, 0.3)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '0.7rem',
                  cursor: 'pointer'
                }}
              >Uninstall</button>
            </>
          ) : (
            <button
              onClick={handleInstall}
              style={{
                background: 'rgba(45, 212, 168, 0.15)',
                color: '#2dd4a8',
                border: '1px solid rgba(45, 212, 168, 0.3)',
                padding: '3px 8px',
                borderRadius: '4px',
                fontSize: '0.7rem',
                cursor: 'pointer'
              }}
            >Install</button>
          )}
        </div>
      </div>

      <p style={{ color: '#aaa', margin: '10px 0', fontSize: '0.9rem', lineHeight: '1.4' }}>
        {module.description || 'No description available'}
      </p>

      {hasUpdate && (
        <p style={{ color: '#e67e22', margin: '4px 0 0 0', fontSize: '0.75rem' }}>
          {updateInfo.installedVersion} → {updateInfo.availableVersion}
          {updateInfo.installedCommit && updateInfo.availableCommit ? ` (${updateInfo.installedCommit} → ${updateInfo.availableCommit})` : ''}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
        <span style={{ color: '#666', fontSize: '0.8rem' }}>v{module.version || '1.0.0'}</span>
        <span style={{ color: '#666', fontSize: '0.8rem' }}>by {module.author || 'Unknown'}</span>
      </div>
    </div>
  );
}

// Module Detail View Component
function ModuleDetailView({ module, installed, installJob, onBack, onInstall, onUninstall, onSaveCredentials, showSuccess, setError }) {
  const [installing, setInstalling] = useState(false);
  const [showCredentialsForm, setShowCredentialsForm] = useState(false);
  const [credentials, setCredentials] = useState({});
  const [components, setComponents] = useState(null);
  const jobKind = installJob?.kind || null;
  const jobStatus = installJob?.status || null;

  // Fetch detailed module info (with components) on mount
  useEffect(() => {
    api.get(`/appstore/modules/${module.name}`)
      .then(res => {
        if (res.success && res.module?.components) {
          setComponents(res.module.components);
        }
      })
      .catch(() => {});
  }, [module.name]);

  async function handleInstall() {
    try {
      setError(null);
      const res = await api.post(`/appstore/modules/${module.name}/install`, { repoId: module.repoId });
      if (res.success) {
        showSuccess(`${module.displayName || module.name} queued for install.`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCancel() {
    const kind = jobKind || 'install';
    try {
      setError(null);
      await api.delete(`/appstore/modules/${module.name}/${kind}`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleUninstall() {
    if (!confirm(`Uninstall ${module.displayName || module.name}? This will remove all module files.`)) return;
    try {
      setError(null);
      const res = await api.delete(`/appstore/modules/${module.name}`);
      if (res.success) {
        showSuccess(`${module.displayName || module.name} queued for uninstall.`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSaveCredentials() {
    try {
      setInstalling(true);
      setError(null);
      const res = await api.put(`/appstore/credentials/${module.name}`, credentials);
      if (res.success) {
        showSuccess('Credentials saved successfully!');
        setShowCredentialsForm(false);
        onSaveCredentials();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div>
      <div style={{ background: '#2c2f33', borderRadius: '10px', padding: '25px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
          <div>
            <h2 style={{ margin: '0 0 10px 0' }}>{module.displayName || module.name}</h2>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <span style={{ color: '#888' }}>v{module.version || '1.0.0'}</span>
              <span style={{ color: '#666' }}>|</span>
              <span style={{ color: '#888' }}>by {module.author || 'Unknown'}</span>
              <span style={{ color: '#666' }}>|</span>
              <span style={{
                background: '#1a1a1a',
                padding: '2px 10px',
                borderRadius: '10px',
                fontSize: '0.85rem',
                color: '#aaa'
              }}>{module.category || 'misc'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            {module.premium && (
              <span style={{
                background: 'linear-gradient(135deg, #f5af19, #f12711)',
                color: '#fff',
                padding: '5px 12px',
                borderRadius: '5px',
                fontSize: '0.85rem',
                fontWeight: 'bold'
              }}>PREMIUM</span>
            )}
          </div>
        </div>

        <p style={{ color: '#ccc', lineHeight: '1.6', marginBottom: '25px' }}>
          {module.description || 'No description available'}
        </p>

        {/* Components Included */}
        {components && (components.commands.length > 0 || components.events.length > 0 || components.panels.length > 0) && (
          <div style={{ marginBottom: '20px', padding: '15px', background: '#1a1a1a', borderRadius: '8px' }}>
            <h4 style={{ margin: '0 0 12px 0', color: '#888' }}>Included Components</h4>
            {components.commands.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <span style={{ color: '#2dd4a8', fontSize: '0.8rem', fontWeight: 600 }}>Commands ({components.commands.length})</span>
                <div style={{ marginTop: '6px' }}>
                  {components.commands.map(c => (
                    <div key={typeof c === 'string' ? c : c.name} style={{ padding: '4px 0', borderBottom: '1px solid #2c2f33' }}>
                      <span style={{ color: '#ccc', fontFamily: 'monospace', fontSize: '0.82rem' }}>/{typeof c === 'string' ? c : c.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {components.events.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <span style={{ color: '#5865F2', fontSize: '0.8rem', fontWeight: 600 }}>Events ({components.events.length})</span>
                <div style={{ marginTop: '6px' }}>
                  {components.events.map(e => (
                    <div key={typeof e === 'string' ? e : e.name} style={{ padding: '4px 0', borderBottom: '1px solid #2c2f33' }}>
                      <span style={{ color: '#ccc', fontSize: '0.82rem' }}>{typeof e === 'string' ? e : e.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {components.panels.length > 0 && (
              <div>
                <span style={{ color: '#fbbf24', fontSize: '0.8rem', fontWeight: 600 }}>Panels ({components.panels.length})</span>
                <div style={{ marginTop: '6px' }}>
                  {components.panels.map(p => (
                    <div key={typeof p === 'string' ? p : p.name} style={{ padding: '4px 0', borderBottom: '1px solid #2c2f33' }}>
                      <span style={{ color: '#ccc', fontSize: '0.82rem' }}>{typeof p === 'string' ? p : p.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Required Intents/Permissions */}
        {(module.requiredIntents?.length > 0 || module.requiredPermissions?.length > 0) && (
          <div style={{ marginBottom: '20px', padding: '15px', background: '#1a1a1a', borderRadius: '8px' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#888' }}>Requirements</h4>
            {module.requiredIntents?.length > 0 && (
              <div style={{ marginBottom: '10px' }}>
                <span style={{ color: '#666' }}>Intents: </span>
                <span style={{ color: '#aaa' }}>{module.requiredIntents.join(', ')}</span>
              </div>
            )}
            {module.requiredPermissions?.length > 0 && (
              <div>
                <span style={{ color: '#666' }}>Permissions: </span>
                <span style={{ color: '#aaa' }}>{module.requiredPermissions.join(', ')}</span>
              </div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {installJob && jobStatus === 'queued' ? (
            <>
              <span className="button" style={{ background: '#555', border: 'none', padding: '12px 25px', cursor: 'default' }}>
                Queued
              </span>
              <button
                className="button"
                onClick={handleCancel}
                style={{ background: '#ed4245', border: 'none', padding: '12px 25px' }}
              >
                Cancel
              </button>
            </>
          ) : installJob && jobStatus === 'running' ? (
            <span className="button" style={{ background: jobKind === 'uninstall' ? '#ed4245' : '#5865F2', border: 'none', padding: '12px 25px', cursor: 'default' }}>
              {jobKind === 'uninstall' ? 'Uninstalling...' : 'Installing...'}
            </span>
          ) : installJob && jobStatus === 'failed' ? (
            <button
              className="button primary"
              onClick={jobKind === 'uninstall' ? handleUninstall : handleInstall}
              title={installJob?.error || (jobKind === 'uninstall' ? 'Uninstall failed' : 'Install failed')}
              style={{ background: '#ed4245', border: 'none', padding: '12px 25px' }}
            >
              {jobKind === 'uninstall' ? 'Retry Uninstall' : 'Retry Install'}
            </button>
          ) : installed ? (
            <>
              <button
                className="button"
                onClick={handleUninstall}
                style={{ background: '#ed4245', border: 'none', padding: '12px 25px' }}
              >
                Uninstall
              </button>
              {module.apiCredentials && (
                <button
                  className="button"
                  onClick={() => setShowCredentialsForm(!showCredentialsForm)}
                  style={{
                    background: '#5865F2',
                    border: 'none',
                    padding: '12px 25px'
                  }}
                >
                  Configure Credentials
                </button>
              )}
            </>
          ) : (
            <button
              className="button primary"
              onClick={handleInstall}
              style={{
                background: 'linear-gradient(135deg, #3ba55d, #2d7d46)',
                border: 'none',
                padding: '12px 25px'
              }}
            >
              Install Module
            </button>
          )}
        </div>

        {/* Credentials Form */}
        {showCredentialsForm && module.apiCredentials?.schema && (
          <div style={{
            marginTop: '20px',
            padding: '20px',
            background: '#1a1a1a',
            borderRadius: '8px',
            border: '1px solid #f5af19'
          }}>
            <h4 style={{ margin: '0 0 15px 0', color: '#f5af19' }}>API Credentials</h4>
            {Object.entries(module.apiCredentials.schema).map(([key, field]) => (
              <div key={key} style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>
                  {field.description || key}
                  {field.required && <span style={{ color: '#ed4245' }}> *</span>}
                </label>
                <input
                  type={key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') ? 'password' : 'text'}
                  value={credentials[key] || ''}
                  onChange={(e) => setCredentials({ ...credentials, [key]: e.target.value })}
                  placeholder={field.placeholder || ''}
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: '#2a2a2a',
                    border: '1px solid #444',
                    borderRadius: '6px',
                    color: '#e0e0e0'
                  }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              <button
                className="button"
                onClick={handleSaveCredentials}
                disabled={installing}
                style={{
                  background: '#3ba55d',
                  border: 'none',
                  padding: '10px 20px'
                }}
              >
                Save Credentials
              </button>
              <button
                className="button"
                onClick={() => setShowCredentialsForm(false)}
                style={{
                  background: '#40444b',
                  border: 'none',
                  padding: '10px 20px'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Repositories View Component
function RepositoriesView({ repositories, onRefresh, showSuccess, setError }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRepo, setNewRepo] = useState({ name: '', url: '', branch: 'main', githubToken: '' });
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState({});

  async function handleAddRepo() {
    if (!newRepo.name || !newRepo.url) {
      setError('Name and URL are required');
      return;
    }
    try {
      setAdding(true);
      setError(null);
      const res = await api.post('/appstore/repos', {
        name: newRepo.name,
        url: newRepo.url,
        branch: newRepo.branch || 'main',
        githubToken: newRepo.githubToken || null
      });
      if (res.success) {
        showSuccess('Repository added successfully!');
        setShowAddForm(false);
        setNewRepo({ name: '', url: '', branch: 'main', githubToken: '' });
        onRefresh();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRefreshRepo(repoId) {
    try {
      setRefreshing({ ...refreshing, [repoId]: true });
      setError(null);
      const res = await api.post(`/appstore/repos/${repoId}/refresh`);
      if (res.success) {
        showSuccess(`Found ${res.modules?.length || 0} modules`);
        onRefresh();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing({ ...refreshing, [repoId]: false });
    }
  }

  async function handleRemoveRepo(repoId, repoName) {
    if (!confirm(`Remove repository "${repoName}"? Installed modules will remain.`)) return;
    try {
      setError(null);
      const res = await api.delete(`/appstore/repos/${repoId}`);
      if (res.success) {
        showSuccess('Repository removed');
        onRefresh();
      }
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0 }}>Repositories</h2>
          <p style={{ color: '#999', margin: '5px 0 0 0' }}>
            Manage module sources
          </p>
        </div>
        <button
          className="button"
          onClick={() => setShowAddForm(!showAddForm)}
          style={{
            background: showAddForm ? '#ed4245' : 'linear-gradient(135deg, #3ba55d, #2d7d46)',
            border: 'none'
          }}
        >
          {showAddForm ? 'Cancel' : '+ Add Repository'}
        </button>
      </div>

      {/* Add Repository Form */}
      {showAddForm && (
        <div style={{
          background: '#2c2f33',
          borderRadius: '10px',
          padding: '20px',
          marginBottom: '20px',
          border: '1px solid #3ba55d'
        }}>
          <h3 style={{ margin: '0 0 15px 0' }}>Add Repository</h3>
          <div style={{ display: 'grid', gap: '15px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>
                Repository Name <span style={{ color: '#ed4245' }}>*</span>
              </label>
              <input
                type="text"
                value={newRepo.name}
                onChange={(e) => setNewRepo({ ...newRepo, name: e.target.value })}
                placeholder="My App Store"
                style={{
                  width: '100%',
                  padding: '10px',
                  background: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '6px',
                  color: '#e0e0e0'
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>
                GitHub URL <span style={{ color: '#ed4245' }}>*</span>
              </label>
              <input
                type="text"
                value={newRepo.url}
                onChange={(e) => setNewRepo({ ...newRepo, url: e.target.value })}
                placeholder="https://github.com/user/repo"
                style={{
                  width: '100%',
                  padding: '10px',
                  background: '#1a1a1a',
                  border: '1px solid #444',
                  borderRadius: '6px',
                  color: '#e0e0e0'
                }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>Branch</label>
                <input
                  type="text"
                  value={newRepo.branch}
                  onChange={(e) => setNewRepo({ ...newRepo, branch: e.target.value })}
                  placeholder="main"
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: '#1a1a1a',
                    border: '1px solid #444',
                    borderRadius: '6px',
                    color: '#e0e0e0'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>
                  GitHub Token (for private repos)
                </label>
                <input
                  type="password"
                  value={newRepo.githubToken}
                  onChange={(e) => setNewRepo({ ...newRepo, githubToken: e.target.value })}
                  placeholder="ghp_..."
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: '#1a1a1a',
                    border: '1px solid #444',
                    borderRadius: '6px',
                    color: '#e0e0e0'
                  }}
                />
              </div>
            </div>
          </div>
          <button
            className="button"
            onClick={handleAddRepo}
            disabled={adding}
            style={{
              marginTop: '20px',
              background: adding ? '#555' : '#3ba55d',
              border: 'none',
              padding: '12px 25px'
            }}
          >
            {adding ? 'Adding...' : 'Add Repository'}
          </button>
        </div>
      )}

      {/* Repository List */}
      {repositories.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: '40px',
          background: '#2a2a2a',
          borderRadius: '8px',
          border: '1px dashed #555'
        }}>
          <h3 style={{ color: '#888' }}>No Repositories</h3>
          <p style={{ color: '#666' }}>Add a repository to start browsing modules.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {repositories.map(repo => (
            <div
              key={repo.id}
              style={{
                background: '#2c2f33',
                border: repo.enabled ? '1px solid #3ba55d' : '1px solid #555',
                borderRadius: '8px',
                padding: '15px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h4 style={{ margin: '0 0 5px 0', color: '#fff' }}>{repo.name}</h4>
                  <p style={{ margin: 0, color: '#888', fontSize: '0.85rem' }}>{repo.url}</p>
                  {repo.lastRefreshed && (
                    <p style={{ margin: '5px 0 0 0', color: '#666', fontSize: '0.8rem' }}>
                      Last refreshed: {new Date(repo.lastRefreshed).toLocaleString()}
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    className="button"
                    onClick={() => handleRefreshRepo(repo.id)}
                    disabled={refreshing[repo.id]}
                    style={{
                      background: refreshing[repo.id] ? '#555' : '#5865F2',
                      border: 'none',
                      padding: '8px 15px'
                    }}
                  >
                    {refreshing[repo.id] ? 'Refreshing...' : 'Refresh'}
                  </button>
                  <button
                    className="button"
                    onClick={() => handleRemoveRepo(repo.id, repo.name)}
                    style={{
                      background: '#ed4245',
                      border: 'none',
                      padding: '8px 15px'
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Premium Tiers View Component
function PremiumTiersView({ tiers, guildAssignments, onRefresh, showSuccess, setError }) {
  // Tier CRUD state
  const [showTierForm, setShowTierForm] = useState(false);
  const [editingTierId, setEditingTierId] = useState(null);
  const [showOverridesFor, setShowOverridesFor] = useState(null);

  // Guild assignment state
  const [botGuilds, setBotGuilds] = useState([]);
  const [guildsLoaded, setGuildsLoaded] = useState(false);
  const [selectedGuildId, setSelectedGuildId] = useState('');
  const [selectedTier, setSelectedTier] = useState('');
  const [processing, setProcessing] = useState(false);
  const [guildSearch, setGuildSearch] = useState('');
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [bulkTier, setBulkTier] = useState('');
  const [bulkProcessing, setBulkProcessing] = useState(false);

  useEffect(() => {
    loadGuilds();
  }, []);

  async function loadGuilds() {
    try {
      const res = await api.get('/appstore/premium/bot-guilds');
      if (res.success) setBotGuilds(res.guilds || []);
    } catch { /* ignore */ }
    setGuildsLoaded(true);
  }

  // ── Tier actions ──
  async function handleDeleteTier(tierId) {
    if (tierId === 'free') return;
    if (!confirm(`Delete tier "${tiers[tierId]?.displayName || tierId}"? All guilds on this tier will be moved to Free.`)) return;
    try {
      const res = await api.delete(`/appstore/premium/tiers/${tierId}`);
      if (res.success) { showSuccess('Tier deleted'); onRefresh(); }
      else setError(res.message || 'Failed to delete tier');
    } catch (err) { setError(err.message); }
  }

  function handleTierSaved() {
    setShowTierForm(false);
    setEditingTierId(null);
    onRefresh();
  }

  function handleOverridesSaved() {
    setShowOverridesFor(null);
    onRefresh();
  }

  // ── Guild assignment actions ──
  async function handleAssignTier() {
    if (!selectedGuildId || !selectedTier) { setError('Select a guild and tier'); return; }
    try {
      setProcessing(true);
      const res = await api.put(`/appstore/premium/guilds/${selectedGuildId}`, { tierId: selectedTier });
      if (res.success) {
        showSuccess(`Guild assigned to ${tiers[selectedTier]?.displayName || selectedTier}`);
        setSelectedGuildId('');
        setSelectedTier('');
        onRefresh();
      } else { setError(res.message || 'Failed to assign'); }
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  async function handleChangeGuildTier(guildId, newTierId) {
    try {
      if (newTierId === 'free' || !newTierId) {
        const res = await api.delete(`/appstore/premium/guilds/${guildId}`);
        if (res.success) { showSuccess('Guild reset to Free'); onRefresh(); }
      } else {
        const res = await api.put(`/appstore/premium/guilds/${guildId}`, { tierId: newTierId });
        if (res.success) { showSuccess('Guild tier changed'); onRefresh(); }
      }
    } catch (err) { setError(err.message); }
  }

  async function handleRemoveAssignment(guildId) {
    if (!confirm('Remove premium tier from this guild?')) return;
    try {
      const res = await api.delete(`/appstore/premium/guilds/${guildId}`);
      if (res.success) { showSuccess('Guild reset to Free'); onRefresh(); }
    } catch (err) { setError(err.message); }
  }

  // ── Bulk assignment ──
  function toggleBulkSelect(guildId) {
    setBulkSelected(prev => {
      const next = new Set(prev);
      if (next.has(guildId)) next.delete(guildId); else next.add(guildId);
      return next;
    });
  }

  async function handleBulkAssign() {
    if (bulkSelected.size === 0 || !bulkTier) { setError('Select guilds and a tier'); return; }
    setBulkProcessing(true);
    let ok = 0, fail = 0;
    for (const guildId of bulkSelected) {
      try {
        const res = await api.put(`/appstore/premium/guilds/${guildId}`, { tierId: bulkTier });
        if (res.success) ok++; else fail++;
      } catch { fail++; }
    }
    setBulkProcessing(false);
    setBulkSelected(new Set());
    setBulkTier('');
    if (ok > 0) showSuccess(`Assigned ${ok} guild${ok !== 1 ? 's' : ''} to ${tiers[bulkTier]?.displayName || bulkTier}`);
    if (fail > 0) setError(`Failed to assign ${fail} guild${fail !== 1 ? 's' : ''}`);
    onRefresh();
  }

  // ── Helpers ──
  const tierList = Object.entries(tiers).sort((a, b) => (a[1].priority || 0) - (b[1].priority || 0));
  const nonFreeTiers = tierList.filter(([id]) => id !== 'free');

  function getGuildName(guildId) {
    const g = botGuilds.find(g => g.id === guildId);
    return g ? g.name : null;
  }

  function getGuildIcon(guildId) {
    const g = botGuilds.find(g => g.id === guildId);
    if (g?.icon) return `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=32`;
    return null;
  }

  function getGuildCountForTier(tierId) {
    return Object.values(guildAssignments).filter(t => t === tierId).length;
  }

  // Filter guilds for assignment dropdown: those not already assigned to a non-free tier
  const assignableGuilds = botGuilds.filter(g => !guildAssignments[g.id]);
  const filteredAssignableGuilds = guildSearch
    ? assignableGuilds.filter(g => g.name.toLowerCase().includes(guildSearch.toLowerCase()) || g.id.includes(guildSearch))
    : assignableGuilds;

  // Guild assignments enriched with names
  const assignmentEntries = Object.entries(guildAssignments).map(([guildId, tierName]) => ({
    guildId, tierName, guildName: getGuildName(guildId), iconUrl: getGuildIcon(guildId),
  }));

  const sectionStyle = { background: '#2c2f33', borderRadius: '10px', padding: '20px', marginBottom: '20px' };

  return (
    <div>
      {/* Modals */}
      {showTierForm && (
        <TierFormModal
          tierId={editingTierId}
          tier={editingTierId ? tiers[editingTierId] : null}
          onSave={handleTierSaved}
          onClose={() => { setShowTierForm(false); setEditingTierId(null); }}
        />
      )}
      {/* Inline tier editor — replaces main content when active */}
      {showOverridesFor && tiers[showOverridesFor] ? (
        <TierEditorPanel
          tierId={showOverridesFor}
          tier={tiers[showOverridesFor]}
          onSave={handleOverridesSaved}
          onClose={() => setShowOverridesFor(null)}
        />
      ) : (<React.Fragment>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#fff' }}>Premium Tiers</h2>
          <p style={{ color: '#999', margin: '5px 0 0 0', fontSize: '0.85rem' }}>
            Manage tier definitions, setting overrides, and guild assignments
          </p>
        </div>
        <button onClick={() => { setEditingTierId(null); setShowTierForm(true); }} style={{
          background: 'linear-gradient(135deg, #f5af19, #f12711)', color: '#fff', border: 'none',
          padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem',
        }}>+ Create Tier</button>
      </div>

      {/* Tier Cards */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 15px 0', color: '#f5af19' }}>Tier Definitions</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
          {tierList.map(([tierId, tier]) => {
            const isFree = tierId === 'free';
            const overrideCount = Object.keys(tier.overrides || {}).length;
            const guildCount = getGuildCountForTier(tierId);

            return (
              <div key={tierId} style={{
                background: '#36393f', borderRadius: '10px', padding: '16px',
                border: isFree ? '1px solid #555' : '1px solid #f5af19', position: 'relative',
              }}>
                {/* Priority badge */}
                <div style={{
                  position: 'absolute', top: '10px', right: '10px',
                  background: isFree ? '#444' : 'linear-gradient(135deg, #f5af19, #f12711)',
                  color: '#fff', padding: '2px 8px', borderRadius: '10px', fontSize: '0.72rem', fontWeight: 700,
                }}>P{tier.priority || 0}</div>

                <h4 style={{ margin: '0 0 4px 0', color: isFree ? '#aaa' : '#f5af19', fontSize: '1rem' }}>
                  {tier.displayName || tierId}
                </h4>
                <div style={{ color: '#666', fontSize: '0.8rem', marginBottom: '10px' }}>
                  ID: <code style={{ background: '#1a1a1a', padding: '1px 4px', borderRadius: '3px', color: '#888' }}>{tierId}</code>
                </div>

                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                  {guildCount > 0 && (
                    <span style={{ background: '#1a1a1a', color: '#888', padding: '2px 8px', borderRadius: '10px', fontSize: '0.72rem' }}>
                      {guildCount} guild{guildCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {overrideCount > 0 && (
                    <span style={{ background: 'rgba(88, 101, 242, 0.15)', color: '#7289da', padding: '2px 8px', borderRadius: '10px', fontSize: '0.72rem' }}>
                      {overrideCount} override{overrideCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button onClick={() => { setEditingTierId(tierId); setShowTierForm(true); }} style={{
                    background: '#40444b', color: '#ddd', border: 'none', padding: '5px 10px',
                    borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem',
                  }}>Edit</button>
                  <button onClick={() => setShowOverridesFor(tierId)} style={{
                    background: '#40444b', color: '#ddd', border: 'none', padding: '5px 10px',
                    borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem',
                  }}>Overrides</button>
                  {!isFree && (
                    <button onClick={() => handleDeleteTier(tierId)} style={{
                      background: 'transparent', color: '#ed4245', border: '1px solid #ed4245', padding: '4px 10px',
                      borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem',
                    }}>Delete</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Guild Assignment */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 15px 0' }}>Assign Guild to Tier</h3>

        {/* Single assign row */}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: botGuilds.length > 0 && assignableGuilds.length > 0 ? '14px' : 0 }}>
          {botGuilds.length > 0 ? (
            <select value={selectedGuildId} onChange={e => setSelectedGuildId(e.target.value)} style={{
              flex: 1, minWidth: '220px', padding: '10px', background: '#1a1a1a',
              border: '1px solid #444', borderRadius: '6px', color: '#e0e0e0',
            }}>
              <option value="">Select Guild...</option>
              {filteredAssignableGuilds.map(g => (
                <option key={g.id} value={g.id}>{g.name} ({g.id})</option>
              ))}
            </select>
          ) : (
            <input type="text" value={selectedGuildId} onChange={e => setSelectedGuildId(e.target.value)}
              placeholder="Guild ID" style={{
                flex: 1, minWidth: '200px', padding: '10px', background: '#1a1a1a',
                border: '1px solid #444', borderRadius: '6px', color: '#e0e0e0',
              }} />
          )}
          <select value={selectedTier} onChange={e => setSelectedTier(e.target.value)} style={{
            padding: '10px 15px', background: '#1a1a1a', border: '1px solid #444',
            borderRadius: '6px', color: '#e0e0e0',
          }}>
            <option value="">Select Tier</option>
            {nonFreeTiers.map(([id, t]) => (
              <option key={id} value={id}>{t.displayName || id}</option>
            ))}
          </select>
          <button onClick={handleAssignTier} disabled={processing} style={{
            background: processing ? '#555' : '#3ba55d', color: '#fff', border: 'none',
            padding: '10px 20px', borderRadius: '6px', cursor: processing ? 'not-allowed' : 'pointer', fontWeight: 600,
          }}>{processing ? 'Assigning...' : 'Assign'}</button>
        </div>

        {botGuilds.length === 0 && guildsLoaded && (
          <div style={{ color: '#666', fontSize: '0.8rem', marginTop: '8px' }}>
            Bot is not running or has no guilds. You can still assign by guild ID manually.
          </div>
        )}

        {/* Bulk assign — shown when there are unassigned guilds */}
        {botGuilds.length > 0 && assignableGuilds.length > 0 && nonFreeTiers.length > 0 && (
          <div style={{ background: '#36393f', borderRadius: '8px', padding: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ color: '#aaa', fontSize: '0.82rem', fontWeight: 600 }}>
                Bulk Assign ({assignableGuilds.length} unassigned guild{assignableGuilds.length !== 1 ? 's' : ''})
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {bulkSelected.size > 0 && (
                  <React.Fragment>
                    <span style={{ color: '#888', fontSize: '0.8rem' }}>{bulkSelected.size} selected</span>
                    <select value={bulkTier} onChange={e => setBulkTier(e.target.value)} style={{
                      padding: '5px 10px', background: '#1a1a1a', border: '1px solid #444',
                      borderRadius: '5px', color: '#e0e0e0', fontSize: '0.82rem',
                    }}>
                      <option value="">Tier...</option>
                      {nonFreeTiers.map(([id, t]) => (
                        <option key={id} value={id}>{t.displayName || id}</option>
                      ))}
                    </select>
                    <button onClick={handleBulkAssign} disabled={bulkProcessing || !bulkTier} style={{
                      background: bulkProcessing || !bulkTier ? '#555' : '#3ba55d', color: '#fff', border: 'none',
                      padding: '5px 12px', borderRadius: '5px', cursor: bulkProcessing || !bulkTier ? 'not-allowed' : 'pointer',
                      fontSize: '0.82rem', fontWeight: 600,
                    }}>{bulkProcessing ? 'Assigning...' : 'Assign Selected'}</button>
                  </React.Fragment>
                )}
                <button onClick={() => {
                  if (bulkSelected.size === assignableGuilds.length) setBulkSelected(new Set());
                  else setBulkSelected(new Set(assignableGuilds.map(g => g.id)));
                }} style={{
                  background: 'none', color: '#7289da', border: '1px solid #7289da',
                  padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.75rem',
                }}>{bulkSelected.size === assignableGuilds.length ? 'Deselect All' : 'Select All'}</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflow: 'auto' }}>
              {assignableGuilds.map(g => (
                <label key={g.id} style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
                  borderRadius: '5px', cursor: 'pointer',
                  background: bulkSelected.has(g.id) ? 'rgba(88, 101, 242, 0.08)' : 'transparent',
                }}>
                  <input type="checkbox" checked={bulkSelected.has(g.id)}
                    onChange={() => toggleBulkSelect(g.id)}
                    style={{ accentColor: '#5865F2', width: '15px', height: '15px' }} />
                  {getGuildIcon(g.id) ? (
                    <img src={getGuildIcon(g.id)} alt="" style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
                  ) : (
                    <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: '#444', flexShrink: 0 }} />
                  )}
                  <span style={{ color: '#ddd', fontSize: '0.85rem' }}>{g.name}</span>
                  <span style={{ color: '#555', fontSize: '0.72rem', fontFamily: 'monospace' }}>{g.id}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Current Assignments */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <h3 style={{ margin: 0 }}>Guild Assignments</h3>
          {assignmentEntries.length > 3 && (
            <input type="text" value={guildSearch} onChange={e => setGuildSearch(e.target.value)}
              placeholder="Search guilds..." style={{
                padding: '6px 12px', background: '#1a1a1a', border: '1px solid #444',
                borderRadius: '6px', color: '#e0e0e0', fontSize: '0.85rem', width: '200px',
              }} />
          )}
        </div>
        {assignmentEntries.length === 0 ? (
          <p style={{ color: '#888' }}>No guilds have premium tiers assigned.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {assignmentEntries
              .filter(a => !guildSearch || (a.guildName || a.guildId).toLowerCase().includes(guildSearch.toLowerCase()))
              .map(({ guildId, tierName, guildName, iconUrl }) => (
                <div key={guildId} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: '#36393f', padding: '10px 14px', borderRadius: '8px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                    {iconUrl ? (
                      <img src={iconUrl} alt="" style={{ width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: '#444', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: '#888' }}>?</div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#fff', fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {guildName || <span style={{ fontFamily: 'monospace', color: '#aaa' }}>{guildId}</span>}
                      </div>
                      {guildName && <div style={{ color: '#666', fontSize: '0.72rem', fontFamily: 'monospace' }}>{guildId}</div>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                    <select value={tierName} onChange={e => handleChangeGuildTier(guildId, e.target.value)} style={{
                      padding: '5px 10px', background: '#1a1a1a', border: '1px solid #444',
                      borderRadius: '5px', color: '#e0e0e0', fontSize: '0.82rem',
                    }}>
                      <option value="free">Free</option>
                      {nonFreeTiers.map(([id, t]) => (
                        <option key={id} value={id}>{t.displayName || id}</option>
                      ))}
                    </select>
                    <button onClick={() => handleRemoveAssignment(guildId)} title="Reset to Free" style={{
                      background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                      padding: '4px 8px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem',
                    }}>Remove</button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      </React.Fragment>)}
    </div>
  );
}

// App Store Panel Component - Browse, install, and manage modules
const { useState, useEffect, useRef } = React;

// Subscribe to the emoji shortcode map so previews re-render once it loads.
function useEmojiMapReady() {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (typeof onDiscordEmojiMapReady !== 'function') return;
    const unsub = onDiscordEmojiMapReady(() => setTick(t => t + 1));
    return unsub;
  }, []);
}

// Render a single-line preview of a Discord message string: custom emojis as
// images, shortcodes as unicode. Mimics a tiny message bubble.
function RestrictionMessagePreview({ text }) {
  useEmojiMapReady();
  const parsed = (typeof parseDiscordInline === 'function')
    ? parseDiscordInline(text || '')
    : (text || '');
  return (
    <div style={{
      background: '#2f3136', borderRadius: '6px', padding: '8px 10px',
      color: '#dcddde', fontSize: '0.85rem', lineHeight: 1.4,
      minHeight: '20px', border: '1px solid #202225',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    }}>
      {(!text || text.length === 0) ? (
        <span style={{ color: '#72767d', fontStyle: 'italic' }}>(empty)</span>
      ) : parsed}
    </div>
  );
}

function AppStorePanel() {
  const [view, setView] = useState('modules'); // 'modules', 'repos', 'premium', 'detail'
  const [modules, setModules] = useState([]);
  const [installed, setInstalled] = useState({});
  const [repositories, setRepositories] = useState([]);
  const [tiers, setTiers] = useState({});
  const [subscriptions, setSubscriptions] = useState({});
  const [premiumMessages, setPremiumMessages] = useState(null);
  const [premiumMessageDefaults, setPremiumMessageDefaults] = useState(null);
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
      setSubscriptions(res.subscriptions || {});
      if (res.messages) setPremiumMessages(res.messages);
      if (res.messageDefaults) setPremiumMessageDefaults(res.messageDefaults);

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
          subscriptions={subscriptions}
          messages={premiumMessages}
          messageDefaults={premiumMessageDefaults}
          onRefresh={loadData}
          onMessagesChanged={(msgs) => setPremiumMessages(msgs)}
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
// ── Override-diff helpers (mirror the backend's pruneOverridesAgainstFree) ──
// Used for the "N overrides" count so the UI never claims a tier diverges
// from Free when every key it sets already matches Free.
function _overrideDeepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const na = a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).sort();
    const nb = b.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).sort();
    return na.every((v, i) => v === nb[i]);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a), bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => _overrideDeepEqual(a[k], b[k]));
  }
  return false;
}
function _moduleOverrideRedundant(tierMod, freeMod) {
  // Mirror backend rule: when Free disables the module entirely, the only
  // baseline it actually contributes to non-Free tiers is `_moduleEnabled: false`;
  // its other keys are moot on a disabled module. Treat them as absent for
  // redundancy comparison.
  const effectiveFree = freeMod && freeMod._moduleEnabled === false
    ? { _moduleEnabled: false }
    : (freeMod || {});
  const keys = Object.keys(tierMod || {});
  if (keys.length === 0) return true;
  for (const key of keys) {
    if (!_overrideDeepEqual(tierMod[key], effectiveFree[key])) return false;
  }
  return true;
}
function computeEffectiveOverrideCount(tier, tierId, freeTier) {
  const ov = tier.overrides || {};
  if (tierId === 'free') return Object.keys(ov).length;
  const freeOv = freeTier?.overrides || {};
  let count = 0;
  for (const [mod, tierMod] of Object.entries(ov)) {
    if (!_moduleOverrideRedundant(tierMod, freeOv[mod] || {})) count++;
  }
  return count;
}

// ── Inline SVG icons used by TierCard ──
const TierIcon = ({ d, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    {d}
  </svg>
);
const IconPencil = (p) => <TierIcon {...p} d={<><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></>} />;
const IconSliders = (p) => <TierIcon {...p} d={<><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></>} />;
const IconDollar = (p) => <TierIcon {...p} d={<><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>} />;
const IconTrash = (p) => <TierIcon {...p} d={<><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></>} />;
const IconGrip = (p) => <TierIcon {...p} d={<><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></>} />;

// ── Single tier row in the Premium Tiers grid ──
// Priority is derived from position (Free pinned at 0, others reorderable via drag-and-drop).
function TierCard({
  tierId, tier, subCount, overrideCount,
  onSaveName, onOpenOverrides, onOpenOfferings, onDelete,
  dragging, onDragStart, onDragEnd, onReorder,
}) {
  const isFree = tierId === 'free';
  const offeringCount = (tier.offerings || []).length;
  const pricesWarning = !isFree && offeringCount === 0;

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(tier.displayName || tierId);
  const [hoverRow, setHoverRow] = useState(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const nameInputRef = useRef(null);

  useEffect(() => { setNameDraft(tier.displayName || tierId); }, [tier.displayName, tierId]);
  useEffect(() => { if (editingName && nameInputRef.current) nameInputRef.current.focus(); }, [editingName]);

  async function commitName() {
    setEditingName(false);
    await onSaveName(tierId, nameDraft);
  }
  function cancelName() {
    setEditingName(false);
    setNameDraft(tier.displayName || tierId);
  }

  // ── Drag-and-drop handlers ──
  // Free is never draggable and never a drop target. A tier can't be dropped onto itself.
  const canDrag = !isFree;
  const canBeDropTarget = !isFree && dragging && dragging !== tierId;

  function handleDragStart(e) {
    if (!canDrag) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', tierId); } catch { /* some browsers need this */ }
    onDragStart(tierId);
  }
  function handleDragEnd() {
    setIsDropTarget(false);
    onDragEnd();
  }
  function handleDragOver(e) {
    if (!canBeDropTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isDropTarget) setIsDropTarget(true);
  }
  function handleDragLeave() {
    if (isDropTarget) setIsDropTarget(false);
  }
  function handleDrop(e) {
    if (!canBeDropTarget) return;
    e.preventDefault();
    setIsDropTarget(false);
    onReorder(dragging, tierId);
  }

  const rowBase = {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '6px 8px', borderRadius: '6px',
    fontSize: '0.82rem', lineHeight: 1.2,
  };
  const rowButtonStyle = (key, tone) => ({
    ...rowBase,
    background: hoverRow === key ? 'rgba(255,255,255,0.04)' : 'transparent',
    color: tone || '#ddd',
    border: 'none', width: '100%', textAlign: 'left',
    cursor: 'pointer', transition: 'background 0.1s',
  });
  const countStyle = (tone) => ({
    color: tone || '#aaa', fontSize: '0.82rem', marginLeft: '4px', minWidth: '16px', textAlign: 'right',
  });

  const beingDragged = dragging === tierId;

  return (
    <div
      draggable={canDrag}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        background: '#36393f', borderRadius: '10px', padding: '16px',
        border: isDropTarget
          ? '2px solid #5865F2'
          : isFree ? '1px solid #555' : '1px solid #f5af19',
        position: 'relative',
        display: 'flex', flexDirection: 'column', gap: '10px',
        opacity: beingDragged ? 0.4 : 1,
        transition: 'border-color 0.1s, opacity 0.1s',
      }}
    >
      {/* Priority badge top-right */}
      <div style={{
        position: 'absolute', top: '10px', right: '10px',
        background: isFree ? '#444' : 'linear-gradient(135deg, #f5af19, #f12711)',
        color: '#fff', padding: '2px 8px', borderRadius: '10px', fontSize: '0.72rem', fontWeight: 700,
      }}>P{tier.priority || 0}</div>

      {/* Title bar: grip (for non-Free) + name + pencil */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: '26px', paddingRight: '52px' }}>
        {canDrag ? (
          <span title="Drag to reorder" style={{
            display: 'flex', alignItems: 'center', color: '#888',
            cursor: 'grab', padding: '2px', marginLeft: '-4px',
          }}>
            <IconGrip size={14} />
          </span>
        ) : (
          <span title="Free tier is always the baseline" style={{
            display: 'flex', alignItems: 'center', color: '#555',
            padding: '2px', marginLeft: '-4px',
          }}>
            <IconGrip size={14} />
          </span>
        )}

        {editingName ? (
          <input
            ref={nameInputRef}
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              else if (e.key === 'Escape') { cancelName(); }
            }}
            style={{
              flex: 1, padding: '3px 8px', background: '#1a1a1a',
              border: '1px solid #555', borderRadius: '4px',
              color: isFree ? '#aaa' : '#f5af19', fontSize: '1rem', fontWeight: 600,
            }}
          />
        ) : (
          <React.Fragment>
            <h4 style={{ margin: 0, color: isFree ? '#aaa' : '#f5af19', fontSize: '1rem' }}>
              {tier.displayName || tierId}
            </h4>
            <button
              onClick={() => setEditingName(true)}
              title="Edit name"
              style={{
                background: 'transparent', border: 'none', padding: '2px 4px',
                cursor: 'pointer', color: '#888', display: 'flex', alignItems: 'center',
              }}
            >
              <IconPencil size={13} />
            </button>
          </React.Fragment>
        )}
      </div>
      <div style={{ color: '#666', fontSize: '0.8rem', marginTop: '-6px' }}>
        ID: <code style={{ background: '#1a1a1a', padding: '1px 4px', borderRadius: '3px', color: '#888' }}>{tierId}</code>
      </div>

      {/* Active-subscription pill (runtime state; not duplicated by rows) */}
      {subCount > 0 && (
        <div>
          <span style={{ background: '#1a1a1a', color: '#888', padding: '2px 8px', borderRadius: '10px', fontSize: '0.72rem' }}>
            {subCount} active
          </span>
        </div>
      )}

      {/* Vertical action list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: 'auto' }}>
        {/* Overrides */}
        <button
          onClick={onOpenOverrides}
          onMouseEnter={() => setHoverRow('overrides')}
          onMouseLeave={() => setHoverRow(null)}
          style={rowButtonStyle('overrides')}
        >
          <IconSliders />
          <span style={{ flex: 1 }}>Overrides</span>
          <span style={countStyle()}>{overrideCount}</span>
          <span style={{ color: '#666' }}>›</span>
        </button>

        {/* Prices (non-Free only) */}
        {!isFree && (
          <button
            onClick={onOpenOfferings}
            onMouseEnter={() => setHoverRow('prices')}
            onMouseLeave={() => setHoverRow(null)}
            style={rowButtonStyle('prices', pricesWarning ? '#e67e22' : '#ddd')}
            title={pricesWarning ? 'No offerings: this tier is not purchasable' : undefined}
          >
            <IconDollar />
            <span style={{ flex: 1 }}>Prices</span>
            {pricesWarning && <span style={{ color: '#e67e22', marginRight: '2px' }}>⚠</span>}
            <span style={countStyle(pricesWarning ? '#e67e22' : undefined)}>{offeringCount}</span>
            <span style={{ color: pricesWarning ? '#e67e22' : '#666' }}>›</span>
          </button>
        )}

        {/* Delete (non-Free only) */}
        {!isFree && (
          <button
            onClick={onDelete}
            onMouseEnter={() => setHoverRow('delete')}
            onMouseLeave={() => setHoverRow(null)}
            style={rowButtonStyle('delete', '#ed4245')}
          >
            <IconTrash />
            <span style={{ flex: 1 }}>Delete</span>
          </button>
        )}
      </div>
    </div>
  );
}

function PremiumTiersView({ tiers, subscriptions, messages, messageDefaults, onRefresh, onMessagesChanged, showSuccess, setError }) {
  // Tier CRUD state
  const [showTierForm, setShowTierForm] = useState(false);
  const [editingTierId, setEditingTierId] = useState(null);
  const [showOverridesFor, setShowOverridesFor] = useState(null);
  const [showOfferingsFor, setShowOfferingsFor] = useState(null);

  // Subscriptions state
  const [botGuilds, setBotGuilds] = useState([]);
  const [guildsLoaded, setGuildsLoaded] = useState(false);
  const [providers, setProviders] = useState([]);
  const [showGrantManual, setShowGrantManual] = useState(false);
  const [editingManualForGuild, setEditingManualForGuild] = useState(null);
  const [subscriptionSearch, setSubscriptionSearch] = useState('');

  // Restriction messages state (local editable copy; prop provides current saved values)
  const [msgDraft, setMsgDraft] = useState(() => messages || { moduleBlocked: '', commandBlocked: '', panelBlocked: '' });
  const [msgSaving, setMsgSaving] = useState(false);

  // Coupons state
  const [coupons, setCoupons] = useState({});
  const [couponsLoaded, setCouponsLoaded] = useState(false);
  const [newCouponDraft, setNewCouponDraft] = useState({ code: '', kind: 'percentOff', value: '', maxUses: '', description: '', expiresAt: '', scope: 'global', allowedTiers: [] });
  const [couponSaving, setCouponSaving] = useState(false);

  useEffect(() => {
    if (messages) setMsgDraft(messages);
  }, [messages]);

  useEffect(() => {
    loadGuilds();
    loadProviders();
    loadCoupons();
  }, []);

  async function loadCoupons() {
    try {
      const res = await api.get('/appstore/premium/coupons');
      if (res.success) setCoupons(res.coupons || {});
    } catch { /* ignore */ }
    setCouponsLoaded(true);
  }

  async function handleSaveCoupon() {
    const code = (newCouponDraft.code || '').trim();
    if (!code) { setError('Coupon code is required'); return; }
    const value = parseInt(newCouponDraft.value, 10);
    if (isNaN(value) || value <= 0) { setError('Coupon value must be a positive number'); return; }
    // scope: 'global' => omit allowedTiers; 'restricted' => at least one tier required.
    if (newCouponDraft.scope === 'restricted' && newCouponDraft.allowedTiers.length === 0) {
      setError('Select at least one tier or switch to "All tiers"');
      return;
    }
    const body = {
      description: newCouponDraft.description || undefined,
      ...(newCouponDraft.kind === 'percentOff' ? { percentOff: value } : { extraDays: value }),
      ...(newCouponDraft.maxUses ? { maxUses: parseInt(newCouponDraft.maxUses, 10) } : {}),
      ...(newCouponDraft.expiresAt ? { expiresAt: new Date(newCouponDraft.expiresAt).toISOString() } : {}),
      ...(newCouponDraft.scope === 'restricted' ? { allowedTiers: newCouponDraft.allowedTiers } : {}),
    };
    try {
      setCouponSaving(true);
      const res = await api.put(`/appstore/premium/coupons/${encodeURIComponent(code)}`, body);
      if (res.success) {
        showSuccess(`Coupon "${code}" saved`);
        setNewCouponDraft({ code: '', kind: 'percentOff', value: '', maxUses: '', description: '', expiresAt: '', scope: 'global', allowedTiers: [] });
        loadCoupons();
      } else {
        setError(res.error || 'Failed to save coupon');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setCouponSaving(false);
    }
  }

  async function handleDeleteCoupon(code) {
    if (!confirm(`Delete coupon "${code}"? Existing subscriptions that used it keep their effect; new redemptions will be rejected.`)) return;
    try {
      const res = await api.delete(`/appstore/premium/coupons/${encodeURIComponent(code)}`);
      if (res.success) { showSuccess('Coupon deleted'); loadCoupons(); }
      else setError(res.error || 'Failed to delete coupon');
    } catch (err) { setError(err.message); }
  }

  async function loadGuilds() {
    try {
      const res = await api.get('/appstore/premium/bot-guilds');
      if (res.success) setBotGuilds(res.guilds || []);
    } catch { /* ignore */ }
    setGuildsLoaded(true);
  }

  async function loadProviders() {
    try {
      const res = await api.get('/appstore/premium/providers');
      if (res.success) setProviders(res.providers || []);
    } catch { /* ignore */ }
  }

  async function handleProviderActivation(providerId, activated, defaultEnabled) {
    try {
      const res = await api.put(`/appstore/premium/providers/${providerId}/activation`, {
        activated,
        defaultEnabled: !!defaultEnabled,
      });
      if (res.success) {
        showSuccess(activated ? 'Payment method activated' : 'Payment method deactivated');
        loadProviders();
      } else {
        setError(res.error || 'Failed to update payment method');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  // Derive activation map from providers list for passing to OfferingsEditorPanel
  const activatedProviders = Object.fromEntries(
    providers.filter(p => p.activated).map(p => [p.id, { defaultEnabled: !!p.defaultEnabled }])
  );

  // ── Tier actions ──
  async function handleDeleteTier(tierId) {
    if (tierId === 'free') return;
    if (!confirm(`Delete tier "${tiers[tierId]?.displayName || tierId}"? Any subscriptions on this tier will be revoked.`)) return;
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

  async function handleSaveTierName(tierId, newName) {
    const tier = tiers[tierId];
    if (!tier) return;
    const trimmed = (newName || '').trim();
    if (!trimmed) { setError('Tier name cannot be empty'); return; }
    if (trimmed === tier.displayName) return;
    try {
      const res = await api.put(`/appstore/premium/tiers/${tierId}`, {
        displayName: trimmed,
        priority: tier.priority,
        overrides: tier.overrides,
        offerings: tier.offerings,
      });
      if (res.success) { showSuccess('Tier renamed'); onRefresh(); }
      else setError(res.message || 'Failed to rename tier');
    } catch (err) { setError(err.message); }
  }

  // ── Drag-and-drop tier reordering ──
  // Priority is derived from display order: Free is pinned at 0; non-Free tiers are 1..N by position.
  const [draggingTierId, setDraggingTierId] = useState(null);

  async function handleReorderTiers(movedId, targetId) {
    if (!movedId || !targetId || movedId === targetId) return;
    if (movedId === 'free' || targetId === 'free') return;

    const nonFreeIds = tierList.filter(([id]) => id !== 'free').map(([id]) => id);
    const fromIdx = nonFreeIds.indexOf(movedId);
    const toIdx = nonFreeIds.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

    nonFreeIds.splice(fromIdx, 1);
    nonFreeIds.splice(toIdx, 0, movedId);

    const updates = nonFreeIds
      .map((id, idx) => ({ id, newPriority: idx + 1 }))
      .filter(u => (tiers[u.id]?.priority || 0) !== u.newPriority);
    if (updates.length === 0) return;

    try {
      await Promise.all(updates.map(u => {
        const t = tiers[u.id];
        return api.put(`/appstore/premium/tiers/${u.id}`, {
          displayName: t.displayName,
          priority: u.newPriority,
          overrides: t.overrides,
          offerings: t.offerings,
        });
      }));
      showSuccess('Tiers reordered');
      onRefresh();
    } catch (err) {
      setError(err.message || 'Failed to reorder tiers');
    }
  }

  function handleOverridesSaved() {
    setShowOverridesFor(null);
    onRefresh();
  }

  function handleOfferingsSaved() {
    setShowOfferingsFor(null);
    onRefresh();
  }

  // ── Manual subscription actions ──
  function handleGrantManualOpen(guildId) {
    setEditingManualForGuild(guildId || null);
    setShowGrantManual(true);
  }

  async function handleRevokeManual(guildId) {
    const gname = getGuildName(guildId) || guildId;
    if (!confirm(`Revoke manual subscription for "${gname}"?`)) return;
    try {
      const res = await api.delete(`/appstore/premium/subscriptions/${guildId}/manual`);
      if (res.success) { showSuccess('Manual subscription revoked'); onRefresh(); }
      else setError('Failed to revoke manual subscription');
    } catch (err) { setError(err.message); }
  }

  // ── Restriction messages actions ──
  const msgDirty = !!messages && (
    (msgDraft.moduleBlocked || '') !== (messages.moduleBlocked || '') ||
    (msgDraft.commandBlocked || '') !== (messages.commandBlocked || '') ||
    (msgDraft.panelBlocked || '') !== (messages.panelBlocked || '')
  );

  async function handleSaveMessages() {
    try {
      setMsgSaving(true);
      const res = await api.put('/appstore/premium/messages', msgDraft);
      if (res.success) {
        if (res.messages && onMessagesChanged) onMessagesChanged(res.messages);
        if (res.messages) setMsgDraft(res.messages);
        showSuccess('Restriction messages saved');
      } else {
        setError(res.error || 'Failed to save messages');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setMsgSaving(false);
    }
  }

  async function handleResetMessages() {
    if (!confirm('Reset all restriction messages to defaults?')) return;
    try {
      setMsgSaving(true);
      const res = await api.post('/appstore/premium/messages/reset');
      if (res.success) {
        if (res.messages && onMessagesChanged) onMessagesChanged(res.messages);
        if (res.messages) setMsgDraft(res.messages);
        showSuccess('Restriction messages reset to defaults');
      } else {
        setError(res.error || 'Failed to reset messages');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setMsgSaving(false);
    }
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

  function getTierDisplayName(tierId) {
    return tiers[tierId]?.displayName || tierId;
  }

  function getActiveSubCountForTier(tierId) {
    const now = Date.now();
    let count = 0;
    for (const gs of Object.values(subscriptions || {})) {
      for (const side of ['manual', 'paid']) {
        const s = gs[side];
        if (!s) continue;
        if (s.tierId !== tierId) continue;
        if (s.status !== 'active') continue;
        if (s.endDate !== null && Date.parse(s.endDate) <= now) continue;
        count++;
      }
    }
    return count;
  }

  function formatRemaining(sub) {
    if (!sub) return '';
    if (sub.status !== 'active') return 'Expired';
    if (sub.endDate === null) return 'Lifetime';
    const remaining = Date.parse(sub.endDate) - Date.now();
    if (remaining <= 0) return 'Expired';
    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days >= 2) return `${days} days`;
    if (days === 1) return `1 day ${hours}h`;
    return `${hours}h`;
  }

  // Build sorted subscription entries for the table
  const now = Date.now();
  const subEntries = Object.entries(subscriptions || {}).map(([guildId, gs]) => {
    const candidates = ['manual', 'paid']
      .map(source => ({ source, sub: gs[source] }))
      .filter(x => x.sub && x.sub.status === 'active' && (x.sub.endDate === null || Date.parse(x.sub.endDate) > now))
      .map(x => ({ ...x, tier: tiers[x.sub.tierId] }))
      .filter(x => x.tier);
    let effective = null;
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if ((b.tier.priority || 0) !== (a.tier.priority || 0)) return (b.tier.priority || 0) - (a.tier.priority || 0);
        return a.source === 'manual' ? -1 : 1;
      });
      effective = candidates[0];
    }
    return {
      guildId,
      guildName: getGuildName(guildId),
      iconUrl: getGuildIcon(guildId),
      manual: gs.manual,
      paid: gs.paid,
      effective,
    };
  }).sort((a, b) => (a.guildName || a.guildId).localeCompare(b.guildName || b.guildId));

  const filteredSubEntries = subscriptionSearch
    ? subEntries.filter(s => (s.guildName || s.guildId).toLowerCase().includes(subscriptionSearch.toLowerCase()) || s.guildId.includes(subscriptionSearch))
    : subEntries;

  const sectionStyle = { background: '#2c2f33', borderRadius: '10px', padding: '20px', marginBottom: '20px' };
  const couponInputStyle = {
    width: '100%', padding: '6px 10px', background: '#1a1a1a',
    border: '1px solid #444', borderRadius: '4px', color: '#e0e0e0',
    fontSize: '0.85rem', boxSizing: 'border-box',
  };

  return (
    <div>
      {/* Modals */}
      {showTierForm && (
        <TierFormModal
          tierId={editingTierId}
          tier={editingTierId ? tiers[editingTierId] : null}
          freeTier={tiers.free}
          nextPriority={1 + Math.max(0, ...Object.values(tiers).map(t => t.priority || 0))}
          onSave={handleTierSaved}
          onClose={() => { setShowTierForm(false); setEditingTierId(null); }}
        />
      )}
      {showGrantManual && (
        <GrantManualModal
          guildId={editingManualForGuild}
          existing={editingManualForGuild ? (subscriptions[editingManualForGuild] || {}).manual : null}
          tiers={tiers}
          botGuilds={botGuilds}
          existingSubscriptions={subscriptions}
          onSave={() => { setShowGrantManual(false); setEditingManualForGuild(null); onRefresh(); }}
          onClose={() => { setShowGrantManual(false); setEditingManualForGuild(null); }}
          showSuccess={showSuccess}
          setError={setError}
        />
      )}

      {/* Inline editors: replace main content when active */}
      {showOfferingsFor && tiers[showOfferingsFor] ? (
        <OfferingsEditorPanel
          tierId={showOfferingsFor}
          tier={tiers[showOfferingsFor]}
          providers={providers}
          activatedProviders={activatedProviders}
          onSave={handleOfferingsSaved}
          onClose={() => setShowOfferingsFor(null)}
          showSuccess={showSuccess}
          setError={setError}
        />
      ) : showOverridesFor && tiers[showOverridesFor] ? (
        <TierEditorPanel
          tierId={showOverridesFor}
          tier={tiers[showOverridesFor]}
          freeTier={tiers.free}
          onSave={handleOverridesSaved}
          onClose={() => setShowOverridesFor(null)}
        />
      ) : (<React.Fragment>

      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ margin: 0, color: '#fff' }}>Premium Tiers</h2>
        <p style={{ color: '#999', margin: '5px 0 0 0', fontSize: '0.85rem' }}>
          Manage tier definitions, setting overrides, offerings, restriction messages, and guild subscriptions
        </p>
      </div>

      {/* Guild Web-UI recommendation */}
      <div style={{
        background: 'rgba(88, 101, 242, 0.08)',
        border: '1px solid rgba(88, 101, 242, 0.35)',
        borderRadius: '8px',
        padding: '10px 14px',
        marginBottom: '20px',
        color: '#bfc4d6',
        fontSize: '0.82rem',
        lineHeight: 1.5,
      }}>
        <strong style={{ color: '#9aa6ee' }}>Guild Web-UI recommended.</strong>{' '}
        The VIP system works fully without it: manual grants, command/module gating and enforcement
        all happen bot-side. But for guilds to self-subscribe, view their tier, or manage paid plans,
        enable the Guild Web-UI in the Credentials tab.
      </div>

      {/* Available Payment Methods */}
      <div style={sectionStyle}>
        <div style={{ marginBottom: '14px' }}>
          <h3 style={{ margin: 0, color: '#ddd' }}>Available Payment Methods</h3>
          <p style={{ color: '#999', margin: '4px 0 0 0', fontSize: '0.8rem' }}>
            Activate the payment methods this bot should accept. Only activated methods appear in an offering's toggles.
          </p>
        </div>
        {providers.length === 0 ? (
          <div style={{ color: '#888', fontSize: '0.85rem', padding: '20px', textAlign: 'center' }}>
            No payment providers registered.
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: '12px',
          }}>
            {providers.map(p => {
              const caps = p.capabilities || {};
              const capBadges = [caps.mechanism, caps.supportsCancel && 'cancel', caps.supportsCoupons && 'coupons'].filter(Boolean);
              return (
                <div key={p.id} style={{
                  background: p.activated ? 'rgba(88, 101, 242, 0.07)' : '#36393f',
                  borderRadius: '10px',
                  padding: '14px 16px',
                  border: p.activated ? '1px solid rgba(88, 101, 242, 0.45)' : '1px solid #3a3d42',
                  transition: 'background 0.15s, border-color 0.15s',
                }}>
                  {/* Header: name + status + activation toggle */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#fff', fontSize: '0.96rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span>{p.displayName}</span>
                        {!p.isConfigured && (
                          <span style={{
                            background: 'rgba(230, 126, 34, 0.18)', color: '#e67e22',
                            padding: '2px 8px', borderRadius: '10px', fontSize: '0.68rem', fontWeight: 500,
                          }}>not configured</span>
                        )}
                      </div>
                      <div style={{ color: '#888', fontSize: '0.72rem', marginTop: '4px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {capBadges.map((b, i) => (
                          <span key={i} style={{
                            background: 'rgba(255,255,255,0.04)', color: '#888',
                            padding: '1px 7px', borderRadius: '8px',
                          }}>{b}</span>
                        ))}
                      </div>
                    </div>
                    {/* Pill-style activation toggle */}
                    <div
                      onClick={() => handleProviderActivation(p.id, !p.activated, p.defaultEnabled)}
                      title={p.activated ? 'Click to deactivate' : 'Click to activate'}
                      style={{
                        width: '38px', height: '22px', borderRadius: '11px',
                        background: p.activated ? '#3ba55d' : '#555',
                        position: 'relative', cursor: 'pointer',
                        transition: 'background 0.15s', flexShrink: 0, marginTop: '2px',
                      }}>
                      <div style={{
                        width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
                        position: 'absolute', top: '2px', left: p.activated ? '18px' : '2px',
                        transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                      }} />
                    </div>
                  </div>

                  {/* Default-enabled sub-toggle, only when activated */}
                  {p.activated && (
                    <div style={{
                      marginTop: '12px', paddingTop: '10px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
                    }}>
                      <span style={{ color: '#b0b0b0', fontSize: '0.78rem' }}>
                        Default-enable on new offerings
                      </span>
                      <div
                        onClick={() => handleProviderActivation(p.id, true, !p.defaultEnabled)}
                        style={{
                          width: '32px', height: '18px', borderRadius: '9px',
                          background: p.defaultEnabled ? '#5865F2' : '#555',
                          position: 'relative', cursor: 'pointer',
                          transition: 'background 0.15s', flexShrink: 0,
                        }}>
                        <div style={{
                          width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                          position: 'absolute', top: '2px', left: p.defaultEnabled ? '16px' : '2px',
                          transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                        }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Tier Cards */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 15px 0', color: '#f5af19' }}>Tier Definitions</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
          {tierList.map(([tierId, tier]) => (
            <TierCard
              key={tierId}
              tierId={tierId}
              tier={tier}
              subCount={getActiveSubCountForTier(tierId)}
              overrideCount={computeEffectiveOverrideCount(tier, tierId, tiers.free)}
              onSaveName={handleSaveTierName}
              onOpenOverrides={() => setShowOverridesFor(tierId)}
              onOpenOfferings={() => setShowOfferingsFor(tierId)}
              onDelete={() => handleDeleteTier(tierId)}
              dragging={draggingTierId}
              onDragStart={setDraggingTierId}
              onDragEnd={() => setDraggingTierId(null)}
              onReorder={handleReorderTiers}
            />
          ))}

          {/* Placeholder card to create a new tier */}
          <div
            onClick={() => { setEditingTierId(null); setShowTierForm(true); }}
            title="Create a new tier"
            style={{
              background: 'transparent', borderRadius: '10px', padding: '16px',
              border: '2px dashed #555', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              minHeight: '150px', color: '#888',
              transition: 'border-color 0.15s, color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = '#f5af19';
              e.currentTarget.style.color = '#f5af19';
              e.currentTarget.style.background = 'rgba(245, 175, 25, 0.05)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = '#555';
              e.currentTarget.style.color = '#888';
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <div style={{ fontSize: '1.8rem', lineHeight: 1, marginBottom: '6px' }}>+</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Create Tier</div>
          </div>
        </div>
      </div>

      {/* Restriction Messages */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <h3 style={{ margin: 0 }}>Restriction Messages</h3>
            <p style={{ color: '#999', margin: '4px 0 0 0', fontSize: '0.8rem' }}>
              Text shown to users in Discord when a tier restriction blocks a command, module, or panel.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleResetMessages}
              disabled={msgSaving || !messages}
              style={{
                background: 'transparent', color: '#999', border: '1px solid #555',
                padding: '8px 14px', borderRadius: '6px',
                cursor: (msgSaving || !messages) ? 'not-allowed' : 'pointer',
                fontSize: '0.8rem',
              }}
            >Reset to Defaults</button>
            <button
              onClick={handleSaveMessages}
              disabled={msgSaving || !msgDirty}
              style={{
                background: (msgSaving || !msgDirty) ? '#555' : '#3ba55d', color: '#fff', border: 'none',
                padding: '8px 18px', borderRadius: '6px',
                cursor: (msgSaving || !msgDirty) ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: '0.82rem',
              }}
            >{msgSaving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>

        {!messages ? (
          <div style={{ color: '#888', fontSize: '0.85rem' }}>Loading…</div>
        ) : (
          <div style={{ display: 'grid', gap: '10px' }}>
            {[
              { key: 'moduleBlocked', label: 'Module blocked', help: 'Command run from a module disabled for the tier.' },
              { key: 'commandBlocked', label: 'Command blocked', help: 'Specific command disabled for the guild\u2019s tier.' },
              { key: 'panelBlocked', label: 'Panel blocked', help: 'Discord panel opened from a disabled module.' },
            ].map(({ key, label, help }) => {
              const value = msgDraft[key] ?? '';
              const defaultValue = messageDefaults && messageDefaults[key];
              const isDefault = defaultValue != null && value === defaultValue;
              return (
                <div key={key} style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                  gap: '10px',
                  alignItems: 'start',
                }}>
                  {/* Left: label + input + restore link */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', marginBottom: '3px' }}>
                      <label style={{ color: '#ddd', fontSize: '0.82rem', fontWeight: 600 }} title={help}>
                        {label}
                      </label>
                      {defaultValue != null && !isDefault && (
                        <button
                          type="button"
                          onClick={() => setMsgDraft(d => ({ ...d, [key]: defaultValue }))}
                          title={`Restore default: ${defaultValue}`}
                          style={{
                            background: 'transparent', border: 'none', padding: 0,
                            color: '#7289da', fontSize: '0.72rem', cursor: 'pointer',
                            textDecoration: 'underline',
                          }}
                        >Restore default</button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={value}
                      onChange={e => setMsgDraft(d => ({ ...d, [key]: e.target.value }))}
                      placeholder={defaultValue || ''}
                      style={{
                        width: '100%', padding: '7px 10px', background: '#1a1a1a',
                        border: '1px solid #444', borderRadius: '6px', color: '#e0e0e0',
                        fontSize: '0.85rem', fontFamily: 'inherit', boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  {/* Right: live preview */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: '#888', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '3px' }}>
                      Preview
                    </div>
                    <RestrictionMessagePreview text={value} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Coupons */}
      <div style={sectionStyle}>
        <div style={{ marginBottom: '12px' }}>
          <h3 style={{ margin: 0 }}>Coupons</h3>
          <p style={{ color: '#999', margin: '4px 0 0 0', fontSize: '0.8rem' }}>
            Admin-defined discount codes. Each coupon is either a percent off or a number of extra subscription days.
            Only providers whose capabilities include "coupons" (currently: Dummy) accept them at checkout.
          </p>
        </div>

        {/* Existing coupons list */}
        {couponsLoaded && Object.keys(coupons).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {Object.entries(coupons).map(([code, c]) => {
              const effect = typeof c.percentOff === 'number'
                ? `${c.percentOff}% off`
                : typeof c.extraDays === 'number'
                  ? `+${c.extraDays} days`
                  : 'no effect';
              const usage = typeof c.maxUses === 'number'
                ? `${c.usedCount || 0} / ${c.maxUses} used`
                : `${c.usedCount || 0} uses`;
              const expired = c.expiresAt && Date.parse(c.expiresAt) < Date.now();
              const scopeText = c.allowedTiers && c.allowedTiers.length > 0
                ? c.allowedTiers.map(id => tiers[id]?.displayName || id).join(', ')
                : 'All tiers';
              const isRestricted = !!(c.allowedTiers && c.allowedTiers.length > 0);
              return (
                <div key={code} style={{
                  background: '#36393f', borderRadius: '8px', padding: '10px 14px',
                  display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(110px, auto) minmax(130px, auto) minmax(110px, auto) minmax(120px, auto) auto',
                  gap: '12px', alignItems: 'center',
                  opacity: expired ? 0.5 : 1,
                }}>
                  <div>
                    <div style={{ color: '#fff', fontFamily: 'monospace', fontSize: '0.95rem', fontWeight: 600 }}>{code}</div>
                    {c.description && <div style={{ color: '#888', fontSize: '0.72rem', marginTop: '2px' }}>{c.description}</div>}
                  </div>
                  <div style={{ color: '#3ba55d', fontSize: '0.85rem', fontWeight: 500 }}>{effect}</div>
                  <div style={{
                    color: isRestricted ? '#f5af19' : '#888',
                    fontSize: '0.78rem',
                    background: isRestricted ? 'rgba(245, 175, 25, 0.1)' : 'transparent',
                    padding: isRestricted ? '2px 8px' : 0,
                    borderRadius: '10px',
                    border: isRestricted ? '1px solid rgba(245, 175, 25, 0.3)' : 'none',
                    display: 'inline-block',
                  }} title={isRestricted ? `Only valid for: ${scopeText}` : 'Applies to every tier'}>
                    {scopeText}
                  </div>
                  <div style={{ color: '#aaa', fontSize: '0.78rem' }}>{usage}</div>
                  <div style={{ color: expired ? '#ed4245' : '#888', fontSize: '0.78rem' }}>
                    {c.expiresAt
                      ? (expired ? 'Expired' : `Expires ${new Date(c.expiresAt).toLocaleDateString()}`)
                      : 'No expiry'}
                  </div>
                  <button onClick={() => handleDeleteCoupon(code)} style={{
                    background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                    padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.72rem',
                  }}>Delete</button>
                </div>
              );
            })}
          </div>
        )}

        {/* New coupon form */}
        <div style={{
          background: '#36393f', borderRadius: '8px', padding: '12px 14px',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px',
        }}>
          <div>
            <label style={{ display: 'block', color: '#aaa', fontSize: '0.72rem', marginBottom: '4px' }}>Code</label>
            <input type="text" value={newCouponDraft.code}
              onChange={e => setNewCouponDraft(d => ({ ...d, code: e.target.value }))}
              placeholder="e.g. LAUNCH50" style={couponInputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', color: '#aaa', fontSize: '0.72rem', marginBottom: '4px' }}>Effect</label>
            <select value={newCouponDraft.kind}
              onChange={e => setNewCouponDraft(d => ({ ...d, kind: e.target.value }))}
              style={couponInputStyle}>
              <option value="percentOff">Percent off</option>
              <option value="extraDays">Extra days</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', color: '#aaa', fontSize: '0.72rem', marginBottom: '4px' }}>
              {newCouponDraft.kind === 'percentOff' ? 'Percent (1-100)' : 'Extra days (>=1)'}
            </label>
            <input type="number" min="1" max={newCouponDraft.kind === 'percentOff' ? '100' : undefined}
              value={newCouponDraft.value}
              onChange={e => setNewCouponDraft(d => ({ ...d, value: e.target.value }))}
              style={couponInputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', color: '#aaa', fontSize: '0.72rem', marginBottom: '4px' }}>Max uses <span style={{ color: '#555' }}>(optional)</span></label>
            <input type="number" min="1" value={newCouponDraft.maxUses}
              onChange={e => setNewCouponDraft(d => ({ ...d, maxUses: e.target.value }))}
              placeholder="Unlimited" style={couponInputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', color: '#aaa', fontSize: '0.72rem', marginBottom: '4px' }}>Expires <span style={{ color: '#555' }}>(optional)</span></label>
            <input type="date" value={newCouponDraft.expiresAt}
              onChange={e => setNewCouponDraft(d => ({ ...d, expiresAt: e.target.value }))}
              style={couponInputStyle} />
          </div>
          {/* Applies to (tier scope) */}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', color: '#aaa', fontSize: '0.72rem', marginBottom: '6px' }}>Applies to</label>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ddd', fontSize: '0.82rem', cursor: 'pointer' }}>
                <input type="radio" name="coupon-scope" checked={newCouponDraft.scope === 'global'}
                  onChange={() => setNewCouponDraft(d => ({ ...d, scope: 'global', allowedTiers: [] }))}
                  style={{ accentColor: '#5865F2' }} />
                All tiers <span style={{ color: '#666', fontSize: '0.72rem' }}>(global)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ddd', fontSize: '0.82rem', cursor: 'pointer' }}>
                <input type="radio" name="coupon-scope" checked={newCouponDraft.scope === 'restricted'}
                  onChange={() => setNewCouponDraft(d => ({ ...d, scope: 'restricted' }))}
                  style={{ accentColor: '#5865F2' }} />
                Restrict to specific tiers
              </label>
            </div>
            {newCouponDraft.scope === 'restricted' && (
              <div style={{
                marginTop: '8px', padding: '8px 10px', background: '#1a1a1a',
                border: '1px solid #333', borderRadius: '4px',
                display: 'flex', flexWrap: 'wrap', gap: '8px 14px',
              }}>
                {Object.entries(tiers).filter(([id]) => id !== 'free').length === 0 ? (
                  <span style={{ color: '#888', fontSize: '0.8rem' }}>No non-Free tiers exist yet; create one first.</span>
                ) : Object.entries(tiers).filter(([id]) => id !== 'free').map(([id, t]) => {
                  const checked = newCouponDraft.allowedTiers.includes(id);
                  return (
                    <label key={id} style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ddd', fontSize: '0.8rem', cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked}
                        onChange={e => {
                          setNewCouponDraft(d => ({
                            ...d,
                            allowedTiers: e.target.checked
                              ? [...d.allowedTiers, id]
                              : d.allowedTiers.filter(x => x !== id),
                          }));
                        }}
                        style={{ accentColor: '#5865F2' }} />
                      {t.displayName || id}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '10px', alignItems: 'end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', color: '#aaa', fontSize: '0.72rem', marginBottom: '4px' }}>Description <span style={{ color: '#555' }}>(optional)</span></label>
              <input type="text" value={newCouponDraft.description}
                onChange={e => setNewCouponDraft(d => ({ ...d, description: e.target.value }))}
                placeholder="Internal note, e.g. 'Launch promo'" style={couponInputStyle} />
            </div>
            <button onClick={handleSaveCoupon} disabled={couponSaving} style={{
              background: couponSaving ? '#555' : 'linear-gradient(135deg, #3ba55d, #2d8049)',
              color: '#fff', border: 'none', padding: '8px 20px', borderRadius: '6px',
              cursor: couponSaving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.85rem',
              whiteSpace: 'nowrap',
            }}>{couponSaving ? 'Saving...' : 'Add Coupon'}</button>
          </div>
        </div>
      </div>

      {/* Guild Subscriptions */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <div>
            <h3 style={{ margin: 0 }}>Guild Subscriptions</h3>
            <p style={{ color: '#999', margin: '4px 0 0 0', fontSize: '0.8rem' }}>
              Manual subscriptions are managed here. Paid subscriptions are owned by their payment provider and shown read-only.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {subEntries.length > 3 && (
              <input type="text" value={subscriptionSearch} onChange={e => setSubscriptionSearch(e.target.value)}
                placeholder="Search guilds..." style={{
                  padding: '6px 12px', background: '#1a1a1a', border: '1px solid #444',
                  borderRadius: '6px', color: '#e0e0e0', fontSize: '0.85rem', width: '180px',
                }} />
            )}
            <button onClick={() => handleGrantManualOpen(null)} disabled={nonFreeTiers.length === 0} style={{
              background: nonFreeTiers.length === 0 ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
              color: '#fff', border: 'none',
              padding: '8px 14px', borderRadius: '6px',
              cursor: nonFreeTiers.length === 0 ? 'not-allowed' : 'pointer',
              fontWeight: 600, fontSize: '0.82rem',
            }}>+ Grant Manual</button>
          </div>
        </div>

        {botGuilds.length === 0 && guildsLoaded && (
          <div style={{ color: '#666', fontSize: '0.8rem', marginBottom: '12px' }}>
            Bot is not running or has no guilds. You can still grant by guild ID manually.
          </div>
        )}

        {subEntries.length === 0 ? (
          <p style={{ color: '#888', fontSize: '0.85rem' }}>No guild has an active subscription yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filteredSubEntries.map(entry => (
              <div key={entry.guildId} style={{
                background: '#36393f', padding: '12px 14px', borderRadius: '8px',
                display: 'grid',
                gridTemplateColumns: 'minmax(180px, 1.2fr) minmax(110px, 0.8fr) minmax(200px, 1.3fr) minmax(200px, 1.3fr)',
                gap: '12px', alignItems: 'start',
              }}>
                {/* Guild */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  {entry.iconUrl ? (
                    <img src={entry.iconUrl} alt="" style={{ width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: '#444', flexShrink: 0 }} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: '#fff', fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.guildName || <span style={{ fontFamily: 'monospace', color: '#aaa' }}>{entry.guildId}</span>}
                    </div>
                    {entry.guildName && <div style={{ color: '#666', fontSize: '0.72rem', fontFamily: 'monospace' }}>{entry.guildId}</div>}
                  </div>
                </div>

                {/* Effective */}
                <div>
                  <div style={{ color: '#888', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Effective</div>
                  {entry.effective ? (
                    <div>
                      <div style={{ color: '#f5af19', fontSize: '0.85rem', fontWeight: 600 }}>{getTierDisplayName(entry.effective.sub.tierId)}</div>
                      <div style={{ color: '#888', fontSize: '0.72rem' }}>via {entry.effective.source}</div>
                    </div>
                  ) : (
                    <div style={{ color: '#666', fontSize: '0.82rem' }}>Free</div>
                  )}
                </div>

                {/* Manual */}
                <div>
                  <div style={{ color: '#888', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Manual</div>
                  {entry.manual ? (
                    <div>
                      <div style={{ color: '#ddd', fontSize: '0.85rem' }}>
                        {getTierDisplayName(entry.manual.tierId)}
                        <span style={{ color: '#888', marginLeft: '6px', fontSize: '0.78rem' }}>· {formatRemaining(entry.manual)}</span>
                      </div>
                      {entry.manual.notes && (
                        <div style={{ color: '#888', fontSize: '0.72rem', fontStyle: 'italic', marginTop: '2px' }}>{entry.manual.notes}</div>
                      )}
                      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                        <button onClick={() => handleGrantManualOpen(entry.guildId)} style={{
                          background: '#40444b', color: '#ddd', border: 'none', padding: '3px 8px',
                          borderRadius: '4px', cursor: 'pointer', fontSize: '0.72rem',
                        }}>Edit</button>
                        <button onClick={() => handleRevokeManual(entry.guildId)} style={{
                          background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                          padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.72rem',
                        }}>Revoke</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ color: '#666', fontSize: '0.82rem' }}>-</span>
                      <button onClick={() => handleGrantManualOpen(entry.guildId)} style={{
                        background: 'transparent', color: '#7289da', border: '1px solid #7289da',
                        padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.72rem',
                      }}>Grant</button>
                    </div>
                  )}
                </div>

                {/* Paid */}
                <div>
                  <div style={{ color: '#888', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Paid</div>
                  {entry.paid ? (
                    <div>
                      <div style={{ color: '#ddd', fontSize: '0.85rem' }}>
                        {getTierDisplayName(entry.paid.tierId)}
                        <span style={{ color: '#888', marginLeft: '6px', fontSize: '0.78rem' }}>· {formatRemaining(entry.paid)}</span>
                      </div>
                      <div style={{ color: '#888', fontSize: '0.72rem', marginTop: '2px' }}>
                        via {entry.paid.providerId || '?'}
                        {entry.paid.autoRenew === false && entry.paid.status === 'active' && (
                          <span style={{ color: '#e67e22', marginLeft: '6px' }}>(cancelled, running out)</span>
                        )}
                      </div>
                      {entry.paid.couponEffect && (
                        <div style={{ color: '#3ba55d', fontSize: '0.72rem', marginTop: '2px' }}>Coupon: {entry.paid.couponEffect}</div>
                      )}
                    </div>
                  ) : (
                    <div style={{ color: '#666', fontSize: '0.82rem' }}>-</div>
                  )}
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

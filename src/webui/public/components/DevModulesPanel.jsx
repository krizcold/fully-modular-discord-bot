/**
 * Dev Modules Panel - Manage modules in modulesDev/
 *
 * Lists dev module repositories and their modules with reload capability.
 * Simplified version of AppStorePanel without install/uninstall/queue/premium.
 *
 * @TODO Future work:
 * - File-watcher auto-reload (watch modulesDev for changes, trigger reload automatically)
 * - Dev logging (dedicated log stream for dev module compile/load output)
 * - Dependency linking (resolve cross-module deps within modulesDev repos)
 */
const { useState, useEffect, useRef } = React;

function DevModulesPanel() {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState({});
  const [reloadingAll, setReloadingAll] = useState(false);
  const [expandedRepos, setExpandedRepos] = useState(new Set());
  const hasLoadedOnce = useRef(false);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const unsubs = [
      wsClient.on('bot:startup', () => loadData()),
      wsClient.on('bot:shutdown', () => loadData()),
    ];
    return () => unsubs.forEach(u => u && u());
  }, []);

  async function loadData() {
    try {
      if (!hasLoadedOnce.current) setLoading(true);
      const res = await api.get('/devmodules/list');
      if (res.success) {
        setRepos(res.repos || []);
        if (!hasLoadedOnce.current) {
          setExpandedRepos(new Set((res.repos || []).map(r => r.name)));
        }
      }
    } catch (err) {
      showToast('Failed to load dev modules: ' + err.message, 'error');
    } finally {
      setLoading(false);
      hasLoadedOnce.current = true;
    }
  }

  async function handleReload(moduleName) {
    setReloading(prev => ({ ...prev, [moduleName]: true }));
    try {
      const res = await api.post(`/devmodules/${moduleName}/reload`);
      if (res.success) {
        showToast(`${moduleName} reloaded successfully` + (res.duration ? ` (${(res.duration / 1000).toFixed(1)}s)` : ''), 'success');
        loadData();
      } else {
        showToast(`Failed to reload ${moduleName}: ${res.error || 'unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to reload ${moduleName}: ${err.message}`, 'error');
    } finally {
      setReloading(prev => ({ ...prev, [moduleName]: false }));
    }
  }

  async function handleReloadAll() {
    setReloadingAll(true);
    try {
      const res = await api.post('/devmodules/reload-all');
      if (res.success) {
        if (res.message) {
          showToast(res.message, 'info');
        } else {
          const count = res.results ? res.results.filter(r => r.success).length : 0;
          showToast(`Reloaded ${count} dev module${count !== 1 ? 's' : ''}`, 'success');
        }
        loadData();
      } else {
        showToast(`Reload all failed: ${res.error || 'unknown error'}`, 'error');
      }
    } catch (err) {
      showToast('Failed to reload all: ' + err.message, 'error');
    } finally {
      setReloadingAll(false);
    }
  }

  function toggleRepo(repoName) {
    setExpandedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoName)) next.delete(repoName);
      else next.add(repoName);
      return next;
    });
  }

  const totalModules = repos.reduce((sum, r) => sum + r.modules.length, 0);
  const loadedCount = repos.reduce((sum, r) => sum + r.modules.filter(m => m.loaded === true).length, 0);
  const hasAnyLoaded = loadedCount > 0;

  if (loading) {
    return <div className="loading">Loading dev modules...</div>;
  }

  return (
    <div className="panel">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '1.3rem' }}>Dev Modules</h2>
          <span style={{ color: '#888', fontSize: '0.85rem' }}>
            {totalModules} module{totalModules !== 1 ? 's' : ''} across {repos.length} repo{repos.length !== 1 ? 's' : ''}
            {hasAnyLoaded && ` \u00B7 ${loadedCount} loaded`}
          </span>
        </div>
        {hasAnyLoaded && (
          <button
            onClick={handleReloadAll}
            disabled={reloadingAll}
            style={{
              background: reloadingAll ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
              color: '#fff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: reloadingAll ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              fontWeight: 600,
              transition: 'all 0.2s ease',
            }}
          >
            {reloadingAll ? 'Reloading...' : 'Reload All'}
          </button>
        )}
      </div>

      {/* Info banner */}
      <div style={{
        background: '#1a1a2e',
        border: '1px solid #333',
        borderRadius: '8px',
        padding: '12px 16px',
        marginBottom: '20px',
        fontSize: '0.82rem',
        color: '#aaa',
        lineHeight: 1.5,
      }}>
        Dev modules are loaded from <code style={{ background: '#2c2f33', padding: '1px 5px', borderRadius: '3px', color: '#ddd' }}>modulesDev/</code>.
        Each subdirectory should be a git repository containing a <code style={{ background: '#2c2f33', padding: '1px 5px', borderRadius: '3px', color: '#ddd' }}>Modules/</code> folder.
        Changes to module files require a reload to take effect.
      </div>

      {/* Empty state */}
      {repos.length === 0 && (
        <div style={{
          border: '2px dashed #444',
          borderRadius: '10px',
          padding: '40px',
          textAlign: 'center',
          color: '#888',
        }}>
          <div style={{ fontSize: '1.1rem', marginBottom: '10px', color: '#aaa' }}>No dev module repositories found</div>
          <div style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
            Clone a module repository into <code style={{ background: '#2c2f33', padding: '1px 5px', borderRadius: '3px', color: '#ddd' }}>modulesDev/</code> to get started.
            <br />
            Expected structure: <code style={{ background: '#2c2f33', padding: '1px 5px', borderRadius: '3px', color: '#ddd' }}>modulesDev/repo-name/Modules/module-name/module.json</code>
          </div>
        </div>
      )}

      {/* Repo sections */}
      {repos.map(repo => {
        const isExpanded = expandedRepos.has(repo.name);
        const repoLoadedCount = repo.modules.filter(m => m.loaded === true).length;

        return (
          <div key={repo.name} style={{
            background: '#2c2f33',
            borderRadius: '8px',
            marginBottom: '10px',
            overflow: 'hidden',
          }}>
            {/* Repo header */}
            <div
              onClick={() => toggleRepo(repo.name)}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: isExpanded ? '1px solid #444' : 'none',
                userSelect: 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ color: '#666', fontSize: '0.8rem', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>&#9654;</span>
                <span style={{ color: '#fff', fontWeight: 600 }}>{repo.name}</span>
                <span style={{
                  background: '#1a1a1a',
                  color: '#888',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontSize: '0.75rem',
                }}>
                  {repo.modules.length} module{repo.modules.length !== 1 ? 's' : ''}
                </span>
                {repoLoadedCount > 0 && (
                  <span style={{
                    background: 'rgba(59, 165, 93, 0.15)',
                    color: '#3ba55d',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    fontSize: '0.75rem',
                  }}>
                    {repoLoadedCount} loaded
                  </span>
                )}
              </div>
            </div>

            {/* Module cards grid */}
            {isExpanded && (
              <div style={{
                padding: '16px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: '15px',
              }}>
                {repo.modules.length === 0 ? (
                  <div style={{ color: '#666', fontSize: '0.85rem', padding: '8px' }}>
                    No modules found. Expected structure: <code style={{ background: '#1a1a1a', padding: '1px 5px', borderRadius: '3px' }}>Modules/module-name/module.json</code>
                  </div>
                ) : repo.modules.map(mod => (
                  <DevModuleCard
                    key={mod.name}
                    module={mod}
                    reloading={reloading[mod.name] || false}
                    onReload={() => handleReload(mod.name)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DevModuleCard({ module: mod, reloading: isReloading, onReload }) {
  const borderColor = mod.loaded === true ? '#3ba55d' : mod.loaded === false ? '#555' : '#444';
  const botRunning = mod.loaded !== null;

  return (
    <div style={{
      background: '#36393f',
      borderRadius: '10px',
      padding: '16px',
      border: `1px solid ${borderColor}`,
      transition: 'all 0.2s ease',
      position: 'relative',
    }}>
      {/* Status badge */}
      <div style={{ position: 'absolute', top: '12px', right: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
        {mod.loaded === true && (
          <span style={{
            background: '#3ba55d',
            color: '#fff',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.5px',
          }}>LOADED</span>
        )}
        {mod.loaded === false && (
          <span style={{
            background: '#555',
            color: '#aaa',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.5px',
          }}>NOT LOADED</span>
        )}
        {mod.loaded === null && (
          <span style={{
            background: '#333',
            color: '#666',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.5px',
          }}>UNKNOWN</span>
        )}
      </div>

      {/* Module info */}
      <h3 style={{ margin: '0 0 4px 0', color: '#fff', fontSize: '1rem', paddingRight: '90px' }}>{mod.displayName}</h3>
      {mod.description && (
        <p style={{
          margin: '0 0 12px 0',
          color: '#aaa',
          fontSize: '0.82rem',
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {mod.description}
        </p>
      )}

      {/* Footer: version, category, author, reload button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{
            background: '#1a1a1a',
            color: '#888',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '0.72rem',
          }}>v{mod.version}</span>
          {mod.category && mod.category !== 'misc' && (
            <span style={{
              background: '#1a1a1a',
              color: '#888',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '0.72rem',
            }}>{mod.category}</span>
          )}
          {mod.author && (
            <span style={{ color: '#666', fontSize: '0.75rem' }}>by {mod.author}</span>
          )}
        </div>
        {botRunning && (
          <button
            onClick={(e) => { e.stopPropagation(); onReload(); }}
            disabled={isReloading}
            style={{
              background: isReloading ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
              color: '#fff',
              border: 'none',
              padding: '5px 12px',
              borderRadius: '5px',
              cursor: isReloading ? 'not-allowed' : 'pointer',
              fontSize: '0.78rem',
              fontWeight: 600,
              transition: 'all 0.2s ease',
              whiteSpace: 'nowrap',
            }}
          >
            {isReloading ? 'Reloading...' : 'Reload'}
          </button>
        )}
      </div>
    </div>
  );
}

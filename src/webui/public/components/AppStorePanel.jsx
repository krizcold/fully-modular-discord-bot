// App Store Panel Component - Browse, install, and manage modules
const { useState, useEffect } = React;

function AppStorePanel() {
  const [view, setView] = useState('modules'); // 'modules', 'repos', 'premium', 'detail'
  const [modules, setModules] = useState([]);
  const [installed, setInstalled] = useState({});
  const [repositories, setRepositories] = useState([]);
  const [tiers, setTiers] = useState({});
  const [guildAssignments, setGuildAssignments] = useState({});
  const [selectedModule, setSelectedModule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('all');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      setError(null);
      const [modulesRes, installedRes, reposRes, tiersRes, guildsRes] = await Promise.all([
        api.get('/appstore/modules'),
        api.get('/appstore/installed'),
        api.get('/appstore/repos'),
        api.get('/appstore/premium/tiers'),
        api.get('/appstore/premium/guilds')
      ]);

      setModules(modulesRes.modules || []);
      setInstalled(installedRes.modules || {});
      setRepositories(reposRes.repositories || []);
      setTiers(tiersRes.tiers || {});
      setGuildAssignments(guildsRes.guilds || {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function showSuccess(message) {
    setSuccess(message);
    setTimeout(() => setSuccess(null), 3000);
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
      {error && <div className="error-message" style={{ marginBottom: '15px' }}>{error}</div>}
      {success && <div className="success-message" style={{ marginBottom: '15px' }}>{success}</div>}

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
          onBack={() => { setView('modules'); setSelectedModule(null); }}
          onInstall={loadData}
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
          categories={categories}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          onSelectModule={(m) => { setSelectedModule(m); setView('detail'); }}
          repositories={repositories}
        />
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
function ModulesView({ modules, installed, categories, categoryFilter, onCategoryChange, onSelectModule, repositories }) {
  const installedCount = Object.keys(installed).length;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0 }}>App Store</h2>
          <p style={{ color: '#999', margin: '5px 0 0 0' }}>
            {modules.length} modules available | {installedCount} installed
          </p>
        </div>

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
              onClick={() => onSelectModule(module)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Module Card Component
function ModuleCard({ module, installed, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#2c2f33',
        border: installed ? '2px solid #3ba55d' : '1px solid #444',
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
        <div style={{ display: 'flex', gap: '5px' }}>
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
          {installed && (
            <span style={{
              background: '#3ba55d',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px',
              fontSize: '0.7rem'
            }}>INSTALLED</span>
          )}
        </div>
      </div>

      <p style={{ color: '#aaa', margin: '10px 0', fontSize: '0.9rem', lineHeight: '1.4' }}>
        {module.description || 'No description available'}
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
        <span style={{ color: '#666', fontSize: '0.8rem' }}>v{module.version || '1.0.0'}</span>
        <span style={{ color: '#666', fontSize: '0.8rem' }}>by {module.author || 'Unknown'}</span>
      </div>
    </div>
  );
}

// Module Detail View Component
function ModuleDetailView({ module, installed, onBack, onInstall, onUninstall, onSaveCredentials, showSuccess, setError }) {
  const [installing, setInstalling] = useState(false);
  const [showCredentialsForm, setShowCredentialsForm] = useState(false);
  const [credentials, setCredentials] = useState({});

  async function handleInstall() {
    try {
      setInstalling(true);
      setError(null);
      const res = await api.post(`/appstore/modules/${module.name}/install`);
      if (res.success) {
        showSuccess(`${module.displayName || module.name} installed! Restart bot to activate.`);
        onInstall();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setInstalling(false);
    }
  }

  async function handleUninstall() {
    if (!confirm(`Uninstall ${module.displayName || module.name}? This will remove all module files.`)) return;
    try {
      setInstalling(true);
      setError(null);
      const res = await api.delete(`/appstore/modules/${module.name}`);
      if (res.success) {
        showSuccess(`${module.displayName || module.name} uninstalled.`);
        onUninstall();
        onBack();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setInstalling(false);
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
      <button
        className="button"
        onClick={onBack}
        style={{ marginBottom: '20px', background: '#40444b', border: 'none' }}
      >
        Back to Modules
      </button>

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
          {!installed ? (
            <button
              className="button primary"
              onClick={handleInstall}
              disabled={installing}
              style={{
                background: installing ? '#555' : 'linear-gradient(135deg, #3ba55d, #2d7d46)',
                border: 'none',
                padding: '12px 25px'
              }}
            >
              {installing ? 'Installing...' : 'Install Module'}
            </button>
          ) : (
            <>
              <button
                className="button"
                onClick={handleUninstall}
                disabled={installing}
                style={{
                  background: installing ? '#555' : '#ed4245',
                  border: 'none',
                  padding: '12px 25px'
                }}
              >
                {installing ? 'Processing...' : 'Uninstall'}
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
        showSuccess(`Found ${res.modulesFound || 0} modules`);
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
  const [editingGuild, setEditingGuild] = useState(null);
  const [newGuildId, setNewGuildId] = useState('');
  const [selectedTier, setSelectedTier] = useState('');
  const [processing, setProcessing] = useState(false);

  async function handleAssignTier() {
    if (!newGuildId || !selectedTier) {
      setError('Guild ID and tier are required');
      return;
    }
    try {
      setProcessing(true);
      setError(null);
      const res = await api.put(`/appstore/premium/guilds/${newGuildId}`, { tier: selectedTier });
      if (res.success) {
        showSuccess(`Guild assigned to ${selectedTier} tier`);
        setNewGuildId('');
        setSelectedTier('');
        onRefresh();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setProcessing(false);
    }
  }

  async function handleRemoveAssignment(guildId) {
    if (!confirm('Remove premium tier from this guild?')) return;
    try {
      setError(null);
      const res = await api.delete(`/appstore/premium/guilds/${guildId}`);
      if (res.success) {
        showSuccess('Guild reset to free tier');
        onRefresh();
      }
    } catch (err) {
      setError(err.message);
    }
  }

  const tierList = Object.keys(tiers);

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ margin: 0 }}>Premium Tiers</h2>
        <p style={{ color: '#999', margin: '5px 0 0 0' }}>
          Manage guild premium subscriptions and tier definitions
        </p>
      </div>

      {/* Tier Definitions */}
      <div style={{
        background: '#2c2f33',
        borderRadius: '10px',
        padding: '20px',
        marginBottom: '20px'
      }}>
        <h3 style={{ margin: '0 0 15px 0', color: '#f5af19' }}>Available Tiers</h3>
        {tierList.length === 0 ? (
          <p style={{ color: '#888' }}>No tiers defined. Edit /data/global/premium-tiers.json to add tiers.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '15px' }}>
            {tierList.map(tierName => (
              <div
                key={tierName}
                style={{
                  background: '#1a1a1a',
                  borderRadius: '8px',
                  padding: '15px',
                  border: tierName === 'free' ? '1px solid #555' : '1px solid #f5af19'
                }}
              >
                <h4 style={{ margin: '0 0 5px 0', color: tierName === 'free' ? '#888' : '#f5af19' }}>
                  {tiers[tierName].displayName || tierName}
                </h4>
                <p style={{ margin: 0, color: '#666', fontSize: '0.85rem' }}>
                  Priority: {tiers[tierName].priority || 0}
                </p>
                {Object.keys(tiers[tierName].overrides || {}).length > 0 && (
                  <p style={{ margin: '5px 0 0 0', color: '#888', fontSize: '0.8rem' }}>
                    {Object.keys(tiers[tierName].overrides).length} module overrides
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Assign Guild to Tier */}
      <div style={{
        background: '#2c2f33',
        borderRadius: '10px',
        padding: '20px',
        marginBottom: '20px'
      }}>
        <h3 style={{ margin: '0 0 15px 0' }}>Assign Guild to Tier</h3>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={newGuildId}
            onChange={(e) => setNewGuildId(e.target.value)}
            placeholder="Guild ID (e.g., 123456789012345678)"
            style={{
              flex: 1,
              minWidth: '200px',
              padding: '10px',
              background: '#1a1a1a',
              border: '1px solid #444',
              borderRadius: '6px',
              color: '#e0e0e0'
            }}
          />
          <select
            value={selectedTier}
            onChange={(e) => setSelectedTier(e.target.value)}
            style={{
              padding: '10px 15px',
              background: '#1a1a1a',
              border: '1px solid #444',
              borderRadius: '6px',
              color: '#e0e0e0'
            }}
          >
            <option value="">Select Tier</option>
            {tierList.filter(t => t !== 'free').map(tierName => (
              <option key={tierName} value={tierName}>
                {tiers[tierName].displayName || tierName}
              </option>
            ))}
          </select>
          <button
            className="button"
            onClick={handleAssignTier}
            disabled={processing}
            style={{
              background: processing ? '#555' : '#3ba55d',
              border: 'none',
              padding: '10px 20px'
            }}
          >
            {processing ? 'Processing...' : 'Assign'}
          </button>
        </div>
      </div>

      {/* Current Assignments */}
      <div style={{ background: '#2c2f33', borderRadius: '10px', padding: '20px' }}>
        <h3 style={{ margin: '0 0 15px 0' }}>Guild Assignments</h3>
        {Object.keys(guildAssignments).length === 0 ? (
          <p style={{ color: '#888' }}>No guilds have premium tiers assigned.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {Object.entries(guildAssignments).map(([guildId, tierName]) => (
              <div
                key={guildId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: '#1a1a1a',
                  padding: '12px 15px',
                  borderRadius: '6px'
                }}
              >
                <div>
                  <span style={{ color: '#fff', fontFamily: 'monospace' }}>{guildId}</span>
                  <span style={{
                    marginLeft: '15px',
                    background: 'linear-gradient(135deg, #f5af19, #f12711)',
                    color: '#fff',
                    padding: '2px 10px',
                    borderRadius: '10px',
                    fontSize: '0.8rem'
                  }}>
                    {tiers[tierName]?.displayName || tierName}
                  </span>
                </div>
                <button
                  className="button"
                  onClick={() => handleRemoveAssignment(guildId)}
                  style={{
                    background: '#ed4245',
                    border: 'none',
                    padding: '6px 12px',
                    fontSize: '0.85rem'
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

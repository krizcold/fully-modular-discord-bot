// Panel List Component - Grid view of available panels with category filter

function PanelList({ panels, categoryFilter, onCategoryChange, onSelectPanel, executing, error }) {
  // Get unique categories
  const categories = ['All', ...new Set(panels.map(p => p.category))];

  // Filter panels
  const filteredPanels = categoryFilter === 'All'
    ? panels
    : panels.filter(p => p.category === categoryFilter);

  return (
    <div className="card">
      <h2>🛠️ Admin Panels</h2>
      <p style={{marginBottom: '15px', color: '#999'}}>
        Select a panel to manage bot features and settings
      </p>

      {error && (
        <div className={error === 'bot_not_running' ? 'info-message' : 'error-message'}>
          {error === 'bot_not_running' ? (
            <div>
              <div style={{marginBottom: '10px'}}>
                <strong>⚠️ Bot Not Running</strong>
              </div>
              <div style={{marginBottom: '10px'}}>
                The bot needs to be started before you can use panels.
                Please go to the <strong>Credentials</strong> tab to set up your bot credentials,
                then start the bot from the <strong>Dashboard</strong>.
              </div>
              <div style={{fontSize: '0.9rem', opacity: 0.8}}>
                Once the bot is running, panels will be available here.
              </div>
            </div>
          ) : (
            error
          )}
        </div>
      )}

      {/* Category filter */}
      <div style={{marginBottom: '20px'}}>
        <label style={{display: 'block', marginBottom: '8px', color: '#ccc', fontWeight: '600'}}>
          Filter by Category
        </label>
        <select
          value={categoryFilter}
          onChange={e => onCategoryChange(e.target.value)}
          style={{
            padding: '8px 12px',
            background: '#1a1a1a',
            border: '1px solid #444',
            borderRadius: '5px',
            color: '#e0e0e0',
            fontSize: '0.95rem',
            cursor: 'pointer'
          }}
        >
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {/* Panel grid */}
      {filteredPanels.length === 0 ? (
        <div style={{color: '#999', textAlign: 'center', padding: '40px'}}>
          No panels available
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '12px'
        }}>
          {filteredPanels.map(panel => (
            <PanelCard
              key={panel.id}
              panel={panel}
              onClick={() => onSelectPanel(panel.id)}
              disabled={executing}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Panel Card Component - Individual panel card in grid
function PanelCard({ panel, onClick, disabled }) {
  return (
    <div
      onClick={() => !disabled && onClick()}
      style={{
        background: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: '6px',
        padding: '16px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.2s',
        opacity: disabled ? 0.6 : 1
      }}
      onMouseEnter={e => !disabled && (e.currentTarget.style.borderColor = '#5865F2')}
      onMouseLeave={e => e.currentTarget.style.borderColor = '#333'}
    >
      <div style={{fontSize: '1.5rem', marginBottom: '8px'}}>
        {panel.icon}
      </div>
      <div style={{
        color: '#e0e0e0',
        fontWeight: '600',
        fontSize: '1rem',
        marginBottom: '6px'
      }}>
        {panel.name}
      </div>
      <div style={{color: '#999', fontSize: '0.85rem', lineHeight: '1.4'}}>
        {panel.description}
      </div>
      <div style={{
        marginTop: '10px',
        color: '#5865F2',
        fontSize: '0.8rem',
        fontWeight: '600'
      }}>
        {panel.category}
      </div>
    </div>
  );
}

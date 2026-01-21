// Guild Panels Panel Component - Panel management for guild context

const { useState, useEffect } = React;

function GuildPanelsPanel({ guild, user, onBack }) {
  const [panels, setPanels] = useState([]);
  const [selectedPanel, setSelectedPanel] = useState(null);
  const [selectedPanelInfo, setSelectedPanelInfo] = useState(null);
  const [panelData, setPanelData] = useState(null);
  const [preModalPanelData, setPreModalPanelData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('All');
  // Channel selection for channel-required panels
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [availableChannels, setAvailableChannels] = useState([]);
  const [loadingChannels, setLoadingChannels] = useState(false);

  useEffect(() => {
    loadPanels();
  }, [guild.id]);

  const loadPanels = async () => {
    try {
      setLoading(true);
      setError(null);

      const guildId = guild.id === 'system' ? null : guild.id;
      const result = await guildApi.getPanelList(guildId);

      if (result.success) {
        setPanels(result.panels || []);
      } else {
        setError(result.error || 'Failed to load panels');
      }
    } catch (err) {
      console.error('Error loading panels:', err);
      setError('Failed to load panels');
    } finally {
      setLoading(false);
    }
  };

  // Load channels for a guild (for channel-required panels)
  const loadChannels = async (guildId) => {
    if (!guildId || guildId === 'system') {
      setAvailableChannels([]);
      return;
    }

    try {
      setLoadingChannels(true);
      const result = await guildApi.getChannels(guildId);
      if (result.success) {
        setAvailableChannels(result.channels || []);
      } else {
        console.error('Failed to load channels:', result.error);
        setAvailableChannels([]);
      }
    } catch (err) {
      console.error('Error loading channels:', err);
      setAvailableChannels([]);
    } finally {
      setLoadingChannels(false);
    }
  };

  const handleChannelSelect = (channelId) => {
    setSelectedChannel(channelId || null);
  };

  const handleExecutePanel = async (panelId, channelIdOverride = null) => {
    try {
      setLoading(true);
      setError(null);

      const guildId = guild.id === 'system' ? null : guild.id;

      // Find panel info to check if it requires a channel
      const panelInfo = panels.find(p => p.id === panelId);
      setSelectedPanelInfo(panelInfo);

      // If panel requires channel, load channels for the selector
      if (panelInfo?.requiresChannel && !channelIdOverride) {
        if (guildId) {
          await loadChannels(guildId);
        }
        setSelectedChannel(null);
      }

      // Use the channel ID from override or selected channel
      const channelId = channelIdOverride || selectedChannel;

      const result = await guildApi.executePanel(panelId, guildId, channelId);

      if (result.success) {
        setSelectedPanel(panelId);
        setPanelData(result.panel);
      } else {
        setError(result.error || 'Failed to execute panel');
      }
    } catch (err) {
      console.error('Error executing panel:', err);
      setError('Failed to execute panel');
    } finally {
      setLoading(false);
    }
  };

  const handleButtonClick = async (buttonId) => {
    try {
      setLoading(true);
      setError(null);

      const guildId = guild.id === 'system' ? null : guild.id;
      const result = await guildApi.handleButton(selectedPanel, buttonId, guildId, selectedChannel);

      if (result.success) {
        // Check if response indicates we should return to panel list
        if (result.panel?.returnToPanelList) {
          // Show notification if present before going back
          if (result.panel?.notification) {
            showNotification(result.panel.notification.type, result.panel.notification.message);
          }
          handleBackToList();
          return;
        }
        // If the response contains a modal, save current panel state for cancel restoration
        if (result.panel?.modal) {
          setPreModalPanelData(panelData);
        } else {
          setPreModalPanelData(null);
        }
        setPanelData(result.panel);
      } else {
        setError(result.error || 'Failed to handle button');
      }
    } catch (err) {
      console.error('Error handling button:', err);
      setError('Failed to handle button');
    } finally {
      setLoading(false);
    }
  };

  const handleDropdownChange = async (values, dropdownId) => {
    try {
      setLoading(true);
      setError(null);

      const guildId = guild.id === 'system' ? null : guild.id;
      const result = await guildApi.handleDropdown(selectedPanel, values, guildId, dropdownId, selectedChannel);

      if (result.success) {
        // Check if response indicates we should return to panel list
        if (result.panel?.returnToPanelList) {
          // Show notification if present before going back
          if (result.panel?.notification) {
            showNotification(result.panel.notification.type, result.panel.notification.message);
          }
          handleBackToList();
          return;
        }
        setPanelData(result.panel);
      } else {
        setError(result.error || 'Failed to handle dropdown');
      }
    } catch (err) {
      console.error('Error handling dropdown:', err);
      setError('Failed to handle dropdown');
    } finally {
      setLoading(false);
    }
  };

  const handleModalSubmit = async (modalId, fields) => {
    try {
      setLoading(true);
      setError(null);

      const guildId = guild.id === 'system' ? null : guild.id;
      const result = await guildApi.handleModal(selectedPanel, modalId, fields, guildId, selectedChannel);

      if (result.success) {
        // Check if response indicates we should return to panel list
        if (result.panel?.returnToPanelList) {
          // Show notification if present before going back
          if (result.panel?.notification) {
            showNotification(result.panel.notification.type, result.panel.notification.message);
          }
          handleBackToList();
          return;
        }
        setPanelData(result.panel);
      } else {
        setError(result.error || 'Failed to handle modal');
      }
    } catch (err) {
      console.error('Error handling modal:', err);
      setError('Failed to handle modal');
    } finally {
      setLoading(false);
    }
  };

  const handleBackToList = () => {
    setSelectedPanel(null);
    setSelectedPanelInfo(null);
    setPanelData(null);
    setPreModalPanelData(null);
    setSelectedChannel(null);
    setAvailableChannels([]);
  };

  // Show a temporary notification toast
  const showNotification = (type, message) => {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 15px 20px;
      background: ${type === 'success' ? '#3ba55d' : type === 'error' ? '#ed4245' : type === 'warning' ? '#faa61a' : '#5865f2'};
      color: white;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
      z-index: 10000;
      animation: slideIn 0.3s ease;
      max-width: 400px;
    `;
    notification.textContent = message;

    // Add animation styles if not already present
    if (!document.getElementById('notification-styles')) {
      const style = document.createElement('style');
      style.id = 'notification-styles';
      style.textContent = `
        @keyframes slideIn {
          from { transform: translateX(400px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(400px); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(notification);

    // Remove notification after 3 seconds
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => {
        if (notification.parentNode) {
          document.body.removeChild(notification);
        }
      }, 300);
    }, 3000);
  };

  // Handle modal cancel - restore pre-modal panel state
  const handleModalCancel = () => {
    if (preModalPanelData) {
      setPanelData(preModalPanelData);
      setPreModalPanelData(null);
    } else {
      handleExecutePanel(selectedPanel, selectedChannel);
    }
  };

  // Channel selector component for channel-required panels
  const renderChannelSelector = () => {
    if (!selectedPanelInfo?.requiresChannel) return null;

    const hasGuildContext = guild.id !== 'system';
    const needsChannel = !selectedChannel;

    return (
      <div style={{
        background: needsChannel ? '#2d3748' : '#1a365d',
        border: needsChannel ? '2px solid #ed8936' : '1px solid #2b6cb0',
        borderRadius: '8px',
        padding: '15px',
        marginBottom: '15px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: needsChannel ? '10px' : '0' }}>
          <span>Target Channel:</span>

          {!hasGuildContext ? (
            <span style={{ color: '#feb2b2' }}>System panels do not support channel selection</span>
          ) : loadingChannels ? (
            <span style={{ color: '#a0aec0' }}>Loading...</span>
          ) : availableChannels.length === 0 ? (
            <span style={{ color: '#faf089' }}>No text channels found</span>
          ) : (
            <select
              value={selectedChannel || ''}
              onChange={(e) => handleChannelSelect(e.target.value)}
              disabled={loading}
              style={{
                flex: 1,
                maxWidth: '300px',
                padding: '8px 12px',
                background: '#1a202c',
                color: '#e2e8f0',
                border: '1px solid #4a5568',
                borderRadius: '4px',
                fontSize: '0.95rem'
              }}
            >
              <option value="">-- Select a channel --</option>
              {availableChannels.map(ch => (
                <option key={ch.id} value={ch.id}>
                  #{ch.name} {ch.parentName ? `(${ch.parentName})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {needsChannel && hasGuildContext && availableChannels.length > 0 && (
          <p style={{ color: '#ed8936', margin: 0, fontSize: '0.85rem' }}>
            Select a channel to enable panel interactions
          </p>
        )}
      </div>
    );
  };

  if (error) {
    return (
      <div className="panel-error">
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={loadPanels}>Retry</button>
        <button onClick={onBack}>Back to Guilds</button>
      </div>
    );
  }

  // Determine if interactions should be disabled (channel-required panel without channel selected)
  const interactionsDisabled = selectedPanelInfo?.requiresChannel && !selectedChannel;

  return (
    <div className="guild-panels-panel">
      {/* Guild Header */}
      <div className="guild-panel-header">
        <button onClick={onBack} className="back-button">Back to Guilds</button>
        <div className="guild-header-info">
          <h2>{guild.name}</h2>
          <span className="guild-id">ID: {guild.id}</span>
        </div>
        <div className="user-info-small">
          {user.username}
        </div>
      </div>

      {/* Panel Content */}
      <div className="guild-panel-content">
        {loading && !panelData ? (
          <div className="panel-loading">
            <div className="spinner"></div>
            <p>Loading panels...</p>
          </div>
        ) : selectedPanel && panelData ? (
          <div>
            {/* Channel selector for channel-required panels */}
            {renderChannelSelector()}

            <PanelViewer
              panelData={panelData}
              onButton={handleButtonClick}
              onDropdown={handleDropdownChange}
              onModal={handleModalSubmit}
              onBack={handleBackToList}
              onRefresh={() => handleExecutePanel(selectedPanel, selectedChannel)}
              onModalCancel={handleModalCancel}
              loading={loading}
              disabled={interactionsDisabled}
              guildId={guild.id === 'system' ? null : guild.id}
            />
          </div>
        ) : (
          <div className="panel-list-container">
            <h3>Available Panels</h3>
            <p>Select a panel to manage your guild settings:</p>
            <PanelList
              panels={panels}
              categoryFilter={categoryFilter}
              onCategoryChange={setCategoryFilter}
              onSelectPanel={handleExecutePanel}
              executing={loading}
            />
          </div>
        )}
      </div>
    </div>
  );
}

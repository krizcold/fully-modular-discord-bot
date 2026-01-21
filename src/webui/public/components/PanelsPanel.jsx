// Panels Panel Component - Main container for panel system

function PanelsPanel() {
  const { useState, useEffect } = React;

  const [panels, setPanels] = useState([]);
  const [selectedPanel, setSelectedPanel] = useState(null);
  const [selectedPanelInfo, setSelectedPanelInfo] = useState(null); // Track panel metadata including requiresChannel
  const [panelData, setPanelData] = useState(null);
  const [preModalPanelData, setPreModalPanelData] = useState(null); // Store panel state before modal
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [guildContext, setGuildContext] = useState('main'); // 'system', 'test', 'main'
  const [guildContextOptions, setGuildContextOptions] = useState([]);
  // Channel selection for channel-required panels
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [availableChannels, setAvailableChannels] = useState([]);
  const [loadingChannels, setLoadingChannels] = useState(false);

  useEffect(() => {
    loadGuildContextOptions();
    loadPanels();
  }, []);

  // Subscribe to real-time panel updates via WebSocket
  useEffect(() => {
    if (typeof wsClient === 'undefined') return;

    const unsubscribe = wsClient.on('panel:updated', (data) => {
      // Only update if this panel is currently being viewed
      if (selectedPanel === data.panelId) {
        // Check guild context matches
        const currentContext = guildContextOptions.find(o => o.value === guildContext);
        const currentGuildId = currentContext?.guildId || null;

        if (data.guildId === currentGuildId || data.guildId === null) {
          setPanelData(data.panel);
        }
      }
    });

    return () => unsubscribe();
  }, [selectedPanel, guildContext, guildContextOptions]);

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
          label: '🌐 System Panels',
          guildId: null
        });

        // Test guild context
        if (testGuildId) {
          options.push({
            value: 'test',
            label: `🧪 Test Guild (${testGuildId})`,
            guildId: testGuildId
          });
        }

        // Main guild context (only if different from test guild)
        if (mainGuildId && mainGuildId !== testGuildId) {
          options.push({
            value: 'main',
            label: `🏛️ Main Guild (${mainGuildId})`,
            guildId: mainGuildId
          });
        }

        setGuildContextOptions(options);

        // Set default context to system panels (first option)
        if (options.length > 0) {
          setGuildContext('system');
        }
      }
    } catch (err) {
      console.error('Failed to load guild context options:', err);
    }
  }

  async function loadPanels() {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get('/panels/list');

      if (res.success) {
        setPanels(res.panels || []);
      } else {
        setError(res.error || 'Failed to load panels');
      }
    } catch (err) {
      // Check if it's a 503 error (bot not running)
      if (err.message.includes('503') || err.message.includes('not running')) {
        setError('bot_not_running');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  // Load channels for a guild (for channel-required panels)
  async function loadChannels(guildId) {
    if (!guildId) {
      setAvailableChannels([]);
      return;
    }

    try {
      setLoadingChannels(true);
      const res = await api.get(`/panels/channels?guildId=${guildId}`);
      if (res.success) {
        // Group channels by category (parent)
        const channelsWithCategories = res.channels || [];
        setAvailableChannels(channelsWithCategories);
      } else {
        console.error('Failed to load channels:', res.error);
        setAvailableChannels([]);
      }
    } catch (err) {
      console.error('Error loading channels:', err);
      setAvailableChannels([]);
    } finally {
      setLoadingChannels(false);
    }
  }

  async function executePanel(panelId, channelIdOverride = null) {
    try {
      setExecuting(true);
      setError(null);

      // Get guild ID from current context
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      // Find panel info to check if it requires a channel
      const panelInfo = panels.find(p => p.id === panelId);
      setSelectedPanelInfo(panelInfo);

      // If panel requires channel, load channels for the selector
      if (panelInfo?.requiresChannel && !channelIdOverride) {
        // Load channels for this guild (for the selector dropdown)
        if (guildId) {
          await loadChannels(guildId);
        }
        setSelectedChannel(null); // Reset channel selection
        // Continue to load the panel - it will render with disabled buttons
      }

      // Use the channel ID from override or selected channel
      const channelId = channelIdOverride || selectedChannel;

      const res = await api.post('/panels/execute', {
        panelId,
        userId: 'web-ui-owner', // Web-UI authenticated user
        guildId: guildId, // Pass guild context
        channelId: channelId // Pass channel context
      });

      if (res.success) {
        setSelectedPanel(panelId);
        setPanelData(res.panel);
      } else {
        setError(res.error || 'Failed to execute panel');
      }
    } catch (err) {
      // Detect common error types and provide helpful messages
      if (err.message.includes('503') || err.message.includes('not running')) {
        setError('bot_not_running');
      } else if (err.message.includes('Rate limit')) {
        setError('Please wait a moment before trying again.');
      } else {
        setError(err.message);
      }
    } finally {
      setExecuting(false);
    }
  }

  // Execute panel after channel is selected
  function handleChannelSelect(channelId) {
    setSelectedChannel(channelId);
    if (selectedPanel && channelId) {
      executePanel(selectedPanel, channelId);
    }
  }

  async function handleButton(buttonId) {
    if (!selectedPanel) return;

    try {
      setExecuting(true);
      setError(null);

      // Get guild ID from current context
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      const res = await api.post('/panels/button', {
        panelId: selectedPanel,
        buttonId,
        userId: 'web-ui-owner', // Web-UI authenticated user
        guildId: guildId, // Pass guild context
        channelId: selectedChannel // Pass channel context
      });

      if (res.success) {
        // Check if response indicates we should return to panel list
        if (res.panel?.returnToPanelList) {
          // Show notification if present before going back
          if (res.panel?.notification) {
            showNotification(res.panel.notification.type, res.panel.notification.message);
          }
          goBack();
          return;
        }
        // If the response contains a modal, save current panel state for cancel restoration
        if (res.panel?.modal) {
          setPreModalPanelData(panelData);
        } else {
          // Clear pre-modal state when showing regular panel
          setPreModalPanelData(null);
        }
        setPanelData(res.panel);
      } else {
        setError(res.error || 'Failed to handle button');
      }
    } catch (err) {
      // Detect common error types and provide helpful messages
      if (err.message.includes('Rate limit')) {
        setError('Please wait a moment before trying again.');
      } else {
        setError(err.message);
      }
    } finally {
      setExecuting(false);
    }
  }

  async function handleDropdown(values, dropdownId) {
    if (!selectedPanel) return;

    try {
      setExecuting(true);
      setError(null);

      // Get guild ID from current context
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      const res = await api.post('/panels/dropdown', {
        panelId: selectedPanel,
        values,
        dropdownId, // Include dropdown customId for proper routing
        userId: 'web-ui-owner', // Web-UI authenticated user
        guildId: guildId, // Pass guild context
        channelId: selectedChannel // Pass channel context
      });

      if (res.success) {
        setPanelData(res.panel);
      } else {
        setError(res.error || 'Failed to handle dropdown');
      }
    } catch (err) {
      // Detect common error types and provide helpful messages
      if (err.message.includes('Rate limit')) {
        setError('Please wait a moment before trying again.');
      } else {
        setError(err.message);
      }
    } finally {
      setExecuting(false);
    }
  }

  async function handleModal(modalId, fields) {
    if (!selectedPanel) return;

    try {
      setExecuting(true);
      setError(null);

      // Get guild ID from current context
      const currentContext = guildContextOptions.find(o => o.value === guildContext);
      const guildId = currentContext?.guildId || null;

      const res = await api.post('/panels/modal', {
        panelId: selectedPanel,
        modalId,
        fields,
        userId: 'web-ui-owner', // Web-UI authenticated user
        guildId: guildId, // Pass guild context
        channelId: selectedChannel // Pass channel context
      });

      if (res.success) {
        // Check if this is a success message (title starts with ✅)
        if (res.panel?.embeds?.[0]?.title?.startsWith('✅') ||
            res.panel?.embeds?.[0]?.title?.startsWith('Config Saved')) {

          // Show success message as a temporary notification
          const message = res.panel.embeds[0].description || 'Configuration saved successfully';
          showNotification('success', message);

          // Return to the previous panel view after a short delay
          setTimeout(() => {
            // Re-execute the panel to return to config view
            executePanel(selectedPanel);
          }, 500);

        } else {
          // Normal panel response - show it
          setPanelData(res.panel);
        }
      } else {
        setError(res.error || 'Failed to handle modal');
      }
    } catch (err) {
      // Detect common error types and provide helpful messages
      if (err.message.includes('Rate limit')) {
        setError('Please wait a moment before trying again.');
      } else {
        setError(err.message);
      }
    } finally {
      setExecuting(false);
    }
  }

  // Show a temporary notification
  function showNotification(type, message) {
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 15px 20px;
      background: ${type === 'success' ? '#3ba55d' : '#ed4245'};
      color: white;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
      z-index: 10000;
      animation: slideIn 0.3s ease;
      max-width: 400px;
    `;
    notification.textContent = message;

    // Add animation styles
    const style = document.createElement('style');
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

    document.body.appendChild(notification);

    // Remove notification after 3 seconds
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => {
        document.body.removeChild(notification);
        document.head.removeChild(style);
      }, 300);
    }, 3000);
  }

  function goBack() {
    setSelectedPanel(null);
    setSelectedPanelInfo(null);
    setPanelData(null);
    setPreModalPanelData(null);
    setSelectedChannel(null);
    setAvailableChannels([]);
  }

  // Handle modal cancel - restore pre-modal panel state
  function handleModalCancel() {
    if (preModalPanelData) {
      // Restore the panel state from before the modal was shown
      setPanelData(preModalPanelData);
      setPreModalPanelData(null);
    } else {
      // Fallback to refreshing the panel if no pre-modal state
      executePanel(selectedPanel);
    }
  }

  if (loading) {
    return <div className="loading">Loading panels...</div>;
  }

  // Channel selector component for channel-required panels
  const renderChannelSelector = () => {
    if (!selectedPanelInfo?.requiresChannel) return null;

    const currentContext = guildContextOptions.find(o => o.value === guildContext);
    const hasGuildContext = currentContext && currentContext.guildId !== null;
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
          <span>📍</span>
          <span style={{ color: '#e2e8f0', fontWeight: '500' }}>Target Channel:</span>

          {!hasGuildContext ? (
            <span style={{ color: '#feb2b2' }}>Select a guild context first</span>
          ) : loadingChannels ? (
            <span style={{ color: '#a0aec0' }}>Loading...</span>
          ) : availableChannels.length === 0 ? (
            <span style={{ color: '#faf089' }}>No text channels found</span>
          ) : (
            <select
              value={selectedChannel || ''}
              onChange={(e) => handleChannelSelect(e.target.value)}
              disabled={executing}
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
            ⚠️ Select a channel to enable panel interactions
          </p>
        )}
      </div>
    );
  };

  // If viewing a panel, show PanelViewer
  if (selectedPanel && panelData) {
    // Determine if interactions should be disabled (channel-required panel without channel selected)
    const interactionsDisabled = selectedPanelInfo?.requiresChannel && !selectedChannel;

    return (
      <div className="panel">
        {/* Channel selector for channel-required panels */}
        {renderChannelSelector()}

        <PanelViewer
          panelData={panelData}
          onButton={handleButton}
          onDropdown={handleDropdown}
          onModal={handleModal}
          onBack={goBack}
          onRefresh={() => executePanel(selectedPanel, selectedChannel)}
          onModalCancel={handleModalCancel}
          executing={executing}
          error={error}
          disabled={interactionsDisabled}
          guildId={guildContextOptions.find(o => o.value === guildContext)?.guildId}
        />
      </div>
    );
  }

  // Otherwise show panel list
  return (
    <PanelList
      panels={panels}
      categoryFilter={categoryFilter}
      onCategoryChange={setCategoryFilter}
      onSelectPanel={executePanel}
      executing={executing}
      error={error}
      guildContext={guildContext}
      guildContextOptions={guildContextOptions}
      onGuildContextChange={setGuildContext}
    />
  );
}

// Panel List Component - Shows available panels
function PanelList({ panels, categoryFilter, onCategoryChange, onSelectPanel, executing, error, guildContext, guildContextOptions, onGuildContextChange }) {
  // Separate panels by scope
  const systemPanels = panels.filter(p => p.scope === 'system');
  const guildPanels = panels.filter(p => p.scope === 'guild' || !p.scope);

  // Check if a guild context is selected (not 'system' which has null guildId)
  const currentContextOption = guildContextOptions.find(o => o.value === guildContext);
  const hasGuildContext = currentContextOption && currentContextOption.guildId !== null;

  // Get categories for each scope
  const systemCategories = ['All', ...new Set(systemPanels.map(p => p.category).filter(Boolean))];
  const guildCategories = ['All', ...new Set(guildPanels.map(p => p.category).filter(Boolean))];

  // Filter panels based on category
  const filteredSystemPanels = categoryFilter === 'All'
    ? systemPanels
    : systemPanels.filter(p => p.category === categoryFilter);

  const filteredGuildPanels = categoryFilter === 'All'
    ? guildPanels
    : guildPanels.filter(p => p.category === categoryFilter);

  return (
    <div className="panel">
      <h2>Administration Panels</h2>
      <p style={{ marginBottom: '20px', color: '#999' }}>
        Manage bot settings through system-wide and guild-specific panels.
      </p>

      {/* Guild Context Selector - Always show if options are available */}
      {guildContextOptions && guildContextOptions.length > 0 && (
        <div style={{ marginBottom: '25px', background: '#2a2a2a', padding: '15px', borderRadius: '8px', border: '1px solid #444' }}>
          <label style={{ display: 'block', marginBottom: '10px', color: '#fff', fontWeight: '600', fontSize: '0.95rem' }}>
            📍 Panel Context
          </label>
          <p style={{ fontSize: '0.85rem', color: '#999', marginBottom: '10px' }}>
            Select which guild context to use for panel execution. System panels ignore this setting.
          </p>
          <select
            value={guildContext}
            onChange={(e) => onGuildContextChange(e.target.value)}
            disabled={executing}
            style={{
              padding: '10px 12px',
              background: '#1a1a1a',
              border: '1px solid #555',
              borderRadius: '6px',
              color: '#e0e0e0',
              fontSize: '0.95rem',
              cursor: executing ? 'not-allowed' : 'pointer',
              width: '100%',
              fontWeight: '500'
            }}
          >
            {guildContextOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {error === 'bot_not_running' ? (
        <div className="error-message" style={{ marginBottom: '20px' }}>
          ⚠️ Bot is not running. Please start the bot from the Dashboard tab to use panels.
        </div>
      ) : error ? (
        <div className="error-message" style={{ marginBottom: '20px' }}>{error}</div>
      ) : null}

      {/* System Panels Section - Only show when System context is selected */}
      {systemPanels.length > 0 && !hasGuildContext && (
        <div style={{ marginBottom: '40px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: '20px',
            paddingBottom: '10px',
            borderBottom: '2px solid #5865F2'
          }}>
            <h3 style={{
              margin: 0,
              fontSize: '1.3rem',
              color: '#fff',
              fontWeight: '600'
            }}>
              ⚙️ System Panels
            </h3>
            <span style={{
              marginLeft: '15px',
              padding: '3px 10px',
              background: 'linear-gradient(135deg, #5865F2, #4752C4)',
              borderRadius: '12px',
              fontSize: '0.8rem',
              fontWeight: '500',
              color: '#fff'
            }}>
              Owner Only
            </span>
          </div>

          <p style={{ color: '#999', marginBottom: '15px', fontSize: '0.95rem' }}>
            Bot-wide configuration and management. These settings affect all guilds.
          </p>

          <div className="panel-list">
            {filteredSystemPanels.map(panel => (
              <button
                key={panel.id}
                className="button"
                onClick={() => onSelectPanel(panel.id)}
                disabled={executing}
                style={{
                  display: 'block',
                  width: '100%',
                  marginBottom: '10px',
                  padding: '12px',
                  textAlign: 'left',
                  background: 'linear-gradient(135deg, #2c2f33 0%, #2a2d35 100%)',
                  border: '1px solid #5865F2',
                  borderRadius: '8px',
                  cursor: executing ? 'wait' : 'pointer',
                  opacity: executing ? 0.7 : 1,
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateX(5px)';
                  e.currentTarget.style.borderColor = '#7983F5';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateX(0)';
                  e.currentTarget.style.borderColor = '#5865F2';
                }}
              >
                <strong style={{ color: '#fff' }}>{panel.name || panel.id}</strong>
                {panel.description && (
                  <div style={{ fontSize: '0.9em', color: '#aaa', marginTop: '4px' }}>
                    {panel.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Guild Panels Section - Only show if a guild context is selected */}
      {guildPanels.length > 0 && hasGuildContext && (
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: '20px',
            paddingBottom: '10px',
            borderBottom: '2px solid #3ba55d'
          }}>
            <h3 style={{
              margin: 0,
              fontSize: '1.3rem',
              color: '#fff',
              fontWeight: '600'
            }}>
              🏛️ Guild Panels
            </h3>
            <span style={{
              marginLeft: '15px',
              padding: '3px 10px',
              background: 'linear-gradient(135deg, #3ba55d, #2d7d46)',
              borderRadius: '12px',
              fontSize: '0.8rem',
              fontWeight: '500',
              color: '#fff'
            }}>
              Per-Guild Settings
            </span>
          </div>

          <p style={{ color: '#999', marginBottom: '15px', fontSize: '0.95rem' }}>
            Guild-specific configuration. These settings only affect the selected guild.
          </p>

          {/* Category Filter */}
          {guildCategories.length > 1 && (
            <div style={{ marginBottom: '20px' }}>
              <label style={{ marginRight: '10px' }}>Filter by category:</label>
              <select
                value={categoryFilter}
                onChange={(e) => onCategoryChange(e.target.value)}
                style={{
                  padding: '8px',
                  borderRadius: '4px',
                  backgroundColor: '#40444b',
                  color: '#fff',
                  border: '1px solid #202225'
                }}
              >
                {guildCategories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
          )}

          <div className="panel-list">
            {filteredGuildPanels.map(panel => (
              <button
                key={panel.id}
                className="button"
                onClick={() => onSelectPanel(panel.id)}
                disabled={executing}
                style={{
                  display: 'block',
                  width: '100%',
                  marginBottom: '10px',
                  padding: '12px',
                  textAlign: 'left',
                  backgroundColor: '#2c2f33',
                  border: '1px solid #3ba55d',
                  borderRadius: '8px',
                  cursor: executing ? 'wait' : 'pointer',
                  opacity: executing ? 0.7 : 1,
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateX(5px)';
                  e.currentTarget.style.borderColor = '#48c774';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateX(0)';
                  e.currentTarget.style.borderColor = '#3ba55d';
                }}
              >
                <strong style={{ color: '#fff' }}>{panel.name || panel.id}</strong>
                {panel.description && (
                  <div style={{ fontSize: '0.9em', color: '#aaa', marginTop: '4px' }}>
                    {panel.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* No panels message */}
      {panels.length === 0 && (
        <div style={{ color: '#888', marginTop: '20px', textAlign: 'center' }}>
          No panels available. {error !== 'bot_not_running' && 'Make sure the bot is running.'}
        </div>
      )}
    </div>
  );
}

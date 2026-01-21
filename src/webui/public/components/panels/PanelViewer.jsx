// Panel Viewer Component - Renders panel content with embeds and components
// Shared between Main Web-UI and Guild Web-UI

function PanelViewer({ panelData, onButton, onDropdown, onModal, onBack, onRefresh, onModalCancel, executing, error, disabled, guildId }) {
  const { useState, useEffect } = React;
  const [notification, setNotification] = useState(null);

  // Show notification when panelData has one
  useEffect(() => {
    if (panelData?.notification) {
      setNotification(panelData.notification);
      // Auto-dismiss after 5 seconds
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [panelData?.notification]);

  const notificationStyles = {
    error: { background: '#ff4444', borderColor: '#cc0000' },
    warning: { background: '#ffbb33', borderColor: '#ff8800', color: '#000' },
    success: { background: '#00C851', borderColor: '#007E33' },
    info: { background: '#33b5e5', borderColor: '#0099CC' }
  };

  const notificationIcons = {
    error: '❌',
    warning: '⚠️',
    success: '✅',
    info: 'ℹ️'
  };

  return (
    <div className="panel">
      {/* Notification Toast */}
      {notification && (
        <div
          className="panel-notification"
          style={{
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '15px 20px',
            borderRadius: '8px',
            border: '2px solid',
            color: '#fff',
            zIndex: 10000,
            maxWidth: '400px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            animation: 'slideIn 0.3s ease-out',
            ...notificationStyles[notification.type]
          }}
          onClick={() => setNotification(null)}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
            <span style={{ fontSize: '1.2rem' }}>{notificationIcons[notification.type]}</span>
            <div>
              {notification.title && (
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{notification.title}</div>
              )}
              <div>{notification.message}</div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setNotification(null); }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: '0 0 0 10px',
                fontSize: '1.2rem',
                opacity: 0.7
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}

      <button
        className="button secondary"
        onClick={onBack}
        disabled={executing}
        style={{ marginBottom: '15px' }}
      >
        ← Back to Panels
      </button>

      {error && (
        <div className="error-message" style={{ marginBottom: '15px' }}>{error}</div>
      )}

      <PanelRenderer
        panel={panelData}
        onButton={onButton}
        onDropdown={onDropdown}
        onModal={onModal}
        onRefresh={onRefresh}
        onModalCancel={onModalCancel}
        executing={executing}
        disabled={disabled}
        guildId={guildId}
      />
    </div>
  );
}

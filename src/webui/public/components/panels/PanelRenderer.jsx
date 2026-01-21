// Panel Renderer Components - Shared between Main Web-UI and Guild Web-UI

// Panel Renderer - Renders panel content, embeds, and components
// Supports both V1 (embeds) and V2 (containers) formats
function PanelRenderer({ panel, onButton, onDropdown, onModal, onRefresh, onModalCancel, executing, disabled, guildId }) {
  if (!panel) return null;

  // Combine executing state with disabled prop (e.g., when channel not selected)
  const isDisabled = executing || disabled;

  // If panel has a modal, render it as a form instead of regular components
  if (panel.modal) {
    return (
      <ModalRenderer
        modal={panel.modal}
        onSubmit={onModal}
        onCancel={onModalCancel || onRefresh}
        executing={executing}
        guildId={guildId}
      />
    );
  }

  // V2 Response - render containers
  if (panel.isV2 && panel.containers) {
    return (
      <div className="panel-content panel-v2">
        {panel.containers.map((container, idx) => (
          <V2Container
            key={idx}
            container={container}
            onButton={onButton}
            onDropdown={onDropdown}
            disabled={isDisabled}
            resolvedUsers={panel.resolvedUsers}
          />
        ))}
      </div>
    );
  }

  // V1 Response - render embeds and components
  return (
    <div className="panel-content">
      {panel.content && (
        <div style={{ marginBottom: '15px', whiteSpace: 'pre-wrap' }}>
          {panel.content}
        </div>
      )}

      {panel.embeds && panel.embeds.map((embed, idx) => (
        <PanelEmbed key={idx} embed={embed} resolvedUsers={panel.resolvedUsers} />
      ))}

      {panel.components && panel.components.map((row, rowIdx) => (
        <PanelActionRow
          key={rowIdx}
          row={row}
          onButton={onButton}
          onDropdown={onDropdown}
          disabled={isDisabled}
        />
      ))}
    </div>
  );
}

// ============================================================================
// V2 Components
// ============================================================================

// V2 Container - wrapper with accent color
function V2Container({ container, onButton, onDropdown, disabled, resolvedUsers }) {
  const accentColor = container.accentColor
    ? '#' + container.accentColor.toString(16).padStart(6, '0')
    : '#5865F2';

  return (
    <div style={{
      backgroundColor: '#2f3136',
      borderLeft: '4px solid ' + accentColor,
      borderRadius: '4px',
      padding: '16px',
      marginBottom: '16px',
    }}>
      {container.components && container.components.map((comp, idx) => (
        <V2Component
          key={idx}
          component={comp}
          onButton={onButton}
          onDropdown={onDropdown}
          disabled={disabled}
          resolvedUsers={resolvedUsers}
        />
      ))}
    </div>
  );
}

// V2 Component Router
function V2Component({ component, onButton, onDropdown, disabled, resolvedUsers }) {
  // Safety check
  if (!component || !component.type) {
    return null;
  }

  switch (component.type) {
    case 'text_display':
      return <V2TextDisplay content={component.content} resolvedUsers={resolvedUsers} />;

    case 'separator':
      return <V2Separator spacing={component.spacing} divider={component.divider} />;

    case 'section':
      return (
        <V2Section
          section={component}
          onButton={onButton}
          disabled={disabled}
          resolvedUsers={resolvedUsers}
        />
      );

    case 'action_row':
      return (
        <PanelActionRow
          row={component}
          onButton={onButton}
          onDropdown={onDropdown}
          disabled={disabled}
        />
      );

    case 'media_gallery':
      return <V2MediaGallery items={component.items} />;

    case 'file':
      return <V2File url={component.url} filename={component.filename} />;

    default:
      return null;
  }
}

// V2 Text Display
function V2TextDisplay({ content, resolvedUsers }) {
  if (!content) return null;

  return (
    <div style={{
      color: '#dcddde',
      fontSize: '14px',
      lineHeight: '1.375',
      marginBottom: '8px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {parseMarkdown(content, resolvedUsers)}
    </div>
  );
}

// V2 Separator
function V2Separator({ spacing, divider }) {
  const pad = spacing === 2 ? '16px' : '8px';

  if (divider === false) {
    return <div style={{ height: pad }} />;
  }

  return (
    <div style={{ padding: pad + ' 0' }}>
      <hr style={{
        border: 'none',
        borderTop: '1px solid #40444b',
        margin: 0,
      }} />
    </div>
  );
}

// V2 Section - text with optional accessory (button or thumbnail)
function V2Section({ section, onButton, disabled, resolvedUsers }) {
  const hasAccessory = section.accessory != null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '16px',
      marginBottom: '8px',
    }}>
      <div style={{ flex: 1 }}>
        {section.textDisplays && section.textDisplays.map((td, idx) => (
          <V2TextDisplay key={idx} content={td.content} resolvedUsers={resolvedUsers} />
        ))}
      </div>

      {hasAccessory && section.accessory.type === 'button' && (
        <V2SectionButton button={section.accessory} onButton={onButton} disabled={disabled} />
      )}

      {hasAccessory && section.accessory.type === 'thumbnail' && (
        <img
          src={section.accessory.url}
          alt={section.accessory.description || ''}
          style={{
            width: '80px',
            height: '80px',
            borderRadius: '4px',
            objectFit: 'cover',
            flexShrink: 0,
          }}
        />
      )}
    </div>
  );
}

// V2 Section Button
function V2SectionButton({ button, onButton, disabled }) {
  const styleMap = {
    1: { bg: '#5865F2', hover: '#4752c4' },
    2: { bg: '#4f545c', hover: '#686d73' },
    3: { bg: '#3ba55c', hover: '#2d7d46' },
    4: { bg: '#ed4245', hover: '#c03537' },
  };
  const colors = styleMap[button.style] || styleMap[2];

  function handleClick() {
    if (disabled || button.disabled || !button.customId) return;

    let buttonId = button.customId;
    const parts = button.customId.split('_');
    const btnIndex = parts.indexOf('btn');
    if (btnIndex !== -1 && btnIndex < parts.length - 1) {
      buttonId = parts.slice(btnIndex + 1).join('_');
    }
    onButton(buttonId);
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled || button.disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '8px 16px',
        backgroundColor: colors.bg,
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        fontSize: '14px',
        fontWeight: 500,
        cursor: disabled || button.disabled ? 'not-allowed' : 'pointer',
        opacity: disabled || button.disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      {button.emoji && (
        button.emoji.id
          ? <img
              src={'https://cdn.discordapp.com/emojis/' + button.emoji.id + (button.emoji.animated ? '.gif' : '.png')}
              alt=""
              style={{ width: '18px', height: '18px' }}
            />
          : <span>{button.emoji.name}</span>
      )}
      {button.label}
    </button>
  );
}

// V2 Media Gallery
function V2MediaGallery({ items }) {
  if (!items || items.length === 0) return null;

  const cols = items.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(150px, 1fr))';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: cols,
      gap: '8px',
      marginBottom: '8px',
    }}>
      {items.map((item, idx) => (
        <img
          key={idx}
          src={item.url}
          alt={item.description || ''}
          style={{
            width: '100%',
            borderRadius: '4px',
            objectFit: 'cover',
          }}
        />
      ))}
    </div>
  );
}

// V2 File
function V2File({ url, filename }) {
  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        backgroundColor: '#40444b',
        borderRadius: '4px',
        color: '#00b0f4',
        textDecoration: 'none',
        marginBottom: '8px',
      }}
    >
      📎 {filename || 'Download'}
    </a>
  );
}

// Modal Renderer - Renders Discord-style modal as a form
function ModalRenderer({ modal, onSubmit, onCancel, executing, guildId }) {
  const { useState, useEffect, useRef } = React;
  const [formValues, setFormValues] = useState({});
  const [fileData, setFileData] = useState({}); // Store file contents for upload fields
  const [validationError, setValidationError] = useState(null);
  const [availableRoles, setAvailableRoles] = useState([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const fileInputRefs = useRef({});

  // Check if modal has role_select components
  const hasRoleSelect = modal.components?.some(row =>
    row.components?.some(c => c.type === 'role_select')
  );

  // Fetch roles when modal has role_select and guildId is available
  useEffect(() => {
    if (hasRoleSelect && guildId) {
      setLoadingRoles(true);
      // Use appropriate API based on context (main UI uses 'api', guild UI uses 'guildApi')
      const fetchRoles = typeof api !== 'undefined'
        ? api.get(`/panels/roles?guildId=${guildId}`)
        : guildApi.getRoles(guildId);

      fetchRoles
        .then(res => {
          if (res.success) {
            setAvailableRoles(res.roles || []);
          }
        })
        .catch(err => console.error('Failed to fetch roles:', err))
        .finally(() => setLoadingRoles(false));
    }
  }, [modal.customId, guildId, hasRoleSelect]);

  // Initialize form values from component defaults
  useEffect(() => {
    const initialValues = {};
    if (modal.components) {
      modal.components.forEach(row => {
        row.components?.forEach(component => {
          if (component.type === 'text_input') {
            initialValues[component.customId] = component.value || '';
          }
        });
      });
    }
    setFormValues(initialValues);
    setFileData({}); // Reset file data when modal changes
  }, [modal.customId]);

  function handleInputChange(customId, value) {
    setFormValues(prev => ({
      ...prev,
      [customId]: value
    }));
    setValidationError(null);
  }

  // Handle file selection
  function handleFileChange(customId, event) {
    const file = event.target.files?.[0];
    if (!file) {
      setFileData(prev => {
        const updated = { ...prev };
        delete updated[customId];
        return updated;
      });
      return;
    }

    // Read file content as text (for JSON files)
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      setFileData(prev => ({
        ...prev,
        [customId]: {
          name: file.name,
          size: file.size,
          type: file.type,
          content: content
        }
      }));
      setValidationError(null);
    };
    reader.onerror = () => {
      setValidationError(`Failed to read file: ${file.name}`);
    };
    reader.readAsText(file);
  }

  function handleSubmit(e) {
    e.preventDefault();
    setValidationError(null);

    // Check for required file uploads
    if (modal.components) {
      for (const row of modal.components) {
        for (const component of (row.components || [])) {
          if (component.type === 'file_upload' && component.required) {
            if (!fileData[component.customId]) {
              setValidationError(`Please select a file for: ${component.label}`);
              return;
            }
          }
        }
      }
    }

    // Validate JSON for config_json fields
    for (const [key, value] of Object.entries(formValues)) {
      if (key === 'config_json') {
        if (!value || value.trim() === '') {
          setValidationError('JSON configuration cannot be empty');
          return;
        }

        try {
          JSON.parse(value);
        } catch (err) {
          setValidationError(`Invalid JSON: ${err.message}`);
          return;
        }
      }
    }

    // Validate uploaded JSON files
    for (const [key, file] of Object.entries(fileData)) {
      if (file.name?.endsWith('.json')) {
        try {
          JSON.parse(file.content);
        } catch (err) {
          setValidationError(`Invalid JSON in ${file.name}: ${err.message}`);
          return;
        }
      }
    }

    // Extract modal ID from custom ID (format: panel_{panelId}_modal_{modalId})
    const parts = modal.customId.split('_');
    const modalIndex = parts.indexOf('modal');
    const modalId = modalIndex !== -1 ? parts.slice(modalIndex + 1).join('_') : modal.customId;

    // Merge file data into form values as special format
    // The backend will recognize _file_ prefixed values as file uploads
    const submissionValues = { ...formValues };
    for (const [customId, file] of Object.entries(fileData)) {
      submissionValues[`_file_${customId}`] = file.content;
      submissionValues[`_filename_${customId}`] = file.name;
    }

    onSubmit(modalId, submissionValues);
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: '20px' }}>
      <h3 style={{ marginBottom: '15px', color: '#fff' }}>{modal.title}</h3>

      {validationError && (
        <div style={{
          padding: '10px',
          marginBottom: '15px',
          backgroundColor: '#ed424520',
          border: '1px solid #ed4245',
          borderRadius: '4px',
          color: '#ed4245'
        }}>
          {validationError}
        </div>
      )}

      {modal.components && modal.components.map((row, rowIdx) => (
        <div key={rowIdx} style={{ marginBottom: '15px' }}>
          {row.components && row.components.map((component, compIdx) => {
            if (component.type === 'text_input') {
              const isTextarea = component.style === 2; // PARAGRAPH style
              const isJsonField = component.customId === 'config_json';

              return (
                <div key={compIdx} style={{ marginBottom: '15px' }}>
                  <label style={{
                    display: 'block',
                    marginBottom: '5px',
                    color: '#dcddde',
                    fontWeight: '500'
                  }}>
                    {component.label}
                    {component.required && <span style={{ color: '#ed4245' }}> *</span>}
                  </label>

                  {isTextarea && isJsonField ? (
                    <JsonEditor
                      value={formValues[component.customId] !== undefined ? formValues[component.customId] : (component.value || '')}
                      onChange={(value) => handleInputChange(component.customId, value)}
                      disabled={executing}
                      maxLength={component.maxLength}
                    />
                  ) : isTextarea ? (
                    <textarea
                      value={formValues[component.customId] || component.value || ''}
                      onChange={(e) => handleInputChange(component.customId, e.target.value)}
                      placeholder={component.placeholder}
                      required={component.required}
                      minLength={component.minLength}
                      maxLength={component.maxLength}
                      rows={5}
                      disabled={executing}
                      onKeyDown={(e) => {
                        // Tab key support - insert 2 spaces
                        if (e.key === 'Tab') {
                          e.preventDefault();
                          const start = e.target.selectionStart;
                          const end = e.target.selectionEnd;
                          const value = e.target.value;
                          const newValue = value.substring(0, start) + '  ' + value.substring(end);
                          handleInputChange(component.customId, newValue);
                          setTimeout(() => {
                            e.target.selectionStart = e.target.selectionEnd = start + 2;
                          }, 0);
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: '4px',
                        backgroundColor: '#40444b',
                        color: '#fff',
                        border: '1px solid #202225',
                        fontSize: '0.95em',
                        fontFamily: 'monospace',
                        resize: 'vertical'
                      }}
                    />
                  ) : (
                    <input
                      type="text"
                      value={formValues[component.customId] || component.value || ''}
                      onChange={(e) => handleInputChange(component.customId, e.target.value)}
                      placeholder={component.placeholder}
                      required={component.required}
                      minLength={component.minLength}
                      maxLength={component.maxLength}
                      disabled={executing}
                      style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: '4px',
                        backgroundColor: '#40444b',
                        color: '#fff',
                        border: '1px solid #202225',
                        fontSize: '0.95em'
                      }}
                    />
                  )}

                  {component.maxLength && !isJsonField && (
                    <div style={{ fontSize: '0.8em', color: '#72767d', marginTop: '4px' }}>
                      {(formValues[component.customId] || component.value || '').length} / {component.maxLength}
                    </div>
                  )}
                </div>
              );
            }
            // File Upload Component
            if (component.type === 'file_upload') {
              const selectedFile = fileData[component.customId];
              return (
                <div key={compIdx} style={{ marginBottom: '15px' }}>
                  <label style={{
                    display: 'block',
                    marginBottom: '5px',
                    color: '#dcddde',
                    fontWeight: '500'
                  }}>
                    {component.label}
                    {component.required && <span style={{ color: '#ed4245' }}> *</span>}
                  </label>
                  {component.description && (
                    <p style={{ color: '#72767d', fontSize: '0.85em', marginBottom: '8px' }}>
                      {component.description}
                    </p>
                  )}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px'
                  }}>
                    <input
                      type="file"
                      accept={component.accept || '.json'}
                      onChange={(e) => handleFileChange(component.customId, e)}
                      disabled={executing}
                      ref={(el) => fileInputRefs.current[component.customId] = el}
                      style={{
                        display: 'none'
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRefs.current[component.customId]?.click()}
                      disabled={executing}
                      style={{
                        padding: '10px 15px',
                        backgroundColor: '#4f545c',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: executing ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '0.95em'
                      }}
                    >
                      <span>📁</span>
                      {selectedFile ? 'Change File' : 'Select File'}
                    </button>
                    {selectedFile && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 12px',
                        backgroundColor: '#3ba55d20',
                        border: '1px solid #3ba55d',
                        borderRadius: '4px',
                        color: '#3ba55d'
                      }}>
                        <span>✓</span>
                        <span style={{ color: '#dcddde' }}>{selectedFile.name}</span>
                        <span style={{ color: '#72767d', fontSize: '0.85em' }}>
                          ({Math.round(selectedFile.size / 1024)}KB)
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            // Select Menu (Dropdown) in Modal
            if (component.type === 'select') {
              return (
                <div key={compIdx} style={{ marginBottom: '15px' }}>
                  <label style={{
                    display: 'block',
                    marginBottom: '5px',
                    color: '#dcddde',
                    fontWeight: '500'
                  }}>
                    {component.placeholder || 'Select an option'}
                  </label>
                  <select
                    value={formValues[component.customId] || (component.options?.find(o => o.default)?.value) || ''}
                    onChange={(e) => handleInputChange(component.customId, e.target.value)}
                    disabled={executing || component.disabled}
                    style={{
                      width: '100%',
                      padding: '10px',
                      borderRadius: '4px',
                      backgroundColor: '#40444b',
                      color: '#fff',
                      border: '1px solid #202225',
                      fontSize: '0.95em',
                      cursor: executing ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {component.options?.map((option, optIdx) => (
                      <option key={optIdx} value={option.value}>
                        {option.label}
                        {option.description ? ` - ${option.description}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }
            // Role Select (populated from guild roles)
            if (component.type === 'role_select') {
              return (
                <div key={compIdx} style={{ marginBottom: '15px' }}>
                  <label style={{
                    display: 'block',
                    marginBottom: '5px',
                    color: '#dcddde',
                    fontWeight: '500'
                  }}>
                    {component.label || 'Select Role'}
                    {component.required && <span style={{ color: '#ed4245' }}> *</span>}
                  </label>
                  {component.description && (
                    <p style={{ color: '#72767d', fontSize: '0.85em', marginBottom: '8px' }}>
                      {component.description}
                    </p>
                  )}
                  {loadingRoles ? (
                    <div style={{ color: '#72767d', padding: '10px' }}>Loading roles...</div>
                  ) : availableRoles.length === 0 ? (
                    <div style={{ color: '#ed4245', padding: '10px' }}>
                      No roles available. Make sure a guild context is selected.
                    </div>
                  ) : (
                    <select
                      value={formValues[component.customId] || ''}
                      onChange={(e) => handleInputChange(component.customId, e.target.value)}
                      disabled={executing}
                      required={component.required}
                      style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: '4px',
                        backgroundColor: '#40444b',
                        color: '#fff',
                        border: '1px solid #202225',
                        fontSize: '0.95em',
                        cursor: executing ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <option value="">{component.placeholder || '-- Select a Role --'}</option>
                      {availableRoles.map((role) => (
                        <option key={role.id} value={role.id} style={{
                          color: role.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#fff'
                        }}>
                          @{role.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            }
            return null;
          })}
        </div>
      ))}

      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          type="submit"
          disabled={executing}
          style={{
            padding: '10px 20px',
            backgroundColor: '#5865F2',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: executing ? 'not-allowed' : 'pointer',
            opacity: executing ? 0.5 : 1,
            fontSize: '0.95em',
            fontWeight: '500'
          }}
        >
          {executing ? 'Submitting...' : 'Submit'}
        </button>
        <button
          type="button"
          onClick={() => onCancel && onCancel()}
          disabled={executing}
          style={{
            padding: '10px 20px',
            backgroundColor: '#4f545c',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: executing ? 'not-allowed' : 'pointer',
            opacity: executing ? 0.5 : 1,
            fontSize: '0.95em',
            fontWeight: '500'
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// Enhanced JSON Editor - Textarea with JSON formatting support
function JsonEditor({ value, onChange, disabled, maxLength }) {
  const { useRef } = React;
  const textareaRef = useRef(null);

  const safeValue = value || '';

  function handleKeyDown(e) {
    // Tab key support - insert 2 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = safeValue.substring(0, start) + '  ' + safeValue.substring(end);
      onChange(newValue);

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  }

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={safeValue}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        maxLength={maxLength}
        rows={20}
        style={{
          width: '100%',
          padding: '12px',
          borderRadius: '4px',
          backgroundColor: '#1e1e1e',
          color: '#d4d4d4',
          border: '1px solid #3c3c3c',
          fontSize: '13px',
          fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
          lineHeight: '1.5',
          resize: 'vertical',
          tabSize: 2,
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          overflowX: 'auto'
        }}
      />
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '0.8em',
        color: '#72767d',
        marginTop: '4px'
      }}>
        <span>Tab = 2 spaces</span>
        {maxLength && (
          <span>{safeValue.length} / {maxLength}</span>
        )}
      </div>
    </div>
  );
}

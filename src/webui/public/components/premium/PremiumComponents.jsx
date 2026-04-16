/**
 * Premium Tier Sub-Components
 *
 * TierFormModal — Create/edit tier modal (name, priority)
 * TierEditorPanel — Inline panel for module access controls + setting overrides
 *
 * Override data model convention (stored in tier.overrides[moduleName]):
 *   _moduleEnabled: boolean    — false = entire module disabled for this tier
 *   _disabledCommands: string[] — specific commands disabled for this tier
 *   <settingKey>: value         — setting value overrides
 */
const { useState, useEffect, useRef } = React;

// ============================================================================
// TierFormModal — Create or edit a premium tier
// ============================================================================
function TierFormModal({ tier, tierId, onSave, onClose }) {
  const isEdit = !!tierId;
  const isFree = tierId === 'free';
  const [id, setId] = useState(tierId || '');
  const [displayName, setDisplayName] = useState(tier?.displayName || '');
  const [priority, setPriority] = useState(tier?.priority ?? 1);
  const [saving, setSaving] = useState(false);

  const idRef = useRef(null);
  useEffect(() => { if (!isEdit && idRef.current) idRef.current.focus(); }, []);

  function slugify(val) {
    return val.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  async function handleSave() {
    const finalId = isEdit ? tierId : slugify(id);
    if (!finalId) { showToast('Tier ID is required', 'error'); return; }
    if (!displayName.trim()) { showToast('Display name is required', 'error'); return; }
    if (typeof priority !== 'number' || isNaN(priority)) { showToast('Priority must be a number', 'error'); return; }

    setSaving(true);
    try {
      const res = await api.put(`/appstore/premium/tiers/${finalId}`, {
        displayName: displayName.trim(),
        priority: isFree ? 0 : priority,
        overrides: tier?.overrides || {},
      });
      if (res.success) {
        showToast(isEdit ? 'Tier updated' : 'Tier created', 'success');
        onSave();
      } else {
        showToast(res.error || 'Failed to save tier', 'error');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  const overlayStyle = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  };
  const modalStyle = {
    background: '#2c2f33', borderRadius: '12px', padding: '24px', width: '420px', maxWidth: '90vw',
    border: '1px solid #444',
  };
  const inputStyle = {
    width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #555',
    background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.9rem', boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', color: '#aaa', fontSize: '0.82rem', marginBottom: '4px' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 16px 0', color: '#fff' }}>{isEdit ? `Edit Tier: ${displayName}` : 'Create New Tier'}</h3>

        {!isEdit && (
          <div style={{ marginBottom: '14px' }}>
            <label style={labelStyle}>Tier ID (slug)</label>
            <input ref={idRef} style={inputStyle} value={id} onChange={e => setId(slugify(e.target.value))}
              placeholder="e.g. premium, vip, basic" />
            <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '2px' }}>Lowercase, hyphens only. Cannot be changed later.</div>
          </div>
        )}

        <div style={{ marginBottom: '14px' }}>
          <label style={labelStyle}>Display Name</label>
          <input style={inputStyle} value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder="e.g. Premium, VIP, Basic" />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={labelStyle}>Priority {isFree && <span style={{ color: '#666' }}>(locked for Free tier)</span>}</label>
          <input style={{ ...inputStyle, width: '120px' }} type="number" value={priority}
            onChange={e => setPriority(parseInt(e.target.value) || 0)} disabled={isFree}
            min="0" />
          <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '2px' }}>Higher priority = more premium. Free is always 0.</div>
        </div>

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            background: '#40444b', color: '#ddd', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            background: saving ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
            color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px',
            cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600,
          }}>{saving ? 'Saving...' : (isEdit ? 'Save' : 'Create')}</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// TierEditorPanel — Inline editor for module access + command toggles + setting overrides
// ============================================================================
function TierEditorPanel({ tierId, tier, onSave, onClose }) {
  const [moduleSchemas, setModuleSchemas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [overrides, setOverrides] = useState(tier?.overrides || {});
  const [saving, setSaving] = useState(false);
  const [expandedModules, setExpandedModules] = useState(new Set());

  useEffect(() => {
    api.get('/appstore/premium/module-schemas')
      .then(res => { if (res.success) setModuleSchemas(res.modules || []); })
      .catch(err => showToast('Failed to load module data: ' + err.message, 'error'))
      .finally(() => setLoading(false));
  }, []);

  // ── Helpers for override data ──
  function getModOverrides(moduleName) { return overrides[moduleName] || {}; }

  function setModOverride(moduleName, key, value) {
    setOverrides(prev => {
      const next = { ...prev };
      if (!next[moduleName]) next[moduleName] = {};
      next[moduleName] = { ...next[moduleName], [key]: value };
      return next;
    });
  }

  function removeModOverride(moduleName, key) {
    setOverrides(prev => {
      const next = { ...prev };
      if (next[moduleName]) {
        const mod = { ...next[moduleName] };
        delete mod[key];
        if (Object.keys(mod).length === 0) delete next[moduleName];
        else next[moduleName] = mod;
      }
      return next;
    });
  }

  // Module-level toggle
  function isModuleEnabled(moduleName) {
    const val = getModOverrides(moduleName)._moduleEnabled;
    return val !== false; // undefined or true = enabled
  }

  function toggleModuleEnabled(moduleName) {
    const currently = isModuleEnabled(moduleName);
    if (currently) {
      setModOverride(moduleName, '_moduleEnabled', false);
    } else {
      removeModOverride(moduleName, '_moduleEnabled');
    }
  }

  // Command-level toggle
  function getDisabledCommands(moduleName) {
    return getModOverrides(moduleName)._disabledCommands || [];
  }

  function isCommandEnabled(moduleName, cmdName) {
    return !getDisabledCommands(moduleName).includes(cmdName);
  }

  function toggleCommand(moduleName, cmdName) {
    const disabled = [...getDisabledCommands(moduleName)];
    const idx = disabled.indexOf(cmdName);
    if (idx >= 0) {
      disabled.splice(idx, 1);
    } else {
      disabled.push(cmdName);
    }
    if (disabled.length === 0) removeModOverride(moduleName, '_disabledCommands');
    else setModOverride(moduleName, '_disabledCommands', disabled);
  }

  // Command type display helpers
  function cmdPrefix(cmd) {
    if (cmd.type === 'User') return 'User >';
    if (cmd.type === 'Message') return 'Message >';
    return '/';
  }

  function cmdTypeLabel(cmd) {
    if (cmd.type === 'User') return 'User Context Menu';
    if (cmd.type === 'Message') return 'Message Context Menu';
    return 'Slash Command';
  }

  function cmdTypeBadgeColor(cmd) {
    if (cmd.type === 'User') return { bg: 'rgba(88, 101, 242, 0.15)', color: '#7289da' };
    if (cmd.type === 'Message') return { bg: 'rgba(230, 126, 34, 0.15)', color: '#e67e22' };
    return null; // no badge for slash commands (default)
  }

  // Setting override value
  function getSettingValue(moduleName, key) { return getModOverrides(moduleName)[key]; }

  function setSettingValue(moduleName, key, value) { setModOverride(moduleName, key, value); }

  function removeSettingOverride(moduleName, key) { removeModOverride(moduleName, key); }

  function toggleExpand(name) {
    setExpandedModules(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  // Count overrides (excluding internal keys for badge display)
  function getSettingOverrideCount(moduleName) {
    const o = getModOverrides(moduleName);
    return Object.keys(o).filter(k => !k.startsWith('_')).length;
  }

  function getChangeCount(moduleName) {
    const o = getModOverrides(moduleName);
    let count = Object.keys(o).filter(k => !k.startsWith('_')).length;
    if (o._moduleEnabled === false) count++;
    if (o._disabledCommands?.length > 0) count += o._disabledCommands.length;
    return count;
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await api.put(`/appstore/premium/tiers/${tierId}`, {
        displayName: tier.displayName,
        priority: tier.priority,
        overrides,
      });
      if (res.success) { showToast('Tier configuration saved', 'success'); onSave(); }
      else showToast(res.error || 'Failed to save', 'error');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally { setSaving(false); }
  }

  // ── Setting input renderer ──
  function renderSettingInput(moduleName, key, setting) {
    const current = getSettingValue(moduleName, key);
    const isSet = current !== undefined;
    const type = setting.type || 'string';
    const inputStyle = {
      padding: '6px 10px', borderRadius: '5px', border: '1px solid #555',
      background: isSet ? '#1a1a2e' : '#1a1a1a', color: '#e0e0e0', fontSize: '0.85rem',
    };

    let input;
    if (type === 'boolean') {
      input = (
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={isSet ? !!current : false}
            onChange={e => setSettingValue(moduleName, key, e.target.checked)}
            style={{ width: '16px', height: '16px', accentColor: '#5865F2' }} />
          <span style={{ color: '#aaa', fontSize: '0.82rem' }}>{isSet ? (current ? 'On' : 'Off') : 'Default'}</span>
        </label>
      );
    } else if (type === 'number') {
      input = (
        <input type="number" style={{ ...inputStyle, width: '120px' }}
          value={isSet ? current : ''} placeholder={String(setting.default ?? '')}
          onChange={e => { const v = e.target.value; if (v === '') removeSettingOverride(moduleName, key); else setSettingValue(moduleName, key, parseFloat(v)); }}
          min={setting.validation?.min} max={setting.validation?.max} />
      );
    } else if (type === 'select' && setting.options) {
      input = (
        <select style={{ ...inputStyle, minWidth: '160px' }} value={isSet ? current : ''}
          onChange={e => { if (e.target.value === '') removeSettingOverride(moduleName, key); else setSettingValue(moduleName, key, e.target.value); }}>
          <option value="">-- Default --</option>
          {setting.options.map(opt => (
            <option key={opt.value || opt} value={opt.value || opt}>{opt.label || opt.value || opt}</option>
          ))}
        </select>
      );
    } else if (type === 'color') {
      const hexVal = isSet && current ? (current.startsWith('0x') ? '#' + current.slice(2) : current) : '';
      input = (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input type="color" value={hexVal || '#5865F2'}
            onChange={e => setSettingValue(moduleName, key, '0x' + e.target.value.slice(1).toUpperCase())}
            style={{ width: '32px', height: '28px', border: 'none', background: 'none', cursor: 'pointer' }} />
          <input type="text" style={{ ...inputStyle, width: '100px' }}
            value={isSet ? current : ''} placeholder={String(setting.default ?? '')}
            onChange={e => { if (e.target.value === '') removeSettingOverride(moduleName, key); else setSettingValue(moduleName, key, e.target.value); }} />
        </div>
      );
    } else {
      input = (
        <input type="text" style={{ ...inputStyle, width: '100%', maxWidth: '300px' }}
          value={isSet ? current : ''} placeholder={String(setting.default ?? '')}
          onChange={e => { if (e.target.value === '') removeSettingOverride(moduleName, key); else setSettingValue(moduleName, key, e.target.value); }} />
      );
    }

    return (
      <div key={key} style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 12px', background: isSet ? 'rgba(88, 101, 242, 0.05)' : 'transparent',
        borderRadius: '6px', marginBottom: '4px', gap: '12px', flexWrap: 'wrap',
      }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ color: '#ddd', fontSize: '0.85rem', fontWeight: 500 }}>{setting.label || key}</div>
          {setting.description && <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '2px' }}>{setting.description}</div>}
          {setting.default !== undefined && <div style={{ color: '#555', fontSize: '0.72rem', marginTop: '1px' }}>Default: {String(setting.default)}</div>}
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
          {input}
          {isSet && (
            <button onClick={() => removeSettingOverride(moduleName, key)} title="Reset to default" style={{
              background: 'none', border: '1px solid #555', color: '#888', borderRadius: '4px',
              padding: '4px 8px', cursor: 'pointer', fontSize: '0.75rem',
            }}>Reset</button>
          )}
        </div>
      </div>
    );
  }

  // ── Toggle switch styling ──
  function ToggleSwitch({ checked, onChange, label, size }) {
    const w = size === 'small' ? 32 : 38;
    const h = size === 'small' ? 18 : 22;
    const dot = size === 'small' ? 14 : 18;
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
        <div onClick={e => { e.preventDefault(); onChange(!checked); }} style={{
          width: w, height: h, borderRadius: h, background: checked ? '#3ba55d' : '#555',
          position: 'relative', transition: 'background 0.2s', cursor: 'pointer', flexShrink: 0,
        }}>
          <div style={{
            width: dot, height: dot, borderRadius: '50%', background: '#fff',
            position: 'absolute', top: (h - dot) / 2, left: checked ? w - dot - 2 : 2,
            transition: 'left 0.2s',
          }} />
        </div>
        {label && <span style={{ color: '#aaa', fontSize: '0.82rem' }}>{label}</span>}
      </label>
    );
  }

  const totalChanges = moduleSchemas.reduce((sum, m) => sum + getChangeCount(m.name), 0);
  const settingEntries = (mod) => Object.entries(mod.settings || {});
  const hasSettings = (mod) => settingEntries(mod).length > 0;
  const hasCommands = (mod) => mod.commands && mod.commands.length > 0;
  // Normalize commands: support both string[] (filesystem fallback) and {name,type}[]
  const normalizeCmd = (cmd) => typeof cmd === 'string' ? { name: cmd, type: 'ChatInput' } : cmd;

  if (loading) return <div className="loading">Loading module data...</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={onClose} style={{
            background: '#40444b', color: '#ddd', border: 'none', padding: '6px 12px',
            borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem',
          }}>&larr; Back</button>
          <div>
            <h3 style={{ margin: 0, color: '#f5af19' }}>{tier.displayName} — Access & Overrides</h3>
            <span style={{ color: '#888', fontSize: '0.82rem' }}>
              {moduleSchemas.length} module{moduleSchemas.length !== 1 ? 's' : ''}
              {totalChanges > 0 && ` \u00B7 ${totalChanges} change${totalChanges !== 1 ? 's' : ''}`}
            </span>
          </div>
        </div>
        <button onClick={handleSave} disabled={saving} style={{
          background: saving ? '#555' : 'linear-gradient(135deg, #3ba55d, #2d8049)',
          color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px',
          cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.85rem',
        }}>{saving ? 'Saving...' : 'Save Changes'}</button>
      </div>

      {/* Info */}
      <div style={{
        background: '#1a1a2e', border: '1px solid #333', borderRadius: '8px',
        padding: '10px 14px', marginBottom: '16px', fontSize: '0.8rem', color: '#aaa', lineHeight: 1.5,
      }}>
        Toggle modules and commands on/off for this tier. Override individual settings below each module.
        Disabled modules and commands will be blocked for guilds on this tier.
      </div>

      {moduleSchemas.length === 0 ? (
        <div style={{ color: '#666', textAlign: 'center', padding: '30px' }}>No modules found.</div>
      ) : (
        moduleSchemas.map(mod => {
          const isExpanded = expandedModules.has(mod.name);
          const modEnabled = isModuleEnabled(mod.name);
          const disabledCmds = getDisabledCommands(mod.name);
          const changeCount = getChangeCount(mod.name);
          const settings = settingEntries(mod);

          return (
            <div key={mod.name} style={{
              background: '#2c2f33', borderRadius: '8px', marginBottom: '8px', overflow: 'hidden',
              opacity: modEnabled ? 1 : 0.6, transition: 'opacity 0.2s',
              border: !modEnabled ? '1px solid #ed4245' : changeCount > 0 ? '1px solid #5865F2' : '1px solid transparent',
            }}>
              {/* Module header */}
              <div style={{
                padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: isExpanded ? '1px solid #444' : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, cursor: 'pointer' }}
                  onClick={() => toggleExpand(mod.name)}>
                  <span style={{ color: '#666', fontSize: '0.75rem', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>&#9654;</span>
                  <span style={{ color: modEnabled ? '#fff' : '#888', fontWeight: 600, fontSize: '0.9rem', textDecoration: modEnabled ? 'none' : 'line-through' }}>
                    {mod.displayName}
                  </span>
                  {mod.category && <span style={{ background: '#1a1a1a', color: '#666', padding: '1px 6px', borderRadius: '10px', fontSize: '0.7rem' }}>{mod.category}</span>}
                  {hasCommands(mod) && <span style={{ background: '#1a1a1a', color: '#888', padding: '1px 6px', borderRadius: '10px', fontSize: '0.7rem' }}>{mod.commands.length} cmd{mod.commands.length !== 1 ? 's' : ''}</span>}
                  {hasSettings(mod) && <span style={{ background: '#1a1a1a', color: '#888', padding: '1px 6px', borderRadius: '10px', fontSize: '0.7rem' }}>{settings.length} setting{settings.length !== 1 ? 's' : ''}</span>}
                  {changeCount > 0 && <span style={{ background: 'rgba(88, 101, 242, 0.2)', color: '#7289da', padding: '1px 7px', borderRadius: '10px', fontSize: '0.7rem' }}>{changeCount} change{changeCount !== 1 ? 's' : ''}</span>}
                  {!modEnabled && <span style={{ background: 'rgba(237, 66, 69, 0.15)', color: '#ed4245', padding: '1px 7px', borderRadius: '10px', fontSize: '0.7rem', fontWeight: 600 }}>DISABLED</span>}
                </div>
                <div onClick={e => e.stopPropagation()}>
                  <ToggleSwitch checked={modEnabled} onChange={() => toggleModuleEnabled(mod.name)} />
                </div>
              </div>

              {/* Expanded content */}
              {isExpanded && (
                <div style={{ padding: '10px 14px' }}>
                  {/* Commands section */}
                  {hasCommands(mod) && (
                    <div style={{ marginBottom: hasSettings(mod) ? '14px' : 0 }}>
                      <div style={{ color: '#aaa', fontSize: '0.78rem', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Commands</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {mod.commands.map(normalizeCmd).map(cmd => {
                          const enabled = isCommandEnabled(mod.name, cmd.name);
                          const badge = cmdTypeBadgeColor(cmd);
                          return (
                            <div key={cmd.name} style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '6px 10px', borderRadius: '5px',
                              background: !enabled ? 'rgba(237, 66, 69, 0.05)' : 'transparent',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{
                                  color: enabled ? '#ddd' : '#888',
                                  fontSize: '0.85rem', fontFamily: 'monospace',
                                  textDecoration: enabled ? 'none' : 'line-through',
                                }}>
                                  <span style={{ color: enabled ? '#888' : '#666' }}>{cmdPrefix(cmd)}</span>{cmd.name}
                                </span>
                                {badge && (
                                  <span style={{
                                    background: badge.bg, color: badge.color,
                                    padding: '1px 6px', borderRadius: '8px', fontSize: '0.65rem', fontWeight: 600,
                                    whiteSpace: 'nowrap',
                                  }}>{cmdTypeLabel(cmd)}</span>
                                )}
                              </div>
                              <ToggleSwitch size="small" checked={enabled}
                                onChange={() => toggleCommand(mod.name, cmd.name)} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Settings section */}
                  {hasSettings(mod) && (
                    <div>
                      <div style={{ color: '#aaa', fontSize: '0.78rem', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Setting Overrides</div>
                      {settings.map(([key, setting]) => renderSettingInput(mod.name, key, setting))}
                    </div>
                  )}

                  {!hasCommands(mod) && !hasSettings(mod) && (
                    <div style={{ color: '#666', fontSize: '0.82rem', padding: '8px 0' }}>
                      This module has no commands or configurable settings. Use the module toggle above to enable/disable it for this tier.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

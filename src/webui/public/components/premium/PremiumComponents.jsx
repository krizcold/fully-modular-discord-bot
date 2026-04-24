/**
 * Premium Tier Sub-Components
 *
 * TierFormModal: Create/edit tier modal (name, priority)
 * TierEditorPanel: Inline panel for module access controls + setting overrides
 *
 * Override data model convention (stored in tier.overrides[moduleName]):
 *   _moduleEnabled: boolean    : false = entire module disabled for this tier
 *   _disabledCommands: string[]: specific commands disabled for this tier
 *   <settingKey>: value        : setting value overrides
 */
const { useState, useEffect, useRef } = React;

// ============================================================================
// TierFormModal: Create or edit a premium tier
// ============================================================================
function TierFormModal({ tier, tierId, freeTier, nextPriority, onSave, onClose }) {
  const isEdit = !!tierId;
  const isFree = tierId === 'free';
  const [id, setId] = useState(tierId || '');
  const [displayName, setDisplayName] = useState(tier?.displayName || '');
  const [saving, setSaving] = useState(false);

  // When creating a new tier, seed its overrides from Free so the new tier
  // starts matching Free's baseline (the admin then loosens it to be "more premium").
  const seededOverrides = isEdit
    ? (tier?.overrides || {})
    : JSON.parse(JSON.stringify(freeTier?.overrides || {}));

  const idRef = useRef(null);
  useEffect(() => { if (!isEdit && idRef.current) idRef.current.focus(); }, []);

  function slugify(val) {
    return val.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  async function handleSave() {
    const finalId = isEdit ? tierId : slugify(id);
    if (!finalId) { showToast('Tier ID is required', 'error'); return; }
    if (!displayName.trim()) { showToast('Display name is required', 'error'); return; }

    // Priority: Free is always 0. On create, auto-assign position-based priority
    // (nextPriority = max existing + 1). On edit, keep the current value; reorder
    // is done via drag-and-drop in the tier grid.
    const finalPriority = isFree
      ? 0
      : isEdit ? (tier?.priority ?? nextPriority ?? 1) : (nextPriority ?? 1);

    setSaving(true);
    try {
      const res = await api.put(`/appstore/premium/tiers/${finalId}`, {
        displayName: displayName.trim(),
        priority: finalPriority,
        overrides: seededOverrides,
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

        <div style={{ marginBottom: '20px' }}>
          <label style={labelStyle}>Display Name</label>
          <input style={inputStyle} value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder="e.g. Premium, VIP, Basic" />
          {!isEdit && !isFree && (
            <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '4px' }}>
              The tier will be added at the end of the ranking. Drag tiers in the grid to reorder.
            </div>
          )}
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
// TierEditorPanel: Inline editor for module access + command toggles + setting overrides
// ============================================================================
function TierEditorPanel({ tierId, tier, freeTier, onSave, onClose }) {
  const [moduleSchemas, setModuleSchemas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [overrides, setOverrides] = useState(tier?.overrides || {});
  const [saving, setSaving] = useState(false);
  const [expandedModules, setExpandedModules] = useState(new Set());

  // ── Free-tier baseline (capabilities offered on Free are the floor) ──
  const isFreeTier = tierId === 'free';
  const freeOverrides = (freeTier?.overrides) || {};
  function getFreeModOverrides(moduleName) { return freeOverrides[moduleName] || {}; }
  /** True iff Free disables this module entirely; its per-command/per-setting state is then moot. */
  function freeModuleIsDisabled(moduleName) {
    return getFreeModOverrides(moduleName)._moduleEnabled === false;
  }
  /** Does Free allow this module? (true when Free doesn't explicitly disable it) */
  function freeAllowsModule(moduleName) {
    return getFreeModOverrides(moduleName)._moduleEnabled !== false;
  }
  /**
   * Does Free allow this command? When Free disables the whole module, no
   * command is "allowed" there: return false so non-Free tiers are never
   * ghost-locked by Free's per-command state inside a disabled module.
   */
  function freeAllowsCommand(moduleName, cmdName) {
    if (freeModuleIsDisabled(moduleName)) return false;
    const disabled = getFreeModOverrides(moduleName)._disabledCommands || [];
    return !disabled.includes(cmdName);
  }
  /**
   * Free's setting value only counts as a baseline when Free actually offers
   * the module. If the module is disabled on Free, Free's setting values are
   * moot and return undefined (no inheritance).
   */
  function getFreeSettingValue(moduleName, key) {
    if (freeModuleIsDisabled(moduleName)) return undefined;
    const v = getFreeModOverrides(moduleName)[key];
    return v;
  }

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

  // ── Free-as-baseline helpers ──
  // Non-Free tiers inherit Free's overrides per-key. A tier's explicit value
  // wins. Toggling an option writes the new state to the tier only when it
  // differs from what Free would imply; otherwise we remove the tier's own
  // override so the tier "auto-links" to Free going forward.
  function freeEffectiveModuleEnabled(moduleName) {
    const v = getFreeModOverrides(moduleName)._moduleEnabled;
    return v !== false;
  }
  function freeEffectiveDisabledCommands(moduleName) {
    // Free's per-command state doesn't propagate when Free disables the whole module.
    if (freeModuleIsDisabled(moduleName)) return [];
    const list = getFreeModOverrides(moduleName)._disabledCommands;
    return Array.isArray(list) ? list : [];
  }

  // Module-level toggle
  function isModuleEnabled(moduleName) {
    const tierVal = getModOverrides(moduleName)._moduleEnabled;
    if (tierVal !== undefined) return tierVal !== false;
    if (!isFreeTier) return freeEffectiveModuleEnabled(moduleName);
    return true;
  }

  function toggleModuleEnabled(moduleName) {
    const currently = isModuleEnabled(moduleName);
    // Free baseline: non-Free tiers cannot disable a module that Free allows.
    if (currently && !isFreeTier && freeAllowsModule(moduleName)) return;
    const newEnabled = !currently;
    const freeImplied = isFreeTier ? true : freeEffectiveModuleEnabled(moduleName);
    if (!isFreeTier && newEnabled === freeImplied) {
      // New state matches what Free implies; drop tier's own override so the
      // tier keeps inheriting from Free automatically.
      removeModOverride(moduleName, '_moduleEnabled');
    } else if (newEnabled) {
      // Enabling: either Free, or a non-Free tier explicitly overriding Free's disable.
      if (isFreeTier) removeModOverride(moduleName, '_moduleEnabled');
      else setModOverride(moduleName, '_moduleEnabled', true);
    } else {
      setModOverride(moduleName, '_moduleEnabled', false);
    }
  }
  /** True when the module toggle is currently locked in its ENABLED position. */
  function moduleToggleLocked(moduleName) {
    if (isFreeTier) return false;
    return isModuleEnabled(moduleName) && freeAllowsModule(moduleName);
  }

  // Command-level toggle
  function getDisabledCommands(moduleName) {
    const tierList = getModOverrides(moduleName)._disabledCommands;
    if (Array.isArray(tierList)) return tierList;
    if (!isFreeTier) return freeEffectiveDisabledCommands(moduleName);
    return [];
  }

  function isCommandEnabled(moduleName, cmdName) {
    return !getDisabledCommands(moduleName).includes(cmdName);
  }

  function toggleCommand(moduleName, cmdName) {
    const effective = getDisabledCommands(moduleName);
    const isEnabled = !effective.includes(cmdName);
    // Free baseline: non-Free tiers cannot disable a command that Free allows.
    if (isEnabled && !isFreeTier && freeAllowsCommand(moduleName, cmdName)) return;
    // Build the new list from the effective (possibly inherited) list.
    const newList = [...effective];
    const idx = newList.indexOf(cmdName);
    if (idx >= 0) newList.splice(idx, 1);
    else newList.push(cmdName);

    if (isFreeTier) {
      if (newList.length === 0) removeModOverride(moduleName, '_disabledCommands');
      else setModOverride(moduleName, '_disabledCommands', newList);
      return;
    }

    // Non-Free: if the new list matches Free's, drop our own override to
    // auto-link to Free. Otherwise store our explicit list.
    const freeList = freeEffectiveDisabledCommands(moduleName);
    const matchesFree = newList.length === freeList.length
      && [...newList].sort().every((v, i) => v === [...freeList].sort()[i]);
    if (matchesFree) removeModOverride(moduleName, '_disabledCommands');
    else setModOverride(moduleName, '_disabledCommands', newList);
  }
  /** True when a command toggle is currently locked in its ENABLED position. */
  function commandToggleLocked(moduleName, cmdName) {
    if (isFreeTier) return false;
    return isCommandEnabled(moduleName, cmdName) && freeAllowsCommand(moduleName, cmdName);
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
  // Non-Free tiers fall through to Free's value when they have no explicit
  // override, so the editor always shows the value the guild would actually
  // see. `isSettingInherited` lets the renderer style the input as
  // "inherited" rather than "owned by this tier".
  function getSettingValue(moduleName, key) {
    const tierVal = getModOverrides(moduleName)[key];
    if (tierVal !== undefined) return tierVal;
    if (!isFreeTier) {
      const freeVal = getFreeSettingValue(moduleName, key);
      if (freeVal !== undefined) return freeVal;
    }
    return undefined;
  }
  function isSettingInherited(moduleName, key) {
    if (isFreeTier) return false;
    return getModOverrides(moduleName)[key] === undefined
      && getFreeSettingValue(moduleName, key) !== undefined;
  }

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
    // `current` = effective value (own, else inherited from Free, else undefined).
    // `ownValue` = the explicit override this tier stores.
    // `isOwned` = this tier diverges from Free for this key.
    // `isInherited` = non-Free tier showing Free's value with no own override.
    const current = getSettingValue(moduleName, key);
    const ownValue = getModOverrides(moduleName)[key];
    const isOwned = ownValue !== undefined;
    const isSet = current !== undefined;
    const isInherited = isSet && !isOwned && !isFreeTier;
    const type = setting.type || 'string';

    // Input visuals: own overrides get a bluer tint, inherited gets a subtle
    // slate tint so the user can tell at a glance whether this tier is
    // diverging or mirroring Free.
    const inputBg = isOwned ? '#1a1a2e' : isInherited ? '#1b2230' : '#1a1a1a';
    const inputBorder = isInherited ? '1px dashed #3f4a63' : '1px solid #555';
    const inputStyle = {
      padding: '6px 10px', borderRadius: '5px', border: inputBorder,
      background: inputBg, color: '#e0e0e0', fontSize: '0.85rem',
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

    const freeVal = !isFreeTier ? getFreeSettingValue(moduleName, key) : undefined;

    return (
      <div key={key} style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 12px', background: isOwned ? 'rgba(88, 101, 242, 0.05)' : 'transparent',
        borderRadius: '6px', marginBottom: '4px', gap: '12px', flexWrap: 'wrap',
      }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ color: '#ddd', fontSize: '0.85rem', fontWeight: 500 }}>
            {setting.label || key}
            {isInherited && (
              <span title="Value inherited from the Free tier; changes to Free flow through here automatically." style={{
                marginLeft: '8px', color: '#5aa5ff',
                background: 'rgba(90, 165, 255, 0.08)', border: '1px solid rgba(90, 165, 255, 0.3)',
                padding: '1px 6px', borderRadius: '10px', fontSize: '0.68rem', fontWeight: 500,
              }}>inherited</span>
            )}
          </div>
          {setting.description && <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '2px' }}>{setting.description}</div>}
          {setting.default !== undefined && <div style={{ color: '#555', fontSize: '0.72rem', marginTop: '1px' }}>Default: {String(setting.default)}</div>}
          {!isFreeTier && freeVal !== undefined && (
            <div style={{ color: '#5aa5ff', fontSize: '0.72rem', marginTop: '2px' }}>
              Free tier: {String(freeVal)} <span style={{ color: '#666' }}>(use as reference; don't go worse than Free)</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
          {input}
          {isOwned && (
            <button onClick={() => removeSettingOverride(moduleName, key)}
              title={freeVal !== undefined ? 'Clear override and inherit from Free' : 'Reset to default'}
              style={{
                background: 'none', border: '1px solid #555', color: '#888', borderRadius: '4px',
                padding: '4px 8px', cursor: 'pointer', fontSize: '0.75rem',
              }}>Reset</button>
          )}
        </div>
      </div>
    );
  }

  // ── Toggle switch styling ──
  // `locked=true` = visually enabled but ignores clicks. Used when Free-tier baseline
  // forbids disabling a capability that Free already offers.
  function ToggleSwitch({ checked, onChange, label, size, locked, title }) {
    const w = size === 'small' ? 32 : 38;
    const h = size === 'small' ? 18 : 22;
    const dot = size === 'small' ? 14 : 18;
    const cursor = locked ? 'not-allowed' : 'pointer';
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor, opacity: locked ? 0.55 : 1 }}
        title={title || (locked ? 'Locked: Free tier offers this, so higher tiers cannot remove it.' : undefined)}>
        <div onClick={e => { e.preventDefault(); if (!locked) onChange(!checked); }} style={{
          width: w, height: h, borderRadius: h,
          background: checked ? (locked ? '#2f6b43' : '#3ba55d') : '#555',
          position: 'relative', transition: 'background 0.2s', cursor, flexShrink: 0,
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
            <h3 style={{ margin: 0, color: '#f5af19' }}>{tier.displayName}: Access & Overrides</h3>
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
                  <ToggleSwitch checked={modEnabled}
                    onChange={() => toggleModuleEnabled(mod.name)}
                    locked={moduleToggleLocked(mod.name)} />
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
                                onChange={() => toggleCommand(mod.name, cmd.name)}
                                locked={commandToggleLocked(mod.name, cmd.name)} />
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

// ============================================================================
// GrantManualModal: Grant or edit a manual subscription for a guild
// ============================================================================
function GrantManualModal({ guildId, existing, tiers, botGuilds, existingSubscriptions, onSave, onClose, showSuccess, setError }) {
  const isEdit = !!guildId;
  const [selectedGuildId, setSelectedGuildId] = useState(guildId || '');
  const [selectedTier, setSelectedTier] = useState(existing?.tierId || '');
  const [isLifetime, setIsLifetime] = useState(existing?.endDate === null);
  const [durationDays, setDurationDays] = useState(() => {
    if (!existing || existing.endDate === null) return 30;
    const remaining = Date.parse(existing.endDate) - Date.now();
    return Math.max(1, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
  });
  const [notes, setNotes] = useState(existing?.notes || '');
  const [saving, setSaving] = useState(false);

  const nonFreeTiers = Object.entries(tiers || {})
    .filter(([id]) => id !== 'free')
    .sort((a, b) => (a[1].priority || 0) - (b[1].priority || 0));

  // For "Grant new": show guilds that don't already have a manual sub
  const availableGuilds = (botGuilds || []).filter(g => !(existingSubscriptions?.[g.id]?.manual));

  async function handleSave() {
    if (!selectedGuildId) { showToast('Guild is required', 'error'); return; }
    if (!selectedTier) { showToast('Tier is required', 'error'); return; }
    const payload = {
      tierId: selectedTier,
      durationDays: isLifetime ? null : Math.max(1, parseInt(durationDays, 10) || 30),
      notes: notes.trim() || undefined,
    };
    setSaving(true);
    try {
      const res = await api.post(`/appstore/premium/subscriptions/${selectedGuildId}/manual`, payload);
      if (res.success) {
        showSuccess(isEdit ? 'Manual subscription updated' : 'Manual subscription granted');
        onSave();
      } else {
        showToast(res.error || 'Failed to save subscription', 'error');
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
    background: '#2c2f33', borderRadius: '12px', padding: '24px', width: '480px', maxWidth: '90vw',
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
        <h3 style={{ margin: '0 0 16px 0', color: '#fff' }}>
          {isEdit ? 'Edit Manual Subscription' : 'Grant Manual Subscription'}
        </h3>

        <div style={{ marginBottom: '14px' }}>
          <label style={labelStyle}>Guild</label>
          {isEdit ? (
            <input style={{ ...inputStyle, opacity: 0.7 }} value={selectedGuildId} disabled />
          ) : (
            botGuilds && botGuilds.length > 0 ? (
              <select style={inputStyle} value={selectedGuildId} onChange={e => setSelectedGuildId(e.target.value)}>
                <option value="">Select guild...</option>
                {availableGuilds.map(g => (
                  <option key={g.id} value={g.id}>{g.name} ({g.id})</option>
                ))}
              </select>
            ) : (
              <input style={inputStyle} value={selectedGuildId} onChange={e => setSelectedGuildId(e.target.value)}
                placeholder="Guild ID" />
            )
          )}
          {!isEdit && botGuilds && botGuilds.length > 0 && availableGuilds.length === 0 && (
            <div style={{ color: '#e67e22', fontSize: '0.72rem', marginTop: '4px' }}>
              All known guilds already have a manual subscription. Edit an existing one from the table.
            </div>
          )}
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={labelStyle}>Tier</label>
          <select style={inputStyle} value={selectedTier} onChange={e => setSelectedTier(e.target.value)}>
            <option value="">Select tier...</option>
            {nonFreeTiers.map(([id, t]) => (
              <option key={id} value={id}>{t.displayName || id} (Priority {t.priority || 0})</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={labelStyle}>Duration</label>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ddd', fontSize: '0.85rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={isLifetime} onChange={e => setIsLifetime(e.target.checked)}
                style={{ accentColor: '#5865F2' }} />
              Lifetime (no expiry)
            </label>
            {!isLifetime && (
              <React.Fragment>
                <input type="number" min="1" style={{ ...inputStyle, width: '130px' }}
                  value={durationDays}
                  onChange={e => setDurationDays(parseInt(e.target.value, 10) || 1)} />
                <span style={{ color: '#888', fontSize: '0.85rem' }}>days</span>
              </React.Fragment>
            )}
          </div>
          {isEdit && (
            <div style={{ color: '#666', fontSize: '0.72rem', marginTop: '4px' }}>
              Saving replaces the existing grant; the duration starts from now.
            </div>
          )}
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical', fontFamily: 'inherit' }}
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Admin notes (e.g. 'Beta tester reward')" />
        </div>

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            background: '#40444b', color: '#ddd', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            background: saving ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
            color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px',
            cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600,
          }}>{saving ? 'Saving...' : (isEdit ? 'Save' : 'Grant')}</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

const DURATION_PRESETS = [
  { days: 7, label: 'Weekly' },
  { days: 30, label: 'Monthly' },
  { days: 90, label: 'Quarterly' },
  { days: 180, label: '6 Months' },
  { days: 365, label: 'Yearly' },
];

function describeDuration(days) {
  if (days === null || days === undefined) return 'Lifetime';
  const preset = DURATION_PRESETS.find(p => p.days === days);
  return preset ? preset.label : `${days} day${days === 1 ? '' : 's'}`;
}

function formatMoney(amount, currency) {
  if (typeof amount !== 'number' || !currency) return '';
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

// CurrencyInput: amount (decimal) + currency dropdown; stores amount as integer minor units.
function CurrencyInput({ amount, currency, onChange }) {
  const displayValue = typeof amount === 'number' ? (amount / 100).toFixed(2) : '';
  const [raw, setRaw] = useState(displayValue);
  useEffect(() => {
    const next = typeof amount === 'number' ? (amount / 100).toFixed(2) : '';
    if (next !== raw) setRaw(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  function handleAmountChange(v) {
    setRaw(v);
    if (v.trim() === '') { onChange({ amount: undefined, currency }); return; }
    const parsed = parseFloat(v);
    if (isNaN(parsed) || parsed < 0) return; // keep raw but don't commit
    onChange({ amount: Math.round(parsed * 100), currency });
  }

  const inputStyle = {
    padding: '8px 10px', borderRadius: '5px', border: '1px solid #555',
    background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.9rem',
  };

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      <input type="text" inputMode="decimal" style={{ ...inputStyle, width: '110px' }}
        value={raw} onChange={e => handleAmountChange(e.target.value)}
        placeholder="5.00" />
      <select value={currency || 'USD'}
        onChange={e => onChange({ amount, currency: e.target.value })}
        style={{ ...inputStyle, width: '90px' }}>
        <option value="USD">USD</option>
        <option value="EUR">EUR</option>
        <option value="GBP">GBP</option>
        <option value="CAD">CAD</option>
        <option value="AUD">AUD</option>
        <option value="JPY">JPY</option>
        <option value="BRL">BRL</option>
        <option value="MXN">MXN</option>
      </select>
    </div>
  );
}

// ============================================================================
// OfferingModal: create / edit a single offering
// ============================================================================
function OfferingModal({ offering, providers, activatedProviders, onSave, onClose }) {
  const isEdit = !!offering;
  const initial = offering || {
    id: `offer-${Date.now().toString(36)}`,
    label: 'Monthly',
    description: '',
    durationDays: 30,
    autoRenewEligible: true,
    amount: 500,
    currency: 'USD',
    providerLinks: Object.fromEntries(
      Object.entries(activatedProviders || {}).map(([pid, a]) => [pid, { enabled: !!a.defaultEnabled, config: {} }])
    ),
    icon: undefined,
  };
  const [draft, setDraft] = useState(() => ({
    ...initial,
    providerLinks: { ...(initial.providerLinks || {}) },
  }));
  const isLifetime = draft.durationDays === null;

  // Only activated providers are shown in the toggle list
  const activatedProviderIds = Object.keys(activatedProviders || {});
  const activatedList = activatedProviderIds
    .map(pid => (providers || []).find(p => p.id === pid))
    .filter(Boolean);

  function setDurationDays(v) {
    setDraft(d => ({
      ...d,
      durationDays: v,
      // Lifetime has no end to renew; keep stored data consistent by clearing
      // the flag. Switching back to a finite duration leaves it off so the
      // admin makes an explicit choice.
      autoRenewEligible: v === null ? false : d.autoRenewEligible,
    }));
  }
  function toggleProvider(pid) {
    setDraft(d => {
      const links = { ...(d.providerLinks || {}) };
      const cur = links[pid] || { enabled: false, config: {} };
      links[pid] = { ...cur, enabled: !cur.enabled };
      return { ...d, providerLinks: links };
    });
  }
  function setProviderConfigValue(pid, key, value) {
    setDraft(d => {
      const links = { ...(d.providerLinks || {}) };
      const cur = links[pid] || { enabled: false, config: {} };
      const config = { ...(cur.config || {}) };
      if (value === undefined || value === '') delete config[key]; else config[key] = value;
      links[pid] = { ...cur, config };
      return { ...d, providerLinks: links };
    });
  }

  function renderProviderField(pid, spec) {
    const config = draft.providerLinks?.[pid]?.config || {};
    const value = config[spec.key];
    const setValue = v => setProviderConfigValue(pid, spec.key, v);
    const inputStyle = {
      padding: '6px 10px', borderRadius: '5px', border: '1px solid #555',
      background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.85rem',
    };
    if (spec.type === 'boolean') {
      return (
        <input type="checkbox" checked={!!value} onChange={e => setValue(e.target.checked)}
          style={{ accentColor: '#5865F2', width: '16px', height: '16px' }} />
      );
    }
    if (spec.type === 'number') {
      return (
        <input type="number" style={{ ...inputStyle, width: '140px' }}
          value={value === undefined || value === null ? '' : value}
          onChange={e => {
            const v = e.target.value;
            if (v === '') setValue(undefined); else setValue(parseInt(v, 10));
          }} />
      );
    }
    if (spec.type === 'select' && spec.options) {
      return (
        <select style={{ ...inputStyle, minWidth: '140px' }}
          value={value ?? ''} onChange={e => setValue(e.target.value || undefined)}>
          <option value="">Default</option>
          {spec.options.map(opt => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
        </select>
      );
    }
    return (
      <input type="text" style={{ ...inputStyle, width: '200px' }}
        value={value ?? ''} onChange={e => setValue(e.target.value || undefined)} />
    );
  }

  function handleSaveClick() {
    if (!draft.label?.trim()) { showToast('Label is required', 'error'); return; }
    onSave(draft);
  }

  const overlayStyle = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  };
  const modalStyle = {
    background: '#2c2f33', borderRadius: '12px', padding: '24px', width: '560px', maxWidth: '92vw',
    maxHeight: '90vh', overflow: 'auto', border: '1px solid #444',
  };
  const inputStyle = {
    width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #555',
    background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.9rem', boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', color: '#aaa', fontSize: '0.82rem', marginBottom: '4px', marginTop: '14px' };

  const enabledCount = Object.values(draft.providerLinks || {}).filter(l => l.enabled).length;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px 0', color: '#fff' }}>{isEdit ? 'Edit Offering' : 'New Offering'}</h3>
        <p style={{ color: '#888', fontSize: '0.82rem', margin: 0 }}>
          Define a plan and pick which payment methods make it purchasable.
        </p>

        <label style={labelStyle}>Label</label>
        <input style={inputStyle} value={draft.label || ''} placeholder="e.g. Monthly"
          onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} />

        <label style={labelStyle}>Description <span style={{ color: '#666', fontWeight: 400 }}>(optional)</span></label>
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: '60px', fontFamily: 'inherit' }}
          rows={2}
          value={draft.description || ''}
          placeholder="e.g. Best value: includes priority support and custom branding."
          onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
        />
        <div style={{ color: '#666', fontSize: '0.72rem', marginTop: '4px' }}>
          Shown on the subscribe card in the guild Web-UI.
        </div>

        <label style={labelStyle}>Price</label>
        <CurrencyInput
          amount={draft.amount} currency={draft.currency}
          onChange={({ amount, currency }) => setDraft(d => ({ ...d, amount, currency }))}
        />
        <div style={{ color: '#666', fontSize: '0.72rem', marginTop: '4px' }}>
          Leave blank for non-monetary offerings (e.g. server boosting).
        </div>

        <label style={labelStyle}>Duration</label>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ddd', fontSize: '0.85rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={isLifetime}
              onChange={e => setDurationDays(e.target.checked ? null : 30)}
              style={{ accentColor: '#5865F2' }} />
            Lifetime (no expiry)
          </label>
          {!isLifetime && (
            <React.Fragment>
              <select value={draft.durationDays ?? 30}
                onChange={e => setDurationDays(parseInt(e.target.value, 10))}
                style={{ ...inputStyle, width: 'auto', minWidth: '140px' }}>
                {DURATION_PRESETS.map(p => (<option key={p.days} value={p.days}>{p.label} ({p.days}d)</option>))}
                {/* Custom duration retained as the selected option if not a preset */}
                {!DURATION_PRESETS.some(p => p.days === draft.durationDays) && draft.durationDays !== null && (
                  <option value={draft.durationDays}>Custom: {draft.durationDays} days</option>
                )}
              </select>
              <span style={{ color: '#888', fontSize: '0.82rem' }}>or</span>
              <input type="number" min="1" style={{ ...inputStyle, width: '100px' }}
                value={draft.durationDays ?? ''}
                onChange={e => setDurationDays(parseInt(e.target.value, 10) || 1)} />
              <span style={{ color: '#888', fontSize: '0.82rem' }}>days</span>
            </React.Fragment>
          )}
        </div>

        {/* Auto-renew is a concept tied to "end of period", so it only makes sense
            for finite-duration offerings. Lifetime has no end, so the field is
            omitted entirely rather than shown as disabled (which read like
            "renewal cancelled"). */}
        {!isLifetime && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ddd', fontSize: '0.85rem', cursor: 'pointer', marginTop: '14px' }}>
            <input type="checkbox" checked={!!draft.autoRenewEligible}
              onChange={e => setDraft(d => ({ ...d, autoRenewEligible: e.target.checked }))}
              style={{ accentColor: '#5865F2' }} />
            Allow auto-renewal at end of period
          </label>
        )}

        {/* Payment methods */}
        <div style={{ marginTop: '20px' }}>
          <div style={{ color: '#aaa', fontSize: '0.82rem', fontWeight: 600, marginBottom: '8px' }}>
            Accept Payment Via
            <span style={{ color: enabledCount === 0 ? '#e67e22' : '#666', fontWeight: 400, marginLeft: '8px', fontSize: '0.75rem' }}>
              ({enabledCount} of {activatedList.length} enabled)
            </span>
          </div>

          {activatedList.length === 0 ? (
            <div style={{
              background: 'rgba(230, 126, 34, 0.1)', border: '1px solid #e67e22',
              color: '#e67e22', padding: '10px 14px', borderRadius: '6px', fontSize: '0.82rem',
            }}>
              No payment methods are activated. Close this dialog and activate a method in the
              "Available Payment Methods" section first.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activatedList.map(provider => {
                const link = draft.providerLinks?.[provider.id] || { enabled: false, config: {} };
                const schema = provider.capabilities?.offeringSchema || [];
                return (
                  <div key={provider.id} style={{
                    background: '#36393f', borderRadius: '8px', padding: '10px 12px',
                    border: link.enabled ? '1px solid #5865F2' : '1px solid transparent',
                  }}>
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
                    }}>
                      <input type="checkbox" checked={!!link.enabled}
                        onChange={() => toggleProvider(provider.id)}
                        style={{ accentColor: '#5865F2', width: '16px', height: '16px' }} />
                      <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>
                        {provider.displayName}
                      </span>
                      {!provider.isConfigured && (
                        <span style={{
                          background: 'rgba(230, 126, 34, 0.2)', color: '#e67e22',
                          padding: '1px 7px', borderRadius: '10px', fontSize: '0.7rem',
                        }}>not configured</span>
                      )}
                    </label>
                    {link.enabled && schema.length > 0 && (
                      <div style={{ marginTop: '10px', paddingLeft: '26px', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                        {schema.map(spec => (
                          <div key={spec.key}>
                            <div style={{ color: '#888', fontSize: '0.72rem', marginBottom: '3px' }}>
                              {spec.label}{spec.required && <span style={{ color: '#ed4245' }}> *</span>}
                            </div>
                            {renderProviderField(provider.id, spec)}
                            {spec.description && (
                              <div style={{ color: '#555', fontSize: '0.7rem', marginTop: '2px' }}>{spec.description}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
          <button onClick={onClose} style={{
            background: '#40444b', color: '#ddd', border: 'none', padding: '9px 18px', borderRadius: '6px', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSaveClick} style={{
            background: 'linear-gradient(135deg, #3ba55d, #2d8049)', color: '#fff', border: 'none',
            padding: '9px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600,
          }}>{isEdit ? 'Save Offering' : 'Add Offering'}</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// OfferingsEditorPanel: Inline list of a tier's offerings; edit in modal
// ============================================================================
function OfferingsEditorPanel({ tierId, tier, providers, activatedProviders, onSave, onClose, showSuccess, setError }) {
  const [offerings, setOfferings] = useState(() =>
    (tier?.offerings || []).map(o => ({ ...o, providerLinks: { ...(o.providerLinks || {}) } }))
  );
  const [saving, setSaving] = useState(false);
  const [editingOffering, setEditingOffering] = useState(null);      // null | 'new' | existing object
  const [dirty, setDirty] = useState(false);

  function openAdd() { setEditingOffering('new'); }
  function openEdit(offering) { setEditingOffering(offering); }
  function closeModal() { setEditingOffering(null); }

  function handleModalSave(nextOffering) {
    setOfferings(prev => {
      const idx = prev.findIndex(o => o.id === nextOffering.id);
      if (idx === -1) return [...prev, nextOffering];
      const copy = [...prev];
      copy[idx] = nextOffering;
      return copy;
    });
    setDirty(true);
    setEditingOffering(null);
  }

  function handleRemove(id) {
    if (!confirm('Remove this offering?')) return;
    setOfferings(prev => prev.filter(o => o.id !== id));
    setDirty(true);
  }

  async function handleSaveAll() {
    setSaving(true);
    try {
      const clean = offerings.map(o => ({
        ...o,
        id: o.id || `offer-${Math.random().toString(36).slice(2, 8)}`,
        providerLinks: o.providerLinks || {},
      }));
      const res = await api.put(`/appstore/premium/tiers/${tierId}`, {
        displayName: tier.displayName,
        priority: tier.priority,
        overrides: tier.overrides,
        offerings: clean,
      });
      if (res.success) { showSuccess('Offerings saved'); onSave(); }
      else setError(res.message || 'Failed to save offerings');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const activatedList = Object.keys(activatedProviders || {})
    .map(pid => (providers || []).find(p => p.id === pid))
    .filter(Boolean);

  // Count offerings with zero currently-enabled-AND-activated providers (warn).
  function offeringIsOrphan(o) {
    const links = o.providerLinks || {};
    return !Object.keys(links).some(pid => links[pid]?.enabled && activatedProviders?.[pid]);
  }

  return (
    <div>
      {editingOffering && (
        <OfferingModal
          offering={editingOffering === 'new' ? null : editingOffering}
          providers={providers}
          activatedProviders={activatedProviders}
          onSave={handleModalSave}
          onClose={closeModal}
        />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={onClose} style={{
            background: '#40444b', color: '#ddd', border: 'none', padding: '6px 12px',
            borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem',
          }}>&larr; Back</button>
          <div>
            <h3 style={{ margin: 0, color: '#f5af19' }}>{tier.displayName}: Offerings</h3>
            <span style={{ color: '#888', fontSize: '0.82rem' }}>
              {offerings.length} offering{offerings.length !== 1 ? 's' : ''}
              {dirty && <span style={{ color: '#e67e22', marginLeft: '8px' }}>· unsaved changes</span>}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={openAdd} style={{
            background: '#40444b', color: '#ddd', border: 'none', padding: '8px 14px',
            borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem',
          }}>+ Add Offering</button>
          <button onClick={handleSaveAll} disabled={saving || !dirty} style={{
            background: (saving || !dirty) ? '#555' : 'linear-gradient(135deg, #3ba55d, #2d8049)',
            color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '6px',
            cursor: (saving || !dirty) ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.85rem',
          }}>{saving ? 'Saving...' : 'Save Changes'}</button>
        </div>
      </div>

      <div style={{
        background: '#1a1a2e', border: '1px solid #333', borderRadius: '8px',
        padding: '10px 14px', marginBottom: '16px', fontSize: '0.8rem', color: '#aaa', lineHeight: 1.5,
      }}>
        Each offering is a plan guilds can buy. One offering can accept multiple payment methods; toggle them on/off inside the offering.
      </div>

      {activatedList.length === 0 && (
        <div style={{
          background: 'rgba(230, 126, 34, 0.1)', border: '1px solid #e67e22',
          borderRadius: '8px', padding: '12px 14px', marginBottom: '16px', color: '#e67e22', fontSize: '0.85rem',
        }}>
          No payment methods are activated system-wide. Go back and enable at least one under
          "Available Payment Methods" before creating offerings.
        </div>
      )}

      {offerings.length === 0 ? (
        <div style={{ color: '#666', textAlign: 'center', padding: '30px' }}>
          No offerings yet. Click "+ Add Offering" to let guilds subscribe to this tier.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {offerings.map(o => {
            const enabledProviderIds = Object.keys(o.providerLinks || {})
              .filter(pid => o.providerLinks[pid]?.enabled);
            const isOrphan = offeringIsOrphan(o);
            return (
              <div key={o.id} style={{
                background: '#2c2f33', borderRadius: '8px', padding: '12px 14px',
                border: isOrphan ? '1px solid #e67e22' : '1px solid #444',
                display: 'flex', gap: '12px', alignItems: 'center',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#fff', fontSize: '0.95rem', fontWeight: 600 }}>
                    {o.label}
                    <span style={{ color: '#888', fontWeight: 400, marginLeft: '8px', fontSize: '0.82rem' }}>
                      · {describeDuration(o.durationDays)}
                      {formatMoney(o.amount, o.currency) && <> · {formatMoney(o.amount, o.currency)}</>}
                      {o.autoRenewEligible && <> · auto-renewable</>}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {enabledProviderIds.length === 0 ? (
                      <span style={{ color: '#e67e22', fontSize: '0.75rem' }}>No payment methods enabled</span>
                    ) : enabledProviderIds.map(pid => {
                      const p = (providers || []).find(pp => pp.id === pid);
                      const isActivated = !!activatedProviders?.[pid];
                      return (
                        <span key={pid} style={{
                          background: isActivated ? 'rgba(88, 101, 242, 0.15)' : 'rgba(230, 126, 34, 0.15)',
                          color: isActivated ? '#7289da' : '#e67e22',
                          padding: '2px 8px', borderRadius: '10px', fontSize: '0.72rem',
                        }}>
                          {p?.displayName || pid}{!isActivated && ' (deactivated)'}
                        </span>
                      );
                    })}
                  </div>
                  {isOrphan && (
                    <div style={{ color: '#e67e22', fontSize: '0.72rem', marginTop: '4px' }}>
                      ⚠ No activated payment methods are enabled for this offering; it's not purchasable.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button onClick={() => openEdit(o)} style={{
                    background: '#40444b', color: '#ddd', border: 'none', padding: '6px 12px',
                    borderRadius: '5px', cursor: 'pointer', fontSize: '0.8rem',
                  }}>Edit</button>
                  <button onClick={() => handleRemove(o.id)} style={{
                    background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                    padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem',
                  }}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

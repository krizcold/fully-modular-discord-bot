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
const { useState, useEffect, useRef, useMemo } = React;

// ============================================================================
// Effective-overrides helper (used by TierEditorPanel dirty tracking)
// ============================================================================
// Sort object keys recursively so two semantically-equal objects with different
// insertion order JSON.stringify to identical strings.
function _canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(_canonicalizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = _canonicalizeValue(value[k]);
    return out;
  }
  return value;
}

// Two override structures are EFFECTIVELY equal when they produce the same
// merged value for every key on this tier. A key whose explicit value equals
// what the tier would inherit anyway (Free's value for non-Free tiers, or the
// schema default) is treated as absent. This mirrors the backend's per-key
// redundancy semantics so the dirty flag tracks "would saving change anything
// the user can observe" rather than raw byte equality. Without this, e.g.
// toggling a boolean checkbox on then off leaves `{Y: false}` in the data,
// structurally a delta vs `{}` baseline, but visually and semantically the
// same as no override when the schema default is `false`.
function effectiveOverrides(rawOverrides, moduleSchemas, freeOverrides, isFreeTier) {
  const safeFree = freeOverrides || {};
  const out = {};
  for (const modName of Object.keys(rawOverrides || {}).sort()) {
    const tierMod = rawOverrides[modName];
    if (!tierMod || typeof tierMod !== 'object') continue;
    const freeMod = safeFree[modName] || {};
    // When Free disables a module, all of Free's other keys for that module
    // become moot - mirrors the backend's effectiveFreeModuleOverride.
    const effectiveFree = freeMod._moduleEnabled === false ? { _moduleEnabled: false } : freeMod;
    const schema = (moduleSchemas || []).find(m => m.name === modName);
    const settings = schema?.settings || {};

    const cleanMod = {};
    for (const key of Object.keys(tierMod).sort()) {
      const val = tierMod[key];
      // Compute the value the tier would see if this override didn't exist.
      let inherited;
      if (key === '_moduleEnabled') {
        inherited = isFreeTier ? true : (effectiveFree._moduleEnabled !== false);
      } else if (key === '_disabledCommands') {
        inherited = isFreeTier
          ? []
          : (Array.isArray(effectiveFree._disabledCommands) ? effectiveFree._disabledCommands : []);
      } else {
        // Setting key: prefer Free's value, fall back to schema default.
        if (isFreeTier) {
          inherited = settings[key]?.default;
        } else {
          inherited = effectiveFree[key] !== undefined ? effectiveFree[key] : settings[key]?.default;
        }
      }

      let matches = false;
      if (Array.isArray(val) && Array.isArray(inherited)) {
        const a = [...val].sort();
        const b = [...inherited].sort();
        matches = a.length === b.length && a.every((v, i) => v === b[i]);
      } else if (val !== null && typeof val === 'object' && inherited !== null && typeof inherited === 'object') {
        matches = JSON.stringify(_canonicalizeValue(val)) === JSON.stringify(_canonicalizeValue(inherited));
      } else {
        matches = val === inherited;
      }
      if (matches) continue; // redundant - drop from the effective view
      cleanMod[key] = Array.isArray(val) ? [...val].sort() : _canonicalizeValue(val);
    }
    if (Object.keys(cleanMod).length > 0) out[modName] = cleanMod;
  }
  return out;
}

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
      // setTier on the backend rebuilds the tier from the request body, so we
      // must round-trip every existing field. On edit, preserve the tier's
      // current offerings so renaming doesn't wipe paid offerings; on create
      // the prop is null and offerings starts empty.
      const res = await api.put(`/appstore/premium/tiers/${finalId}`, {
        displayName: displayName.trim(),
        priority: finalPriority,
        overrides: seededOverrides,
        offerings: isEdit ? (tier?.offerings || []) : [],
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
  // Baseline = the on-disk overrides at last successful save (or initial mount).
  // isDirty compares the *effective* shape of current vs baseline (per-key
  // redundancies vs Free / schema defaults pruned out), so toggling a boolean
  // on then off and similar round trips return to a clean state even when the
  // raw structure picked up a redundant entry along the way.
  const [baseline, setBaseline] = useState(() => JSON.parse(JSON.stringify(tier?.overrides || {})));

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

  // Dirty = the *effective* shape of the current overrides differs from the
  // baseline. Computed on every render (cost is trivial: a handful of modules
  // with a handful of keys). We keep the schemas / Free overrides as inputs so
  // that the comparison reflects the same per-key redundancy semantics the
  // backend would apply at save time.
  const isDirty = useMemo(
    () => JSON.stringify(effectiveOverrides(overrides, moduleSchemas, freeOverrides, isFreeTier))
       !== JSON.stringify(effectiveOverrides(baseline, moduleSchemas, freeOverrides, isFreeTier)),
    [overrides, baseline, moduleSchemas, freeOverrides, isFreeTier]
  );

  async function handleSave() {
    if (!isDirty) return;
    setSaving(true);
    // Pre-prune: the dirty check treats per-key redundancies (a value that
    // matches Free's value or the schema default) as no-ops. Persist the same
    // shape so the on-disk state, the editor view, and the tier card's
    // override count all agree. Without this, a tier "made identical to Free"
    // would still show "N overrides" on its card because the backend's prune
    // is whole-module-only.
    const effective = effectiveOverrides(overrides, moduleSchemas, freeOverrides, isFreeTier);
    const snapshot = JSON.parse(JSON.stringify(effective));
    try {
      if (isFreeTier) {
        // Free baseline lives in `/data/global/{module}/settings.json`, not
        // in `tiers.free.overrides`. Decompose `effective` into per-module
        // global-config writes; also write empty configs for modules that
        // previously had baseline data but no longer do, so the on-disk
        // state matches the editor view.
        const moduleNames = new Set([
          ...Object.keys(effective || {}),
          ...Object.keys(baseline || {}),
        ]);
        const failures = [];
        for (const moduleName of moduleNames) {
          const mod = effective[moduleName] || {};
          const { _moduleEnabled, _disabledCommands, _hardLimits, ...values } = mod;
          const payload = {
            values,
            moduleEnabled: _moduleEnabled !== false,
            disabledCommands: Array.isArray(_disabledCommands) ? _disabledCommands : [],
            hardLimits: _hardLimits && typeof _hardLimits === 'object' ? _hardLimits : {},
          };
          try {
            const r = await api.put(`/appstore/global-config/${encodeURIComponent(moduleName)}`, payload);
            if (!r.success) failures.push(`${moduleName}: ${r.error || 'unknown error'}`);
          } catch (e) {
            failures.push(`${moduleName}: ${e.message || e}`);
          }
        }
        if (failures.length === 0) {
          setOverrides(effective);
          setBaseline(snapshot);
          showToast('Free baseline saved', 'success');
          onSave();
        } else {
          showToast(`Saved with ${failures.length} error(s): ${failures.join('; ')}`, 'error');
        }
      } else {
        // Send the full tier shape: setTier on the backend rebuilds the entire
        // tier record, so any field omitted here would get reset to its empty
        // default. In particular `offerings` must be passed through verbatim
        // from the parent-supplied prop or paid offerings get wiped.
        const res = await api.put(`/appstore/premium/tiers/${tierId}`, {
          displayName: tier.displayName,
          priority: tier.priority,
          overrides: effective,
          offerings: tier.offerings || [],
        });
        if (res.success) {
          setOverrides(effective);
          setBaseline(snapshot);
          showToast('Tier configuration saved', 'success');
          onSave();
        } else showToast(res.error || 'Failed to save', 'error');
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally { setSaving(false); }
  }

  // ── Hard-limit cap editor helpers ──
  // Caps live at `overrides[moduleName]._hardLimits[key]` as a HardLimitOverride
  // shape. Read returns own cap or inherited Free baseline; write touches own
  // tier only.
  function getCap(moduleName, key) {
    const mod = getModOverrides(moduleName);
    return (mod._hardLimits && mod._hardLimits[key]) || {};
  }
  function getFreeCap(moduleName, key) {
    if (isFreeTier) return {};
    const freeMod = getFreeModOverrides(moduleName);
    return (freeMod._hardLimits && freeMod._hardLimits[key]) || {};
  }
  // Merged effective cap for the current tier context: Free baseline merged
  // with this tier's own cap (this tier wins per-field, matching the
  // server-side merge in `getTierHardLimits`). Used for live-clamping the
  // VALUE input so as the host edits the cap inputs the value stays inside
  // the new range.
  function effectiveCap(moduleName, key) {
    const own = getCap(moduleName, key);
    if (isFreeTier) return own;
    return { ...getFreeCap(moduleName, key), ...own };
  }
  // Compute the effective numeric clamp range for a NUMBER setting given
  // its schema definition and the merged hard-limit cap currently in
  // effect. Mirrors `validateValue` + `validateValueWithEffectiveLimits`
  // server-side: absolute bounds are always enforced; the soft min/max
  // is shadowed by the cap when the cap is set.
  function numberEffectiveBound(settingDef, cap) {
    const v = (settingDef && settingDef.validation) || {};
    const softMin = typeof cap?.min === 'number' ? cap.min : v.min;
    const softMax = typeof cap?.max === 'number' ? cap.max : v.max;
    const aMin = v.absoluteMin;
    const aMax = v.absoluteMax;
    const effMin = (typeof aMin === 'number' && typeof softMin === 'number') ? Math.max(aMin, softMin)
      : typeof aMin === 'number' ? aMin
      : typeof softMin === 'number' ? softMin
      : undefined;
    const effMax = (typeof aMax === 'number' && typeof softMax === 'number') ? Math.min(aMax, softMax)
      : typeof aMax === 'number' ? aMax
      : typeof softMax === 'number' ? softMax
      : undefined;
    return { effMin, effMax };
  }
  // Same shape, but for STRING settings: clamps length, not numeric value.
  // Used to drive `maxLength` on text inputs and to truncate the value
  // when a cap tightens below the current value's length.
  function stringEffectiveBound(settingDef, cap) {
    const v = (settingDef && settingDef.validation) || {};
    const softMinLength = typeof cap?.minLength === 'number' ? cap.minLength : v.minLength;
    const softMaxLength = typeof cap?.maxLength === 'number' ? cap.maxLength : v.maxLength;
    const aMinLength = v.absoluteMinLength ?? v.absoluteMin;
    const aMaxLength = v.absoluteMaxLength ?? v.absoluteMax;
    const effMinLength = (typeof aMinLength === 'number' && typeof softMinLength === 'number') ? Math.max(aMinLength, softMinLength)
      : typeof aMinLength === 'number' ? aMinLength
      : typeof softMinLength === 'number' ? softMinLength
      : undefined;
    const effMaxLength = (typeof aMaxLength === 'number' && typeof softMaxLength === 'number') ? Math.min(aMaxLength, softMaxLength)
      : typeof aMaxLength === 'number' ? aMaxLength
      : typeof softMaxLength === 'number' ? softMaxLength
      : undefined;
    return { effMinLength, effMaxLength };
  }
  // Pair lookup for the min <= max constraint on cap inputs.
  function siblingCapKey(k) {
    if (k === 'min') return 'max';
    if (k === 'max') return 'min';
    if (k === 'minLength') return 'maxLength';
    if (k === 'maxLength') return 'minLength';
    if (k === 'minItems') return 'maxItems';
    if (k === 'maxItems') return 'minItems';
    return null;
  }
  function patchCap(moduleName, key, patch) {
    setOverrides(prev => {
      const next = { ...prev };
      const mod = { ...(next[moduleName] || {}) };
      const hardLimits = { ...(mod._hardLimits || {}) };
      const merged = { ...(hardLimits[key] || {}), ...patch };
      // Drop undefined / null entries so the cap object only carries set fields.
      for (const k of Object.keys(merged)) {
        if (merged[k] === undefined || merged[k] === null || Number.isNaN(merged[k])) delete merged[k];
      }
      if (Object.keys(merged).length === 0) {
        delete hardLimits[key];
      } else {
        hardLimits[key] = merged;
      }
      if (Object.keys(hardLimits).length === 0) {
        delete mod._hardLimits;
      } else {
        mod._hardLimits = hardLimits;
      }

      // After the cap changes, drag the override value with it. If the
      // stored value for this setting falls outside the new effective
      // range, clamp it in place so the visible value never sits beyond
      // the cap the host just typed.
      const schemaForMod = (moduleSchemas || []).find(m => m.name === moduleName);
      const settingDef = schemaForMod?.settings?.[key];
      // Build the effective cap that will apply when this update lands:
      // Free baseline (for non-Free tiers) + the just-updated cap.
      const freeOwn = isFreeTier ? {} : (((freeOverrides[moduleName] || {})._hardLimits) || {})[key] || {};
      const effCap = { ...freeOwn, ...merged };
      if (settingDef && settingDef.type === 'number' && typeof mod[key] === 'number') {
        const { effMin, effMax } = numberEffectiveBound(settingDef, effCap);
        let v = mod[key];
        if (typeof effMin === 'number' && v < effMin) v = effMin;
        if (typeof effMax === 'number' && v > effMax) v = effMax;
        if (v !== mod[key]) mod[key] = v;
      } else if (settingDef && settingDef.type === 'string' && typeof mod[key] === 'string') {
        // Truncate string values when their length cap shrinks below the
        // current value's length. We do NOT pad shorter strings up to
        // `minLength` automatically - that would invent characters the
        // user didn't type; just let save-time validation flag it.
        const { effMaxLength } = stringEffectiveBound(settingDef, effCap);
        if (typeof effMaxLength === 'number' && mod[key].length > effMaxLength) {
          mod[key] = mod[key].slice(0, effMaxLength);
        }
      }

      if (Object.keys(mod).length === 0) {
        delete next[moduleName];
      } else {
        next[moduleName] = mod;
      }
      return next;
    });
  }
  function settingHasCaps(setting) {
    const t = setting.type || 'string';
    return t === 'number' || t === 'string'
      || t === 'multiSelect' || t === 'multiChannel' || t === 'multiRole';
  }
  function renderCapsRow(moduleName, key, setting) {
    if (!settingHasCaps(setting)) return null;
    const cap = getCap(moduleName, key);
    const freeCap = getFreeCap(moduleName, key);
    const v = setting.validation || {};
    const t = setting.type || 'string';
    const fieldStyle = {
      padding: '3px 6px', borderRadius: '4px', border: '1px solid #444',
      background: '#171717', color: '#cfcfcf', fontSize: '0.75rem', width: '70px',
    };
    const labelStyle = { color: '#888', fontSize: '0.7rem' };

    // Placeholder for an empty cap input: just the most relevant reference
    // value (Free baseline if a paid tier has one, else the schema's
    // recommended limit, else the absolute bound). No label - the field
    // label next to the input already says what it is.
    function placeholderFor(capKey, schemaKey, absoluteKey) {
      if (!isFreeTier && freeCap[capKey] !== undefined) return String(freeCap[capKey]);
      if (v[schemaKey] !== undefined) return String(v[schemaKey]);
      if (v[absoluteKey] !== undefined) return String(v[absoluteKey]);
      return '';
    }

    function field(capKey, placeholder, minAttr, maxAttr) {
      // Caps must stay within their effective range (`validateHardLimits`
      // in settingsValidation enforces this against `absoluteMin/Max` and
      // `absoluteMinLength/MaxLength` etc. at save time; we mirror it
      // here so the UI can't even emit an out-of-bound cap value).
      //
      // Also enforces `min <= max` (equal is allowed): typing min=10 when
      // max=5 already exists clamps the new min to 5; typing max=5 when
      // min=10 already exists clamps the new max to 10. The sibling cap
      // pulls the typed value toward the valid range.
      const siblingKey = siblingCapKey(capKey);
      const siblingValue = siblingKey ? cap[siblingKey] : undefined;
      const clamp = (n) => {
        if (typeof n !== 'number' || Number.isNaN(n)) return n;
        if (typeof minAttr === 'number' && n < minAttr) return minAttr;
        if (typeof maxAttr === 'number' && n > maxAttr) return maxAttr;
        if (typeof siblingValue === 'number') {
          if (capKey.startsWith('min') && n > siblingValue) return siblingValue;
          if (capKey.startsWith('max') && n < siblingValue) return siblingValue;
        }
        return n;
      };
      // Reference value for "empty + interaction" bootstrap: the
      // placeholder. The placeholder already encodes the right reference
      // (Free's cap for paid tiers, else schema's recommended limit, else
      // the absolute bound). If the placeholder isn't numeric, fall back
      // to the floor of the cap's effective range.
      const placeholderNum = placeholder !== '' ? parseFloat(placeholder) : NaN;
      const refNum = !Number.isNaN(placeholderNum) ? placeholderNum
        : (typeof minAttr === 'number' ? minAttr : 0);
      const isEmpty = cap[capKey] === undefined;
      // String-coerce for stable controlled-input behavior across browsers.
      const capValue = isEmpty || !Number.isFinite(cap[capKey]) ? '' : String(cap[capKey]);
      // Custom paired +/- stepper. Native spinner clicks don't reveal
      // direction, so we replace them with explicit buttons.
      const stepBy = (direction) => {
        const base = !isEmpty && Number.isFinite(cap[capKey]) ? cap[capKey] : refNum;
        patchCap(moduleName, key, { [capKey]: clamp(base + direction) });
      };
      const stepperBtnStyle = {
        background: '#171717', color: '#888', border: '1px solid #444',
        cursor: 'pointer', padding: '0 3px', lineHeight: 1, fontSize: '0.55rem',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flex: 1, minHeight: 0,
      };
      return (
        <div style={{ display: 'inline-flex', alignItems: 'stretch' }}>
          <input type="number" className="no-native-spinner"
            style={{
              ...fieldStyle, width: '60px',
              borderTopRightRadius: 0, borderBottomRightRadius: 0,
            }}
            value={capValue}
            placeholder={placeholder}
            min={minAttr} max={maxAttr}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                stepBy(e.key === 'ArrowUp' ? 1 : -1);
              }
            }}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') { patchCap(moduleName, key, { [capKey]: undefined }); return; }
              const num = parseFloat(raw);
              if (Number.isNaN(num)) return;
              patchCap(moduleName, key, { [capKey]: clamp(num) });
            }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <button type="button" onClick={() => stepBy(1)}
              style={{ ...stepperBtnStyle, borderTopRightRadius: '4px', borderBottom: 'none', borderLeft: 'none' }}
              aria-label="Increment"
              tabIndex={-1}>▲</button>
            <button type="button" onClick={() => stepBy(-1)}
              style={{ ...stepperBtnStyle, borderBottomRightRadius: '4px', borderLeft: 'none' }}
              aria-label="Decrement"
              tabIndex={-1}>▼</button>
          </div>
        </div>
      );
    }

    // For string/array caps, fall back to `absoluteMin`/`absoluteMax` when
    // the type-specific length/items field isn't set, so a schema author
    // writing `absoluteMin: 1` gets it honored as a length / item floor.
    const absLo = (typeKey) => v[typeKey] ?? v.absoluteMin;
    const absHi = (typeKey) => v[typeKey] ?? v.absoluteMax;

    let fields;
    let rangeText = null;
    if (t === 'number') {
      const lo = v.absoluteMin;
      const hi = v.absoluteMax;
      fields = (
        <>
          <span style={labelStyle}>min</span>
          {field('min', placeholderFor('min', 'min', 'absoluteMin'), lo, hi)}
          <span style={labelStyle}>max</span>
          {field('max', placeholderFor('max', 'max', 'absoluteMax'), lo, hi)}
        </>
      );
      const rLo = v.min ?? lo;
      const rHi = v.max ?? hi;
      if (rLo !== undefined || rHi !== undefined) rangeText = `${rLo ?? '−∞'}–${rHi ?? '∞'}`;
    } else if (t === 'string') {
      const lo = absLo('absoluteMinLength') ?? 0;
      const hi = absHi('absoluteMaxLength');
      fields = (
        <>
          <span style={labelStyle}>min length</span>
          {field('minLength', placeholderFor('minLength', 'minLength', 'absoluteMinLength'), lo, hi)}
          <span style={labelStyle}>max length</span>
          {field('maxLength', placeholderFor('maxLength', 'maxLength', 'absoluteMaxLength'), lo, hi)}
        </>
      );
      const rLo = v.minLength ?? lo;
      const rHi = v.maxLength ?? hi;
      if (rLo !== undefined || rHi !== undefined) rangeText = `${rLo ?? 0}–${rHi ?? '∞'} chars`;
    } else {
      const lo = absLo('absoluteMinItems') ?? 0;
      const hi = absHi('absoluteMaxItems');
      fields = (
        <>
          <span style={labelStyle}>min items</span>
          {field('minItems', placeholderFor('minItems', 'minItems', 'absoluteMinItems'), lo, hi)}
          <span style={labelStyle}>max items</span>
          {field('maxItems', placeholderFor('maxItems', 'maxItems', 'absoluteMaxItems'), lo, hi)}
        </>
      );
      const rLo = v.minItems ?? lo;
      const rHi = v.maxItems ?? hi;
      if (rLo !== undefined || rHi !== undefined) rangeText = `${rLo ?? 0}–${rHi ?? '∞'} items`;
    }
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        marginTop: '4px', paddingLeft: '12px',
        borderLeft: '2px solid rgba(245, 175, 25, 0.35)',
      }}>
        <span style={{ color: '#f5af19', fontSize: '0.7rem', fontWeight: 600, marginRight: '4px' }}>
          {isFreeTier ? 'Cap' : 'Cap (overrides Free)'}
        </span>
        {fields}
        {rangeText && (
          <span style={{ color: '#666', fontSize: '0.72rem' }}>
            <span style={{ color: '#888' }}>Range:</span> {rangeText}
          </span>
        )}
      </div>
    );
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
      // Effective range is the intersection of:
      //   - absolute bounds (immutable technical floor/ceiling)
      //   - the cap currently being edited (Free baseline + this tier's
      //     own cap merged), which shadows the schema's soft min/max
      //   - the schema's soft min/max when no cap is set (the schema
      //     author's recommended range)
      // Mirrors the server-side `validateValueWithEffectiveLimits` flow.
      const cap = effectiveCap(moduleName, key);
      const { effMin, effMax } = numberEffectiveBound(setting, cap);
      const hasMin = typeof effMin === 'number';
      const hasMax = typeof effMax === 'number';
      const clamp = (n) => {
        if (typeof n !== 'number' || Number.isNaN(n)) return n;
        if (hasMin && n < effMin) return effMin;
        if (hasMax && n > effMax) return effMax;
        return n;
      };
      // Coerce to a string for the `value` prop. React's controlled number
      // input behaves inconsistently when the prop transitions between a
      // number and an empty string: some browsers retain the last-shown
      // text even when React thinks the value cleared. String normalizes
      // the prop type across all states.
      const valueProp = isSet && Number.isFinite(current) ? String(current) : '';
      // Custom paired +/- stepper. Replaces the native spinner because we
      // can't tell which native spinner button was clicked - both produce
      // an onChange event with no direction information, and on an empty
      // input the browser fills in the same min/step value for both, so
      // UP and DOWN are indistinguishable. The custom buttons know which
      // direction they are stepping in, and the keyboard arrow handler
      // below mirrors the same logic for keyboard input.
      const stepBy = (direction) => {
        const base = isSet && Number.isFinite(current)
          ? current
          : (typeof setting.default === 'number' ? setting.default : 0);
        setSettingValue(moduleName, key, clamp(base + direction));
      };
      const stepperBtnStyle = {
        background: '#1a1a2e', color: '#888', border: '1px solid #555',
        cursor: 'pointer', padding: '0 4px', lineHeight: 1, fontSize: '0.6rem',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // No fixed height: `flex: 1` inside the column stretches each
        // button to fill half of the input's natural height, so the
        // total stepper matches the input regardless of font size /
        // padding tweaks elsewhere.
        flex: 1, minHeight: 0,
      };
      input = (
        <div style={{ display: 'inline-flex', alignItems: 'stretch' }}>
          <input type="number" className="no-native-spinner"
            style={{
              ...inputStyle, width: '90px',
              borderTopRightRadius: 0, borderBottomRightRadius: 0,
            }}
            value={valueProp}
            placeholder={String(setting.default ?? '')}
            min={hasMin ? effMin : undefined}
            max={hasMax ? effMax : undefined}
            onKeyDown={e => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                stepBy(e.key === 'ArrowUp' ? 1 : -1);
              }
            }}
            onChange={e => {
              const raw = e.target.value;
              if (raw === '') { removeSettingOverride(moduleName, key); return; }
              const parsed = parseFloat(raw);
              if (Number.isNaN(parsed)) return;
              setSettingValue(moduleName, key, clamp(parsed));
            }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <button type="button" onClick={() => stepBy(1)}
              style={{ ...stepperBtnStyle, borderTopRightRadius: '5px', borderBottom: 'none', borderLeft: 'none' }}
              aria-label="Increment"
              tabIndex={-1}>▲</button>
            <button type="button" onClick={() => stepBy(-1)}
              style={{ ...stepperBtnStyle, borderBottomRightRadius: '5px', borderLeft: 'none' }}
              aria-label="Decrement"
              tabIndex={-1}>▼</button>
          </div>
        </div>
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
      // Hex preview color for the native `<input type="color">` swatch.
      // Accepts both `0xRRGGBB` (canonical) and `#RRGGBB` (textbox) at
      // read time, even if the typed value is mid-edit and not yet a
      // complete hex string.
      const hexVal = isSet && typeof current === 'string' && current
        ? (current.startsWith('0x') ? '#' + current.slice(2) : current)
        : '';
      const isCompleteHex = (s) => typeof s === 'string'
        && /^[0-9A-Fa-f]{6}$/.test(s.replace(/^(0x|#)/i, ''));
      input = (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input type="color" value={isCompleteHex(current) ? hexVal : '#5865F2'}
            onChange={e => setSettingValue(moduleName, key, '0x' + e.target.value.slice(1).toUpperCase())}
            style={{ width: '32px', height: '28px', border: 'none', background: 'none', cursor: 'pointer' }} />
          <input type="text" style={{ ...inputStyle, width: '100px' }}
            value={isSet ? current : ''} placeholder={String(setting.default ?? '')}
            onChange={e => {
              // Never interrupt while typing: store the raw text as-is,
              // even mid-edit (e.g. `0xa-`). Validation + correction
              // happens on blur, below.
              const raw = e.target.value;
              if (raw === '') { removeSettingOverride(moduleName, key); return; }
              setSettingValue(moduleName, key, raw);
            }}
            onBlur={e => {
              // On blur, normalize a valid hex (accept `RRGGBB`,
              // `#RRGGBB`, or `0xRRGGBB`, any case) to the canonical
              // `0xRRGGBB` form. If the value is invalid (incomplete,
              // wrong length, non-hex characters), revert: drop the
              // override so the field re-shows the schema default
              // placeholder. This way the field never settles in an
              // invalid state but the user can type freely without
              // being corrected mid-keystroke.
              const raw = (e.target.value || '').trim();
              if (raw === '') { removeSettingOverride(moduleName, key); return; }
              const stripped = raw.replace(/^(0x|#)/i, '');
              if (/^[0-9A-Fa-f]{6}$/.test(stripped)) {
                const normalized = '0x' + stripped.toUpperCase();
                if (normalized !== current) setSettingValue(moduleName, key, normalized);
              } else {
                removeSettingOverride(moduleName, key);
              }
            }} />
        </div>
      );
    } else {
      // Fallback for string-shaped settings (type: 'string', or anything
      // not specially handled above). Mirrors the number input's clamp
      // logic, but the bound is on length (HTML `maxLength` attribute
      // prevents typing beyond, and the cap-change drag in patchCap
      // truncates the stored value when a cap tightens).
      const { effMaxLength } = stringEffectiveBound(setting, effectiveCap(moduleName, key));
      input = (
        <input type="text" style={{ ...inputStyle, width: '100%', maxWidth: '300px' }}
          value={isSet ? current : ''} placeholder={String(setting.default ?? '')}
          maxLength={typeof effMaxLength === 'number' ? effMaxLength : undefined}
          onChange={e => {
            const raw = e.target.value;
            if (raw === '') { removeSettingOverride(moduleName, key); return; }
            // Defensive truncation for paste / IME / spec-compliance:
            // HTML `maxLength` covers typing in most browsers but paste
            // events can land an overflow.
            const truncated = typeof effMaxLength === 'number' && raw.length > effMaxLength
              ? raw.slice(0, effMaxLength)
              : raw;
            setSettingValue(moduleName, key, truncated);
          }} />
      );
    }

    const freeVal = !isFreeTier ? getFreeSettingValue(moduleName, key) : undefined;
    const metaStyle = { color: '#666', fontSize: '0.72rem' };
    const metaBoldStyle = { color: '#888' };

    return (
      <div key={key} style={{
        padding: '10px 12px',
        background: isOwned ? 'rgba(88, 101, 242, 0.05)' : 'rgba(255,255,255,0.015)',
        border: isOwned ? '1px solid rgba(88, 101, 242, 0.18)' : '1px solid #2a2a2a',
        borderRadius: '6px', marginBottom: '6px',
      }}>
        {/* Title line: label + inherited badge */}
        <div style={{ color: '#ddd', fontSize: '0.88rem', fontWeight: 600, marginBottom: '2px' }}>
          {setting.label || key}
          {isInherited && (
            <span title="Value inherited from the Free tier; changes to Free flow through here automatically." style={{
              marginLeft: '8px', color: '#5aa5ff',
              background: 'rgba(90, 165, 255, 0.08)', border: '1px solid rgba(90, 165, 255, 0.3)',
              padding: '1px 6px', borderRadius: '10px', fontSize: '0.68rem', fontWeight: 500,
            }}>inherited</span>
          )}
        </div>

        {/* Description (optional) */}
        {setting.description && (
          <div style={{ color: '#7a7a7a', fontSize: '0.75rem', marginBottom: '6px' }}>
            {setting.description}
          </div>
        )}

        {/* Value line: input, then inline metadata (default, Free baseline),
            then Reset. Range info belongs with the caps row, not here. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {input}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {setting.default !== undefined && (
              <span style={metaStyle}>
                <span style={metaBoldStyle}>Default:</span> {String(setting.default)}
              </span>
            )}
            {!isFreeTier && freeVal !== undefined && (
              <span style={{ ...metaStyle, color: '#5aa5ff' }}
                title="Reference: don't go worse than Free for this setting.">
                <span style={metaBoldStyle}>Free:</span> {String(freeVal)}
              </span>
            )}
          </div>
          {isOwned && (
            <button onClick={() => removeSettingOverride(moduleName, key)}
              title={freeVal !== undefined ? 'Clear override and inherit from Free' : 'Reset to default'}
              style={{
                marginLeft: 'auto',
                background: 'none', border: '1px solid #555', color: '#888', borderRadius: '4px',
                padding: '4px 8px', cursor: 'pointer', fontSize: '0.75rem',
              }}>Reset</button>
          )}
        </div>

        {renderCapsRow(moduleName, key, setting)}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={onClose} style={{
          background: '#40444b', color: '#ddd', border: 'none', padding: '6px 12px',
          borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem',
        }}>&larr; Back</button>
        <button onClick={handleSave} disabled={saving || !isDirty} title={!isDirty && !saving ? 'No unsaved changes' : undefined} style={{
          background: (saving || !isDirty) ? '#555' : 'linear-gradient(135deg, #3ba55d, #2d8049)',
          color: '#fff', border: 'none', padding: '8px 14px', borderRadius: '6px',
          cursor: (saving || !isDirty) ? 'not-allowed' : 'pointer',
          opacity: (saving || !isDirty) ? 0.55 : 1,
          fontWeight: 600, fontSize: '0.85rem',
          display: 'inline-flex', alignItems: 'center', gap: '8px',
        }}>
          <span>{saving ? 'Saving...' : 'Save Changes'}</span>
          {isDirty && !saving && (
            <span title="You have unsaved changes" style={{
              background: '#ffcc4d', color: '#1a1a1a', borderRadius: '50%',
              width: '18px', height: '18px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.78rem', fontWeight: 800, lineHeight: 1,
            }}>!</span>
          )}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, color: '#f5af19' }}>{tier.displayName}: Access & Overrides</h3>
          <span style={{ color: '#888', fontSize: '0.82rem' }}>
            {moduleSchemas.length} module{moduleSchemas.length !== 1 ? 's' : ''}
              {totalChanges > 0 && ` \u00B7 ${totalChanges} change${totalChanges !== 1 ? 's' : ''}`}
            </span>
          </div>
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
  // Filter to guilds that don't already have a manual sub anywhere (active
  // or paused queue). Stacking lets us grant another manual on top, but for
  // the simplest UX we hide guilds that already have one.
  function guildHasManual(g) {
    const subs = existingSubscriptions?.[g.id];
    if (!subs) return false;
    if (subs.active?.source === 'manual') return true;
    if (Array.isArray(subs.paused) && subs.paused.some(p => p.source === 'manual')) return true;
    return false;
  }
  const availableGuilds = (botGuilds || []).filter(g => !guildHasManual(g));

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
  // New-model defaults: ProviderLinks is an Array of { providerId, enabled,
  // mode, priceConfig?, productConfig?, cache? }. One row per activated
  // provider on first open; admin enables the ones they want. Product mode
  // is preferred (single Product ID, variants sync from the provider) over
  // hand-curating individual variant IDs; falls back to Price mode for
  // providers without a Product concept (Discord, Patreon, Boost).
  const buildInitialLinks = () => {
    if (offering?.providerLinks && Array.isArray(offering.providerLinks)) {
      return offering.providerLinks.map(l => ({ ...l }));
    }
    return Object.entries(activatedProviders || {}).map(([providerId, a]) => {
      const supportsProduct = !!(providers || []).find(p => p.id === providerId)?.capabilities?.supportsProductMode;
      return supportsProduct
        ? { providerId, enabled: !!a.defaultEnabled, mode: 'product', productConfig: { productId: '' } }
        : { providerId, enabled: !!a.defaultEnabled, mode: 'price', priceConfig: { entries: [] } };
    });
  };
  const [draft, setDraft] = useState(() => ({
    id: offering?.id || `offer-${Date.now().toString(36)}`,
    label: offering?.label || 'Standard',
    description: offering?.description || '',
    icon: offering?.icon,
    forceAutoRenew: !!offering?.forceAutoRenew,
    primaryProviderId: offering?.primaryProviderId,
    providerLinks: buildInitialLinks(),
  }));
  const [refreshing, setRefreshing] = useState({}); // providerId -> bool
  const [refreshError, setRefreshError] = useState({}); // providerId -> string

  // Latest draft mirrored to a ref so async setTimeout-driven auto-fetches
  // always see the user's most recent input. Without this, a debounced
  // refresh fired off keystroke N captures the closure from render N, which
  // is one render behind the state setter that scheduled it.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;

  // Per-provider debounce timers for auto-fetch on Product/Variant ID input.
  const refreshTimers = React.useRef({});
  React.useEffect(() => () => {
    for (const t of Object.values(refreshTimers.current)) clearTimeout(t);
  }, []);

  function getLink(providerId) {
    return draft.providerLinks.find(l => l.providerId === providerId);
  }

  function updateLink(providerId, mutator) {
    setDraft(d => ({
      ...d,
      providerLinks: d.providerLinks.map(l =>
        l.providerId === providerId ? mutator({ ...l }) : l,
      ),
    }));
  }

  function ensureLinkExists(providerId) {
    setDraft(d => {
      if (d.providerLinks.some(l => l.providerId === providerId)) return d;
      const supportsProduct = !!(providers || []).find(p => p.id === providerId)?.capabilities?.supportsProductMode;
      return {
        ...d,
        providerLinks: [...d.providerLinks, supportsProduct
          ? { providerId, enabled: false, mode: 'product', productConfig: { productId: '' } }
          : { providerId, enabled: false, mode: 'price', priceConfig: { entries: [] } }],
      };
    });
  }

  function toggleProvider(providerId) {
    ensureLinkExists(providerId);
    updateLink(providerId, l => ({ ...l, enabled: !l.enabled }));
  }

  function setMode(providerId, mode) {
    updateLink(providerId, l => ({
      ...l,
      mode,
      // Reset the other mode's config to defaults; keep the existing cache so
      // recently-fetched variants don't disappear under the user.
      priceConfig: mode === 'price' ? (l.priceConfig || { entries: [] }) : undefined,
      productConfig: mode === 'product' ? (l.productConfig || { productId: '' }) : undefined,
    }));
    // Mode switch may reveal data that's already enterable (e.g. flipping back
    // to product after typing a productId earlier). Schedule a refresh; the
    // gate inside scheduleRefresh skips when there's nothing to fetch.
    scheduleRefresh(providerId);
  }

  function addPriceEntry(providerId) {
    updateLink(providerId, l => ({
      ...l,
      priceConfig: {
        entries: [...(l.priceConfig?.entries || []), { variantId: '' }],
      },
    }));
  }

  function updatePriceEntry(providerId, idx, mutator) {
    updateLink(providerId, l => {
      const entries = [...(l.priceConfig?.entries || [])];
      entries[idx] = mutator({ ...entries[idx] });
      return { ...l, priceConfig: { entries } };
    });
    scheduleRefresh(providerId);
  }

  function removePriceEntry(providerId, idx) {
    updateLink(providerId, l => {
      const entries = (l.priceConfig?.entries || []).filter((_, i) => i !== idx);
      return { ...l, priceConfig: { entries } };
    });
    scheduleRefresh(providerId);
  }

  function setProductId(providerId, productId) {
    updateLink(providerId, l => ({
      ...l,
      productConfig: { ...(l.productConfig || {}), productId },
    }));
    scheduleRefresh(providerId);
  }

  function setHostedPicker(providerId, useProviderHostedPicker) {
    updateLink(providerId, l => ({
      ...l,
      productConfig: { ...(l.productConfig || { productId: '' }), useProviderHostedPicker },
    }));
  }

  /**
   * Set an admin label override for a single variant in Product mode. Empty
   * string clears the override (so the provider's label shines through). No
   * cache re-bake: overrides are applied at display time both here and in
   * the SubscribeModal, so the cached `OfferingVariant.label` stays as the
   * provider's truth.
   */
  function setProductVariantOverride(providerId, variantId, value) {
    updateLink(providerId, l => {
      const prev = l.productConfig?.variantLabelOverrides || {};
      const next = { ...prev };
      const trimmed = value?.trim();
      if (trimmed) next[variantId] = value;
      else delete next[variantId];
      return {
        ...l,
        productConfig: { ...(l.productConfig || { productId: '' }), variantLabelOverrides: next },
      };
    });
  }

  /**
   * Debounced auto-fetch. Fires 500ms after the last keystroke per provider.
   * Skips silently when there's nothing to fetch (empty productId or no
   * variant entries) so typing then deleting doesn't pop "Enter a Product ID"
   * errors. The manual Refresh button uses `refreshLink` directly which
   * still throws to surface those messages on click.
   */
  function scheduleRefresh(providerId) {
    clearTimeout(refreshTimers.current[providerId]);
    refreshTimers.current[providerId] = setTimeout(() => {
      const link = draftRef.current.providerLinks.find(l => l.providerId === providerId);
      if (!link) return;
      if (link.mode === 'product') {
        if (!link.productConfig?.productId?.trim()) return;
      } else {
        const entries = link.priceConfig?.entries || [];
        if (entries.every(e => !e.variantId?.trim())) return;
      }
      void refreshLink(providerId);
    }, 500);
  }

  async function refreshLink(providerId) {
    const link = draftRef.current.providerLinks.find(l => l.providerId === providerId);
    if (!link) return;
    setRefreshing(r => ({ ...r, [providerId]: true }));
    setRefreshError(r => ({ ...r, [providerId]: undefined }));
    try {
      if (link.mode === 'product') {
        if (!link.productConfig?.productId) {
          throw new Error('Enter a Product ID first.');
        }
        const res = await api.post(`/appstore/premium/providers/${providerId}/product-lookup`, {
          productId: link.productConfig.productId,
        });
        if (!res.success) throw new Error(res.error || 'Lookup failed');
        updateLink(providerId, l => ({
          ...l,
          cache: {
            syncedAt: new Date().toISOString(),
            variants: res.variants || [],
          },
        }));
      } else {
        const entries = link.priceConfig?.entries || [];
        if (entries.length === 0) throw new Error('Add at least one variant entry first.');
        const variants = [];
        for (const entry of entries) {
          if (!entry.variantId) continue;
          const res = await api.post(`/appstore/premium/providers/${providerId}/variant-lookup`, {
            variantId: entry.variantId,
          });
          if (res.success && res.variant) {
            variants.push(entry.labelOverride
              ? { ...res.variant, label: entry.labelOverride }
              : res.variant);
          }
        }
        updateLink(providerId, l => ({
          ...l,
          cache: {
            syncedAt: new Date().toISOString(),
            variants,
          },
        }));
      }
    } catch (err) {
      setRefreshError(r => ({ ...r, [providerId]: err?.message || 'Lookup failed' }));
    } finally {
      setRefreshing(r => ({ ...r, [providerId]: false }));
    }
  }

  // Show only providers that are activated system-wide. Real providers (not
  // immediate-mechanism) and Dummy alike.
  const activatedProviderIds = Object.keys(activatedProviders || {});
  const activatedList = activatedProviderIds
    .map(pid => (providers || []).find(p => p.id === pid))
    .filter(Boolean);

  /**
   * Per-provider URL builder for the "Open in [provider]" deep link. Returns
   * null when there's no useful target (provider not handled, or required
   * IDs not yet typed). Stripe goes to its dashboard; Dummy jumps to the
   * in-app Dummy Settings panel via a hash anchor on /appstore.
   *
   * Stripe: test vs live mode is left to the user's dashboard session; we
   * don't know which key is configured here and Stripe handles the redirect.
   */
  function buildOpenInUrl(provider, link) {
    if (!provider) return null;
    if (provider.id === 'stripe') {
      if (link.mode === 'product') {
        const pid = link.productConfig?.productId?.trim();
        return pid ? `https://dashboard.stripe.com/products/${encodeURIComponent(pid)}` : null;
      }
      const firstId = (link.priceConfig?.entries || [])
        .map(e => e.variantId?.trim())
        .find(Boolean);
      return firstId ? `https://dashboard.stripe.com/prices/${encodeURIComponent(firstId)}` : null;
    }
    if (provider.id === 'dummy') {
      // Same-origin deep link with a hash anchor; AppStorePanel scrolls to
      // the matching id on mount + hashchange.
      return '/appstore#dummy-settings';
    }
    return null;
  }

  function handleSaveClick() {
    if (!draft.label?.trim()) { showToast('Label is required', 'error'); return; }
    // Surface hosted-picker cap overflow as a confirm() at save time so the
    // admin doesn't accidentally ship a config that hides variants from
    // subscribers. Inline warning above already flags it; this is a hard
    // checkpoint that also catches the case where the admin enables the
    // toggle but never scrolls back to read the inline notice.
    const overflows = [];
    for (const link of (draft.providerLinks || [])) {
      if (!link.enabled) continue;
      if (link.mode !== 'product') continue;
      if (!link.productConfig?.useProviderHostedPicker) continue;
      const provider = (providers || []).find(p => p.id === link.providerId);
      const cap = provider?.capabilities?.hostedPickerVariantCap;
      if (!cap) continue;
      const activeCount = (link.cache?.variants || []).filter(v => v.active).length;
      if (activeCount > cap) {
        const hidden = activeCount - cap;
        overflows.push(`${provider.displayName}: ${hidden} of ${activeCount} active prices won't be visible (cap ${cap})`);
      }
    }
    if (overflows.length > 0) {
      const ok = confirm(
        `Heads up - some hosted-picker links have more variants than the provider can show:\n\n` +
        overflows.map(o => `  • ${o}`).join('\n') +
        `\n\nSave anyway?`
      );
      if (!ok) return;
    }
    onSave(draft);
  }

  const overlayStyle = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  };
  const modalStyle = {
    background: '#2c2f33', borderRadius: '12px', padding: '24px', width: '640px', maxWidth: '92vw',
    maxHeight: '90vh', overflow: 'auto', border: '1px solid #444',
  };
  const inputStyle = {
    width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #555',
    background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.9rem', boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', color: '#aaa', fontSize: '0.82rem', marginBottom: '4px', marginTop: '14px' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px 0', color: '#fff' }}>{isEdit ? 'Edit Offering' : 'New Offering'}</h3>
        <p style={{ color: '#888', fontSize: '0.82rem', margin: 0 }}>
          Define a plan and pick which payment methods make it purchasable. Each method has its own variant list.
        </p>

        <label style={labelStyle}>Label</label>
        <input style={inputStyle} value={draft.label || ''} placeholder="e.g. Standard"
          onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} />

        <label style={labelStyle}>Description <span style={{ color: '#666', fontWeight: 400 }}>(optional)</span></label>
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: '60px', fontFamily: 'inherit' }}
          rows={2}
          value={draft.description || ''}
          placeholder="e.g. Best value: includes priority support and custom branding."
          onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px', color: '#ddd', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!draft.forceAutoRenew}
            onChange={e => setDraft(d => ({ ...d, forceAutoRenew: e.target.checked }))}
            style={{ accentColor: '#5865F2' }} />
          Force auto-renew (hide the "buy as one-time" option for users)
        </label>
        <div style={{ color: '#666', fontSize: '0.72rem', marginTop: '2px', marginLeft: '24px' }}>
          Only affects recurring variants. Lifetime/one-time variants never renew regardless.
        </div>

        <div style={{ marginTop: '20px', color: '#aaa', fontSize: '0.82rem', fontWeight: 600, marginBottom: '8px' }}>
          Accept Payment Via
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {activatedList.map(provider => {
              const link = getLink(provider.id) || {
                providerId: provider.id,
                enabled: false,
                mode: 'price',
                priceConfig: { entries: [] },
              };
              const cap = provider.capabilities || {};
              const variants = link.cache?.variants || [];
              return (
                <div key={provider.id} style={{
                  background: '#36393f', borderRadius: '8px', padding: '12px 14px',
                  border: link.enabled ? '1px solid #5865F2' : '1px solid #444',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!link.enabled}
                        onChange={() => toggleProvider(provider.id)}
                        style={{ accentColor: '#5865F2', width: '16px', height: '16px' }} />
                      <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>
                        {provider.displayName}
                      </span>
                    </label>
                    {!provider.isConfigured && (
                      <span style={{
                        background: 'rgba(230, 126, 34, 0.2)', color: '#e67e22',
                        padding: '1px 7px', borderRadius: '10px', fontSize: '0.7rem',
                      }}>not configured</span>
                    )}
                    {link.enabled && cap.supportsProductMode && (
                      <select value={link.mode}
                        onChange={e => setMode(provider.id, e.target.value)}
                        style={{
                          marginLeft: 'auto',
                          padding: '4px 8px', borderRadius: '5px', border: '1px solid #555',
                          background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.8rem',
                        }}>
                        <option value="product">Product mode (synced from provider)</option>
                        <option value="price">Price mode (curated list)</option>
                      </select>
                    )}
                  </div>

                  {link.enabled && (
                    <div style={{ marginTop: '10px', paddingLeft: '24px' }}>
                      {link.mode === 'product' ? (
                        <div>
                          <div style={{ color: '#888', fontSize: '0.78rem', marginBottom: '4px' }}>
                            {cap.productIdLabel || 'Product ID'}
                          </div>
                          <input style={{ ...inputStyle, marginBottom: '8px' }}
                            value={link.productConfig?.productId || ''}
                            onChange={e => setProductId(provider.id, e.target.value)}
                            placeholder="prod_..." />
                          {cap.supportsHostedPicker && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ddd', fontSize: '0.82rem', cursor: 'pointer', marginBottom: '8px' }}>
                              <input type="checkbox" checked={!!link.productConfig?.useProviderHostedPicker}
                                onChange={e => setHostedPicker(provider.id, e.target.checked)}
                                style={{ accentColor: '#5865F2' }} />
                              Show prices on {provider.displayName}'s checkout page
                              {cap.hostedPickerVariantCap ? ` (max ${cap.hostedPickerVariantCap} prices visible)` : ''}
                            </label>
                          )}
                          {(() => {
                            // Surface the cap inline as soon as the wired Product
                            // exceeds it AND the hosted picker is on. Save still
                            // succeeds (config is valid; provider just truncates
                            // visually), but the admin should know the overflow
                            // variants won't be selectable from the hosted page.
                            if (!cap.supportsHostedPicker) return null;
                            if (!cap.hostedPickerVariantCap) return null;
                            if (!link.productConfig?.useProviderHostedPicker) return null;
                            const activeCount = (link.cache?.variants || []).filter(v => v.active).length;
                            if (activeCount <= cap.hostedPickerVariantCap) return null;
                            const hidden = activeCount - cap.hostedPickerVariantCap;
                            return (
                              <div style={{
                                background: 'rgba(230, 126, 34, 0.1)', border: '1px solid rgba(230, 126, 34, 0.5)',
                                color: '#e67e22', padding: '6px 10px', borderRadius: '5px',
                                fontSize: '0.74rem', marginBottom: '8px',
                              }}>
                                ⚠ {provider.displayName}'s hosted page shows max {cap.hostedPickerVariantCap} prices. {hidden} of your {activeCount} active price{activeCount === 1 ? '' : 's'} won't be visible to subscribers. Either uncheck the hosted-picker option (we'll render the full list) or reduce the active prices on this Product at {provider.displayName}.
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <div>
                          <div style={{ color: '#888', fontSize: '0.78rem', marginBottom: '4px' }}>
                            {cap.variantIdLabel || 'Variant ID'}{cap.supportsMultipleVariants ? ' (one per billing option)' : ''}
                          </div>
                          {(link.priceConfig?.entries || []).map((entry, idx) => (
                            <div key={idx} style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                              <input style={{ ...inputStyle, flex: 1 }}
                                value={entry.variantId}
                                onChange={e => updatePriceEntry(provider.id, idx, en => ({ ...en, variantId: e.target.value }))}
                                placeholder="price_..." />
                              <input style={{ ...inputStyle, flex: 1 }}
                                value={entry.labelOverride || ''}
                                onChange={e => updatePriceEntry(provider.id, idx, en => ({ ...en, labelOverride: e.target.value || undefined }))}
                                placeholder="Label override (optional)" />
                              <button type="button" onClick={() => removePriceEntry(provider.id, idx)}
                                style={{
                                  background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                                  padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem',
                                }}>×</button>
                            </div>
                          ))}
                          {(cap.supportsMultipleVariants || (link.priceConfig?.entries || []).length === 0) && (
                            <button type="button" onClick={() => addPriceEntry(provider.id)}
                              style={{
                                background: '#40444b', color: '#ddd', border: 'none',
                                padding: '5px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem', marginTop: '4px',
                              }}>+ Add variant</button>
                          )}
                        </div>
                      )}

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => refreshLink(provider.id)}
                          disabled={!!refreshing[provider.id]}
                          style={{
                            background: 'transparent', border: '1px solid #555', color: '#aaa',
                            padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.75rem',
                          }}>
                          {refreshing[provider.id] ? 'Refreshing...' : '⟳ Refresh from provider'}
                        </button>
                        {(() => {
                          const url = buildOpenInUrl(provider, link);
                          if (!url) return null;
                          return (
                            <a href={url} target="_blank" rel="noopener noreferrer" style={{
                              background: 'transparent', border: '1px solid #555', color: '#aaa',
                              padding: '4px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.75rem',
                              textDecoration: 'none',
                            }}>
                              Open in {provider.displayName} ↗
                            </a>
                          );
                        })()}
                        {link.cache?.syncedAt && (
                          <span style={{ color: '#666', fontSize: '0.72rem' }}>
                            synced {new Date(link.cache.syncedAt).toLocaleString()}
                          </span>
                        )}
                      </div>

                      {refreshError[provider.id] && (
                        <div style={{ color: '#ed4245', fontSize: '0.78rem', marginTop: '6px' }}>
                          ⚠ {refreshError[provider.id]}
                        </div>
                      )}

                      {variants.length > 0 && (
                        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {variants.map(v => {
                            // Product mode: show an inline label-override input
                            // per variant (Price mode already has its override
                            // inside the entry editor above). Empty value falls
                            // through to the provider's label as a placeholder.
                            const isProductMode = link.mode === 'product';
                            const override = isProductMode
                              ? (link.productConfig?.variantLabelOverrides?.[v.variantId] || '')
                              : '';
                            return (
                              <div key={v.variantId} style={{
                                background: '#1a1a1a', padding: '6px 10px', borderRadius: '4px',
                                fontSize: '0.78rem', color: '#ddd',
                                display: 'flex', alignItems: 'center', gap: '10px',
                              }}>
                                {isProductMode ? (
                                  <input
                                    style={{
                                      flex: 1, minWidth: 0, padding: '3px 6px', borderRadius: '3px',
                                      border: '1px solid #444', background: '#0e0e0e', color: '#e0e0e0',
                                      fontSize: '0.76rem', boxSizing: 'border-box',
                                    }}
                                    value={override}
                                    placeholder={v.label}
                                    onChange={e => setProductVariantOverride(provider.id, v.variantId, e.target.value)}
                                    title="Override the label subscribers see for this variant. Leave empty to use the provider's label."
                                  />
                                ) : (
                                  <span style={{ flex: 1, minWidth: 0 }}>{v.label}</span>
                                )}
                                <span style={{ color: '#888', whiteSpace: 'nowrap' }}>
                                  {(v.amount / 100).toFixed(2)} {v.currency}
                                  {v.durationDays === null
                                    ? ' (lifetime)'
                                    : ` / ${v.durationDays}d`}
                                  {v.recurring ? ' · recurring' : ' · one-time'}
                                  {!v.active && ' · ARCHIVED'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

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
    (tier?.offerings || []).map(o => ({
      ...o,
      providerLinks: Array.isArray(o.providerLinks) ? o.providerLinks.map(l => ({ ...l })) : [],
    }))
  );
  const [saving, setSaving] = useState(false);
  const [editingOffering, setEditingOffering] = useState(null);      // null | 'new' | existing object
  // Baseline = the on-disk offerings at last successful save (or initial mount).
  // isDirty re-evaluates each render via canonical-JSON diff, so add-then-remove
  // and edit-then-revert round-trip back to a clean state.
  const [baseline, setBaseline] = useState(() => JSON.parse(JSON.stringify(tier?.offerings || [])));
  const isDirty = useMemo(
    () => JSON.stringify((offerings || []).map(_canonicalizeValue))
       !== JSON.stringify((baseline || []).map(_canonicalizeValue)),
    [offerings, baseline]
  );

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
    setEditingOffering(null);
  }

  function handleRemove(id) {
    if (!confirm('Remove this offering?')) return;
    setOfferings(prev => prev.filter(o => o.id !== id));
  }

  async function handleSaveAll() {
    if (!isDirty) return;
    setSaving(true);
    try {
      const clean = offerings.map(o => ({
        ...o,
        id: o.id || `offer-${Math.random().toString(36).slice(2, 8)}`,
        providerLinks: Array.isArray(o.providerLinks) ? o.providerLinks : [],
      }));
      const res = await api.put(`/appstore/premium/tiers/${tierId}`, {
        displayName: tier.displayName,
        priority: tier.priority,
        overrides: tier.overrides,
        offerings: clean,
      });
      if (res.success) {
        // Snap baseline to what we just persisted so isDirty clears immediately
        // (don't wait on the parent to re-pass the tier prop). Use `clean` -
        // that's what's now on disk, including any generated ids.
        setBaseline(JSON.parse(JSON.stringify(clean)));
        showSuccess('Offerings saved');
        onSave();
      } else setError(res.message || 'Failed to save offerings');
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
    const links = Array.isArray(o.providerLinks) ? o.providerLinks : [];
    return !links.some(l => l.enabled && activatedProviders?.[l.providerId]);
  }

  /**
   * Cheapest variant across all enabled provider links' caches; used to
   * surface a price hint on the offering card. Returns null when no link
   * has been refreshed yet (admin needs to click Refresh in the modal).
   */
  function cheapestVariant(o) {
    const links = Array.isArray(o.providerLinks) ? o.providerLinks : [];
    let best = null;
    for (const link of links) {
      if (!link.enabled) continue;
      const variants = link.cache?.variants || [];
      for (const v of variants) {
        if (!v.active) continue;
        if (!best || v.amount < best.amount) best = v;
      }
    }
    return best;
  }

  function variantCount(o) {
    const links = Array.isArray(o.providerLinks) ? o.providerLinks : [];
    let count = 0;
    for (const link of links) {
      if (!link.enabled) continue;
      count += (link.cache?.variants?.filter(v => v.active) || []).length;
    }
    return count;
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

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={onClose} style={{
          background: '#40444b', color: '#ddd', border: 'none', padding: '6px 12px',
          borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem',
        }}>&larr; Back</button>
        <button onClick={handleSaveAll} disabled={saving || !isDirty} title={!isDirty && !saving ? 'No unsaved changes' : undefined} style={{
          background: (saving || !isDirty) ? '#555' : 'linear-gradient(135deg, #3ba55d, #2d8049)',
          color: '#fff', border: 'none', padding: '8px 14px', borderRadius: '6px',
          cursor: (saving || !isDirty) ? 'not-allowed' : 'pointer',
          opacity: (saving || !isDirty) ? 0.55 : 1,
          fontWeight: 600, fontSize: '0.85rem',
          display: 'inline-flex', alignItems: 'center', gap: '8px',
        }}>
          <span>{saving ? 'Saving...' : 'Save Changes'}</span>
          {isDirty && !saving && (
            <span title="You have unsaved changes" style={{
              background: '#ffcc4d', color: '#1a1a1a', borderRadius: '50%',
              width: '18px', height: '18px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.78rem', fontWeight: 800, lineHeight: 1,
            }}>!</span>
          )}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, color: '#f5af19' }}>{tier.displayName}: Offerings</h3>
          <span style={{ color: '#888', fontSize: '0.82rem' }}>
            {offerings.length} offering{offerings.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button onClick={openAdd} style={{
          background: '#40444b', color: '#ddd', border: 'none', padding: '8px 14px',
          borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem',
        }}>+ Add Offering</button>
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
            const enabledProviderIds = (Array.isArray(o.providerLinks) ? o.providerLinks : [])
              .filter(l => l.enabled)
              .map(l => l.providerId);
            const isOrphan = offeringIsOrphan(o);
            const cheapest = cheapestVariant(o);
            const totalVariants = variantCount(o);
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
                      {totalVariants > 0 ? <> · {totalVariants} variant{totalVariants !== 1 ? 's' : ''}</> : <> · no variants synced yet</>}
                      {cheapest && <> · from {(cheapest.amount / 100).toFixed(2)} {cheapest.currency}</>}
                      {o.forceAutoRenew && <> · force auto-renew</>}
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

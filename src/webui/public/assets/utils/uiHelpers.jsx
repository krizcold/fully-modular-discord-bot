// Shared UI helpers for consistent loading + disabled states across the
// React Web-UI. Both the main app (index.html) and the Guild Web-UI
// (guild.html) include this file via <script type="text/babel">, so all
// helpers attach to the global `window` and are usable from any component.
//
// Why these exist:
//  - `disabled={true}` on a <button> doesn't actually look disabled to the
//    user unless paired with visual cues (opacity, cursor). A button that
//    just label-swaps to "..." reads as a glitch, not as a deliberate
//    "wait" signal. `disabledButtonStyle(processing)` provides the cues.
//  - When data is refetching after a mutation, full-page "Loading..."
//    blanks erase context and make users think their action failed.
//    `<RefetchOverlay>` keeps the previous content visible underneath a
//    dim + spinner so the user can see what's about to update.

/**
 * Inline-style overlay to apply to a button when it's mid-async-operation
 * or otherwise disabled. Spread this AFTER the button's base style so
 * cursor / opacity actually override the defaults.
 *
 *   <button disabled={busy} style={{
 *     ...baseStyle,
 *     ...disabledButtonStyle(busy),
 *   }}>...</button>
 */
window.disabledButtonStyle = function disabledButtonStyle(isDisabled) {
  if (!isDisabled) return null;
  return {
    opacity: 0.55,
    cursor: 'not-allowed',
  };
};

/**
 * Wraps a panel section so that, while `loading` is true, the existing
 * content stays rendered but is dimmed and overlaid with a centered
 * spinner. Avoids the "wipe to a blank Loading... screen on refetch"
 * pattern that briefly shows misleading default state (e.g. Free tier
 * for a few seconds while subscription data reloads).
 *
 * Use as the outer wrapper of any region whose content is currently
 * stale and being refetched. For first-load (no data yet), pair this
 * with a sensible empty-but-not-misleading initial render.
 */
window.RefetchOverlay = function RefetchOverlay({ loading, children, minHeight }) {
  return (
    <div style={{ position: 'relative', minHeight: minHeight || undefined }}>
      {children}
      {loading && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 10,
          borderRadius: 'inherit',
          pointerEvents: 'auto',
        }}>
          <div style={{
            width: '40px', height: '40px',
            border: '4px solid rgba(255,255,255,0.15)',
            borderTopColor: '#5865F2',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
        </div>
      )}
    </div>
  );
};

/**
 * Inline-style block for a "first load with no data yet" placeholder.
 * Distinct from RefetchOverlay's "we already had data, refreshing" case:
 * here we have nothing to show. Used when subData / config / etc. is
 * still null on initial mount.
 */
window.FirstLoadPlaceholder = function FirstLoadPlaceholder({ label }) {
  return (
    <div style={{
      padding: '40px',
      textAlign: 'center',
      color: '#888',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: '14px',
    }}>
      <div style={{
        width: '32px', height: '32px',
        border: '3px solid rgba(255,255,255,0.15)',
        borderTopColor: '#5865F2',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite',
      }} />
      <div>{label || 'Loading...'}</div>
    </div>
  );
};

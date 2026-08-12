// Fleet section of the Usage tab: node cards, shard table, guild -> shard
// map. Initial fetch from /api/fleet/state, then live bot:fleet:status
// pushes. Bare global functions (no import/export), dependency-free like
// UsageCharts.jsx.

const FLEET_HEALTH_COLORS = { up: '#57f287', late: '#fee75c', down: '#ed4245' };

// Guilds-per-shard scale limits (FinalArchitecture Part 1/8). Recommended
// max is the reshard trigger; hard max is Discord's absolute ceiling.
const FLEET_RECOMMENDED_MAX = 1500;
const FLEET_HARD_MAX = 2500;
const FLEET_APPROACHING = FLEET_RECOMMENDED_MAX * 0.9;

function fleetFormatAge(ms) {
  if (ms == null) return '-';
  if (ms < 1500) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

function fleetFormatDuration(ms) {
  if (ms == null) return '-';
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function FleetBadge({ text, background, color }) {
  return (
    <span
      style={{
        display: 'inline-block',
        marginLeft: '6px',
        padding: '1px 6px',
        borderRadius: '8px',
        background,
        color,
        fontSize: '0.68rem',
        verticalAlign: 'middle',
        textTransform: 'none',
        letterSpacing: 'normal',
      }}
    >
      {text}
    </span>
  );
}

// Fleet-wide scale signal: total guilds, shard count + source, unassigned
// shards, and busiest-shard utilization against the guild-per-shard limits.
function FleetCapacityCard({ cap }) {
  const barColor = cap.busiest > FLEET_RECOMMENDED_MAX
    ? '#ed4245'
    : cap.busiest >= 1000
      ? '#fee75c'
      : '#57f287';
  const barPct = Math.max(0, Math.min(100, (cap.busiest / FLEET_HARD_MAX) * 100));

  let shardsLabel;
  if (cap.shardSource === 'override') shardsLabel = `${cap.shardCount} (manual override)`;
  else if (cap.shardSource === 'discord') shardsLabel = `${cap.shardCount} (Discord-recommended)`;
  else shardsLabel = String(cap.shardCount);

  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Fleet capacity</div>
      <div className="usage-stat-sub" style={{ marginBottom: '10px' }}>
        {`${cap.totalGuilds} guild${cap.totalGuilds === 1 ? '' : 's'} across the fleet`}
        {` · Shards: ${shardsLabel}`}
        {cap.shardSource === 'override' && cap.recommendedShards != null && cap.recommendedShards !== cap.shardCount
          ? ` (Discord recommends ${cap.recommendedShards})`
          : ''}
      </div>

      {cap.unassigned > 0 ? (
        <div className="usage-notice" style={{ marginBottom: '10px' }}>
          {`${cap.unassigned} shard${cap.unassigned === 1 ? '' : 's'} unassigned - those guilds are unserved until an instance holds them.`}
          {cap.onHoldNodes > 0
            ? ' Assign a free shard to an on-hold instance to bring those guilds online.'
            : ''}
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#bbb', marginBottom: '4px' }}>
        <span>
          {`${cap.approximate ? '~' : ''}${cap.busiest} guilds/shard`}
          {cap.approximate ? ' (estimate)' : ' (busiest shard)'}
        </span>
        <span style={{ color: '#777' }}>{`recommended max ${FLEET_RECOMMENDED_MAX} · hard max ${FLEET_HARD_MAX}`}</span>
      </div>
      <div style={{ height: '8px', background: '#1e1e1e', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${barPct}%`, height: '100%', background: barColor, transition: 'width 0.3s ease' }} />
      </div>
      {cap.busiest > FLEET_APPROACHING ? (
        <div className="usage-stat-sub" style={{ marginTop: '8px', color: '#fee75c' }}>
          Approaching per-shard capacity - plan to add shards/instances.
        </div>
      ) : null}
      {cap.ownNodeOnly ? (
        <div className="usage-stat-sub" style={{ marginTop: '8px', color: '#777' }}>
          Per-shard guild counts on a co-worker cover this node's shards only.
        </div>
      ) : null}
    </div>
  );
}

// Identify-budget gauge from /gateway/bot session_start_limit: remaining vs
// total, reset countdown, stale warning when the last fetch failed, and the
// crash-loop backoff list. Hidden entirely when budget is null (standalone).
function FleetBudgetCard({ budget }) {
  if (budget.unavailable) {
    return (
      <div className="usage-stat-card" style={{ marginTop: '10px' }}>
        <div className="usage-stat-title">Identify budget</div>
        <div className="usage-stat-sub" style={{ marginTop: '4px', color: '#fee75c' }}>
          Identify budget unknown - /gateway/bot has not succeeded since boot; the reserve floor is not enforced.
        </div>
        {(budget.backoffs || []).map((b) => (
          <div key={b.nodeId} className="usage-stat-sub" style={{ marginTop: '6px', color: '#fee75c' }}>
            {`${b.nodeName}: crash-loop, next identify permit in ${fleetFormatDuration(b.nextPermitInMs)}`}
          </div>
        ))}
      </div>
    );
  }
  const pct = budget.total > 0 ? Math.max(0, Math.min(100, (budget.remaining / budget.total) * 100)) : 0;
  const barColor = pct < 10 ? '#ed4245' : pct < 25 ? '#fee75c' : '#57f287';
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Identify budget</div>
      <div className="usage-stat-sub" style={{ marginBottom: '6px' }}>
        {`${budget.remaining} / ${budget.total} identifies remaining · resets in ${fleetFormatDuration(budget.resetAfterMs)} · fetched ${fleetFormatAge(budget.fetchedAgoMs)}`}
      </div>
      <div style={{ height: '8px', background: '#1e1e1e', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width 0.3s ease' }} />
      </div>
      {budget.stale ? (
        <div className="usage-stat-sub" style={{ marginTop: '8px', color: '#fee75c' }}>
          {`Budget data is stale - the last /gateway/bot fetch failed (${fleetFormatAge(budget.fetchedAgoMs)}); values may be outdated.`}
        </div>
      ) : null}
      {(budget.backoffs || []).map((b) => (
        <div key={b.nodeId} className="usage-stat-sub" style={{ marginTop: '6px', color: '#fee75c' }}>
          {`${b.nodeName}: crash-loop, next identify permit in ${fleetFormatDuration(b.nextPermitInMs)}`}
        </div>
      ))}
    </div>
  );
}

// Master-only picker + Assign button for an UNASSIGNED (free, no-data) shard.
// Moving a held shard is a migration (Phase 4) and is not offered here.
function FleetAssignControl({ shardId, nodes, defaultNodeId, onAssigned }) {
  const [nodeId, setNodeId] = React.useState(defaultNodeId || (nodes[0] && nodes[0].nodeId) || '');
  const [busy, setBusy] = React.useState(false);

  if (nodes.length === 0) {
    return <span style={{ color: '#777', fontSize: '0.78rem' }}>no connected instance</span>;
  }

  const assign = () => {
    if (!nodeId || busy) return;
    setBusy(true);
    api.post('/fleet/assign', { shardId, nodeId })
      .then((res) => {
        if (res && res.success === false) {
          showToast(res.error || res.message || 'Assign failed', 'error');
          return;
        }
        showToast(`Assigned shard ${shardId}`, 'success');
        if (onAssigned) onAssigned();
      })
      .catch((err) => showToast(err.message || 'Assign failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <select
        value={nodeId}
        onChange={(e) => setNodeId(e.target.value)}
        disabled={busy}
        style={{ fontSize: '0.75rem', padding: '1px 4px' }}
      >
        {nodes.map((n) => (
          <option key={n.nodeId} value={n.nodeId}>
            {n.nodeName}{n.onHold ? ' (on hold)' : ''}
          </option>
        ))}
      </select>
      <button onClick={assign} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>
        {busy ? 'Assigning...' : 'Assign'}
      </button>
    </span>
  );
}

const MIGRATION_FILE_WARNING = 'File backend: after a verified hand-off the source copy is retired to the graveyard (14-day TTL). Aborting at any point leaves the source untouched.';

// Master-only Move action for an OWNED shard: pick a target node, run a
// precheck (est size, target free space, direction), confirm, then submit.
function FleetMoveControl({ shardId, fromNodeId, nodes, onStarted }) {
  const targets = nodes.filter((n) => n.nodeId !== fromNodeId && n.connected !== false && !n.draining);
  const [toNodeId, setToNodeId] = React.useState((targets[0] && targets[0].nodeId) || '');
  const [busy, setBusy] = React.useState(false);

  if (targets.length === 0) {
    return <span style={{ color: '#777', fontSize: '0.78rem' }}>no eligible target</span>;
  }

  const move = () => {
    if (!toNodeId || busy) return;
    setBusy(true);
    api.post('/fleet/migrate/precheck', { kind: 'move', shardId, toNodeId })
      .then((res) => {
        if (!res || res.success === false) {
          showToast((res && res.error) || 'Precheck failed', 'error');
          return null;
        }
        const p = res.precheck || {};
        const estMb = p.estBytes != null ? Math.round(p.estBytes / 1048576) : '?';
        const freeMb = p.targetFreeBytes != null ? Math.round(p.targetFreeBytes / 1048576) : 'unknown';
        const guildN = (p.guilds || []).length;
        const warnText = (p.warnings || []).length ? `WARNING: ${p.warnings.join('; ')}\n\n` : '';
        if (!confirm(
          `Move shard ${shardId} to the selected node?\n`
          + `~${estMb} MB across ${guildN} guild(s), target free ~${freeMb} MB, direction ${p.direction || '?'}.\n\n`
          + warnText
          + MIGRATION_FILE_WARNING
        )) return null;
        return api.post('/fleet/migrate', { kind: 'move', shardId, toNodeId });
      })
      .then((res) => {
        if (!res) return;
        if (res.success === false) { showToast(res.error || 'Move failed', 'error'); return; }
        showToast(`Move of shard ${shardId} started`, 'success');
        if (onStarted) onStarted();
      })
      .catch((err) => showToast(err.message || 'Move failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <select value={toNodeId} onChange={(e) => setToNodeId(e.target.value)} disabled={busy} style={{ fontSize: '0.75rem', padding: '1px 4px' }}>
        {targets.map((n) => (
          <option key={n.nodeId} value={n.nodeId}>{n.nodeName}{n.onHold ? ' (on hold)' : ''}</option>
        ))}
      </select>
      <button onClick={move} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>
        {busy ? 'Moving...' : 'Move'}
      </button>
    </span>
  );
}

// Master-only Retire dialog: lists the node's owned shards with a per-shard
// target dropdown, then submits one retire migration (sequential legs).
function FleetRetireControl({ node, nodes, shardTable, onStarted }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const owned = (node.shardIds || []).slice();
  const targets = nodes.filter((n) => n.nodeId !== node.nodeId && n.connected !== false && !n.draining);
  const [targetByShard, setTargetByShard] = React.useState({});

  if (owned.length === 0 || targets.length === 0) return null;

  const setTarget = (shardId, toNodeId) => setTargetByShard((prev) => Object.assign({}, prev, { [shardId]: toNodeId }));

  const submit = () => {
    if (busy) return;
    const targetsMap = {};
    for (const shardId of owned) {
      const t = targetByShard[shardId] || (targets[0] && targets[0].nodeId);
      if (!t) { showToast(`Choose a target for shard ${shardId}`, 'error'); return; }
      targetsMap[String(shardId)] = t;
    }
    setBusy(true);
    api.post('/fleet/migrate/precheck', { kind: 'retire', nodeId: node.nodeId, targets: targetsMap })
      .then((pre) => {
        const p = (pre && pre.precheck) || {};
        if (pre && pre.success === false) { showToast(pre.error || 'Precheck failed', 'error'); return null; }
        const warnText = (p.warnings || []).length ? `WARNING: ${p.warnings.join('; ')}\n\n` : '';
        if (!confirm(
          `Retire ${node.nodeName}? Its ${owned.length} shard(s) will be moved one at a time to the chosen targets.\n\n`
          + warnText
          + MIGRATION_FILE_WARNING
        )) return null;
        return api.post('/fleet/migrate', { kind: 'retire', nodeId: node.nodeId, targets: targetsMap });
      })
      .then((res) => {
        if (!res) return;
        if (res.success === false) { showToast(res.error || 'Retire failed', 'error'); return; }
        showToast(`Retire of ${node.nodeName} started`, 'success');
        setOpen(false);
        if (onStarted) onStarted();
      })
      .catch((err) => showToast(err.message || 'Retire failed', 'error'))
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <div style={{ marginTop: '6px' }}>
        <button onClick={() => setOpen(true)} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>Retire</button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '6px', padding: '8px', background: '#1e1e1e', borderRadius: '6px' }}>
      <div className="usage-stat-sub" style={{ marginBottom: '6px' }}>Move each owned shard to a target, then retire this node:</div>
      {owned.map((shardId) => (
        <div key={shardId} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' }}>
          <span style={{ fontSize: '0.75rem', width: '70px' }}>{`shard ${shardId}`}</span>
          <select
            value={targetByShard[shardId] || (targets[0] && targets[0].nodeId) || ''}
            onChange={(e) => setTarget(shardId, e.target.value)}
            disabled={busy}
            style={{ fontSize: '0.75rem', padding: '1px 4px' }}
          >
            {targets.map((n) => (
              <option key={n.nodeId} value={n.nodeId}>{n.nodeName}{n.onHold ? ' (on hold)' : ''}</option>
            ))}
          </select>
        </div>
      ))}
      <div style={{ marginTop: '6px', display: 'flex', gap: '6px' }}>
        <button onClick={submit} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>{busy ? 'Starting...' : 'Start retire'}</button>
        <button onClick={() => setOpen(false)} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>Cancel</button>
      </div>
    </div>
  );
}

// Active-migration card: state badge, per-leg progress bars, round/delta
// counters, frozen-write rejections, Abort (pre-commit), Resume (paused retire).
function FleetMigrationCard({ migration, onChanged }) {
  const [busy, setBusy] = React.useState(false);
  if (!migration || !migration.active) return null;
  const m = migration.active;
  const canAbort = m.state !== 'COMMITTING' && m.state !== 'GRANTING' && m.state !== 'DONE' && m.state !== 'ABORTED';

  const abort = () => {
    if (busy) return;
    if (!confirm('Abort the active migration? Committed data stays; uncommitted transfers are discarded and sources kept.')) return;
    setBusy(true);
    api.post('/fleet/migrate/abort', { migrationId: m.id })
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Abort failed', 'error'); return; }
        showToast('Migration aborting', 'success');
        if (onChanged) onChanged();
      })
      .catch((err) => showToast(err.message || 'Abort failed', 'error'))
      .finally(() => setBusy(false));
  };

  const resume = () => {
    if (busy) return;
    setBusy(true);
    api.post('/fleet/migrate/resume', { migrationId: m.id })
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Resume failed', 'error'); return; }
        showToast('Retire resumed', 'success');
        if (onChanged) onChanged();
      })
      .catch((err) => showToast(err.message || 'Resume failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">
        {`Migration: ${m.kind}`}
        <FleetBadge text={m.state} background="#2b3a5c" color="#a0c0f0" />
        {m.paused ? <FleetBadge text="PAUSED" background="#4a3a1a" color="#fee75c" /> : null}
      </div>
      {m.error ? <div className="usage-stat-sub" style={{ color: '#ed4245' }}>{m.error}</div> : null}
      {(m.legs || []).map((leg) => {
        const pct = leg.guildsTotal > 0 ? Math.max(0, Math.min(100, (leg.guildsDone / leg.guildsTotal) * 100)) : 0;
        return (
          <div key={leg.legId} style={{ marginTop: '6px' }}>
            <div className="usage-stat-sub">
              {`shard ${leg.shardId}: ${leg.guildsDone}/${leg.guildsTotal} guilds, round ${leg.round}, delta ${leg.deltaFiles}, ${Math.round((leg.bytesSent || 0) / 1048576)} MB`}
              {leg.legState ? ` (${leg.legState})` : ''}
            </div>
            <div style={{ height: '6px', background: '#1e1e1e', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: '#57f287', transition: 'width 0.3s ease' }} />
            </div>
          </div>
        );
      })}
      <div className="usage-stat-sub" style={{ marginTop: '6px', color: m.frozenWriteRejections > 0 ? '#fee75c' : '#777' }}>
        {`frozen-write rejections during drain: ${m.frozenWriteRejections || 0}`}
      </div>
      <div style={{ marginTop: '6px', display: 'flex', gap: '6px' }}>
        {canAbort ? <button onClick={abort} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>{busy ? 'Working...' : 'Abort'}</button> : null}
        {m.paused ? <button onClick={resume} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>{busy ? 'Working...' : 'Resume'}</button> : null}
      </div>
    </div>
  );
}

// Master-only pin-violation banner: the pinned shard sits off the master. The
// Swap button submits the proposed legs (never auto-executed); a null proposal
// shows the no-capacity reason.
function FleetPinViolationBanner({ pin, onStarted }) {
  const [busy, setBusy] = React.useState(false);
  if (!pin) return null;

  const swap = () => {
    if (busy || !pin.proposedLegs) return;
    const legs = pin.proposedLegs.map((l) => ({ shardId: l.shardId, fromNodeId: l.fromNodeId, toNodeId: l.toNodeId }));
    if (!confirm(
      `Swap to restore the pinned shard ${pin.shardId} to the master? ${legs.length} lease move(s) run under one barrier.\n\n`
      + MIGRATION_FILE_WARNING
    )) return;
    setBusy(true);
    api.post('/fleet/migrate', { kind: 'swap', legs })
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Swap failed', 'error'); return; }
        showToast('Swap started', 'success');
        if (onStarted) onStarted();
      })
      .catch((err) => showToast(err.message || 'Swap failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="usage-notice">
      <div>{`Pin violation: the pinned shard ${pin.shardId} is held off the master.`}</div>
      {pin.proposedLegs ? (
        <div style={{ marginTop: '4px' }}>
          {`Proposed swap: ${pin.proposedLegs.map((l) => `shard ${l.shardId} -> ${l.toNodeId.slice(0, 8)}`).join(', ')}`}
        </div>
      ) : (
        <div style={{ marginTop: '4px', color: '#fee75c' }}>{`No swap proposal available (${pin.reason || 'no-capacity'}).`}</div>
      )}
      <button onClick={swap} disabled={busy || !pin.proposedLegs} style={{ marginTop: '6px', fontSize: '0.72rem', padding: '2px 8px' }}>
        {busy ? 'Swapping...' : 'Swap'}
      </button>
    </div>
  );
}

// Master-only reshard pause banner: a confirmed reshard archived the previous
// ownership and froze all automatic assignment; the Resume button (behind a
// confirm dialog, locked until the stale-holder hold-down elapses) deletes
// the pause marker and lets distribution proceed. A corrupt marker still
// pauses (fail closed) and renders unknown fields.
function FleetReshardPauseBanner({ paused, holdMs, nodes, onResumed }) {
  const [busy, setBusy] = React.useState(false);

  const connectedNames = nodes
    .filter((n) => n.connected !== false)
    .map((n) => n.nodeName);

  const fromLabel = paused.from != null ? paused.from : 'unknown';
  const toLabel = paused.to != null ? paused.to : 'unknown';
  const archiveRef = paused.from != null && paused.archivedAt != null
    ? ` (fleet/archive/plan-${paused.from}-${paused.archivedAt}.json)`
    : '';
  const holdLocked = holdMs > 0;

  const resume = () => {
    if (busy || holdLocked) return;
    if (!confirm(
      'Resume assignments? Shards will be granted and instances begin serving under the new shard count. '
      + 'Guilds whose data was not redistributed start fresh; their old data remains on its former holders (recoverable later).'
    )) return;
    setBusy(true);
    api.post('/fleet/resume-assignments', {})
      .then((res) => {
        if (res && res.success === false) {
          showToast(res.error || res.message || 'Resume failed', 'error');
          return;
        }
        showToast('Assignments resumed', 'success');
        if (onResumed) onResumed();
      })
      .catch((err) => showToast(err.message || 'Resume failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="usage-notice">
      <div>
        {`Reshard pause: ${fromLabel} -> ${toLabel} shards. The previous shard plan and ownership records were archived${archiveRef}. NO shards will be assigned until assignments are resumed.`}
      </div>
      <div style={{ marginTop: '4px' }}>
        Manual assignment stays available during the pause; a manually assigned shard starts serving with whatever data its node holds locally.
      </div>
      {holdLocked ? (
        <div style={{ marginTop: '4px' }}>
          {`Resume and manual assignment unlock in ${Math.ceil(holdMs / 1000)}s (waiting for stale-holder leases to expire).`}
        </div>
      ) : null}
      <div style={{ marginTop: '4px', color: '#bbb' }}>
        {connectedNames.length > 0
          ? `Connected instances: ${connectedNames.join(', ')}`
          : 'No instances connected yet.'}
      </div>
      <button onClick={resume} disabled={busy || holdLocked} style={{ marginTop: '6px', fontSize: '0.72rem', padding: '2px 8px' }}>
        {busy ? 'Resuming...' : 'Resume assignments'}
      </button>
    </div>
  );
}

// Master-only worker-onboarding card. Renders a copy-paste env block an
// operator drops into a new bot instance's Fleet config to add it as a worker.
function FleetConnectCard({ connect }) {
  const [copiedKey, setCopiedKey] = React.useState(null);
  const [secretVisible, setSecretVisible] = React.useState(false);

  if (!connect.secretSet) {
    return (
      <div className="usage-stat-card" style={{ marginTop: '10px' }}>
        <div className="usage-stat-title">Connect a worker</div>
        <div className="usage-stat-sub">
          Set a CONTROL_SECRET in this bot's Fleet config to let other instances join.
        </div>
      </div>
    );
  }

  const secretValue = connect.secret != null
    ? connect.secret
    : '<generate one on this master>';
  const block = [
    'BOT_NODE_ROLE=co-worker',
    `MASTER_URL=${connect.masterUrl}`,
    `CONTROL_SECRET=${secretValue}`,
  ].join('\n');

  const copy = (key, value) => {
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const buttonStyle = { fontSize: '0.72rem', padding: '2px 8px', flexShrink: 0 };
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' };
  const labelStyle = { fontSize: '0.72rem', color: '#999', width: '130px', flexShrink: 0 };
  const valueStyle = {
    fontFamily: 'monospace',
    fontSize: '0.78rem',
    userSelect: 'text',
    wordBreak: 'break-all',
    flex: '1 1 auto',
    minWidth: 0,
  };

  const copyButton = (key, value) => (
    <button onClick={() => copy(key, value)} style={buttonStyle}>
      {copiedKey === key ? 'Copied' : 'Copy'}
    </button>
  );

  const secretMasked = connect.secret != null && !secretVisible;

  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">
        Connect a worker
        <button
          onClick={() => copy('all', block)}
          title="Copy all three lines (paste into a .env)"
          style={{ marginLeft: '10px', fontSize: '0.72rem', padding: '2px 8px' }}
        >
          {copiedKey === 'all' ? 'Copied' : 'Copy all'}
        </button>
      </div>
      <div style={{ margin: '6px 0', padding: '8px 10px', background: '#1e1e1e', borderRadius: '6px' }}>
        <div style={rowStyle}>
          <span style={labelStyle}>BOT_NODE_ROLE</span>
          <span style={valueStyle}>co-worker</span>
          {copyButton('role', 'co-worker')}
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>MASTER_URL</span>
          <span style={valueStyle}>{connect.masterUrl}</span>
          {copyButton('url', connect.masterUrl)}
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>CONTROL_SECRET</span>
          <span style={valueStyle}>{secretMasked ? '••••••••••••' : secretValue}</span>
          {connect.secret != null ? (
            <button onClick={() => setSecretVisible(!secretVisible)} style={buttonStyle}>
              {secretVisible ? 'Hide' : 'Show'}
            </button>
          ) : null}
          {copyButton('secret', secretValue)}
        </div>
      </div>
      <div className="usage-stat-sub">
        Paste these into a new bot instance's Fleet config to add it as a worker.
        {connect.urlIsTemplate
          ? ' Replace <host> with this master\'s reachable address (LAN IP, or the master\'s container name on a shared docker network for a same-box worker).'
          : ''}
      </div>
    </div>
  );
}

// Co-worker sync card: mirror status against the master's manifest revision.
function FleetSyncCard({ sync }) {
  if (!sync || sync.status === 'n/a') return null;
  const labels = {
    'waiting-master': 'Waiting for master sync',
    'syncing': 'Syncing from master...',
    'in-sync': 'In sync',
    'degraded': 'Degraded',
  };
  const color = sync.status === 'in-sync' ? '#57f287' : sync.status === 'degraded' ? '#ed4245' : '#fee75c';
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Master sync</div>
      <div className="usage-stat-value" style={{ color }}>{labels[sync.status] || sync.status}</div>
      <div className="usage-stat-sub">
        {sync.appliedRevision != null ? `applied revision ${sync.appliedRevision}` : 'no revision applied yet'}
        {sync.revision != null && sync.revision !== sync.appliedRevision ? ` · master revision ${sync.revision}` : ''}
      </div>
      {sync.lastError ? (
        <div className="usage-stat-sub" style={{ color: '#ed4245' }}>{sync.lastError}</div>
      ) : null}
    </div>
  );
}

function FleetNodeCard({ node, isMasterView, onAction, masterSyncRevision, retireControl }) {
  const [busy, setBusy] = React.useState(false);
  const [waiting, setWaiting] = React.useState(false);
  const healthColor = FLEET_HEALTH_COLORS[node.health] || '#888';
  const held = (node.shardIds && node.shardIds.length) || 0;
  const capacity = node.capacity != null ? node.capacity : null;
  const isDown = node.health === 'down' && !node.isSelf;

  // Wait dismisses the CURRENT down episode only; a recovery re-arms the buttons.
  React.useEffect(() => {
    if (!isDown) setWaiting(false);
  }, [isDown]);

  const act = (path, confirmText, successMsg) => {
    if (busy) return;
    if (!confirm(confirmText)) return;
    setBusy(true);
    api.post(path, { nodeId: node.nodeId })
      .then((res) => {
        if (res && res.success === false) {
          showToast(res.error || res.message || 'Action failed', 'error');
          return;
        }
        showToast(successMsg, 'success');
        if (onAction) onAction();
      })
      .catch((err) => showToast(err.message || 'Action failed', 'error'))
      .finally(() => setBusy(false));
  };

  const dataCaveat = "this node's disk holds those guilds' data; reassigned guilds start fresh";
  const buttonStyle = { fontSize: '0.72rem', padding: '2px 8px' };

  return (
    <div className="usage-stat-card">
      <div className="usage-stat-title">
        <span style={{ color: healthColor, marginRight: '6px' }} title={`health: ${node.health}`}>●</span>
        {node.nodeName}
        <FleetBadge
          text={node.isMaster ? 'master' : 'co-worker'}
          background={node.isMaster ? '#2b3a5c' : '#3a3a3a'}
          color={node.isMaster ? '#a0c0f0' : '#bbb'}
        />
        {node.isSelf ? <FleetBadge text="self" background="#2b4a2b" color="#a0e0a0" /> : null}
        {node.onHold ? <FleetBadge text="ON HOLD" background="#4a3a1a" color="#fee75c" /> : null}
        {node.draining ? <FleetBadge text="DRAINING" background="#4a3a1a" color="#fee75c" /> : null}
        {node.backoff ? <FleetBadge text="BACKOFF" background="#4a2a1a" color="#f0a0a0" /> : null}
      </div>
      <div className="usage-stat-value">{node.guildCount} guilds</div>
      <div className="usage-stat-sub">
        {capacity != null ? `holds ${held} / ${capacity} shards` : `holds ${held} shards`}
        {node.shardIds && node.shardIds.length > 0 ? ` [${node.shardIds.join(', ')}]` : ''}
      </div>
      {node.onHold ? (
        <div className="usage-stat-sub" style={{ color: '#fee75c' }}>
          waiting for a free shard - not serving guilds yet
        </div>
      ) : null}
      {node.backoff ? (
        <div className="usage-stat-sub" style={{ color: '#fee75c' }}>
          {`crash-loop backoff (${node.backoff.crashCount} recent registrations); next identify permit in ${fleetFormatDuration(node.backoff.nextPermitInMs)}`}
        </div>
      ) : null}
      {isDown ? (
        <div className="usage-stat-sub" style={{ color: '#ed4245' }}>
          {`down since ${fleetFormatAge(node.downSinceMs)}, ${held} shard${held === 1 ? '' : 's'} frozen`}
        </div>
      ) : null}
      {isDown && isMasterView ? (
        waiting ? (
          <div style={{ marginTop: '6px' }}>
            <button onClick={() => setWaiting(false)} disabled={busy} style={buttonStyle}>
              Waiting for recovery - show actions
            </button>
          </div>
        ) : (
          <div style={{ marginTop: '6px', display: 'flex', gap: '6px' }}>
            <button onClick={() => setWaiting(true)} disabled={busy} style={buttonStyle}>Wait</button>
            <button
              onClick={() => act(
                '/fleet/declare-lost',
                `Declare ${node.nodeName} lost? Its ${held} frozen shard${held === 1 ? '' : 's'} will be freed and redistributed to surviving instances. File-mode warning: ${dataCaveat}.`,
                'Node declared lost',
              )}
              disabled={busy}
              style={buttonStyle}
            >
              {busy ? 'Working...' : 'Declare Lost'}
            </button>
          </div>
        )
      ) : null}
      {!isDown && isMasterView && !node.isSelf && node.connected !== false && !node.draining ? (
        <div style={{ marginTop: '6px' }}>
          <button
            onClick={() => act(
              '/fleet/drain',
              `Drain ${node.nodeName}? All its leases will be revoked and its shards redistributed to other instances. File-mode warning: ${dataCaveat}.`,
              'Node drained',
            )}
            disabled={busy}
            style={buttonStyle}
          >
            {busy ? 'Working...' : 'Drain'}
          </button>
        </div>
      ) : null}
      {!isDown && isMasterView && !node.isSelf && node.connected !== false && !node.draining && retireControl ? retireControl : null}
      <div className="usage-stat-sub">
        {node.load
          ? `cpu ${node.load.cpuPct}% · rss ${node.load.rssMb} MB · loop ${node.load.loopLagMs} ms`
          : 'no load sample yet'}
      </div>
      <div className="usage-stat-sub">heartbeat {fleetFormatAge(node.lastHeartbeatAgoMs)}</div>
      {isMasterView && !node.isMaster && masterSyncRevision != null ? (
        <div className="usage-stat-sub">
          {node.syncAppliedRevision == null
            ? 'Sync: unknown'
            : node.syncAppliedRevision >= masterSyncRevision
              ? 'Sync: In sync'
              : `Sync: Behind (${masterSyncRevision - node.syncAppliedRevision})`}
        </div>
      ) : null}
    </div>
  );
}

function FleetView({ api, wsClient, guildNames }) {
  const [fleet, setFleet] = React.useState(null);
  // Distinguishes "lease expired after the master vanished" from "never had a
  // lease" on a co-worker; reset once the master is back.
  const sawCachedLeaseRef = React.useRef(false);

  const loadFleet = React.useCallback(() => {
    api.get('/fleet/state')
      .then((res) => { if (res.success) setFleet(res); })
      .catch((err) => console.error('[Fleet] Failed to load fleet state:', err));
  }, [api]);

  React.useEffect(() => {
    loadFleet();
    const unsubscribe = wsClient.on('bot:fleet:status', (state) => {
      setFleet(Object.assign({ success: true, running: true }, state));
    });
    const unsubscribeStatus = wsClient.on('bot:status', () => loadFleet());
    const unsubscribeSync = wsClient.on('bot:sync:status', () => loadFleet());
    return () => {
      unsubscribe();
      unsubscribeStatus();
      unsubscribeSync();
    };
  }, [loadFleet]);

  if (!fleet) {
    return (
      <div className="usage-board">
        <h3>Fleet</h3>
        <div className="usage-empty">Loading fleet state...</div>
      </div>
    );
  }

  if (!fleet.running || !fleet.initialized) {
    return (
      <div className="usage-board">
        <h3>Fleet</h3>
        <div className="usage-empty">
          {!fleet.running
            ? 'Fleet state becomes available once the bot process is running.'
            : 'Fleet layer is initializing...'}
        </div>
      </div>
    );
  }

  const nodes = fleet.nodes || [];

  // Co-worker: a compact, honest self-status. A co-worker never holds the
  // fleet-wide picture (all nodes, the full shard table, every guild) - the
  // master owns that - so rendering the full dashboard here would show a
  // mostly-empty, misleading table (its own shard held, every other shard
  // reading "unassigned"). Full fleet status and shard assignment live on the
  // master's Usage tab.
  if (fleet.role !== 'master') {
    const selfNode = nodes[0];
    const heldShards = (fleet.leases || []).map((l) => l.shardId).sort((a, b) => a - b);
    const servingGuilds = selfNode ? selfNode.guildCount : 0;
    if (fleet.servingOnCachedLease) sawCachedLeaseRef.current = true;
    if (fleet.masterKnown) sawCachedLeaseRef.current = false;
    return (
      <div className="usage-board">
        <h3>Fleet</h3>
        <div className="usage-stat-sub">
          {`role co-worker · term ${fleet.term} · epoch ${fleet.epoch} · ${fleet.shardCount} shard${fleet.shardCount === 1 ? '' : 's'} in the fleet`}
        </div>

        {!fleet.masterKnown && fleet.servingOnCachedLease && (
          <div className="usage-notice">
            {`Master unreachable - still serving ${servingGuilds} guild${servingGuilds === 1 ? '' : 's'} on cached leases; sessions stop in ${Math.ceil((fleet.cachedLeaseTtlRemainingMs || 0) / 1000)}s unless the master returns.`}
          </div>
        )}
        {!fleet.masterKnown && !fleet.servingOnCachedLease && sawCachedLeaseRef.current && (
          <div className="usage-notice">Lease expired; gateway sessions destroyed; waiting for master.</div>
        )}
        {!fleet.masterKnown && !fleet.servingOnCachedLease && !sawCachedLeaseRef.current && (
          <div className="usage-notice">Master unreachable, retrying...</div>
        )}
        {fleet.draining && (
          <div className="usage-notice">
            Draining: this node's leases were revoked by the operator; it rejoins placement after a restart (re-register).
          </div>
        )}
        {fleet.sync && fleet.sync.status === 'waiting-master' && (
          <div className="usage-notice">
            Waiting for master sync: modules and configuration load after the first verified sync from the master.
          </div>
        )}
        {fleet.masterKnown && fleet.onHold && (
          <div className="usage-notice">
            On hold: connected to the master, waiting for a shard to be assigned. Not serving any guilds yet.
          </div>
        )}
        {fleet.masterKnown && !fleet.onHold && (
          <div className="usage-stat-card" style={{ marginTop: '10px' }}>
            <div className="usage-stat-title">Connected to master</div>
            <div className="usage-stat-value">
              {heldShards.length > 0
                ? `Holding shard${heldShards.length === 1 ? '' : 's'} [${heldShards.join(', ')}] of ${fleet.shardCount}`
                : 'No shards held'}
            </div>
            <div className="usage-stat-sub">{`Serving ${servingGuilds} guild${servingGuilds === 1 ? '' : 's'}`}</div>
          </div>
        )}

        <FleetSyncCard sync={fleet.sync} />

        {fleet.budget ? <FleetBudgetCard budget={fleet.budget} /> : null}

        {selfNode ? (
          <div className="usage-stat-grid" style={{ marginTop: '14px' }}>
            <FleetNodeCard node={selfNode} />
          </div>
        ) : null}

        <div className="usage-stat-sub" style={{ marginTop: '14px', color: '#777' }}>
          Full fleet status and shard assignment are on the master's Usage tab.
        </div>
      </div>
    );
  }

  const shardTable = fleet.shardTable || [];
  const guildMap = fleet.guildMap || {};
  // Names for guilds the connected clients cannot name (guilds on unassigned
  // shards), supplied by the master's REST list; the connected-client names
  // (guildNames prop) still win when present.
  const fleetGuildNames = fleet.guildNames || {};

  const nodesById = {};
  for (const node of nodes) nodesById[node.nodeId] = node;
  const nodeNameOf = (nodeId) => (nodesById[nodeId] && nodesById[nodeId].nodeName) || nodeId;
  const shardToNode = {};
  for (const entry of shardTable) shardToNode[entry.shardId] = entry.nodeId;

  const guildEntries = Object.entries(guildMap).map(([guildId, shardId]) => ({
    guildId,
    shardId,
    name: (guildNames && guildNames[guildId]) || fleetGuildNames[guildId] || guildId,
  }));
  guildEntries.sort((a, b) => a.shardId - b.shardId || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));

  // Shard count with a safe fallback to what the table actually shows.
  const shardCount = fleet.shardCount != null ? fleet.shardCount : shardTable.length;

  // Per-shard guild counts come straight from the shard table. The master fills
  // each row's guildCount from its REST guild list, so unassigned shards report
  // their real count too; a co-worker only knows its own shards. Total = sum,
  // busiest = max. One source of truth for the column and the capacity signal.
  let totalGuilds = 0;
  let busiest = 0;
  for (const s of shardTable) {
    const c = s.guildCount || 0;
    totalGuilds += c;
    if (c > busiest) busiest = c;
  }
  // Fallback before the first REST fetch lands / when the table has no counts.
  if (totalGuilds === 0) {
    for (const node of nodes) totalGuilds += node.guildCount || 0;
    if (totalGuilds === 0) totalGuilds = Object.keys(guildMap).length;
  }
  const approximate = false;

  const unassignedCount = shardTable.filter((s) => s.status === 'unassigned').length;
  const onHoldNodeCount = nodes.filter((n) => n.onHold).length;
  const capacitySummary = {
    totalGuilds,
    shardCount,
    shardSource: fleet.shardSource,
    recommendedShards: fleet.recommendedShards != null ? fleet.recommendedShards : null,
    unassigned: unassignedCount,
    onHoldNodes: onHoldNodeCount,
    busiest,
    approximate,
    // On a co-worker guildMap is own-node only, so per-shard counts (busiest,
    // and the shard table column) cover this node's shards, not the whole fleet.
    ownNodeOnly: fleet.role === 'co-worker',
  };

  // Assign picker targets: connected, non-draining nodes, on-hold ones first (they are idle).
  const isMaster = fleet.role === 'master';
  const assignableNodes = nodes
    .filter((n) => n.connected !== false && !n.draining)
    .slice()
    .sort((a, b) => (b.onHold ? 1 : 0) - (a.onHold ? 1 : 0));
  const defaultAssignNodeId = (assignableNodes.find((n) => n.onHold) || assignableNodes[0] || {}).nodeId;

  return (
    <div className="usage-board">
      <h3>Fleet</h3>
      <div className="usage-stat-sub">
        {fleet.standalone ? 'standalone (single node)' : `role ${fleet.role}`}
        {` · term ${fleet.term} · epoch ${fleet.epoch} · ${shardCount} shard${shardCount === 1 ? '' : 's'}`}
        {fleet.pinTestGuildShard && fleet.pinnedShardId != null ? ` · shard ${fleet.pinnedShardId} pinned to master` : ''}
      </div>

      {fleet.controlStoreFenced && (
        <div className="usage-notice" style={{ borderColor: '#e5534b', color: '#e5534b' }}>
          {`CRITICAL: another master (term ${fleet.controlStoreFenced.observedTerm}) owns this fleet's control store. This master has stopped granting shards. Keep exactly one master per control store, then restart this instance.`}
        </div>
      )}

      {fleet.role === 'co-worker' && !fleet.masterKnown && (
        <div className="usage-notice">Master unreachable, retrying...</div>
      )}

      {fleet.role === 'co-worker' && fleet.masterKnown && fleet.onHold && (
        <div className="usage-notice">
          On hold: connected to the master, waiting for a shard to be assigned. Not serving any guilds yet.
        </div>
      )}

      {fleet.recovery && fleet.recovery.holdDownRemainingMs > 0 && !fleet.recovery.reshardPaused && (
        <div className="usage-notice">
          {`Recovery hold-down: free-shard distribution and manual assignment resume in ${Math.ceil(fleet.recovery.holdDownRemainingMs / 1000)}s. Re-grants to returning instances are unaffected.`}
        </div>
      )}

      {fleet.recovery && fleet.recovery.reshardAdvised && (
        <div className="usage-notice">
          {`Discord now recommends ${fleet.recovery.reshardAdvised.recommended} shard${fleet.recovery.reshardAdvised.recommended === 1 ? '' : 's'}; fleet runs ${fleet.recovery.reshardAdvised.running}; resharding requires setting FLEET_SHARD_COUNT.`}
        </div>
      )}

      {fleet.recovery && fleet.recovery.reshardApplied && (
        <div className="usage-notice">
          {`Reshard applied: ${fleet.recovery.reshardApplied.from} -> ${fleet.recovery.reshardApplied.to} shards (FLEET_SHARD_COUNT override); the previous shard plan and ownership records were archived.`}
        </div>
      )}

      {fleet.recovery && fleet.recovery.reshardNeedsConfirm && (
        <div className="usage-notice">
          {`Shard count change requested (${fleet.recovery.reshardNeedsConfirm.from} -> ${fleet.recovery.reshardNeedsConfirm.to}) but not confirmed; the fleet keeps running ${fleet.recovery.reshardNeedsConfirm.from} shard${fleet.recovery.reshardNeedsConfirm.from === 1 ? '' : 's'}. Set FLEET_CONFIRM_RESHARD=1 and restart the master to apply it.`}
        </div>
      )}

      {fleet.recovery && fleet.recovery.reshardPaused && (
        <FleetReshardPauseBanner
          paused={fleet.recovery.reshardPaused}
          holdMs={fleet.recovery.holdDownRemainingMs}
          nodes={nodes}
          onResumed={loadFleet}
        />
      )}

      {(fleet.refusedRegistrations || []).length > 0 && (
        <div className="usage-notice">
          <div>Refused registrations (worker not admitted to the fleet):</div>
          {fleet.refusedRegistrations.slice(-5).reverse().map((r, i) => (
            <div key={`${r.nodeName}-${r.at}-${i}`} style={{ marginTop: '4px' }}>
              {`${r.nodeName}: ${r.reason} (${fleetFormatAge(Date.now() - r.at)})`}
            </div>
          ))}
        </div>
      )}

      <FleetCapacityCard cap={capacitySummary} />

      {fleet.budget ? <FleetBudgetCard budget={fleet.budget} /> : null}

      {fleet.role === 'master' && fleet.connect ? <FleetConnectCard connect={fleet.connect} /> : null}

      {fleet.pinViolation ? <FleetPinViolationBanner pin={fleet.pinViolation} onStarted={loadFleet} /> : null}

      {fleet.migration ? <FleetMigrationCard migration={fleet.migration} onChanged={loadFleet} /> : null}

      <div className="usage-stat-grid" style={{ marginTop: '14px' }}>
        {nodes.map((node) => (
          <FleetNodeCard
            key={node.nodeId}
            node={node}
            isMasterView={isMaster}
            onAction={loadFleet}
            masterSyncRevision={fleet.sync != null ? fleet.sync.revision : null}
            retireControl={isMaster && !node.isSelf && (node.shardIds || []).length > 0 ? (
              <FleetRetireControl node={node} nodes={nodes} shardTable={shardTable} onStarted={loadFleet} />
            ) : null}
          />
        ))}
      </div>

      <div className="usage-stat-title">Shard table</div>
      {shardTable.length === 0 ? (
        <div className="usage-empty">No shards yet</div>
      ) : (
        <table className="usage-table usage-table-compact fleet-table">
          <colgroup>
            <col style={{ width: '8%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '9%' }} />
            {isMaster ? <col style={{ width: '29%' }} /> : null}
          </colgroup>
          <thead>
            <tr>
              <th>Shard</th><th>Node</th><th>Status</th>
              <th title={fleet.role === 'co-worker'
                ? "Guilds on this shard (co-worker: this node's shards only)"
                : 'Guilds on this shard, from the fleet guild map'}>Guilds</th>
              <th>Term</th><th>Epoch</th>
              {isMaster ? <th>Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {shardTable.map((s) => {
              const isFree = s.status === 'unassigned' || s.nodeId == null;
              const isPending = s.status === 'pending';
              const isFrozen = s.status === 'frozen';
              const statusColor = isFree ? '#777' : isPending ? '#fee75c' : isFrozen ? '#ed4245' : undefined;
              return (
                <tr key={s.shardId} style={isFrozen ? { background: 'rgba(237, 66, 69, 0.08)' } : undefined}>
                  <td>
                    {s.shardId}
                    {fleet.pinnedShardId === s.shardId ? <FleetBadge text="pinned" background="#4a3a1a" color="#fee75c" /> : null}
                  </td>
                  <td style={isFree ? { color: '#777' } : undefined}>{s.nodeId != null ? nodeNameOf(s.nodeId) : '-'}</td>
                  <td style={statusColor ? { color: statusColor } : undefined}>{s.status}</td>
                  <td style={isFree ? { color: '#777' } : undefined}>{s.guildCount || 0}</td>
                  <td>{s.term != null ? s.term : '-'}</td>
                  <td>{s.epoch != null ? s.epoch : '-'}</td>
                  {isMaster ? (
                    <td>
                      {isFree ? (
                        <FleetAssignControl
                          shardId={s.shardId}
                          nodes={assignableNodes}
                          defaultNodeId={defaultAssignNodeId}
                          onAssigned={loadFleet}
                        />
                      ) : isPending ? (
                        <span style={{ color: '#777', fontSize: '0.78rem' }}>assigning...</span>
                      ) : isFrozen ? (
                        <span style={{ color: '#ed4245', fontSize: '0.78rem' }}>held by down node - Wait or Declare Lost on its node card</span>
                      ) : (
                        <FleetMoveControl
                          shardId={s.shardId}
                          fromNodeId={s.nodeId}
                          nodes={assignableNodes}
                          onStarted={loadFleet}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="usage-stat-title" style={{ marginTop: '14px' }}>Guilds by shard</div>
      {guildEntries.length === 0 ? (
        <div className="usage-empty">No guilds mapped yet</div>
      ) : (
        <table className="usage-table usage-table-compact fleet-table">
          <colgroup>
            <col style={{ width: '58%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '28%' }} />
          </colgroup>
          <thead>
            <tr><th>Guild</th><th>Shard</th><th>Node</th></tr>
          </thead>
          <tbody>
            {guildEntries.map((g) => (
              <tr key={g.guildId}>
                <td>
                  <div>{g.name}</div>
                  {g.name !== g.guildId ? (
                    <div style={{ fontSize: '0.72rem', color: '#777', fontFamily: 'monospace' }}>{g.guildId}</div>
                  ) : null}
                </td>
                <td>{g.shardId}</td>
                <td>{shardToNode[g.shardId] != null ? nodeNameOf(shardToNode[g.shardId]) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

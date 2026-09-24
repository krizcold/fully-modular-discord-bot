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
const MIGRATION_PG_WARNING = 'Database backend: guild data stays in the central database and follows the shard; the hand-off is a lease re-grant (seconds). Aborting copies and deletes nothing.';

function migrationWarning(dataBackend) {
  return dataBackend === 'postgres' ? MIGRATION_PG_WARNING : MIGRATION_FILE_WARNING;
}

// Master-only Move action for an OWNED shard: pick a target node, run a
// precheck (est size, target free space, direction), confirm, then submit.
function FleetMoveControl({ shardId, fromNodeId, nodes, dataBackend, onStarted }) {
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
        const guildN = (p.guilds || []).length;
        const warnText = (p.warnings || []).length ? `WARNING: ${p.warnings.join('; ')}\n\n` : '';
        const sizeLine = dataBackend === 'postgres'
          ? `${guildN} guild(s) hand off through the database (no file copy).\n\n`
          : (() => {
            const estMb = p.estBytes != null ? Math.round(p.estBytes / 1048576) : '?';
            const freeMb = p.targetFreeBytes != null ? Math.round(p.targetFreeBytes / 1048576) : 'unknown';
            return `~${estMb} MB across ${guildN} guild(s), target free ~${freeMb} MB, direction ${p.direction || '?'}.\n\n`;
          })();
        if (!confirm(
          `Move shard ${shardId} to the selected node?\n`
          + sizeLine
          + warnText
          + migrationWarning(dataBackend)
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
function FleetRetireControl({ node, nodes, shardTable, dataBackend, onStarted }) {
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
          + migrationWarning(dataBackend)
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

// Backend-transformation card: direction, state badge, per-node conversion
// (and retirement) progress, failed guilds, Pause/Resume/Abort.
function FleetTransformationCard({ transformation, api, onChanged }) {
  const [busy, setBusy] = React.useState(false);
  const t = transformation;
  const finished = t.state === 'DONE' || t.state === 'ABORTED';
  const directionLabel = t.direction === 'postgres-to-file' ? 'database to file' : 'file to database';
  const badgeStyle = finished
    ? { background: '#3a3a3a', color: '#bbb' }
    : t.state === 'PAUSED'
      ? { background: '#4a3a1a', color: '#fee75c' }
      : { background: '#2b3a5c', color: '#a0c0f0' };
  const showRetired = t.state === 'RETIRING' || t.state === 'DONE'
    || (t.state === 'PAUSED' && t.pausedFrom === 'RETIRING');
  const canPause = t.state === 'CONVERTING' || t.state === 'ABORTING' || t.state === 'RETIRING';
  const canResume = t.state === 'PAUSED';
  const canAbort = t.state === 'CONVERTING'
    || (t.state === 'PAUSED' && (t.pausedFrom == null || t.pausedFrom === 'CONVERTING'));
  const buttonStyle = { fontSize: '0.72rem', padding: '2px 8px' };

  const act = (path, successMsg) => {
    if (busy) return;
    setBusy(true);
    api.post(path, {})
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Action failed', 'error'); return; }
        showToast(successMsg, 'success');
        if (onChanged) onChanged();
      })
      .catch((err) => showToast(err.message || 'Action failed', 'error'))
      .finally(() => setBusy(false));
  };

  const abort = () => {
    if (busy) return;
    if (!confirm('Abort the backend transformation? Converted guilds will be converted back to the source backend. Nothing is deleted.')) return;
    act('/fleet/transform/abort', 'Transformation aborting');
  };

  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">
        {`Backend transformation: ${directionLabel}`}
        <FleetBadge text={t.state} background={badgeStyle.background} color={badgeStyle.color} />
      </div>
      {t.error ? <div className="usage-stat-sub" style={{ color: '#ed4245' }}>{t.error}</div> : null}
      {(t.nodes || []).map((n) => {
        const convertPct = n.total > 0 ? Math.max(0, Math.min(100, (n.converted / n.total) * 100)) : 0;
        const retirePct = n.total > 0 ? Math.max(0, Math.min(100, (n.retired / n.total) * 100)) : 0;
        return (
          <div key={n.nodeId} style={{ marginTop: '6px' }}>
            <div className="usage-stat-sub">{`${n.nodeName}: ${n.converted}/${n.total} guilds converted`}</div>
            <div style={{ height: '6px', background: '#1e1e1e', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ width: `${convertPct}%`, height: '100%', background: '#57f287', transition: 'width 0.3s ease' }} />
            </div>
            {showRetired ? (
              <div style={{ marginTop: '4px' }}>
                <div className="usage-stat-sub">{`${n.nodeName}: ${n.retired}/${n.total} source copies retired`}</div>
                <div style={{ height: '6px', background: '#1e1e1e', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ width: `${retirePct}%`, height: '100%', background: '#a0c0f0', transition: 'width 0.3s ease' }} />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {(t.failedGuilds || []).length > 0 ? (
        <div style={{ marginTop: '6px' }}>
          <div className="usage-stat-sub" style={{ color: '#fee75c' }}>
            {`${t.failedGuilds.length} guild${t.failedGuilds.length === 1 ? '' : 's'} failed to convert:`}
          </div>
          {t.failedGuilds.map((f) => (
            <div key={f.guildId} className="usage-stat-sub" style={{ color: '#fee75c', fontFamily: 'monospace' }}>
              {`${f.guildId}: ${f.reason}`}
            </div>
          ))}
        </div>
      ) : null}
      {canPause || canResume || canAbort ? (
        <div style={{ marginTop: '6px', display: 'flex', gap: '6px' }}>
          {canPause ? <button onClick={() => act('/fleet/transform/pause', 'Transformation pausing')} disabled={busy} style={buttonStyle}>{busy ? 'Working...' : 'Pause'}</button> : null}
          {canResume ? <button onClick={() => act('/fleet/transform/resume', 'Transformation resumed')} disabled={busy} style={buttonStyle}>{busy ? 'Working...' : 'Resume'}</button> : null}
          {canAbort ? <button onClick={abort} disabled={busy} className="btn btn-danger" style={buttonStyle}>{busy ? 'Working...' : 'Abort'}</button> : null}
        </div>
      ) : null}
    </div>
  );
}

// Master-only transformation-required banner: the configured DATA_BACKEND
// names one backend while the guild data still lives in the other.
function FleetTransformBanner({ dataBoot, transformation, api, onChanged }) {
  const [busy, setBusy] = React.useState(false);
  const active = transformation != null && transformation.state !== 'DONE' && transformation.state !== 'ABORTED';

  const start = () => {
    if (busy) return;
    if (!confirm('Start the backend transformation? Guilds are converted one at a time (writes to a guild pause for seconds while it converts), verified, then the whole deployment flips to the new backend. You can pause or abort until the flip.')) return;
    setBusy(true);
    api.post('/fleet/transform', {})
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Start failed', 'error'); return; }
        showToast('Transformation started', 'success');
        if (onChanged) onChanged();
      })
      .catch((err) => showToast(err.message || 'Start failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="usage-notice">
      <div>Backend transformation required</div>
      <div style={{ marginTop: '4px' }}>{dataBoot.banner}</div>
      {active ? null : (
        <button onClick={start} disabled={busy} style={{ marginTop: '6px', fontSize: '0.72rem', padding: '2px 8px' }}>
          {busy ? 'Starting...' : 'Start transformation'}
        </button>
      )}
    </div>
  );
}

// Reshard exit named by the capacity banners when Discord recommends fewer
// shards than the fleet runs; empty otherwise.
function reshardHint(fleet) {
  if (fleet.recommendedShards == null || fleet.recommendedShards >= fleet.shardCount) return '';
  return `, or reshard (Discord recommends ${fleet.recommendedShards} shard${fleet.recommendedShards === 1 ? '' : 's'}: set FLEET_SHARD_COUNT)`;
}

// Master-only pin-violation banner: the pinned shard sits off the master. The
// Swap button submits the proposed legs (never auto-executed); a null proposal
// shows the no-capacity reason.
function FleetPinViolationBanner({ pin, dataBackend, onStarted }) {
  const [busy, setBusy] = React.useState(false);
  if (!pin) return null;

  const swap = () => {
    if (busy || !pin.proposedLegs) return;
    const legs = pin.proposedLegs.map((l) => ({ shardId: l.shardId, fromNodeId: l.fromNodeId, toNodeId: l.toNodeId }));
    if (!confirm(
      `Swap to restore the pinned shard ${pin.shardId} to the master? ${legs.length} lease move(s) run under one barrier.\n\n`
      + migrationWarning(dataBackend)
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
function FleetReshardPauseBanner({ paused, holdMs, nodes, dataBackend, onResumed }) {
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
      + (dataBackend === 'postgres'
        ? 'Guild data lives in the central database and follows each shard to its new owner.'
        : 'Guilds whose data was not redistributed start fresh; their old data remains on its former holders (recoverable later).')
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
    `MASTER_URLS=${connect.masterUrl}`,
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
          <span style={labelStyle}>MASTER_URLS</span>
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

function FleetNodeCard({ node, isMasterView, onAction, masterSyncRevision, retireControl, dataBackend, standbySlot }) {
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

  const dataCaveat = dataBackend === 'postgres'
    ? 'guild data lives in the central database; reassigned guilds keep their data'
    : "this node's disk holds those guilds' data; reassigned guilds start fresh";
  const caveatLabel = dataBackend === 'postgres' ? 'Database backend' : 'File-mode warning';
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
        {node.capabilities && node.capabilities.backupMaster ? (
          <FleetBadge
            text="BACKUP"
            background="#2b3a5c"
            color="#8ab4f8"
          />
        ) : null}
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
                `Declare ${node.nodeName} lost? Its ${held} frozen shard${held === 1 ? '' : 's'} will be freed and redistributed to surviving instances. ${caveatLabel}: ${dataCaveat}.`,
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
              `Drain ${node.nodeName}? All its leases will be revoked and its shards redistributed to other instances. ${caveatLabel}: ${dataCaveat}.`,
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
      {node.dbReplica ? <FleetReplicaLine replica={node.dbReplica} /> : null}
      {standbySlot ? <FleetSlotLine slot={standbySlot} /> : null}
    </div>
  );
}

// The primary's word on this node's standby slot, relayed by the master
// (20.17). A lost slot is the one state the copy cannot recover from on its
// own, so it is stated in red rather than left to a missing green line.
function FleetSlotLine({ slot }) {
  const age = slot.receivedAt ? ` · ${fleetFormatAge(Date.now() - slot.receivedAt)}` : '';
  const source = slot.sourceIsCurrentMaster === true ? '' : slot.sourceIsCurrentMaster === false ? ' (not from the current master)' : ' (source unknown)';
  const bad = slot.walStatus === 'lost' || slot.walStatus === 'absent';
  const warn = slot.walStatus === 'unreserved';
  return (
    <div className="usage-stat-sub" style={{ color: bad ? '#e5534b' : warn ? '#d29922' : undefined }}>
      Primary slot {slot.slotName}: {slot.walStatus}{source}{age}
    </div>
  );
}

// One node's database standby, from its own heartbeat. A standby that stopped
// following is the failure this whole arc exists to survive, so it is stated
// rather than left to a missing green line.
function FleetReplicaLine({ replica }) {
  const lagText = replica.replayAgeMs == null ? '' : ` · last replay ${fleetFormatAge(replica.replayAgeMs)}`;
  if (replica.error) {
    return <div className="usage-stat-sub" style={{ color: '#e5534b' }}>DB standby: unreachable ({replica.error})</div>;
  }
  if (!replica.inRecovery) {
    return <div className="usage-stat-sub" style={{ color: '#e5534b' }}>DB standby: promoted, no longer following the primary</div>;
  }
  if (!replica.streaming) {
    return <div className="usage-stat-sub" style={{ color: '#e5534b' }}>DB standby: NOT streaming{lagText}</div>;
  }
  const stale = replica.replayAgeMs != null && replica.replayAgeMs > 60000;
  return (
    <div className="usage-stat-sub" style={{ color: stale ? '#d29922' : undefined }}>
      DB standby: streaming{lagText}
    </div>
  );
}

// Fleet runtime config (B2): the master edits the candidate list live (zero
// restarts, pushed fleet-wide); every other node shows the copy in force.
function FleetConfigCard({ api, fleet }) {
  const cfg = fleet.fleetConfig;
  const [draft, setDraft] = React.useState(null);
  const [witnessDraft, setWitnessDraft] = React.useState('');
  const [backupsDraft, setBackupsDraft] = React.useState([]);
  // The order is posted only when the operator actually moved it: the draft is
  // an Edit-time snapshot, and the list keeps changing under it as nodes register.
  const [backupsEdited, setBackupsEdited] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (!cfg) return null;
  const editable = fleet.role === 'master' && !fleet.standalone;
  const move = (i, delta) => {
    const next = [...backupsDraft];
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setBackupsDraft(next);
    setBackupsEdited(true);
  };
  const nodeName = (id) => {
    const node = (fleet.nodes || []).find((n) => n.nodeId === id);
    return node ? node.nodeName : id.slice(0, 8);
  };
  // Active mode needs BOTH keys: this is the node's half, and the master cannot
  // supply it (20.5). A node that has not registered here cannot be shown to
  // consent, so it reads as passive.
  const consents = (id) => {
    const node = (fleet.nodes || []).find((n) => n.nodeId === id);
    return !!(node && node.capabilities && node.capabilities.activeCapable);
  };
  // A node this master has no registration of cannot be read either way.
  const consentKnown = (id) => (fleet.nodes || []).some((n) => n.nodeId === id);
  const toggleMode = (i) => {
    const next = [...backupsDraft];
    next[i] = next[i].mode === 'active'
      ? { nodeId: next[i].nodeId, priority: next[i].priority }
      : { nodeId: next[i].nodeId, priority: next[i].priority, mode: 'active' };
    setBackupsDraft(next);
    setBackupsEdited(true);
  };
  const save = () => {
    if (busy) return;
    const urls = draft.split('\n').map((u) => u.trim()).filter(Boolean);
    setBusy(true);
    api.post('/fleet/config', { masterCandidates: urls, witnessChannelId: witnessDraft.trim(), ...(backupsEdited ? { backupDesignations: backupsDraft.map((d, i) => (d.mode === 'active' ? { nodeId: d.nodeId, priority: i + 1, mode: 'active' } : { nodeId: d.nodeId, priority: i + 1 })) } : {}) })
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Config update failed', 'error'); return; }
        showToast(`Fleet config saved (revision ${res.revision}) and pushed to every node`, 'success');
        setDraft(null);
      })
      .catch((err) => showToast((err && err.message) || 'Config update failed', 'error'))
      .finally(() => setBusy(false));
  };
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Fleet config</div>
      <div className="usage-stat-sub">
        {`Revision ${cfg.revision} · candidates: ${cfg.sources.masterCandidates === 'runtime' ? 'runtime copy' : 'env seed (no runtime list)'} · witness channel: ${cfg.sources.witnessChannelId === 'runtime' ? 'runtime copy' : 'default (owner DM)'} · backups: ${cfg.sources.backupDesignations === 'runtime' ? 'runtime copy' : 'none designated'}`}
      </div>
      {draft !== null ? (
        <div style={{ marginTop: '6px' }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(3, draft.split('\n').length + 1)}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.75rem' }}
          />
          <input
            type="text"
            value={witnessDraft}
            onChange={(e) => setWitnessDraft(e.target.value)}
            placeholder="witness beacon channel id (empty = owner DM)"
            style={{ width: '100%', marginTop: '4px', fontFamily: 'monospace', fontSize: '0.75rem' }}
          />
          {backupsDraft.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div className="usage-stat-sub">Backup order: the first stands in first, and breaks a tie between equally fresh copies. Active mode lets a backup stand in temporarily while the master is gone, and needs that node's own consent too. It is not free: while it is on, every write in the fleet waits for that copy, so losing it costs about a second or two of stalled writes before replication drops back to asynchronous.</div>
              {backupsDraft.map((d, i) => (
                <div key={d.nodeId} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{`${i + 1}. ${nodeName(d.nodeId)}`}</span>
                  <button onClick={() => move(i, -1)} disabled={busy || i === 0} style={{ fontSize: '0.7rem', padding: '1px 6px' }}>Up</button>
                  <button onClick={() => move(i, 1)} disabled={busy || i === backupsDraft.length - 1} style={{ fontSize: '0.7rem', padding: '1px 6px' }}>Down</button>
                  <button
                    onClick={() => toggleMode(i)}
                    disabled={busy || (!consents(d.nodeId) && d.mode !== 'active')}
                    style={{ fontSize: '0.7rem', padding: '1px 6px' }}
                    title={!consentKnown(d.nodeId)
                      ? (d.mode === 'active'
                        ? 'Active mode is enabled here for this node now; its own consent cannot be read while it is unregistered, and once saved, turning it off here cannot be undone until it registers again (Cancel still restores it)'
                        : 'That node is not registered here, so its consent cannot be read; active mode cannot be enabled for it until it registers')
                      : consents(d.nodeId)
                        ? 'Active lets this backup stand in temporarily while the master is gone; passive means it only stores data'
                        : 'This node has not declared FLEET_BACKUP_MODE=active, so it cannot be enabled for active mode from here'}
                  >
                    {d.mode === 'active' ? 'Active' : 'Passive'}
                  </button>
                  <button onClick={() => { setBackupsDraft(backupsDraft.filter((_, j) => j !== i)); setBackupsEdited(true); }} disabled={busy} style={{ fontSize: '0.7rem', padding: '1px 6px' }} title="Removed from the order; the node is designated again on its next register while its env still says backup-master, but its active mode does NOT come back on its own">Remove</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: '4px' }}>
            <button onClick={save} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>
              {busy ? 'Saving...' : 'Save and push'}
            </button>
            <button onClick={() => setDraft(null)} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px', marginLeft: '6px' }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: '6px' }}>
          <div className="usage-stat-sub" style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
            {cfg.masterCandidates.join('\n') || 'no master candidates'}
          </div>
          {(cfg.backupDesignations || []).length > 0 && (
            <div className="usage-stat-sub" style={{ marginTop: '4px' }}>
              {[...cfg.backupDesignations].sort((a, b) => a.priority - b.priority).map((d, i) => {
                // Consent is a fact the master reads off each node's registration; a
                // co-worker sees only itself, so it says the stored mode alone.
                const enabled = d.mode === 'active';
                const consent = consents(d.nodeId);
                const known = consentKnown(d.nodeId);
                // A co-worker reads only its own consent; other entries show the stored mode alone.
                const self = d.nodeId === fleet.nodeId;
                const mode = fleet.role !== 'master'
                  ? (!self ? (enabled ? 'active' : 'passive')
                    : enabled && fleet.activeCapable ? 'active (enabled by the master; this node consents)'
                    : enabled ? 'enabled by the master, but this node does not consent (FLEET_BACKUP_MODE is not active here), so it stays passive and will not stand in'
                    : fleet.activeCapable ? 'passive (this node consents to active; the master has not enabled it)'
                    : 'passive')
                  : !known ? (enabled ? 'active (enabled here; that node is not registered here, so its consent cannot be read)' : 'passive (that node is not registered here)')
                  : enabled && consent ? 'active (enabled here; the node consents)'
                  : enabled ? 'active enabled here, but the node does not consent (FLEET_BACKUP_MODE is not active there), so it drops to passive on its next register'
                  : consent ? 'passive here, while the node consents to active (enable it under Edit fleet config)'
                  : 'passive';
                const lever = self && fleet.role !== 'master' && fleet.modeOverride
                  ? (enabled ? '; the local emergency lever is set but adds nothing (the stored designation enables this node)'
                    : fleet.backupMaster !== true ? '; the local emergency lever is set, but this node\'s env role is not backup-master (BOT_NODE_ROLE), so it cannot stand in'
                    : fleet.dataBackend && fleet.dataBackend !== 'postgres' ? '; the local emergency lever is set, but this node is in file mode, which has no standby, so it cannot stand in'
                    : fleet.masterKnown ? '; the local emergency lever is set but ignored while the master is reachable'
                    : !fleet.activeCapable ? '; the local emergency lever is set, but this node does not consent (FLEET_BACKUP_MODE is not active), so it stays passive'
                    : '; the local emergency lever is enabling it (read-only) while the master is dark')
                  : '';
                return <div key={d.nodeId}>{`${i + 1}. ${nodeName(d.nodeId)}: ${mode}${lever}`}</div>;
              })}
            </div>
          )}
          {editable && (
            <button onClick={() => { setDraft(cfg.masterCandidates.join('\n')); setWitnessDraft(cfg.witnessChannelId || ''); setBackupsDraft([...(cfg.backupDesignations || [])].sort((a, b) => a.priority - b.priority)); setBackupsEdited(false); }} style={{ marginTop: '4px', fontSize: '0.72rem', padding: '2px 8px' }}>
              Edit fleet config
            </button>
          )}
        </div>
      )}
      <div className="usage-stat-sub" style={{ marginTop: '6px' }}>
        {`Witness beacon: ${cfg.witnessChannelId ? `channel ${cfg.witnessChannelId}` : 'owner DM (default)'}`}
      </div>
      {(cfg.backupDesignations || []).length > 0 && (
        <div className="usage-stat-sub" style={{ marginTop: '6px' }}>
          {`Backup order: ${[...cfg.backupDesignations].sort((a, b) => a.priority - b.priority).map((d) => `${d.priority}. ${nodeName(d.nodeId)}`).join(', ')}`}
        </div>
      )}
    </div>
  );
}

// Discord witness status (B3): where this node's beacon lives and what the
// last renew and read saw. Read-only; darkness is stated, never inferred.
function FleetWitnessCard({ fleet }) {
  const w = fleet.witness;
  if (!w) return null;
  const home = w.home === 'channel' ? `channel ${w.channelId}` : w.home === 'dm' ? 'owner DM (default)' : 'unresolved';
  const roleLabel = (r) => (r === 'master' ? 'master' : 'backup');
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Discord witness</div>
      <div className="usage-stat-sub">{`Beacon home: ${home}`}</div>
      {w.lastRenewOk ? (
        <div className="usage-stat-sub">{`Beacon renewed ${fleetFormatAge(Date.now() - w.lastRenewAt)}`}</div>
      ) : (
        <div className="usage-stat-sub" style={{ color: '#e5534b' }}>
          {`Witness dark${w.lastError ? `: ${w.lastError}` : ''}`}
        </div>
      )}
      {(w.claims || []).map((c) => (
        <div key={c.nodeId} className="usage-stat-sub" style={{ fontFamily: 'monospace' }}>
          {`${c.nodeName} · ${roleLabel(c.role)} · term ${c.term} · seen ${fleetFormatAge(Date.now() - c.observedAt)}`}
        </div>
      ))}
    </div>
  );
}

// Warm standby (PLAN_STANDBY 3.5): the designated backup's promote surface.
// Rendered ONLY on the backup co-worker's own UI in postgres mode. The
// chainTakeover decision follows what this node can see: master WS down =
// dead-master failover (declare lost + take its shards), master WS up =
// planned handover (the deposed master keeps its shards until demoted).
function FleetPromoteCard({ api, fleet, reload }) {
  const [busy, setBusy] = React.useState(false);
  const masterDown = !fleet.masterKnown;
  const pair = fleet.dbReplica === true;
  const record = fleet.promote;
  // A claim parked before its term landed hides nothing: startPromote re-runs
  // the whole verdict over a parked record and the claim is idempotent, so
  // pressing Promote again is the forward exit when Cancel cannot prove the
  // claim never landed (a dead canonical reads the same as a lost one).
  // The engine's liveness: an unparked record no phase runs is idle too. A
  // record the fleet has moved past keeps hiding the buttons: its card names
  // Cancel, and the engine refuses a new verdict over it until then.
  const recordIdle = !!(record && (record.parked || fleet.promoteRunning === false));
  const active = !!(record && record.phase !== 'done' && !(recordIdle && record.phase === 'claim' && !record.claimedTerm && !fleet.promoteHeldBy));
  // The backup order (20.9) as ADVICE: a higher-ranked backup whose beacon is
  // fresh is the preferred stand-in; the click stays the operator's.
  const order = [...((fleet.fleetConfig && fleet.fleetConfig.backupDesignations) || [])].sort((a, b) => a.priority - b.priority);
  const mine = order.find((d) => d.nodeId === fleet.nodeId);
  const freshMs = 135000; // three witness renew periods, the fleet's own fresh window
  // Darkness is not evidence: an unread witness says nothing about who is
  // alive, and the claims snapshot is whatever the last SUCCESSFUL read saw.
  const witnessRead = !!(fleet.witness && fleet.witness.lastReadAt != null && Date.now() - fleet.witness.lastReadAt < freshMs);
  const claims = (fleet.witness && fleet.witness.claims) || [];
  const preferred = mine && witnessRead ? order.filter((d) => d.priority < mine.priority && claims.some((c) => c.nodeId === d.nodeId && Date.now() - c.observedAt < freshMs)) : [];
  const nameOf = (id) => { const n = (fleet.nodes || []).find((x) => x.nodeId === id); return n ? n.nodeName : id.slice(0, 8); };
  // Unified promote (PLAN_REPLICATION 20.4): ONE action moves the whole side.
  // The verdict is the engine's; the card only names the likely path and
  // drives the confirmations (the RPO acknowledgement re-posts with confirmLag).
  const post = (body) => api.post('/fleet/promote', body);
  const run = (retireOldMaster) => {
    if (busy) return;
    const text = masterDown
      ? 'Promote this instance to MASTER?\n\nThe master looks unreachable from this node. If its database still answers, this is a zero-loss transfer: the old database is fenced at a known point, the copy here catches up, then takes over. If nothing answers, the copy is promoted as far as replication reached and you will be asked to accept how current it is. This node restarts once as master; workers keep their sessions.'
      : retireOldMaster
        ? 'TRANSFER master here and RETIRE the old master?\n\nThe old master is deposed within seconds, keeps serving its shards until this node moves them, then rejoins as a co-worker. Its manager is told to reseed its database as a standby of this node once the transfer completes. No data is lost: the old database is fenced before the copy point.'
        : 'TRANSFER master to this instance?\n\nZero data loss: the old database is fenced at a known point, the copy here catches up to it, then becomes the fleet database. The old master keeps serving its shards until this node moves them, then rejoins as a co-worker. Writes are refused for a few seconds around the switch; Discord sessions stay up.';
    if (!confirm(text)) return;
    setBusy(true);
    // The engine asks for the RPO, then the lineage, then whether other nodes
    // can reach this one, so each can arrive on the answer to another; each is
    // asked once and carried on.
    const attempt = (body) => post(body).then((res) => {
      if (!res || res.success !== false) return res;
      if (res.needsLagConfirm && !body.confirmLag) {
        const replayed = res.lagMs != null
          ? `this machine's copy last replayed a transaction ${Math.round(res.lagMs / 1000)}s ago`
          : 'this machine\'s copy has replayed nothing since it started, so how far behind it is cannot be measured';
        if (!confirm(`${res.error || `Nothing answers on the old master or its database, and ${replayed}.`}\n\nPromoting makes that copy the fleet database, so anything the old one accepted after that point is LOST. Continue?`)) return null;
        return attempt({ ...body, confirmLag: true });
      }
      if (res.needsLineageConfirm && !body.confirmLineage) {
        if (!confirm((res.error || 'Another designated backup received further than this copy.') + '\n\nPromote this copy anyway?')) return null;
        return attempt({ ...body, confirmLineage: true });
      }
      if (res.needsReachabilityConfirm && !body.confirmReachability) {
        if (!confirm((res.error || 'No other instance can connect to this node.') + '\n\nPromote this instance anyway?')) return null;
        return attempt({ ...body, confirmReachability: true });
      }
      return res;
    });
    attempt({ retireOldMaster })
      .then((res) => {
        if (res === null) return;
        if (!res || res.success === false) { showToast((res && res.error) || 'Promotion failed', 'error'); return; }
        showToast(`Promote started (${res.record ? res.record.mode : 'promote'}); follow the phases in the card below`, 'success');
        // The record lives in the parent, so only a state fetch surfaces it;
        // without this the phase card stays invisible for the whole run and a
        // parked promote would never show its Continue button.
        reload();
      })
      .catch((err) => showToast((err && err.message) || 'Promotion failed', 'error'))
      .finally(() => { setBusy(false); reload(); });
  };
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">{fleet.followerHold ? 'Returning master' : 'Backup master'}</div>
      <div className="usage-stat-sub">
        This instance takes over only when you press a button here: bot and database together, one action.
      </div>
      {order.length > 1 && (
        <div className="usage-stat-sub" style={{ marginTop: '4px', color: preferred.length ? '#d29922' : undefined }}>
          {`Backup order: ${order.map((d) => `${d.priority}. ${nameOf(d.nodeId)}`).join(', ')}.`}
          {mine ? (preferred.length
            ? ` ${nameOf(preferred[0].nodeId)} ranks above this node and its beacon is fresh, so it is the preferred stand-in; promoting here is still your call.`
            : witnessRead
              ? ' No higher-ranked backup is beaconing; this node is the preferred stand-in.'
              : ' The witness has not been read recently, so nothing here says whether a higher-ranked backup is alive.') : ''}
        </div>
      )}
      {!pair ? (
        <div className="usage-stat-sub" style={{ color: '#d29922' }}>
          No database standby on this machine yet; the promote refuses until one is seeded (the manager provisions it from the copy block).
        </div>
      ) : null}
      {!active && (masterDown ? (
        <button onClick={() => run(false)} disabled={busy} style={{ marginTop: '6px' }}>
          {busy ? 'Working...' : 'Promote to master'}
        </button>
      ) : (
        <div style={{ marginTop: '6px' }}>
          <button onClick={() => run(false)} disabled={busy}>
            {busy ? 'Working...' : 'Transfer master here'}
          </button>
          <button onClick={() => run(true)} disabled={busy} style={{ marginLeft: '6px' }}>
            {busy ? 'Working...' : 'Transfer and retire old master'}
          </button>
        </div>
      ))}
    </div>
  );
}

const PROMOTE_PHASE_TEXT = {
  verdict: 'Deciding',
  claim: 'Claiming the term on the old database',
  fence: 'Fencing the old database',
  catchup: 'Catching the copy up to the fenced position',
  promote: 'Promoting the local copy',
  restart: 'Restarting as master',
  done: 'Done',
};

// The promote record rides beside the fleet state from the parent, so it stays
// visible while the bot child restarts; a parked phase offers Continue.
function FleetPromoteRecord({ api, fleet, reload, readOnly = false }) {
  const [busy, setBusy] = React.useState(false);
  const r = fleet.promote;
  if (!r) return null;
  if (r.phase === 'done' && !r.parked && !r.lastError) return null;
  const act = (path, okText) => {
    if (busy) return;
    setBusy(true);
    api.post(path, {})
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Failed', 'error'); return; }
        showToast(okText, 'success');
      })
      .catch((err) => showToast((err && err.message) || 'Failed', 'error'))
      .finally(() => { setBusy(false); reload(); });
  };
  // The engine's liveness: an unparked record no phase runs (the parent
  // restarted without resuming it) keeps its exits like a parked one.
  const idle = r.parked || fleet.promoteRunning === false;
  // Another node has held the fleet since this record was decided: the engine
  // refuses Continue and dismisses on Cancel, from a fact that needs no child.
  const heldBy = fleet.promoteHeldBy || null;
  // A boot parked on a live holder since this record was decided: the engine
  // dismisses on Cancel from the park view, and Continue can only refuse.
  const parkedSince = r.mode !== 'stand-in' && fleet.staleMasterPark && fleet.staleMasterPark.at >= r.startedAt ? fleet.staleMasterPark : null;
  const cancellable = !!heldBy || !!parkedSince || (r.phase === 'claim' && !r.claimedTerm) || (r.mode === 'failover' && r.phase === 'promote') || r.mode === 'stand-in';
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px', borderColor: idle && r.phase !== 'done' ? '#e5534b' : undefined }}>
      <div className="usage-stat-title">{`Promote (${r.mode}): ${PROMOTE_PHASE_TEXT[r.phase] || r.phase}${r.parked ? ' · PARKED' : idle && r.phase !== 'done' ? ' · STOPPED' : ''}`}</div>
      {r.lastError ? <div className="usage-stat-sub" style={{ color: '#ed4245' }}>{r.lastError}</div> : null}
      {r.fencedLsn ? <div className="usage-stat-sub">{`Old database fenced at ${r.fencedLsn}`}</div> : null}
      {heldBy ? (
        <div className="usage-stat-sub" style={{ color: '#ed4245' }}>{`Node ${heldBy.nodeId.slice(0, 8)} has held the fleet at term ${heldBy.term} since this promote was decided, so continuing it would restart this node as master past the fence${idle ? ': Continue is refused and Cancel dismisses it.' : '; the running phases will refuse to stage the takeover restart and park with that reason, and Cancel then dismisses it.'}`}</div>
      ) : null}
      {parkedSince ? (
        <div className="usage-stat-sub" style={{ color: '#ed4245' }}>{`The boot is parked on a live holder (${parkedSince.peerUrl} answers at term ${parkedSince.observedTerm}) since this promote was decided, so its takeover restart is what the fence parks: Cancel dismisses it and clears any takeover it staged.`}</div>
      ) : null}
      {!r.parked && idle && r.phase !== 'done' ? (
        <div className="usage-stat-sub" style={{ marginTop: '6px' }}>No phase is running this promote (the parent restarted without resuming it); Continue re-enters it at its recorded phase.</div>
      ) : null}
      {idle && r.phase !== 'done' && readOnly && !heldBy ? (
        <div className="usage-stat-sub" style={{ marginTop: '6px' }}>Start the bot to continue or cancel this promote: the gates that protect a takeover restart need its fleet state.</div>
      ) : null}
      {idle && r.phase !== 'done' && (!readOnly || heldBy) ? (
        <div style={{ marginTop: '6px' }}>
          {!readOnly && !parkedSince ? <button onClick={() => act('/fleet/promote/continue', 'Promote continues')} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px' }}>Continue</button> : null}
          {cancellable ? (
            <button onClick={() => act('/fleet/promote/cancel', 'Promote cancelled')} disabled={busy} style={{ fontSize: '0.72rem', padding: '2px 8px', marginLeft: readOnly || parkedSince ? 0 : '6px' }}>Cancel</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The last stand-in episode this node took part in (20.5, B6-j), on either
// side: who stood in for whom, how it ended, and the plan's question, did the
// writes taken during the outage survive.
function FleetEpisodeCard({ fleet }) {
  const e = fleet.episode;
  if (!e) return null;
  const nameOf = (id, given) => {
    if (given) return given;
    const n = (fleet.nodes || []).find(x => x.nodeId === id);
    return n ? n.nodeName : id.slice(0, 8);
  };
  const at = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const standIn = nameOf(e.standInNodeId, e.standInName);
  const covering = nameOf(e.coveringNodeId, e.coveringName);
  const ENDING = {
    'handed-back': `the fleet moved onto a database built from that copy (the failback, or a promote through it)${e.writesSurvived === 'partial' ? ', as far as this database had replayed from it' : ', so the writes travelled with it'}`,
    'promoted-for-good': `${standIn} was promoted by hand into the true master`,
    'demoted': `${standIn} was demoted by the operator`,
    'superseded': 'another node took the fleet at a higher term',
    'seized': `${covering} seized the fleet back onto its own database`,
    'never-served': 'the lane ended before it served, or while it served read-only',
  };
  // A node that held the fleet on this copy (a stand-in promoted for good, or
  // a returning master after its failback) and was superseded later, its
  // record closed before that supersession: the writes are on the fleet
  // database only if the new master's database was built from this copy.
  const s = fleet.superseded;
  const heldForGood = !!(s && (e.writesSurvived === 'yes' || e.writesSurvived === 'partial') && e.endedAt < s.since
    && ((e.side === 'stand-in' && e.standInNodeId === fleet.nodeId && e.ending === 'promoted-for-good') || (e.side === 'master' && e.coveringNodeId === fleet.nodeId)));
  const WRITES = {
    yes: heldForGood
      ? `The writes taken during the outage were the fleet's while this node held it; ${s.byNodeName} has since taken term ${s.term}, so they are on the fleet database only if that database was built from this machine's database${e.copyReseeded ? `; this machine's database has since been re-seeded as a standby, so ${e.side === 'stand-in' ? 'they are nowhere else' : 'this side no longer holds them'}` : ': do not re-seed or decommission this side until that is settled'}.`
      : 'The writes taken during the outage SURVIVED: they are on the fleet database.',
    no: e.side === 'stand-in' && e.standInNodeId === fleet.nodeId && e.ending === 'seized' && !e.copyReseeded
      ? 'The writes taken during the outage were DISCARDED: they are off the fleet database; this copy still holds them until it is re-seeded, so take a dump of this database first if they are wanted.'
      : 'The writes taken during the outage were DISCARDED.',
    held: `The writes taken during the outage are held ONLY by ${standIn}'s copy: a re-seed discards them, a promote of that node makes them the fleet's.`,
    none: 'No writes were taken during the episode.',
    partial: heldForGood
      ? `The writes taken during the outage survived only as far as this database had replayed from that copy (it was never fenced, so anything the stand-in took after that was lost), and what it did recover was the fleet's while this node held it; ${s.byNodeName} has since taken term ${s.term}, so it is on the fleet database only if that database was built from this machine's database${e.copyReseeded ? '; this machine\'s database has since been re-seeded as a standby, so this side no longer holds it' : ': do not re-seed or decommission this side until that is settled'}.`
      : 'The writes taken during the outage survived only as far as this database had replayed from that copy: it was never fenced, so anything the stand-in took after that was lost.',
  };
  const lineage = e.lineageVerdict === 'prefix' ? ` ${covering}'s own pre-outage database was a prefix of that copy, so nothing of its own was lost at the wipe.`
    : e.lineageVerdict === 'diverged' ? ` ${covering}'s own pre-outage database held changes that copy never received; they were discarded at the consented wipe (the safety dump taken before it has them if it succeeded; this machine's manager reported the outcome at the consent).`
    : e.lineageVerdict === 'unknown' ? ` Whether ${covering}'s own pre-outage database held changes that copy never received could not be told.`
    : '';
  // The record is this lane's own when its since-when is the arm's. A record
  // that closed before a disarmed lane ARMED cannot be the lane's own, so the
  // lane's record was not written (a later promote restamps only the disarm
  // time); any record older than an open episode (a live lane, a follower
  // hold) is an earlier one, whichever side it is.
  const arm = fleet.standIn;
  const ownLane = !!(arm && e.side === 'stand-in' && e.standInNodeId === fleet.nodeId && e.standInSince === arm.armedAt);
  const laneMiss = !!(arm && arm.phase === 'disarmed' && !ownLane && e.endedAt < arm.armedAt);
  const openSince = arm && arm.phase !== 'disarmed' ? arm.armedAt : fleet.followerHold ? fleet.followerHold.since : null;
  const earlier = laneMiss || (openSince !== null && e.endedAt <= openSince);
  const title = !earlier ? 'Last stand-in episode' : laneMiss ? "An earlier stand-in episode (this lane's own record was not written; if the write faulted, the bot log says so)" : 'An earlier stand-in episode';
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">{title}</div>
      <div className="usage-stat-sub">
        {`${standIn} stood in for ${covering} from ${at(e.standInSince)}${e.writesFrom ? `, taking writes from ${at(e.writesFrom)}` : ''}, until ${at(e.endedAt)}: ${ENDING[e.ending] || e.ending}${e.detail ? ` (${e.detail})` : ''}.`}
      </div>
      <div className="usage-stat-sub" style={{ marginTop: '4px', color: e.writesSurvived === 'no' ? '#e5534b' : e.writesSurvived === 'held' || e.writesSurvived === 'partial' || (e.writesSurvived === 'yes' && heldForGood) ? '#e0a030' : undefined }}>
        {(WRITES[e.writesSurvived] || '') + lineage}
      </div>
    </div>
  );
}

// A master (or the co-worker it became) that a higher term superseded (B4).
// An ex-stand-in whose episode was handed back names the failback instead of
// calling its copy inert (B6-j): the drop-back re-seeds it.
function FleetSupersededBanner({ fleet }) {
  const s = fleet.superseded;
  if (!s) return null;
  // Only an episode closed by THIS supersession speaks for the hand-back (the
  // record outlives its episode). A held verdict is durable (the record itself
  // expires when the copy is re-seeded) and needs no such correlation: while
  // it stands, this copy alone holds the outage writes and is not inert. A
  // node that held the fleet for good on this copy and was superseded later is
  // inert only if the new master's database was built from it.
  const e = fleet.episode;
  const own = !!(e && e.side === 'stand-in' && e.standInNodeId === fleet.nodeId);
  const thisEpisode = own && e.endedAt >= s.since && e.ending === 'handed-back' && e.writesSurvived === 'yes';
  const holdsWrites = own && e.writesSurvived === 'held';
  // A lane that took writes and left no record of its own (the write faulted,
  // or the process died between the two writes): nothing here can say where
  // the writes went, so nothing here may call the copy inert, nor read an
  // older record as this lane's, until the copy is seen re-seeded (the
  // sampler stamps the arm record once).
  const a = fleet.standIn;
  const laneRecordMissing = !!(a && a.phase === 'disarmed' && a.promotedAt !== null && (!e || (!(own && e.standInSince === a.armedAt) && e.endedAt < a.armedAt)));
  const laneUnrecorded = laneRecordMissing && !a.copyReseededAt;
  const heldForGood = !!e && !laneRecordMissing && (e.writesSurvived === 'yes' || e.writesSurvived === 'partial') && e.endedAt < s.since
    && ((own && e.ending === 'promoted-for-good') || (e.side === 'master' && e.coveringNodeId === fleet.nodeId));
  // A lane the fleet moved on from (a seizure, or a lossy failback): the copy
  // still holds what it took until it is re-seeded, so a dump comes first.
  const seizedHere = own && e.ending === 'seized' && !e.copyReseeded;
  const tail = thisEpisode
    ? ` The fleet moved onto a database built from this machine's copy (the failback, or a promote through it), so the writes taken during the outage survived on ${s.byNodeName}'s database. This copy is re-seeded as a standby of it by the drop-back run on this machine's manager when the failback asked this side to retire (its Database modal parks and asks first); otherwise re-seed it by hand from that node's Database modal.`
    : holdsWrites
      ? ` This database is NOT inert: the writes taken during the outage are held ONLY by this copy. Do not re-seed or decommission this side until they are recovered: promote this node for good to make them the fleet's, or take a dump of this database first.`
      : heldForGood
        ? (e.copyReseeded
          ? ` This node held the fleet on this machine's database before ${s.byNodeName} took term ${s.term}; it has since been re-seeded as a standby of that node, so it is inert now, and the writes it held are on the fleet database only if that node's database was built from it${e.side === 'stand-in' ? ', and nowhere else if it was not' : ''}.`
          : ` This node held the fleet on this copy before ${s.byNodeName} took term ${s.term}: the copy is inert only if that node's database was built from it; settle that before re-seeding or decommissioning this side.`)
        : seizedHere
          ? ' The fleet moved on without the writes this copy took while standing in; this copy still holds them until it is re-seeded, so take a dump of this database first if they are wanted. It is inert for the fleet otherwise: retire this side from the manager (reseed it as a standby of the new master, or decommission it).'
          : laneUnrecorded
            ? " This copy took the fleet's writes as a stand-in and its lane left no episode record (if the write faulted, the bot log says so), so whether they reached the new master's database cannot be told from here: do not re-seed or decommission this side until that is settled."
            : ' Its database is inert now: retire this side from the manager (reseed it as a standby of the new master, or decommission it).';
  return (
    <div className="usage-notice" style={{ borderColor: '#e5534b', color: '#e5534b' }}>
      {`SUPERSEDED by ${s.byNodeName} at term ${s.term} (${s.source}). ${s.steppedDown
        ? 'This node has stepped down and serves as a co-worker of the new master.'
        : 'This node keeps serving its shards until the new master is proven up, then steps down on its own.'}${tail}`}
    </div>
  );
}

// Empty-store boot hold (PLAN_REPLICATION 20.14): a master with no data while
// other nodes are configured must seed from a backup before it serves.
// The stand-in lane's own surface (20.5, B6-f): what this node is holding for
// whom, whether writes have been taken, and why they have not been.
function FleetStandInBanner({ fleet }) {
  const s = fleet.standIn;
  if (!s) return null;
  const nameOf = (id) => {
    const n = (fleet.nodes || []).find(x => x.nodeId === id);
    return n ? n.nodeName : id.slice(0, 8);
  };
  const at = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
  if (!s.live) {
    if (s.phase !== 'disarmed' || !s.disarmedAt) return null;
    // The lane's own episode record says how it ended (it is this lane's when
    // its since-when is the arm's); the arm record's reason is restamped by a
    // later promote by hand, which the manager reads.
    const e = fleet.episode;
    const lane = e && e.side === 'stand-in' && e.standInNodeId === fleet.nodeId && e.standInSince === s.armedAt ? e : null;
    return (
      <div className="usage-stat-sub" style={{ marginTop: '6px' }}>
        {`Last stand-in attempt for ${nameOf(s.coveringNodeId)} ended at ${at(lane ? lane.endedAt : s.disarmedAt)}: ${lane ? lane.detail : (s.disarmReason || 'no reason recorded')}.${s.rearmAfter && Date.now() < s.rearmAfter ? ` The lane may arm again after ${at(s.rearmAfter)}.` : ''}`}
      </div>
    );
  }
  let text;
  if (!fleet.initialized && s.writeGate) {
    text = `STANDING IN for ${nameOf(s.coveringNodeId)}: this boot is HELD. ${s.writeGate}`;
  } else if (s.phase === 'promoted') {
    text = `STANDING IN for ${nameOf(s.coveringNodeId)} WITH WRITES${s.promotedAt ? ` since ${new Date(s.promotedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}: this machine's copy has been promoted and is the fleet database until the master returns for failback or an operator promotes this node for good.${s.writeGate ? ` ${s.writeGate}` : ''}`;
  } else if (s.phase === 'promoting') {
    text = `STANDING IN for ${nameOf(s.coveringNodeId)}: taking writes now (promoting this machine's copy).${s.writeGate ? ` ${s.writeGate}` : ''}`;
  } else {
    const gate = s.writeGate
      ? s.writeGate
      : s.writeRefusal
        ? `Taking writes was refused: ${s.writeRefusal}`
        : Date.now() < s.holdUntil
          ? `Writes are taken automatically after ${at(s.holdUntil)} if the master is still gone on every check and this copy was provably in sync.`
          : 'Checking whether writes can be taken.';
    text = `STANDING IN for ${nameOf(s.coveringNodeId)} at term ${s.inheritedTerm == null ? '?' : s.inheritedTerm}, READ-ONLY. ${gate} Manual promote stays available and makes this node the true master for good.`;
  }
  if (fleet.initialized) text += ` This is a PARTIAL takeover: the shards ${nameOf(s.coveringNodeId)} held stay dark until it returns, and this node serves only the free pool and the nodes that re-register with it.`;
  return (
    <div className="usage-notice" style={{ borderColor: '#5b9bd5', color: '#5b9bd5' }}>{text}</div>
  );
}

// The follower hold (20.5, B6 map F28): a returning master that found its
// stand-in holding the fleet's writes, or its own database a copy, and runs
// as a co-worker of the node holding the fleet until the failback promotes it
// back. The failback-pending surface proper is B6-j's; this says what holds
// and what ends it.
function FleetFollowerHoldBanner({ api, fleet }) {
  const h = fleet.followerHold;
  const who = h.standInName || (h.standInNodeId ? h.standInNodeId.slice(0, 8) : 'the node holding the fleet');
  const behind = h.reason === 'copy'
    ? `this node's own database is a copy in recovery${h.observedTerm != null ? ` of ${who}'s at term ${h.observedTerm}` : ''}, so it cannot serve as master from it`
    : `${who} stood in for this node while it was down and took the fleet's writes at term ${h.observedTerm}, while this node's own database holds term ${h.localTerm}: that copy is the fleet database now and this one is behind it`;
  const posture = h.namesThisNode === true
    ? (h.following
      ? `Following ${who} as a co-worker on its database.`
      : `Registered with ${who}, but the database it delivered is not installed here yet (not dialable from this machine, or its identity did not verify), so this node serves nothing until it is.`)
    : h.namesThisNode === false
      ? `Following ${who} as a co-worker, but it no longer stands in for this node (promoted by hand, or its lane ended), so there is no failback to run: demote this node to stay a co-worker, or set BOT_NODE_ROLE=backup-master on this node and restart it to make it a designated backup.`
      : `Dialing ${who} to follow it as a co-worker.`;
  const lastResort = ' If that node is gone for good, FLEET_CONFIRM_TAKEOVER=1 on this node plus a restart seizes the fleet back onto this database, losing everything that node accepted during the outage.';
  // A lane of THIS hold in flight outranks the routes (a record from before the
  // hold names no database the node follows, and is not the failback). A claim
  // parked before its term landed keeps the routes: the promote card stays
  // live for it.
  const rec = fleet.promote && fleet.promote.phase !== 'done' && !fleet.promoteHeldBy ? fleet.promote : null;
  // The engine's rule (recordOfHold): a hold that has delivered nothing yet is
  // not judged, so the lane it names is still the lane.
  const forms = [h.following, ...(h.followingForms || [])].filter(Boolean);
  const lane = rec && rec.canonicalEndpoint && (forms.length === 0 || forms.includes(rec.canonicalEndpoint)) ? rec : null;
  // The record card's liveness: an unparked lane no phase runs is stopped.
  const laneIdle = !!(lane && (lane.parked || fleet.promoteRunning === false));
  const unlandedClaim = !!(laneIdle && lane.phase === 'claim' && !lane.claimedTerm);
  const cancellable = !!(laneIdle && ((lane.phase === 'claim' && !lane.claimedTerm) || (lane.mode === 'failover' && lane.phase === 'promote')));
  const phaseText = lane ? (PROMOTE_PHASE_TEXT[lane.phase] || lane.phase) : '';
  // A record the fleet has moved past is not the lane, but it blocks a new
  // verdict until it is cancelled: named ahead of the promote routes.
  const stale = fleet.promote && fleet.promote.phase !== 'done' && fleet.promoteHeldBy ? fleet.promote : null;
  const staleIdle = !!(stale && (stale.parked || fleet.promoteRunning === false));
  const next = lane && !unlandedClaim
    ? (laneIdle
      ? ` The failback is ${lane.parked ? 'parked' : 'stopped (no phase is running it)'} (${phaseText}); Continue it in the promote record card below${cancellable ? ', or Cancel it there' : ''}.`
      : ` The failback is running (${phaseText}); the promote record card below follows it.`)
    : stale
    ? ` A promote decided before node ${fleet.promoteHeldBy.nodeId.slice(0, 8)} took the fleet is still on record (${PROMOTE_PHASE_TEXT[stale.phase] || stale.phase})${staleIdle
      ? `; Cancel it in the promote record card below${h.namesThisNode === true ? ', and the promote button returns here' : ', before any new verdict'}.`
      : '; its running phases will refuse to stage the takeover restart and park with that reason, and Cancel in the promote record card below dismisses it then.'}`
    : h.namesThisNode === true
    ? (h.reason === 'copy'
      ? ' FAILBACK PENDING: to take the fleet back, promote this node from the card below once its copy has caught up; that ends the stand-in. A manager that manages this database runs that step itself (its Database modal shows the failback run).'
      : ` FAILBACK PENDING. A manager that manages this database runs it from its Database modal: it dumps this database, parks and asks before wiping it, re-seeds it as a standby of that copy, then promotes this node back once it has caught up. By hand: re-seed this database as a standby of that copy (its block is on that node's Database modal), then promote this node from the card below once the copy has caught up. Demote this node to stay a co-worker instead.` + lastResort)
    : h.namesThisNode === null
      ? (h.reason === 'copy'
        ? ' The failback cannot start until this node is registered with the node holding the fleet; this copy is kept as it is meanwhile (neither re-seeded nor adopted).'
        : lastResort)
      : '';
  return (
    <div className="usage-notice" style={{ borderColor: '#e0a030', color: '#e0a030' }}>
      {`RETURNING MASTER, HOLDING: ${behind}. ${posture}${next}`}
      <div><FleetDemoteButton api={api} /></div>
    </div>
  );
}

function FleetEmptyStoreHoldBanner({ api, hold }) {
  const [busy, setBusy] = React.useState(false);
  const confirmFresh = () => {
    if (busy) return;
    if (!confirm('Confirm this is a BRAND-NEW fleet?\n\nOnly do this when no backup anywhere holds real data for this bot. The empty database on this machine becomes the fleet database and a term is minted on it. If a backup with real data exists, cancel and seed this machine from it instead (Promote on that data, or provision this machine as a standby first).')) return;
    setBusy(true);
    api.post('/fleet/confirm-fresh', {})
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'Confirm failed', 'error'); return; }
        showToast('Brand-new fleet confirmed; the hold releases on its next check', 'success');
      })
      .catch((err) => showToast((err && err.message) || 'Confirm failed', 'error'))
      .finally(() => setBusy(false));
  };
  return (
    <div className="usage-notice" style={{ borderColor: '#e0a030', color: '#e0a030' }}>
      {`EMPTY STORE HOLD: this master's database is ${hold.storeState} while this fleet has other nodes on record (${(hold.candidates || []).join(', ')}). It will not mint a term or serve while a backup may hold the real data. Provision this machine as a standby of the node that holds the data and let it catch up (the hold releases by itself once this database holds real data), or demote this node to rejoin the fleet as a co-worker. Only confirm a brand-new fleet when no backup anywhere holds data for this bot.`}
      <div>
        <FleetDemoteButton api={api} />
      </div>
      <div>
        <button onClick={confirmFresh} disabled={busy} style={{ marginTop: '6px', fontSize: '0.72rem', padding: '2px 8px' }}>
          {busy ? 'Confirming...' : 'This is a brand-new fleet'}
        </button>
      </div>
    </div>
  );
}

// The emergency lever (B6-k, F11): a node-local enable of active mode for the
// outage, on this backup's own web UI. It supplies the master's key only,
// counts only while the master is unreachable, and survives restarts until
// cleared.
function FleetModeLeverCard({ api, fleet, reload }) {
  const [busy, setBusy] = React.useState(false);
  const o = fleet.modeOverride;
  // The set path belongs to a backup master's co-worker view; a set lever is
  // shown, and can be cleared, on every role, or a standing-in node could
  // neither see what armed it nor end that.
  const canSet = fleet.backupMaster && fleet.dataBackend === 'postgres' && fleet.role === 'co-worker';
  if (!o && !canSet) return null;
  const at = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const standing = !!(fleet.standIn && fleet.standIn.live);
  // The arm log's own test: a node the master enabled runs on the stored
  // designation, and the lever adds nothing there.
  // The pre-init build publishes no node id and the degraded responses no
  // config, so the stored mode is unknown there rather than passive.
  const storedKnown = !!fleet.nodeId && !!(fleet.fleetConfig && fleet.fleetConfig.backupDesignations);
  const storedActive = storedKnown && fleet.fleetConfig.backupDesignations.some((d) => d.nodeId === fleet.nodeId && d.mode === 'active');
  // masterKnown is the arm's evidence on the co-worker build only: a serving
  // stand-in reports it for itself, and the pre-init build has no arm tick.
  const now = !o || storedActive ? ''
    : standing ? (storedKnown ? ' This stand-in was armed by the local lever; clearing it does not end the current lane (demote does).' : ' Clearing it does not end the current stand-in lane (demote does).')
    : fleet.initialized !== true ? ' Whether it counts right now cannot be read until this node\'s fleet layer is up.'
    : fleet.role === 'master' ? ' It has no effect while this node is the master.'
    : fleet.backupMaster !== true ? ' It cannot count on this node: its env role is not backup-master (BOT_NODE_ROLE), so no stand-in lane is evaluated here.'
    : fleet.dataBackend && fleet.dataBackend !== 'postgres' ? ' It cannot count on this node: its data backend is file mode, which has no standby to stand in from.'
    : fleet.masterKnown ? ' Ignored right now: the master is reachable, so its stored designation decides.'
    : ' Counting right now: this node holds no control connection to the master.';
  const send = (clear) => {
    if (busy) return;
    if (!clear && !confirm('Enable active mode locally?\n\nWhile the master is unreachable this node may then stand in READ-ONLY, as a designated backup would. Taking writes needs the master\'s own in-sync attestation, which a node the master never enabled does not have, so writes stay a manual promote with its RPO confirm. Whenever the master is reachable the stored designation decides and this is ignored. It stays set across restarts until cleared here.')) return;
    setBusy(true);
    api.post('/fleet/mode-override', clear ? { clear: true } : {})
      .then((res) => {
        if (!res || res.success === false) { showToast((res && res.error) || 'The lever could not be set', 'error'); return; }
        showToast(clear ? 'Local enable cleared' : 'Active mode enabled locally for the outage', 'success');
        if (reload) reload();
      })
      .catch((err) => showToast((err && err.message) || 'The lever could not be set', 'error'))
      .finally(() => setBusy(false));
  };
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Emergency lever</div>
      <div className="usage-stat-sub">
        {(o
          ? storedActive
            ? `Active mode is ENABLED LOCALLY (set ${at(o.setAt)} by ${o.setBy}), but the master's stored designation already enables this node, so the lever adds nothing here${standing ? ' (this stand-in runs on the stored enable)' : ''}. It survives restarts until cleared here.`
            : `Active mode is ENABLED LOCALLY (set ${at(o.setAt)} by ${o.setBy}): while the master is unreachable this node may stand in READ-ONLY as a designated backup would; taking writes still needs the master's own in-sync attestation replicated into this copy, and without it writes stay a manual promote with its RPO confirm.${now} It survives restarts until cleared here.`
          : (storedActive ? 'The master\'s stored designation already enables active mode for this node, so the lever would add nothing here now; it exists for a node the master never enabled. ' : '')
            + 'If the master is dark and its stored designation does not enable active mode for this node, this enables it locally for the outage: the node may then stand in READ-ONLY; taking writes stays a manual promote with its RPO confirm. It ranks below the stored designation whenever the master is reachable, and it survives restarts until cleared here.')
          + (fleet.activeCapable ? '' : ' This node does not CONSENT to active mode (FLEET_BACKUP_MODE is not active), so the lever has no effect until its env consents.')}
      </div>
      <button onClick={() => send(!!o)} disabled={busy} style={{ marginTop: '6px', fontSize: '0.72rem', padding: '2px 8px' }}>
        {o ? 'Clear the local enable' : 'Enable active mode locally'}
      </button>
    </div>
  );
}

// Demote surface for a deposed / operator-overridden master. With no other
// master visible the route answers needsConfirm with the ordering warning.
function FleetDemoteButton({ api }) {
  const [busy, setBusy] = React.useState(false);
  const demote = () => {
    if (busy) return;
    if (!confirm('Demote this master to co-worker?\n\nIt restarts, dials the master candidates and re-adopts its shards from the live master at zero identify cost.')) return;
    setBusy(true);
    const send = (confirmFreeze) => api.post('/fleet/demote', confirmFreeze ? { confirm: true } : {});
    send(false)
      .then((res) => {
        if (res && res.success === false && res.needsConfirm) {
          if (!confirm(res.error)) return null;
          return send(true);
        }
        return res;
      })
      .then((res) => {
        if (res === null) return;
        if (!res || res.success === false) { showToast((res && res.error) || 'Demotion failed', 'error'); return; }
        showToast('Demotion started: this node restarts as co-worker', 'success');
      })
      .catch((err) => showToast((err && err.message) || 'Demotion failed', 'error'))
      .finally(() => setBusy(false));
  };
  return (
    <button onClick={demote} disabled={busy} style={{ marginTop: '6px', fontSize: '0.72rem', padding: '2px 8px' }}>
      {busy ? 'Demoting...' : 'Demote to co-worker'}
    </button>
  );
}

function FleetView({ api, wsClient, guildNames }) {
  const [fleet, setFleet] = React.useState(null);
  // Distinguishes "lease expired after the master vanished" from "never had a
  // lease" on a co-worker; reset once the master is back.
  const sawCachedLeaseRef = React.useRef(false);
  // No WS pushes arrive while the fleet layer is mid-init (e.g. the boot
  // takeover guard holding), so poll until initialized.
  const fleetInitializedRef = React.useRef(false);
  // The promote record is the PARENT's, so the child's fleet-status pushes
  // never carry it; a running promote keeps polling the route that does.
  const promoteActiveRef = React.useRef(false);

  const applyFleet = React.useCallback((obj) => {
    fleetInitializedRef.current = obj != null && obj.initialized === true;
    promoteActiveRef.current = !!(obj && obj.promote && obj.promote.phase !== 'done');
    setFleet(obj);
  }, []);

  const loadFleet = React.useCallback(() => {
    api.get('/fleet/state')
      .then((res) => { if (res.success) applyFleet(res); })
      .catch((err) => console.error('[Fleet] Failed to load fleet state:', err));
  }, [api, applyFleet]);

  React.useEffect(() => {
    loadFleet();
    const unsubscribe = wsClient.on('bot:fleet:status', (state) => {
      // Carry the last known promote record, and the parent-side facts that
      // describe it, across a child push: replacing the object wholesale would
      // blank the phase card for the whole run.
      setFleet((prev) => Object.assign({ success: true, running: true }, state, prev && prev.promote ? { promote: prev.promote, promoteHeldBy: prev.promoteHeldBy, promoteRunning: prev.promoteRunning } : {}));
      fleetInitializedRef.current = state != null && state.initialized === true;
    });
    const unsubscribeStatus = wsClient.on('bot:status', () => loadFleet());
    const unsubscribeSync = wsClient.on('bot:sync:status', () => loadFleet());
    const initPoll = setInterval(() => {
      if (!fleetInitializedRef.current || promoteActiveRef.current) loadFleet();
    }, 5000);
    return () => {
      unsubscribe();
      unsubscribeStatus();
      unsubscribeSync();
      clearInterval(initPoll);
    };
  }, [loadFleet, applyFleet]);

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
        {fleet.takeoverHold && (
          <div className="usage-notice" style={{ borderColor: '#e0a030', color: '#e0a030' }}>
            {`TAKEOVER GUARD: another master (term ${fleet.takeoverHold.observedTerm}) still looks alive, so this master boot is holding: ${Math.round((fleet.takeoverHold.observingForMs || 0) / 1000)}s of ${Math.round((fleet.takeoverHold.requiredMs || 0) / 1000)}s without its stamp advancing. It proceeds automatically once the incumbent goes silent; a deliberate takeover is started from the backup's Promote button instead. If this node is a returned OLD master, demote it here to rejoin the fleet as a co-worker.`}
            <div><FleetDemoteButton api={api} /></div>
          </div>
        )}
        {fleet.staleMasterPark && (
          <div className="usage-notice" style={{ borderColor: '#e5534b', color: '#e5534b' }}>
            {`STALE MASTER FENCE: ${fleet.staleMasterPark.peerUrl} holds the fleet at term ${fleet.staleMasterPark.observedTerm}, while this node's own database holds term ${fleet.staleMasterPark.localTerm} and nothing is writing to it. The fleet's term ${fleet.staleMasterPark.observedTerm} was minted on that node's database, so this machine's copy is a fork: acquiring a term here would put two masters on one bot token, each writing a database the other never sees. The boot is parked and will not release on its own. Demote this node to rejoin the fleet as a co-worker on the live database - that is the intended recovery, and it is safe even if this machine's copy is the newer one, because the fleet's data lives on the node above. Only if that node must NOT keep the fleet, set FLEET_CONFIRM_TAKEOVER=1 on this node and restart it to seize the fleet onto this database instead; every change the fleet has made on that node is lost.${String(fleet.staleMasterPark.peerUrl || '').startsWith('witness beacon') ? ' One more case releases safely: if this database was DELIBERATELY restored from a dump on this same machine, the fleet has not moved anywhere and the fence is reacting to the rewound control term - the manager\'s restore lane advances it automatically, and the takeover confirm above is the by-hand override.' : ''}`}
            <div><FleetDemoteButton api={api} /></div>
          </div>
        )}
        {fleet.readOnlyStorePark && (
          <div className="usage-notice" style={{ borderColor: '#e5534b', color: '#e5534b' }}>
            {fleet.readOnlyStorePark.reason}
            <div><FleetDemoteButton api={api} /></div>
          </div>
        )}
        {fleet.followerHold && <FleetFollowerHoldBanner api={api} fleet={fleet} />}
        {fleet.emptyStoreHold && (
          <FleetEmptyStoreHoldBanner api={api} hold={fleet.emptyStoreHold} />
        )}
        <FleetStandInBanner fleet={fleet} />
        <FleetModeLeverCard api={api} fleet={fleet} reload={loadFleet} />
        {fleet.standIn && fleet.standIn.live && fleet.standIn.writeGate && (
          <div><FleetDemoteButton api={api} /></div>
        )}
        <FleetPromoteRecord api={api} fleet={fleet} reload={loadFleet} readOnly={!fleet.running} />
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
        {fleet.masterKnown && (
          <div className="usage-stat-sub" style={{ color: fleet.masterStandingInFor ? '#5b9bd5' : undefined }}>
            {`Following ${fleet.masterName || (fleet.masterNodeId ? fleet.masterNodeId.slice(0, 8) : 'the master')}${fleet.masterUrl ? ` at ${fleet.masterUrl}` : ''}${fleet.masterStandingInFor
              ? (fleet.masterStandingInFor === fleet.nodeId
                ? ', which is STANDING IN for THIS node: the fleet runs on its copy until the failback promotes this node back'
                : `, which is STANDING IN for ${fleet.masterStandingInFor.slice(0, 8)}: the fleet runs on ${fleet.masterName || 'that stand-in'}'s copy until that master returns for the failback`)
              : ` as the fleet's master`}${fleet.deliveredForms && fleet.deliveredForms.length > 0 ? ` · data from ${fleet.deliveredForms[0]}` : ''}`}
          </div>
        )}
        <FleetEpisodeCard fleet={fleet} />

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
        {fleet.dataBoot && fleet.dataBoot.banner && (
          <div className="usage-notice">
            {`${fleet.dataBoot.banner} The transformation is started from the master's Usage tab.`}
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
        <FleetSupersededBanner fleet={fleet} />
        {fleet.followerHold && <FleetFollowerHoldBanner api={api} fleet={fleet} />}
        <FleetStandInBanner fleet={fleet} />
        {fleet.roleOverride && (
          <div className="usage-stat-sub" style={{ marginTop: '6px' }}>
            {`Role set by operator override (${fleet.roleOverride.setBy}, ${new Date(fleet.roleOverride.setAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)`}
          </div>
        )}
        {(fleet.backupMaster || (fleet.followerHold && fleet.followerHold.namesThisNode === true)) && fleet.dataBackend === 'postgres' && (
          <FleetPromoteCard api={api} fleet={fleet} reload={loadFleet} />
        )}
        <FleetModeLeverCard api={api} fleet={fleet} reload={loadFleet} />
        <FleetPromoteRecord api={api} fleet={fleet} reload={loadFleet} />
        {fleet.backupMaster && fleet.dataBackend !== 'postgres' && (
          <div className="usage-stat-sub" style={{ marginTop: '6px', color: '#777' }}>
            Designated backup master, but promotion is a postgres-mode feature (file mode has no standby).
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

        {!fleet.standalone && <FleetConfigCard api={api} fleet={fleet} />}
        <FleetWitnessCard fleet={fleet} />
        <FleetSyncCard sync={fleet.sync} />

        {fleet.budget ? <FleetBudgetCard budget={fleet.budget} /> : null}

        {selfNode ? (
          <div className="usage-stat-grid" style={{ marginTop: '14px' }}>
            <FleetNodeCard node={selfNode} dataBackend={fleet.dataBackend} standbySlot={fleet.standbySlot} />
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
          {`CRITICAL: another master (term ${fleet.controlStoreFenced.observedTerm}) owns this fleet's control store. This master has stopped granting shards.${fleet.superseded ? '' : ' Demote this node to rejoin the fleet as a co-worker, or keep exactly one master per control store and restart.'}`}
          {!fleet.standalone && !fleet.superseded && <div><FleetDemoteButton api={api} /></div>}
        </div>
      )}
      <FleetSupersededBanner fleet={fleet} />
      <FleetEpisodeCard fleet={fleet} />
      <FleetPromoteRecord api={api} fleet={fleet} reload={loadFleet} />

      {fleet.dbStandbys && fleet.dbStandbys.some((sb) => sb.state !== 'streaming') && (
        <div className="usage-notice" style={{ borderColor: '#e5534b', color: '#e5534b' }}>
          {`Database replication is BROKEN: ${fleet.dbStandbys.filter((sb) => sb.state !== 'streaming').map((sb) => `${sb.clientAddr || 'standby'} is ${sb.state || 'not streaming'}`).join(', ')}. The copy is going stale, so this machine dying would lose everything written since the link broke. Re-seed the standby from its manager.`}
        </div>
      )}

      {fleet.termStampFailingForMs != null && !fleet.controlStoreFenced && (
        <div className="usage-notice">
          {`Control store unreachable: the term liveness stamp has been failing for ${Math.round(fleet.termStampFailingForMs / 1000)}s. Control-plane writes are held; guilds keep serving on cached state.`}
        </div>
      )}

      <FleetStandInBanner fleet={fleet} />
      <FleetModeLeverCard api={api} fleet={fleet} reload={loadFleet} />
      {fleet.roleOverride && !fleet.standalone && (
        <div className="usage-stat-sub">
          {`Role set by operator override (${fleet.roleOverride.setBy}, ${new Date(fleet.roleOverride.setAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)`}
        </div>
      )}
      {!fleet.standalone && !fleet.controlStoreFenced && !fleet.superseded && (
        <div className="usage-stat-sub">
          <FleetDemoteButton api={api} />
        </div>
      )}

      {!fleet.standalone && <FleetConfigCard api={api} fleet={fleet} />}
      <FleetWitnessCard fleet={fleet} />

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

      {fleet.overCapacity && (
        <div className="usage-notice">
          {`Over capacity: this master holds ${fleet.overCapacity.shardIds.length} shard${fleet.overCapacity.shardIds.length === 1 ? '' : 's'} [${fleet.overCapacity.shardIds.join(', ')}]${fleet.overCapacity.pinned != null ? ` (plus pinned shard ${fleet.overCapacity.pinned}, which stays here)` : ''} against its declared capacity of ${fleet.overCapacity.capacity}${fleet.overCapacity.alone ? ' as the only node able to hold shards' : ''}. ${fleet.overCapacity.alone ? 'Start another instance, then move shards to it with Move on their rows' : 'Move shards to another instance with Move on their rows'}${reshardHint(fleet)}.`}
        </div>
      )}

      {fleet.unassigned && fleet.unassigned.length > 0 && (
        <div className="usage-notice">
          <div>Unassigned shards: no instance serves their guilds.</div>
          {fleet.unassigned.map((u) => (
            <div key={u.shardIds.join(',')} style={{ marginTop: '4px', color: '#fee75c' }}>
              {`Shard${u.shardIds.length === 1 ? '' : 's'} [${u.shardIds.join(', ')}]: ${u.reason}.`}
            </div>
          ))}
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
          dataBackend={fleet.dataBackend}
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

      {fleet.dataBoot && fleet.dataBoot.state === 'refused' && (
        <div className="usage-notice" style={{ borderColor: '#e5534b', color: '#e5534b' }}>
          <div>The data backend refused to serve requests.</div>
          <div style={{ marginTop: '4px' }}>{fleet.dataBoot.refusalReason || 'No reason was reported.'}</div>
        </div>
      )}

      {fleet.dataBoot && fleet.dataBoot.banner && (
        <FleetTransformBanner dataBoot={fleet.dataBoot} transformation={fleet.transformation} api={api} onChanged={loadFleet} />
      )}

      <FleetCapacityCard cap={capacitySummary} />

      {fleet.budget ? <FleetBudgetCard budget={fleet.budget} /> : null}

      {fleet.role === 'master' && fleet.connect ? <FleetConnectCard connect={fleet.connect} /> : null}

      {fleet.pinViolation ? <FleetPinViolationBanner pin={fleet.pinViolation} dataBackend={fleet.dataBackend} onStarted={loadFleet} /> : null}

      {fleet.migration ? <FleetMigrationCard migration={fleet.migration} onChanged={loadFleet} /> : null}

      {fleet.transformation ? <FleetTransformationCard transformation={fleet.transformation} api={api} onChanged={loadFleet} /> : null}

      <div className="usage-stat-grid" style={{ marginTop: '14px' }}>
        {nodes.map((node) => (
          <FleetNodeCard
            key={node.nodeId}
            node={node}
            isMasterView={isMaster}
            onAction={loadFleet}
            masterSyncRevision={fleet.sync != null ? fleet.sync.revision : null}
            dataBackend={fleet.dataBackend}
            retireControl={isMaster && !node.isSelf && (node.shardIds || []).length > 0 ? (
              <FleetRetireControl node={node} nodes={nodes} shardTable={shardTable} dataBackend={fleet.dataBackend} onStarted={loadFleet} />
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
                          dataBackend={fleet.dataBackend}
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

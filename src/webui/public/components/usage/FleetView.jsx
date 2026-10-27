// Shard section of the Usage tab: this node, its shards and the guild ->
// shard map. Initial fetch from /api/fleet/state, then live bot:fleet:status
// pushes. Bare global functions (no import/export), dependency-free like
// UsageCharts.jsx.

// Guilds-per-shard scale limits. Recommended max is where a reshard is due;
// hard max is Discord's absolute ceiling.
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

// Total guilds, shard count + source, and busiest-shard utilization against
// the guild-per-shard limits.
function FleetCapacityCard({ cap }) {
  const barColor = cap.busiest > FLEET_RECOMMENDED_MAX
    ? '#ed4245'
    : cap.busiest >= 1000
      ? '#fee75c'
      : '#57f287';
  const barPct = Math.max(0, Math.min(100, (cap.busiest / FLEET_HARD_MAX) * 100));

  const readAt = cap.recommendedAt != null ? `, read ${new Date(cap.recommendedAt).toLocaleString()}` : '';
  let shardsLabel;
  if (cap.shardSource === 'override') shardsLabel = `${cap.shardCount} (FLEET_SHARD_COUNT override)`;
  else if (cap.shardSource === 'discord') shardsLabel = `${cap.shardCount} (Discord's recommendation at boot)`;
  else if (cap.shardSource === 'fallback') shardsLabel = `${cap.shardCount} (fallback: Discord's recommendation could not be read at boot)`;
  else shardsLabel = String(cap.shardCount);

  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Capacity</div>
      <div className="usage-stat-sub" style={{ marginBottom: '10px' }}>
        {`${cap.totalGuilds} guild${cap.totalGuilds === 1 ? '' : 's'}`}
        {` · Shards: ${shardsLabel}`}
        {cap.recommendedShards != null && cap.recommendedShards !== cap.shardCount
          ? ` (Discord recommends ${cap.recommendedShards}${readAt})`
          : ''}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#bbb', marginBottom: '4px' }}>
        <span>{`${cap.busiest} guilds/shard (busiest shard)`}</span>
        <span style={{ color: '#777' }}>{`recommended max ${FLEET_RECOMMENDED_MAX} · hard max ${FLEET_HARD_MAX}`}</span>
      </div>
      <div style={{ height: '8px', background: '#1e1e1e', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${barPct}%`, height: '100%', background: barColor, transition: 'width 0.3s ease' }} />
      </div>
      {cap.busiest > FLEET_APPROACHING ? (
        <div className="usage-stat-sub" style={{ marginTop: '8px', color: '#fee75c' }}>
          Approaching per-shard capacity: plan to add shards.
        </div>
      ) : null}
    </div>
  );
}

// Identify-budget gauge from /gateway/bot session_start_limit: remaining vs
// total, reset countdown, and a stale warning when the last fetch failed.
function FleetBudgetCard({ budget }) {
  if (budget.unavailable) {
    return (
      <div className="usage-stat-card" style={{ marginTop: '10px' }}>
        <div className="usage-stat-title">Identify budget</div>
        <div className="usage-stat-sub" style={{ marginTop: '4px', color: '#fee75c' }}>
          Identify budget unknown: /gateway/bot has not answered since boot.
        </div>
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
          {`Budget data is stale: the last /gateway/bot fetch failed (${fleetFormatAge(budget.fetchedAgoMs)}); values may be outdated.`}
        </div>
      ) : null}
    </div>
  );
}

const DATA_BOOT_TEXT = {
  file: 'serving from files',
  starting: 'starting',
  serving: 'serving',
  refused: 'refused',
};

function FleetDataCard({ dataBackend, dataBoot }) {
  const state = dataBoot ? dataBoot.state : null;
  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">Data backend</div>
      <div className="usage-stat-sub" style={state === 'refused' ? { color: '#ed4245' } : undefined}>
        {`${dataBackend === 'postgres' ? 'PostgreSQL' : 'File'} · ${state ? DATA_BOOT_TEXT[state] || state : 'unknown'}`}
      </div>
      {state === 'refused' ? (
        <div className="usage-stat-sub" style={{ marginTop: '6px', color: '#ed4245' }}>
          {dataBoot.refusalReason || 'No reason was reported.'}
        </div>
      ) : null}
    </div>
  );
}

function FleetView({ api, wsClient, guildNames }) {
  const [fleet, setFleet] = React.useState(null);
  // No WS pushes arrive while the shard layer is mid-init, so poll until initialized.
  const fleetInitializedRef = React.useRef(false);

  const applyFleet = React.useCallback((obj) => {
    fleetInitializedRef.current = obj != null && obj.initialized === true;
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
      applyFleet(Object.assign({ success: true, running: true }, state));
    });
    const unsubscribeStatus = wsClient.on('bot:status', () => loadFleet());
    const initPoll = setInterval(() => {
      if (!fleetInitializedRef.current) loadFleet();
    }, 5000);
    return () => {
      unsubscribe();
      unsubscribeStatus();
      clearInterval(initPoll);
    };
  }, [loadFleet, applyFleet]);

  if (!fleet) {
    return (
      <div className="usage-board">
        <h3>Shards</h3>
        <div className="usage-empty">Loading shard state...</div>
      </div>
    );
  }

  if (!fleet.running || !fleet.initialized) {
    return (
      <div className="usage-board">
        <h3>Shards</h3>
        {fleet.dataBoot && fleet.dataBoot.state === 'refused' ? (
          <FleetDataCard dataBackend={fleet.dataBackend} dataBoot={fleet.dataBoot} />
        ) : null}
        <div className="usage-empty">
          {!fleet.running
            ? 'Shard state becomes available once the bot process is running.'
            : fleet.reachable === false ? (fleet.error || 'Shard state unavailable: no reason given')
            : 'Shards are starting...'}
        </div>
      </div>
    );
  }

  const shardTable = fleet.shardTable || [];
  const guildMap = fleet.guildMap || {};

  const guildEntries = Object.entries(guildMap).map(([guildId, shardId]) => ({
    guildId,
    shardId,
    name: (guildNames && guildNames[guildId]) || guildId,
  }));
  guildEntries.sort((a, b) => a.shardId - b.shardId || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));

  const shardCount = fleet.shardCount != null ? fleet.shardCount : shardTable.length;

  let totalGuilds = 0;
  let busiest = 0;
  for (const s of shardTable) {
    const c = s.guildCount || 0;
    totalGuilds += c;
    if (c > busiest) busiest = c;
  }
  if (totalGuilds === 0) totalGuilds = Object.keys(guildMap).length;

  const capacitySummary = {
    totalGuilds,
    shardCount,
    shardSource: fleet.shardSource,
    recommendedShards: fleet.recommendedShards != null ? fleet.recommendedShards : null,
    recommendedAt: fleet.recommendedAt != null ? fleet.recommendedAt : null,
    busiest,
  };

  return (
    <div className="usage-board">
      <h3>Shards</h3>
      <div className="usage-stat-sub">
        {`node ${fleet.nodeName || '-'}`}
        {fleet.nodeId ? ` (${fleet.nodeId.slice(0, 8)})` : ''}
        {fleet.appVersion ? ` · v${fleet.appVersion}` : ''}
        {` · ${shardCount} shard${shardCount === 1 ? '' : 's'}`}
      </div>

      <FleetDataCard dataBackend={fleet.dataBackend} dataBoot={fleet.dataBoot} />

      <FleetCapacityCard cap={capacitySummary} />

      {fleet.budget ? <FleetBudgetCard budget={fleet.budget} /> : null}

      <div className="usage-stat-title" style={{ marginTop: '14px' }}>Shard table</div>
      {shardTable.length === 0 ? (
        <div className="usage-empty">No shards yet</div>
      ) : (
        <table className="usage-table usage-table-compact fleet-table">
          <colgroup>
            <col style={{ width: '20%' }} />
            <col style={{ width: '50%' }} />
            <col style={{ width: '30%' }} />
          </colgroup>
          <thead>
            <tr><th>Shard</th><th>Status</th><th>Guilds</th></tr>
          </thead>
          <tbody>
            {shardTable.map((s) => (
              <tr key={s.shardId}>
                <td>{s.shardId}</td>
                <td>{s.status}</td>
                <td>{s.guildCount || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="usage-stat-title" style={{ marginTop: '14px' }}>Guilds by shard</div>
      {guildEntries.length === 0 ? (
        <div className="usage-empty">No guilds mapped yet</div>
      ) : (
        <table className="usage-table usage-table-compact fleet-table">
          <colgroup>
            <col style={{ width: '75%' }} />
            <col style={{ width: '25%' }} />
          </colgroup>
          <thead>
            <tr><th>Guild</th><th>Shard</th></tr>
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

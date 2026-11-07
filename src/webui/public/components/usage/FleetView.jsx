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

// NB9 12's dates are the UTC day, as the log lines give them.
function fleetDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function fleetSetOn(target) {
  return `set on ${target.by}${target.at != null ? ` on ${fleetDay(target.at)}` : ''}`;
}

// A database bot follows Discord's recommendation upward while no FLEET_SHARD_COUNT is set; a JSON bot while its own
// setting is unset.
function fleetFollowsDiscord(cap) {
  if (cap.dataBackend === 'postgres') return !(cap.target && cap.target.count != null);
  return cap.shardSource !== 'override';
}

// NB9 12's P2 to P5: the open attempt, a wanted count that waits or cannot run, and the last reshard.
function fleetReshardLines(cap) {
  const lines = [];
  const r = cap.reshard;
  if (r) {
    const head = `Resharding from ${r.from} to ${r.to} shards`;
    const names = r.waitingFor || [];
    if (r.state === 'flipped') {
      lines.push(`${head}: switched; the old shards save what they hold${names.length > 0 ? ` (still held by ${names.join(', ')})` : ''}, then the new ones serve`);
    } else if (r.method === 'stop-start' || r.state === 'stopping') {
      lines.push(`${head} by stopping and starting every machine${r.reason ? ` (${r.reason})` : ''}${names.length > 0 ? `: waiting for ${names.join(', ')} to stop` : ''}`);
    } else {
      const times = [];
      if (r.startedAgoMs != null) times.push(`started ${Math.max(0, Math.round(r.startedAgoMs / 60000))} min ago`);
      if (r.untilMs != null) times.push(`called off if not done in ${Math.max(0, Math.ceil(r.untilMs / 60000))} min`);
      lines.push(`${head} beside the running ones: ${r.connected} of ${r.to} new shards connected${times.length > 0 ? `; ${times.join(', ')}` : ''}`);
    }
  }
  const w = cap.reshardWait;
  if (w && w.cannot) {
    const tail = cap.dataBackend === 'postgres'
      ? `Set FLEET_SHARD_COUNT to ${w.wanted} on one machine to reshard by stopping and starting every machine`
      : `Set FLEET_SHARD_COUNT to ${w.wanted} and restart the bot to reshard by restarting it`;
    lines.push(`Discord recommends ${w.wanted} shards (the bot runs ${cap.shardCount}), and a reshard beside the running shards cannot run: ${w.reason}. ${tail}`);
  } else if (w) {
    const source = w.source === 'setting' && cap.target ? fleetSetOn(cap.target) : "from Discord's recommendation";
    lines.push(`${w.wanted} shards wanted (${source}); resharding waits: ${w.reason}`);
  }
  const last = cap.lastReshard;
  if (last && last.state === 'done') {
    const how = last.method === 'overlap' ? ', beside the running shards' : last.method === 'stop-start' ? ', by stopping and starting' : '';
    lines.push(`Last reshard: ${last.from} to ${last.to} shards${last.endedAt != null ? ` on ${fleetDay(last.endedAt)}` : ''}${how}`);
  } else if (last && last.state === 'cancelled') {
    lines.push(`The last reshard to ${last.to} shards was called off${last.endedAt != null ? ` on ${fleetDay(last.endedAt)}` : ''}${last.reason ? `: ${last.reason}` : ''}`);
  }
  return lines;
}

// The Capacity card's summary of a fleet state.
function fleetCapacitySummary(fleet) {
  const shardTable = fleet.shardTable || [];
  const guildMap = fleet.guildMap || {};
  let totalGuilds = 0;
  let busiest = 0;
  for (const s of shardTable) {
    const c = s.guildCount || 0;
    totalGuilds += c;
    if (c > busiest) busiest = c;
  }
  if (totalGuilds === 0) totalGuilds = Object.keys(guildMap).length;
  return {
    totalGuilds,
    shardCount: fleet.shardCount != null ? fleet.shardCount : shardTable.length,
    shardSource: fleet.shardSource,
    recommendedShards: fleet.recommendedShards != null ? fleet.recommendedShards : null,
    recommendedAt: fleet.recommendedAt != null ? fleet.recommendedAt : null,
    busiest,
    dataBackend: fleet.dataBackend,
    reshard: fleet.reshard || null,
    reshardWait: fleet.reshardWait || null,
    lastReshard: fleet.lastReshard || null,
    target: fleet.target || null,
  };
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
  if (cap.dataBackend === 'postgres') {
    shardsLabel = cap.target && cap.target.count != null
      ? `${cap.shardCount} (FLEET_SHARD_COUNT ${cap.target.count}, ${fleetSetOn(cap.target)})`
      : `${cap.shardCount} (follows Discord's recommendation upward)`;
  } else if (cap.shardSource === 'override') shardsLabel = `${cap.shardCount} (FLEET_SHARD_COUNT override)`;
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
      {fleetReshardLines(cap).map((line) => (
        <div key={line} className="usage-stat-sub" style={{ marginBottom: '8px' }}>{line}</div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#bbb', marginBottom: '4px' }}>
        <span>{`${cap.busiest} guilds/shard (busiest shard)`}</span>
        <span style={{ color: '#777' }}>{`recommended max ${FLEET_RECOMMENDED_MAX} · hard max ${FLEET_HARD_MAX}`}</span>
      </div>
      <div style={{ height: '8px', background: '#1e1e1e', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${barPct}%`, height: '100%', background: barColor, transition: 'width 0.3s ease' }} />
      </div>
      {cap.busiest > FLEET_APPROACHING ? (
        <div className="usage-stat-sub" style={{ marginTop: '8px', color: '#fee75c' }}>
          {fleetFollowsDiscord(cap) && !(cap.reshardWait && cap.reshardWait.cannot)
            ? 'Approaching per-shard capacity: Discord will recommend more shards, and the bot reshards to them'
            : 'Approaching per-shard capacity: plan to add shards.'}
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

// NB5 decision 19: the main database, the held counts while the process holds guilds, and every address.
function fleetDatabaseLines(database) {
  if (!database) return [];
  const lines = [];
  if (database.state === 'main' && database.chosen) {
    lines.push(`Database: ${database.chosen}, main generation ${database.generation}${database.machine ? ` (${database.machine})` : ''}`);
  } else {
    lines.push(`Database: ${database.reason || database.state}`);
  }
  if (database.held && database.held.guilds > 0) lines.push(`${database.held.guilds} guild(s) hold changes that could not be saved`);
  if (database.held && database.held.resave > 0) lines.push(`${database.held.resave} guild(s) are not re-saved yet on the bot's main database`);
  for (const a of database.addresses || []) {
    const generation = a.generation === null || a.generation === undefined ? '' : `, generation ${a.generation}${a.machine ? ` (${a.machine})` : ''}`;
    lines.push(`${a.address}: ${a.state}${generation}${a.cause ? ` (${a.cause})` : ''}`);
  }
  return lines;
}

function FleetDataCard({ dataBackend, dataBoot, database }) {
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
      {fleetDatabaseLines(database).map((line, i) => (
        <div key={i} className="usage-stat-sub" style={{ marginTop: i === 0 ? '6px' : undefined }}>{line}</div>
      ))}
    </div>
  );
}

// NB4 decision 21: the claim rows and the machines, as this process last read them from the database.
function fleetClaimExpires(row) {
  const name = row.holderName || '-';
  switch (row.state) {
    case 'never-taken': return 'never taken';
    case 'held': return `in ${fleetFormatDuration(row.expiresInMs)}`;
    case 'reserved': return `reserved by ${name} for its restart; not served meanwhile`;
    case 'kept': return `released: kept for ${name}, or free to any machine in ${fleetFormatDuration(row.expiresInMs)}`;
    case 'expired-deferred': return `expired ${fleetFormatDuration(row.expiredAgoMs)} ago: kept for ${name}'s restart for ${fleetFormatDuration(row.deferredMs)} more, then any machine with room may take it`;
    default: return `expired ${fleetFormatDuration(row.expiredAgoMs)} ago: any machine with room may take it`;
  }
}

function fleetAboveText(node) {
  const above = node.held - node.target;
  const r = node.aboveReason;
  if (!r || above <= 0) return '';
  if (r.kind === 'no-web-ui') return ` (${above} above target: it gives no shard away while it runs, having no web UI)`;
  if (r.kind === 'returns-off') return ` (${above} above target: moves are off on this machine, FLEET_SHARD_RETURN=false)`;
  if (r.kind === 'moving') return ` (${above} above target: moves to ${r.to} when this machine restarts for it)`;
  if (r.kind === 'waiting-healthy') return ` (${above} above target: moves to ${r.name} once ${r.name} has been healthy for 5 minutes, in ${fleetFormatDuration(r.leftMs)})`;
  return ` (${above} above target: no other machine has room)`;
}

function fleetRenewalError(e) {
  if (!e) return '';
  if (e.kind === 'refused') return 'the database refused the login';
  if (e.kind === 'timeout') return 'the renewal timed out';
  if (e.kind === 'unreachable') return 'the database did not answer';
  return `the database refused the renewal: SQLSTATE ${e.code} ${e.message}`;
}

function fleetReadError(e) {
  if (!e) return '';
  if (e.kind === 'refused') return 'the database refused the login';
  if (e.kind === 'timeout') return 'the claims read timed out';
  if (e.kind === 'unreachable') return 'the database did not answer';
  return `the database refused the claims read: SQLSTATE ${e.code} ${e.message}`;
}

function fleetClaimsAge(fleet) {
  if (!fleet.renewalError && !fleet.claimsReadError && !fleet.claimsStale) return '';
  const age = fleet.claimsReadAgoMs == null ? 'Claims not read yet' : `Claims as last read ${fleetFormatDuration(fleet.claimsReadAgoMs)} ago`;
  const cause = fleet.renewalError ? fleetRenewalError(fleet.renewalError) : fleetReadError(fleet.claimsReadError);
  return cause ? `${age}; ${cause}` : age;
}

function fleetPendingRestart(fleet) {
  if (!fleet.pendingRestart) return '';
  return `Restarting to ${fleet.pendingRestart}${fleet.restartWaiting ? ` (waiting: ${fleet.restartWaiting})` : ''}`;
}

function FleetClaimsCard({ fleet }) {
  if (fleet.dataBackend !== 'postgres') {
    return <div className="usage-stat-sub" style={{ marginTop: '14px' }}>This bot keeps its data in files: one process runs every shard and takes no claims.</div>;
  }
  const claims = fleet.claims || [];
  const nodes = fleet.nodes || [];
  return (
    <div>
      {fleetClaimsAge(fleet) ? <div className="usage-stat-sub">{fleetClaimsAge(fleet)}</div> : null}
      {(fleet.stillConnected || []).map((s) => (
        <div key={`still-${s}`} className="usage-stat-sub">{`Shard ${s} may still be connected to Discord`}</div>
      ))}
      {fleet.pendingRestart ? <div className="usage-stat-sub">{fleetPendingRestart(fleet)}</div> : null}

      <div className="usage-stat-title" style={{ marginTop: '14px' }}>Claims</div>
      {claims.length === 0 ? (
        <div className="usage-empty">No claims read yet</div>
      ) : (
        <table className="usage-table usage-table-compact fleet-table">
          <thead>
            <tr><th>Shard</th><th>Machine</th><th>Claim</th><th>Expires</th><th>Home</th></tr>
          </thead>
          <tbody>
            {claims.map((c) => (
              <tr key={c.shardId}>
                <td>{c.shardId}</td>
                <td>{c.holderName ? `${c.holderName}${c.mine ? ' (this process)' : ''}` : '-'}</td>
                <td>{c.claim != null ? c.claim : '-'}</td>
                <td>{fleetClaimExpires(c)}</td>
                <td>{c.homeName || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="usage-stat-title" style={{ marginTop: '14px' }}>Machines</div>
      {nodes.length === 0 ? (
        <div className="usage-empty">No machine has written its row yet</div>
      ) : (
        <table className="usage-table usage-table-compact fleet-table">
          <thead>
            <tr><th>Machine</th><th>Shards</th><th>Healthy for</th><th>Last seen</th></tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const gone = n.seenAgoMs >= n.takeoverSeconds * 1000;
              return (
                <tr key={n.nodeId}>
                  <td>{n.name}</td>
                  <td>{`${n.held} of target ${n.target}${fleetAboveText(n)}${n.restartable ? '' : '; takes shards only when it starts: no web UI'}`}</td>
                  <td>{n.healthyForMs == null ? 'not healthy now' : fleetFormatDuration(n.healthyForMs)}</td>
                  <td>{gone ? `gone: not seen for ${fleetFormatDuration(n.seenAgoMs)}` : fleetFormatAge(n.seenAgoMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
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
          <FleetDataCard dataBackend={fleet.dataBackend} dataBoot={fleet.dataBoot} database={fleet.database} />
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

  const capacitySummary = fleetCapacitySummary(fleet);
  const shardCount = capacitySummary.shardCount;

  return (
    <div className="usage-board">
      <h3>Shards</h3>
      <div className="usage-stat-sub">
        {`node ${fleet.nodeName || '-'}`}
        {fleet.nodeId ? ` (${fleet.nodeId.slice(0, 8)})` : ''}
        {fleet.appVersion ? ` · v${fleet.appVersion}` : ''}
        {` · ${shardCount} shard${shardCount === 1 ? '' : 's'}`}
      </div>

      <FleetDataCard dataBackend={fleet.dataBackend} dataBoot={fleet.dataBoot} database={fleet.database} />

      <FleetCapacityCard cap={capacitySummary} />

      {fleet.budget ? <FleetBudgetCard budget={fleet.budget} /> : null}

      <FleetClaimsCard fleet={fleet} />

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

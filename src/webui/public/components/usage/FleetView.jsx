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
          ? ' Replace <host> with this master\'s reachable address (LAN IP, or host.docker.internal for a same-box container).'
          : ''}
      </div>
    </div>
  );
}

function FleetNodeCard({ node }) {
  const healthColor = FLEET_HEALTH_COLORS[node.health] || '#888';
  const held = (node.shardIds && node.shardIds.length) || 0;
  const capacity = node.capacity != null ? node.capacity : null;
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
      <div className="usage-stat-sub">
        {node.load
          ? `cpu ${node.load.cpuPct}% · rss ${node.load.rssMb} MB · loop ${node.load.loopLagMs} ms`
          : 'no load sample yet'}
      </div>
      <div className="usage-stat-sub">heartbeat {fleetFormatAge(node.lastHeartbeatAgoMs)}</div>
    </div>
  );
}

function FleetView({ api, wsClient, guildNames }) {
  const [fleet, setFleet] = React.useState(null);

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
    return () => {
      unsubscribe();
      unsubscribeStatus();
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
    return (
      <div className="usage-board">
        <h3>Fleet</h3>
        <div className="usage-stat-sub">
          {`role co-worker · term ${fleet.term} · epoch ${fleet.epoch} · ${fleet.shardCount} shard${fleet.shardCount === 1 ? '' : 's'} in the fleet`}
        </div>

        {!fleet.masterKnown && (
          <div className="usage-notice">Master unreachable, retrying...</div>
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

  // Assign picker targets: connected nodes, on-hold ones first (they are idle).
  const isMaster = fleet.role === 'master';
  const assignableNodes = nodes
    .filter((n) => n.connected !== false)
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

      {fleet.role === 'co-worker' && !fleet.masterKnown && (
        <div className="usage-notice">Master unreachable, retrying...</div>
      )}

      {fleet.role === 'co-worker' && fleet.masterKnown && fleet.onHold && (
        <div className="usage-notice">
          On hold: connected to the master, waiting for a shard to be assigned. Not serving any guilds yet.
        </div>
      )}

      <FleetCapacityCard cap={capacitySummary} />

      {fleet.role === 'master' && fleet.connect ? <FleetConnectCard connect={fleet.connect} /> : null}

      <div className="usage-stat-grid" style={{ marginTop: '14px' }}>
        {nodes.map((node) => <FleetNodeCard key={node.nodeId} node={node} />)}
      </div>

      <div className="usage-stat-title">Shard table</div>
      {shardTable.length === 0 ? (
        <div className="usage-empty">No shards yet</div>
      ) : (
        <table className="usage-table usage-table-compact">
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
              const statusColor = isFree ? '#777' : isPending ? '#fee75c' : undefined;
              return (
                <tr key={s.shardId}>
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
                      ) : (
                        <span style={{ color: '#777', fontSize: '0.78rem' }}>held (migration to move)</span>
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
        <table className="usage-table usage-table-compact">
          <thead>
            <tr><th>Guild</th><th>Shard</th><th>Node</th></tr>
          </thead>
          <tbody>
            {guildEntries.map((g) => (
              <tr key={g.guildId}>
                <td>{g.name}</td>
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

// Fleet section of the Usage tab: node cards, shard table, guild -> shard
// map. Initial fetch from /api/fleet/state, then live bot:fleet:status
// pushes. Bare global functions (no import/export), dependency-free like
// UsageCharts.jsx.

const FLEET_HEALTH_COLORS = { up: '#57f287', late: '#fee75c', down: '#ed4245' };

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

// Master-only worker-onboarding card. Renders a copy-paste env block an
// operator drops into a new bot instance's Fleet config to add it as a worker.
function FleetConnectCard({ connect }) {
  const [copied, setCopied] = React.useState(false);

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

  const secretLine = connect.secret != null
    ? `CONTROL_SECRET=${connect.secret}`
    : 'CONTROL_SECRET=<generate one on this master>';
  const block = [
    'BOT_NODE_ROLE=co-worker',
    `MASTER_URL=${connect.masterUrl}`,
    secretLine,
  ].join('\n');

  const copyBlock = () => {
    navigator.clipboard.writeText(block);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="usage-stat-card" style={{ marginTop: '10px' }}>
      <div className="usage-stat-title">
        Connect a worker
        <button onClick={copyBlock} style={{ marginLeft: '10px', fontSize: '0.72rem', padding: '2px 8px' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        style={{
          margin: '6px 0',
          padding: '8px 10px',
          background: '#1e1e1e',
          borderRadius: '6px',
          fontSize: '0.78rem',
          userSelect: 'all',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >{block}</pre>
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
      </div>
      <div className="usage-stat-value">{node.guildCount} guilds</div>
      <div className="usage-stat-sub">
        {node.shardIds.length > 0 ? `shards [${node.shardIds.join(', ')}]` : 'no shards leased'}
      </div>
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

  const nodesById = {};
  for (const node of fleet.nodes) nodesById[node.nodeId] = node;
  const nodeNameOf = (nodeId) => (nodesById[nodeId] && nodesById[nodeId].nodeName) || nodeId;
  const shardToNode = {};
  for (const entry of fleet.shardTable) shardToNode[entry.shardId] = entry.nodeId;

  const guildEntries = Object.entries(fleet.guildMap || {}).map(([guildId, shardId]) => ({
    guildId,
    shardId,
    name: (guildNames && guildNames[guildId]) || guildId,
  }));
  guildEntries.sort((a, b) => a.shardId - b.shardId || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));

  return (
    <div className="usage-board">
      <h3>Fleet</h3>
      <div className="usage-stat-sub">
        {fleet.standalone ? 'standalone (single node)' : `role ${fleet.role}`}
        {` · term ${fleet.term} · epoch ${fleet.epoch} · ${fleet.shardCount} shard${fleet.shardCount === 1 ? '' : 's'}`}
        {fleet.pinTestGuildShard && fleet.pinnedShardId != null ? ` · shard ${fleet.pinnedShardId} pinned to master` : ''}
      </div>

      {fleet.role === 'co-worker' && !fleet.masterKnown && (
        <div className="usage-notice">Master unreachable, retrying...</div>
      )}

      {fleet.role === 'master' && fleet.connect ? <FleetConnectCard connect={fleet.connect} /> : null}

      <div className="usage-stat-grid">
        {fleet.nodes.map((node) => <FleetNodeCard key={node.nodeId} node={node} />)}
      </div>

      <div className="usage-stat-title">Shard table</div>
      {fleet.shardTable.length === 0 ? (
        <div className="usage-empty">No shard leases yet</div>
      ) : (
        <table className="usage-table usage-table-compact">
          <thead>
            <tr><th>Shard</th><th>Node</th><th>Status</th><th>Term</th><th>Epoch</th></tr>
          </thead>
          <tbody>
            {fleet.shardTable.map((s) => (
              <tr key={s.shardId}>
                <td>
                  {s.shardId}
                  {fleet.pinnedShardId === s.shardId ? <FleetBadge text="pinned" background="#4a3a1a" color="#fee75c" /> : null}
                </td>
                <td>{nodeNameOf(s.nodeId)}</td>
                <td>{s.status}</td>
                <td>{s.term}</td>
                <td>{s.epoch}</td>
              </tr>
            ))}
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

// Usage tab - the bot "task manager". Honesty rules baked into the UI:
// per-guild DISK is exact, per-guild CPU is attributed-approximate
// ("~ share of bot work"), per-guild RAM is a cache estimate, process totals
// are real. Bare global function (no import/export).

const USAGE_SERIES_CAP = 720;

function usageFormatUptime(sec) {
  if (!sec || sec <= 0) return '0s';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function usageFormatMb(mb) {
  if (mb == null) return '-';
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB`;
  return `${Math.round(mb * 1024)} KB`;
}

function UsageStatCard({ title, value, sub, series, stroke }) {
  return (
    <div className="usage-stat-card">
      <div className="usage-stat-title">{title}</div>
      <div className="usage-stat-value">{value}</div>
      {sub ? <div className="usage-stat-sub">{sub}</div> : null}
      <Sparkline data={series} width={150} height={30} stroke={stroke} />
    </div>
  );
}

function UsageLeaderboardTable({ title, columns, rows, sortKey, sortDir, onSort, renderRow, emptyText }) {
  return (
    <div className="usage-board">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <div className="usage-empty">{emptyText}</div>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={col.sortable ? 'usage-sortable' : ''}
                  onClick={col.sortable ? () => onSort(col.key) : undefined}
                >
                  {col.label}
                  {sortKey === col.key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{rows.map(renderRow)}</tbody>
        </table>
      )}
    </div>
  );
}

function GuildUsageDetail({ api, guildId }) {
  const [detail, setDetail] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api.get(`/usage/guild/${encodeURIComponent(guildId)}`)
      .then((res) => { if (!cancelled) res.success ? setDetail(res) : setError(res.error || 'Failed to load'); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [guildId]);

  if (error) return <div className="usage-guild-detail usage-empty">Error: {error}</div>;
  if (!detail) return <div className="usage-guild-detail usage-empty">Loading guild usage...</div>;

  const maxDiskMb = Math.max(1, ...detail.disk.byModule.map((d) => d.mb));
  return (
    <div className="usage-guild-detail">
      <div className="usage-guild-detail-cols">
        <div>
          <h4>Disk by module (exact) - {usageFormatMb(detail.disk.totalMb)}</h4>
          {detail.disk.byModule.length === 0 ? (
            <div className="usage-empty">No data on disk yet</div>
          ) : (
            detail.disk.byModule.map((d) => (
              <div key={d.module} className="usage-bar-row">
                <span className="usage-bar-label">{d.module}</span>
                <div className="usage-bar-track">
                  <div className="usage-bar-fill" style={{ width: `${Math.max(2, (d.mb / maxDiskMb) * 100)}%` }} />
                </div>
                <span className="usage-bar-value">{usageFormatMb(d.mb)}</span>
              </div>
            ))
          )}
          <div className="usage-stat-sub">RAM cache estimate: {usageFormatMb(detail.ramEstimateMb)}</div>
        </div>
        <div>
          <h4>Modules</h4>
          {detail.leaderboard.modules.length === 0 ? (
            <div className="usage-empty">No recorded activity yet</div>
          ) : (
            <table className="usage-table usage-table-compact">
              <thead>
                <tr><th>Module</th><th>Calls</th><th>Errors</th><th>Avg ms</th><th>CPU ms</th></tr>
              </thead>
              <tbody>
                {detail.leaderboard.modules.map((m) => (
                  <tr key={m.module}>
                    <td>{m.module}</td>
                    <td>{m.calls}</td>
                    <td>{m.errors}</td>
                    <td>{m.avgMs}</td>
                    <td>{m.cpuMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {detail.leaderboard.commands.length > 0 && (
            <div>
              <h4>Commands</h4>
              <table className="usage-table usage-table-compact">
                <thead>
                  <tr><th>Command</th><th>Module</th><th>Calls</th><th>Errors</th><th>Avg ms</th></tr>
                </thead>
                <tbody>
                  {detail.leaderboard.commands.map((c) => (
                    <tr key={`${c.module}:${c.command}`}>
                      <td>/{c.command}</td>
                      <td>{c.module}</td>
                      <td>{c.calls}</td>
                      <td>{c.errors}</td>
                      <td>{c.avgMs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UsagePanel({ api, wsClient }) {
  const [data, setData] = React.useState(null);
  const [guildRows, setGuildRows] = React.useState([]);
  const [firstLoad, setFirstLoad] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [series, setSeries] = React.useState({ cpu: [], mem: [], loop: [] });
  const [live, setLive] = React.useState(null);
  const [moduleSort, setModuleSort] = React.useState({ key: 'calls', dir: 'desc' });
  const [commandSort, setCommandSort] = React.useState({ key: 'calls', dir: 'desc' });
  const [expandedGuild, setExpandedGuild] = React.useState(null);
  const metricsEnabledRef = React.useRef(true);

  const loadData = React.useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [globalRes, guildsRes] = await Promise.all([
        api.get('/usage/global'),
        api.get('/usage/guilds'),
      ]);
      if (globalRes.success) {
        setData(globalRes);
        setSeries(globalRes.series);
        metricsEnabledRef.current = globalRes.metricsEnabled === true;
      }
      if (guildsRes.success) {
        setGuildRows(guildsRes.guilds || []);
      }
    } catch (err) {
      console.error('[Usage] Failed to load usage data:', err);
      showToast(`Failed to load usage data: ${err.message}`, 'error');
    } finally {
      setFirstLoad(false);
      setRefreshing(false);
    }
  }, [api]);

  React.useEffect(() => {
    loadData(false);
    // Live push: append each 5s sample to the local series (LogsPanel pattern).
    // When the sample's enabled flag contradicts what the tab shows, reload so
    // the metrics.enabled toggle applies without a manual refresh
    const unsubscribe = wsClient.on('bot:metrics:snapshot', (sample) => {
      if (sample.metricsEnabled === false) {
        setLive(null);
        if (metricsEnabledRef.current) loadData(false);
        return;
      }
      if (!metricsEnabledRef.current) loadData(false);
      setLive(sample);
      setSeries((prev) => ({
        cpu: [...prev.cpu, { t: sample.t, v: sample.cpuPct }].slice(-USAGE_SERIES_CAP),
        mem: [...prev.mem, { t: sample.t, v: sample.memRssMb }].slice(-USAGE_SERIES_CAP),
        loop: [...prev.loop, { t: sample.t, v: sample.loopLagMs }].slice(-USAGE_SERIES_CAP),
      }));
    });
    const unsubscribeStatus = wsClient.on('bot:status', () => loadData(false));
    return () => {
      unsubscribe();
      unsubscribeStatus();
    };
  }, [loadData]);

  const toggleSort = (setter) => (key) => {
    setter((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  };

  const sortRows = (rows, { key, dir }) => {
    const sorted = [...rows].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0));
    return dir === 'desc' ? sorted.reverse() : sorted;
  };

  if (firstLoad) {
    return <FirstLoadPlaceholder label="Loading usage data..." />;
  }

  if (!data || !data.running) {
    return (
      <div className="usage-panel">
        <div className="usage-offline">
          <h3>Bot is offline</h3>
          <p>Usage data becomes available once the bot process is running.</p>
        </div>
      </div>
    );
  }

  const sys = {
    cpuPct: live ? live.cpuPct : data.system.cpuPct,
    memRssMb: live ? live.memRssMb : data.system.memRssMb,
    heapMb: live ? live.heapMb : data.system.heapMb,
    loopLagMs: live ? live.loopLagMs : data.system.loopLagMs,
    diskTotalMb: live ? live.diskTotalMb : data.system.diskTotalMb,
  };

  const moduleColumns = [
    { key: 'module', label: 'Module', sortable: false },
    { key: 'calls', label: 'Calls', sortable: true },
    { key: 'errors', label: 'Errors', sortable: true },
    { key: 'avgMs', label: 'Avg ms', sortable: true },
    { key: 'cpuShare', label: 'CPU ~share of bot work', sortable: true },
  ];
  const commandColumns = [
    { key: 'command', label: 'Command', sortable: false },
    { key: 'module', label: 'Module', sortable: false },
    { key: 'calls', label: 'Calls', sortable: true },
    { key: 'errors', label: 'Errors', sortable: true },
    { key: 'avgMs', label: 'Avg ms', sortable: true },
  ];

  return (
    <div className="usage-panel">
      <div className="usage-header">
        <h2>Usage</h2>
        <span className="usage-live-indicator">
          {live ? `live - last sample ${new Date(live.t).toLocaleTimeString()}` : 'waiting for live samples...'}
        </span>
        <button onClick={() => loadData(true)} disabled={refreshing} style={disabledButtonStyle(refreshing)}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {!data.metricsEnabled && (
        <div className="usage-notice">Metrics are disabled (metrics.enabled = false in config.json). Showing empty data.</div>
      )}

      <RefetchOverlay loading={refreshing}>
        <div className="usage-stat-grid">
          <UsageStatCard
            title="CPU (bot process)"
            value={`${sys.cpuPct}%`}
            sub="% of one core, averaged over each 5s window"
            series={series.cpu}
            stroke="#5865f2"
          />
          <UsageStatCard
            title="RAM (process RSS)"
            value={usageFormatMb(sys.memRssMb)}
            sub={`heap ${usageFormatMb(sys.heapMb)}`}
            series={series.mem}
            stroke="#57f287"
          />
          <UsageStatCard
            title="Event-loop lag (p95)"
            value={`${sys.loopLagMs} ms`}
            series={series.loop}
            stroke="#fee75c"
          />
          <UsageStatCard
            title="Disk (bot data)"
            value={usageFormatMb(sys.diskTotalMb)}
            sub="exact"
            series={[]}
            stroke="#eb459e"
          />
          <UsageStatCard
            title="Uptime"
            value={usageFormatUptime(data.system.uptime)}
            sub={`${data.totals.calls} calls, ${data.totals.errors} errors total`}
            series={[]}
            stroke="#eb459e"
          />
        </div>

        <div className="usage-charts">
          <AreaChart data={series.cpu} label="CPU % (bot process, ~1h)" formatValue={(v) => `${Math.round(v * 10) / 10}%`} />
          <AreaChart
            data={series.mem}
            label="RAM MB (process RSS, ~1h)"
            stroke="#57f287"
            fill="rgba(87,242,135,0.2)"
            formatValue={(v) => usageFormatMb(v)}
          />
        </div>

        <div className="usage-boards">
          <UsageLeaderboardTable
            title="Modules"
            columns={moduleColumns}
            rows={sortRows(data.leaderboard.modules, moduleSort)}
            sortKey={moduleSort.key}
            sortDir={moduleSort.dir}
            onSort={toggleSort(setModuleSort)}
            emptyText="No module activity recorded yet"
            renderRow={(m) => (
              <tr key={m.module}>
                <td>
                  {m.module}
                  {m.heavyLoad ? <span className="usage-badge-heavy" title="Declared heavyLoad in its manifest">heavy</span> : null}
                </td>
                <td>{m.calls}</td>
                <td>{m.errors}</td>
                <td>{m.avgMs}</td>
                <td title="~ share of bot work (approx)">{m.cpuShare}%</td>
              </tr>
            )}
          />
          <UsageLeaderboardTable
            title="Commands"
            columns={commandColumns}
            rows={sortRows(data.leaderboard.commands, commandSort)}
            sortKey={commandSort.key}
            sortDir={commandSort.dir}
            onSort={toggleSort(setCommandSort)}
            emptyText="No commands recorded yet"
            renderRow={(c) => (
              <tr key={`${c.module}:${c.command}`}>
                <td>/{c.command}</td>
                <td>{c.module}</td>
                <td>{c.calls}</td>
                <td>{c.errors}</td>
                <td>{c.avgMs}</td>
              </tr>
            )}
          />
        </div>

        <div className="usage-board">
          <h3>Guilds</h3>
          <div className="usage-honesty">
            Disk is exact. CPU is <em>~ share of bot work (approx)</em>. RAM is a <em>cache estimate</em>.
          </div>
          {guildRows.length === 0 ? (
            <div className="usage-empty">No guild data yet</div>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Guild</th>
                  <th>Calls</th>
                  <th>CPU ~ share</th>
                  <th>RAM (cache estimate)</th>
                  <th>Disk (exact)</th>
                  <th>Top module</th>
                </tr>
              </thead>
              <tbody>
                {guildRows.map((g) => (
                  <React.Fragment key={g.guildId}>
                    <tr
                      className="usage-guild-row"
                      onClick={() => setExpandedGuild(expandedGuild === g.guildId ? null : g.guildId)}
                    >
                      <td>{expandedGuild === g.guildId ? '▾ ' : '▸ '}{g.name}</td>
                      <td>{g.calls}</td>
                      <td>{g.cpuShare}%</td>
                      <td>{usageFormatMb(g.ramEstimateMb)}</td>
                      <td>{usageFormatMb(g.diskMb)}</td>
                      <td>{g.topModule || '-'}</td>
                    </tr>
                    {expandedGuild === g.guildId && (
                      <tr>
                        <td colSpan={6}>
                          <GuildUsageDetail api={api} guildId={g.guildId} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <FleetView
          api={api}
          wsClient={wsClient}
          guildNames={guildRows.reduce((acc, g) => { acc[g.guildId] = g.name; return acc; }, {})}
        />
      </RefetchOverlay>
    </div>
  );
}

// The Dashboard's "Data backups" section (NB8 decisions 14 and 15): the bot's own JSON backups from GET /api/backups,
// a restore per complete backup, and the schedule's switch and hour.

function backupTimeText(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function backupSizeText(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const backupEnded = text => (/[.!?]$/.test(text) ? text : `${text}.`);

// NM2's message line of an alert, followed by its note.
function backupMessageLine(message) {
  if (!message) return null;
  let line = null;
  if (message.state === 'sent') {
    const place = message.place === 'dm' ? 'DM' : message.place === 'channel' ? 'message in the owner messages channel' : 'Discord message';
    line = `The owner was sent a ${place} at ${backupTimeText(message.at)}.`;
  } else if (message.state === 'already') {
    line = 'The bot had already posted this message, so nothing new was posted.';
  } else if (message.state === 'sending') {
    line = 'The message is being sent.';
  } else if (message.state === 'failed') {
    line = `The message could not be sent (${message.error}); it is tried again every hour.`;
  } else if (message.state === 'unknown') {
    line = `can't confirm the owner got the message: ${backupEnded(String(message.error))} It is not sent again.`;
  }
  if (line && typeof message.note === 'string' && message.note !== '') line = `${line} ${message.note}`;
  return line;
}

// The status lines of decision 15 (with 31, 44's frames, B6's running-take frame and C14), in the order shown.
function backupStatusLines(b, now) {
  if (!b.json) return ["This bot keeps its data in Postgres, so it takes no backups of its own; the Bot Manager backs up the databases it runs."];
  const lines = [];
  if (!b.enabled) lines.push('Backups are off for this bot: no backup is taken and none is deleted.');
  const m = b.migration || { kind: 'none' };
  if (m.kind === 'running') lines.push('A data migration is running; backups wait until it has finished.');
  else if (m.kind === 'unfinished') lines.push(`Data migration ${m.jobId} did not finish (it stopped at ${m.stage}); backups wait until it is run again and has finished.`);
  else if (m.kind === 'unknown') lines.push(`can't confirm whether a data migration is running or unfinished (${m.cause}); backups wait until that can be read.`);
  const newest = b.newest;
  lines.push(newest
    ? `Newest backup: ${newest.name}, taken ${backupTimeText(newest.takenAt)}, ${newest.files} files, ${backupSizeText(newest.bytes)}.`
    : 'No backup yet.');
  const a = b.lastAttempt;
  if (a && a.result === 'failed' && typeof a.error === 'string') lines.push(`Last attempt failed at ${backupTimeText(a.at)}: ${backupEnded(a.error)}`);
  else if (a && a.result === 'unknown' && typeof a.error === 'string') lines.push(`Last attempt at ${backupTimeText(a.at)}: ${backupEnded(a.error)}`);
  const r = b.lastRefusal;
  const hourStart = Math.floor(now / 3600000) * 3600000;
  const backupThisHour = newest && newest.takenAt >= hourStart;
  const attemptThisHour = a && a.at >= hourStart;
  const later = (newest && newest.takenAt > (r ? r.at : 0)) || (a && a.at > (r ? r.at : 0));
  if (r && !backupThisHour && !attemptThisHour && !later) {
    lines.push(typeof r.startedAt === 'number'
      ? `The backup started at ${backupTimeText(r.startedAt)} was not kept: ${backupEnded(r.words)}`
      : `No backup could be started at ${backupTimeText(r.at)}: ${backupEnded(r.words)}`);
  }
  const last = b.test && b.test.last;
  if (!last) lines.push('No test restore yet: the first runs after the first daily backup.');
  else if (last.result === 'passed') lines.push(`Last test restore: passed at ${backupTimeText(last.at)} (${last.name}).`);
  else if (typeof last.detail === 'string' && last.detail !== '') lines.push(`Last test restore: failed at ${backupTimeText(last.at)} (${last.name}): ${backupEnded(last.detail)}`);
  else lines.push(`Last test restore: failed at ${backupTimeText(last.at)} (${last.name}).`);
  for (const key of ['snapshot-failed', 'test-failed']) {
    const alert = b.alerts && b.alerts[key];
    if (!alert || typeof alert.text !== 'string') continue;
    lines.push(alert.text);
    const message = backupMessageLine(alert.message);
    if (message) lines.push(message);
  }
  return lines;
}

function backupConfirmText(s) {
  return `Restore ${s.name}, taken ${backupTimeText(s.takenAt)}? Every server's data, the deleted servers' data, the data of no server (the premium data included), config.json and the owner messages channel setting go back to that time; the App Store's state and this machine's identity stay as they are. The data there now is kept as a backup named pre-restore-<time>, which you can restore to undo this. A bot in maintenance is stopped for the restore and started again in maintenance; a stopped bot stays stopped.`;
}

// The alert the header badge shows, picked as getStatus().backups picks it.
function backupStandingAlert(alerts) {
  for (const key of ['snapshot-failed', 'test-failed']) {
    const alert = alerts && alerts[key];
    if (alert && typeof alert.text === 'string') return { case: key, text: alert.text };
  }
  return null;
}

function DataBackupsPanel({ api, onBackupAlert }) {
  const [backups, setBackups] = React.useState(null);
  const [readError, setReadError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const reads = React.useRef(0);

  async function read() {
    const mine = ++reads.current;
    try {
      const res = await api.get('/backups');
      if (mine !== reads.current) return;
      setBackups(res);
      setReadError(null);
      if (onBackupAlert) onBackupAlert(backupStandingAlert(res.alerts));
    } catch (err) {
      if (mine !== reads.current) return;
      setBackups(null);
      setReadError(/^The backups could not be read: /.test(err.message) ? err.message : `The backups could not be read: ${err.message}`);
    }
  }

  React.useEffect(() => {
    read();
    const timer = setInterval(read, 60000);
    return () => clearInterval(timer);
  }, []);

  async function restore(s) {
    if (!confirm(backupConfirmText(s))) return;
    setBusy(true);
    try {
      const res = await api.post('/backups/restore', { name: s.name });
      if (res.state === 'running' && typeof res.note === 'string') showToast(res.note, 'info');
    } catch (err) {
      showToast(typeof err.status === 'number' ? err.message : `can't confirm whether the restore of ${s.name} started: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
    await read();
  }

  async function saveSetting(key, value) {
    setBusy(true);
    try {
      await api.put('/backups/settings', { [key]: value, expected: { [key]: backups[key] } });
    } catch (err) {
      showToast(typeof err.status === 'number' ? err.message : `can't confirm whether the backup settings were saved: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
    await read();
  }

  if (!backups) {
    return (
      <div className="card">
        <h2>Data backups</h2>
        {readError && <p>{readError}</p>}
      </div>
    );
  }

  const r = backups.restore;
  const restoreStands = !!r && (r.running || !!r.latch || r.state !== 'clear' || (r.stage === 'placed' && !r.result));
  const lines = backupStatusLines(backups, Date.now());

  return (
    <div className="card">
      <h2>Data backups</h2>
      {lines.map((line, i) => <p key={`line-${i}`}>{line}</p>)}
      {r && r.line && <p>{r.line}</p>}
      {(backups.notes || []).map((note, i) => <p key={`note-${i}`}>{note}</p>)}
      {backups.json && (
        <>
          <div style={{ marginTop: '15px' }}>
            <label style={{ marginRight: '20px' }}>
              <input
                type="checkbox"
                checked={backups.enabled}
                disabled={busy}
                onChange={e => saveSetting('enabled', e.target.checked)}
              />
              {' Take backups'}
            </label>
            <label>
              {'Daily backup hour (UTC) '}
              <select value={backups.hour} disabled={busy} onChange={e => saveSetting('hour', Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </label>
          </div>
          {backups.snapshots.length > 0 && (
            <table style={{ marginTop: '15px', width: '100%' }}>
              <thead>
                <tr><th>Backup</th><th>Taken</th><th>Files</th><th>Size</th><th>Test</th><th></th></tr>
              </thead>
              <tbody>
                {backups.snapshots.map(s => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    {s.state === 'complete' ? (
                      <>
                        <td>{backupTimeText(s.takenAt)}</td>
                        <td>{s.files}</td>
                        <td>{backupSizeText(s.bytes)}</td>
                        <td>{s.test || ''}</td>
                        <td>
                          {!restoreStands && (
                            <button className="btn btn-warning" disabled={busy} onClick={() => restore(s)}>Restore</button>
                          )}
                        </td>
                      </>
                    ) : (
                      <td colSpan={5}>{`cannot be read (${s.cause})`}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

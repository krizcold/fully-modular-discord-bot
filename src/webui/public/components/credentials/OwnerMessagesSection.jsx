// NB5 decision 23: where the Bot Manager's messages for the owner go, a channel or the owner's DMs.
function OwnerMessagesSection() {
  const [view, setView] = React.useState(null);
  const [value, setValue] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  async function load() {
    try {
      const answer = await api.get('/setup/owner-channel');
      setView(answer);
      if (answer.readable) setValue(answer.channelId || '');
    } catch (error) {
      setView({ readable: false, reason: error.message });
    }
  }

  React.useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    try {
      const trimmed = value.trim();
      const answer = await api.put('/setup/owner-channel', { channelId: trimmed === '' ? null : trimmed });
      showToast(answer.note, 'success');
    } catch (error) {
      showToast(error.message, 'error', { sticky: true });
    } finally {
      setSaving(false);
      load();
    }
  }

  const refusal = view && view.readable && view.lastRefusal ? view.lastRefusal : null;
  return (
    <div className="credentials-section">
      <div className="credentials-form">
        <div className="form-group">
          <label>Owner messages channel</label>
          <input
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="123456789012345678"
            disabled={saving}
          />
          <small>Channel ID where the bot posts the Bot Manager's messages for you and a copy of each switch notice. Leave it empty to get them in your DMs. Switch notices always go to your DMs as well.</small>
          {view && !view.readable ? (
            <small style={{ display: 'block', color: '#ed4245', marginTop: '6px' }}>{`Can't read where owner messages go: ${view.reason}`}</small>
          ) : null}
          {refusal ? (
            <small style={{ display: 'block', color: '#ed4245', marginTop: '6px' }}>
              {`The last message to channel ${view.channelId} was refused on ${new Date(refusal.at).toLocaleString()}: ${refusal.text}`}
            </small>
          ) : null}
        </div>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving} style={disabledButtonStyle(saving)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

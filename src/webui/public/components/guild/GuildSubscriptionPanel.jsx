// Guild Subscription Panel: current-status summary + tier browser + per-tier subscribe modal.
// Uses `subData` supplied by guildApp (single fetch point). Calls `onRefresh()` after any mutation.

const { useState: useSubState } = React;

function GuildSubscriptionPanel({ guild, subData, onRefresh }) {
  const [processing, setProcessing] = useSubState(false);
  const [error, setError] = useSubState(null);
  const [subscribeModalTierId, setSubscribeModalTierId] = useSubState(null);

  if (!subData) {
    return <div style={{ padding: '40px', color: '#888', textAlign: 'center' }}>Loading…</div>;
  }

  const { subscriptions = {}, effective, tiers = {}, providers = [] } = subData;
  const manual = subscriptions.manual;
  const paid = subscriptions.paid;
  const pausedPaid = Array.isArray(subscriptions.pausedPaid) ? subscriptions.pausedPaid : [];

  // ── Helpers ──
  function getTierName(tierId) { return tiers[tierId]?.displayName || tierId; }
  function getProviderName(providerId) {
    return providers.find(p => p.id === providerId)?.displayName || providerId || '';
  }
  function formatRemaining(sub) {
    if (!sub) return '';
    if (sub.status !== 'active') return 'Expired';
    if (sub.endDate === null) return 'Lifetime';
    const remaining = Date.parse(sub.endDate) - Date.now();
    if (remaining <= 0) return 'Expired';
    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days >= 2) return `${days} days remaining`;
    if (days === 1) return `1 day ${hours}h remaining`;
    return `${hours}h remaining`;
  }
  function offeringProviderIds(o) {
    return Object.entries(o.providerLinks || {})
      .filter(([, l]) => l && l.enabled)
      .map(([pid]) => pid);
  }
  function tierIsPurchasable(t) {
    return (t.offerings || []).some(o =>
      offeringProviderIds(o).some(pid => providers.find(p => p.id === pid))
    );
  }
  /**
   * True if the guild already owns a paid sub at this tier (active OR paused).
   * The backend rejects same-priority stacking so we surface this up-front.
   */
  function tierAlreadyOwned(tierIdToCheck) {
    if (paid && paid.tierId === tierIdToCheck) return true;
    return pausedPaid.some(p => p.tierId === tierIdToCheck);
  }
  /**
   * True if buying this tier right now would be queued behind the active paid
   * sub (i.e. lower priority than whatever is currently active). The purchase
   * still goes through; it just won't be effective until every higher-priority
   * sub above it ends.
   */
  function tierWouldBePaused(t) {
    if (!paid || paid.status !== 'active') return false;
    const activePriority = tiers[paid.tierId]?.priority ?? 0;
    return (t.priority ?? 0) < activePriority;
  }
  function tierOfferings(t) { return t.offerings || []; }
  function tierCheapestMoney(t) {
    const money = tierOfferings(t)
      .filter(o => typeof o.amount === 'number' && o.currency)
      .sort((a, b) => a.amount - b.amount);
    return money[0] || null;
  }

  // ── Actions ──
  async function handleCancel() {
    if (!confirm('Cancel your paid subscription? You keep access until the current period ends and can reactivate any time before then.')) return;
    setProcessing(true); setError(null);
    try {
      const res = await guildApi.cancelPaidSubscription(guild.id);
      if (res.success) await onRefresh();
      else setError('Failed to cancel');
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  async function handleReactivate() {
    setProcessing(true); setError(null);
    try {
      const res = await guildApi.reactivatePaidSubscription(guild.id);
      if (res.success) await onRefresh();
      else setError('Failed to reactivate');
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  // ── Styles ──
  const sectionStyle = { background: '#2c2f33', borderRadius: '10px', padding: '20px', marginBottom: '18px' };
  const cardStyle = { background: '#36393f', borderRadius: '8px', padding: '14px' };

  const sortedTiers = Object.entries(tiers).sort(([, a], [, b]) => (a.priority || 0) - (b.priority || 0));

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '24px' }}>
      <h2 style={{ color: '#fff', margin: '0 0 6px 0' }}>Subscription</h2>
      <p style={{ color: '#999', margin: '0 0 22px 0', fontSize: '0.9rem' }}>
        Manage your server's premium status and subscribe to a higher tier.
      </p>

      {error && (
        <div style={{
          background: 'rgba(237, 66, 69, 0.1)', border: '1px solid #ed4245',
          color: '#ed4245', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
        }}>{error}</div>
      )}

      {/* Current status */}
      <div style={sectionStyle}>
        <div style={{ color: '#888', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
          Current Tier
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div>
            <div style={{
              color: effective && effective.tierId !== 'free' ? '#f5af19' : '#aaa',
              fontSize: '1.7rem', fontWeight: 700, lineHeight: 1.1,
            }}>
              {effective ? effective.tier.displayName : 'Free'}
            </div>
            <div style={{ color: '#888', fontSize: '0.82rem', marginTop: '4px' }}>
              {effective && effective.source
                ? <>Active via <strong style={{ color: '#bbb' }}>{effective.source}</strong> subscription</>
                : 'Your server is on the default Free tier.'}
            </div>
          </div>
        </div>
      </div>

      {/* Active subscriptions */}
      {(manual || paid || pausedPaid.length > 0) && (
        <div style={sectionStyle}>
          <h3 style={{ margin: '0 0 12px 0', color: '#ddd' }}>Active Subscriptions</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            {manual && (
              <div style={{ ...cardStyle, borderLeft: '3px solid #7289da' }}>
                <div style={{ color: '#7289da', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Manual Grant</div>
                <div style={{ color: '#fff', fontSize: '1.05rem', fontWeight: 600, marginTop: '4px' }}>{getTierName(manual.tierId)}</div>
                <div style={{ color: '#aaa', fontSize: '0.82rem', marginTop: '2px' }}>{formatRemaining(manual)}</div>
                {manual.notes && (
                  <div style={{ color: '#888', fontSize: '0.76rem', marginTop: '8px', fontStyle: 'italic' }}>&ldquo;{manual.notes}&rdquo;</div>
                )}
              </div>
            )}
            {paid && (
              <div style={{ ...cardStyle, borderLeft: '3px solid #3ba55d' }}>
                <div style={{ color: '#3ba55d', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Paid</div>
                <div style={{ color: '#fff', fontSize: '1.05rem', fontWeight: 600, marginTop: '4px' }}>{getTierName(paid.tierId)}</div>
                <div style={{ color: '#aaa', fontSize: '0.82rem', marginTop: '2px' }}>{formatRemaining(paid)}</div>
                <div style={{ color: '#888', fontSize: '0.78rem', marginTop: '4px' }}>
                  via <strong style={{ color: '#ccc' }}>{getProviderName(paid.providerId)}</strong>
                  {paid.autoRenew === false && paid.status === 'active' && (
                    <span style={{ color: '#e67e22', marginLeft: '6px' }}>(cancelled, will not renew)</span>
                  )}
                  {paid.autoRenew === true && (
                    <span style={{ color: '#3ba55d', marginLeft: '6px' }}>(auto-renewing)</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                  {paid.autoRenew === true ? (
                    <button onClick={handleCancel} disabled={processing} style={{
                      background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                      padding: '5px 12px', borderRadius: '5px', cursor: processing ? 'not-allowed' : 'pointer', fontSize: '0.78rem',
                    }}>{processing ? '…' : 'Cancel'}</button>
                  ) : paid.status === 'active' ? (
                    <button onClick={handleReactivate} disabled={processing} style={{
                      background: '#3ba55d', color: '#fff', border: 'none',
                      padding: '5px 12px', borderRadius: '5px', cursor: processing ? 'not-allowed' : 'pointer', fontSize: '0.78rem', fontWeight: 600,
                    }}>{processing ? '…' : 'Reactivate'}</button>
                  ) : null}
                </div>
              </div>
            )}
            {pausedPaid.map((ps, idx) => {
              const remaining = ps.remainingDaysAtPause;
              const remainingText = remaining == null
                ? 'Lifetime (resumes after current plan ends)'
                : remaining === 1
                  ? '1 day remaining (resumes after current plan ends)'
                  : `${remaining} days remaining (resumes after current plan ends)`;
              return (
                <div key={(ps.providerSubId || ps.tierId) + ':' + idx} style={{
                  ...cardStyle,
                  borderLeft: '3px solid #888',
                  opacity: 0.85,
                }}>
                  <div style={{ color: '#888', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Paid · Paused
                  </div>
                  <div style={{ color: '#ddd', fontSize: '1.05rem', fontWeight: 600, marginTop: '4px' }}>
                    {getTierName(ps.tierId)}
                  </div>
                  <div style={{ color: '#aaa', fontSize: '0.82rem', marginTop: '2px' }}>{remainingText}</div>
                  <div style={{ color: '#888', fontSize: '0.78rem', marginTop: '4px' }}>
                    via <strong style={{ color: '#ccc' }}>{getProviderName(ps.providerId)}</strong>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Available plans: one card per tier */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 12px 0', color: '#ddd' }}>Available Plans</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '14px' }}>
          {sortedTiers.map(([id, t]) => {
            const isFree = id === 'free';
            const isCurrent = effective && effective.tierId === id;
            const purchasable = !isFree && tierIsPurchasable(t);
            const alreadyOwned = !isFree && tierAlreadyOwned(id);
            const wouldBePaused = !isFree && tierWouldBePaused(t);
            const cheapest = tierCheapestMoney(t);
            const offeringCount = tierOfferings(t).length;

            return (
              <div key={id} style={{
                background: '#36393f', borderRadius: '10px', padding: '16px',
                border: isCurrent
                  ? '2px solid #f5af19'
                  : isFree ? '1px solid #3a3d42' : '1px solid #4a4d52',
                position: 'relative',
                display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '170px',
              }}>
                {isCurrent && (
                  <div style={{
                    position: 'absolute', top: '10px', right: '10px',
                    background: 'linear-gradient(135deg, #f5af19, #f12711)', color: '#fff',
                    padding: '2px 8px', borderRadius: '10px', fontSize: '0.66rem', fontWeight: 700,
                    letterSpacing: '0.5px',
                  }}>CURRENT</div>
                )}
                <h4 style={{
                  margin: 0,
                  color: isFree ? '#aaa' : '#f5af19',
                  fontSize: '1.1rem',
                }}>{t.displayName}</h4>
                <div style={{ color: '#888', fontSize: '0.72rem' }}>Priority {t.priority || 0}</div>

                {cheapest && (
                  <div style={{ color: '#ddd', fontSize: '0.95rem', marginTop: '4px' }}>
                    <strong style={{ fontSize: '1.1rem' }}>{(cheapest.amount / 100).toFixed(2)}</strong>
                    <span style={{ color: '#888', marginLeft: '4px', fontSize: '0.85rem' }}>{cheapest.currency}</span>
                    {offeringCount > 1 && (
                      <span style={{ color: '#777', fontSize: '0.75rem', marginLeft: '6px' }}>
                        · {offeringCount} plan{offeringCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                )}
                {!cheapest && offeringCount > 0 && (
                  <div style={{ color: '#888', fontSize: '0.82rem' }}>{offeringCount} plan{offeringCount !== 1 ? 's' : ''}</div>
                )}

                <div style={{ flex: 1 }} />

                {isFree ? (
                  <div style={{ color: '#666', fontSize: '0.8rem', textAlign: 'center', padding: '8px 0' }}>
                    {isCurrent ? 'You are on this tier' : 'Default tier for all servers'}
                  </div>
                ) : alreadyOwned ? (
                  <div style={{ color: '#888', fontSize: '0.72rem', textAlign: 'center', padding: '8px 0', lineHeight: 1.4 }}>
                    {isCurrent ? 'Currently active' : 'Already owned (paused)'}
                  </div>
                ) : purchasable ? (
                  <React.Fragment>
                    <button onClick={() => setSubscribeModalTierId(id)} style={{
                      background: 'linear-gradient(135deg, #5865F2, #4752C4)', color: '#fff', border: 'none',
                      padding: '9px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.88rem',
                    }}>{wouldBePaused ? 'Subscribe (queued)' : 'Subscribe'}</button>
                    {wouldBePaused && (
                      <div style={{ color: '#888', fontSize: '0.7rem', textAlign: 'center', marginTop: '6px', lineHeight: 1.4 }}>
                        Stays paused until your current plan ends.
                      </div>
                    )}
                  </React.Fragment>
                ) : (
                  <div style={{ color: '#666', fontSize: '0.72rem', textAlign: 'center', padding: '8px 0' }}>
                    Not purchasable right now
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {subscribeModalTierId && tiers[subscribeModalTierId] && (
        <SubscribeModal
          guildId={guild.id}
          tierId={subscribeModalTierId}
          tier={tiers[subscribeModalTierId]}
          providers={providers}
          willBePaused={tierWouldBePaused(tiers[subscribeModalTierId])}
          activeTierName={paid && paid.status === 'active' ? getTierName(paid.tierId) : null}
          onClose={() => setSubscribeModalTierId(null)}
          onSuccess={() => { setSubscribeModalTierId(null); onRefresh(); }}
        />
      )}
    </div>
  );
}

// ── Per-tier Subscribe modal ──
function SubscribeModal({ guildId, tierId, tier, providers, willBePaused, activeTierName, onClose, onSuccess }) {
  const [selectedOfferingId, setSelectedOfferingId] = useSubState('');
  const [selectedProviderId, setSelectedProviderId] = useSubState('');
  const [couponCode, setCouponCode] = useSubState('');
  // Coupon preview state: null = not checked, { valid, effectText|reason } = checked.
  const [couponPreview, setCouponPreview] = useSubState(null);
  const [couponChecking, setCouponChecking] = useSubState(false);
  const [saving, setSaving] = useSubState(false);
  const [error, setError] = useSubState(null);
  const [successMsg, setSuccessMsg] = useSubState(null);

  async function handleCouponBlur() {
    const code = (couponCode || '').trim();
    if (!code) { setCouponPreview(null); return; }
    setCouponChecking(true);
    try {
      const res = await guildApi.previewCoupon(guildId, code, tierId);
      setCouponPreview(res);
    } catch (err) {
      setCouponPreview({ valid: false, reason: err.message });
    } finally {
      setCouponChecking(false);
    }
  }

  function offeringProviderOptions(o) {
    const enabled = Object.entries(o.providerLinks || {})
      .filter(([, link]) => link && link.enabled)
      .map(([pid]) => pid);
    return providers.filter(p => enabled.includes(p.id));
  }
  function offeringIsPurchasable(o) { return offeringProviderOptions(o).length > 0; }

  const offerings = (tier.offerings || []).filter(offeringIsPurchasable);
  const offering = offerings.find(o => o.id === selectedOfferingId);
  const providerOptions = offering ? offeringProviderOptions(offering) : [];
  const provider = offering && selectedProviderId ? providers.find(p => p.id === selectedProviderId) : null;

  function formatPrice(o) {
    if (o.amount !== undefined && o.currency) return `${(o.amount / 100).toFixed(2)} ${o.currency}`;
    return '';
  }
  function formatDuration(o) {
    if (o.durationDays === null) return 'Lifetime';
    if (o.durationDays === 30) return 'per month';
    if (o.durationDays === 365) return 'per year';
    if (o.durationDays === 90) return 'per 3 months';
    if (o.durationDays === 180) return 'per 6 months';
    if (o.durationDays === 7) return 'per week';
    return `per ${o.durationDays} days`;
  }

  async function handleSubmit() {
    if (!selectedOfferingId || !selectedProviderId) return;
    setSaving(true); setError(null);
    try {
      const res = await guildApi.subscribePaid(guildId, tierId, selectedOfferingId, selectedProviderId, couponCode || undefined);
      if (res.success) {
        const result = res.result || {};
        if (result.redirectUrl) { window.location.href = result.redirectUrl; return; }
        if (result.oauthUrl)    { window.location.href = result.oauthUrl;    return; }
        if (result.clientHandoff) {
          alert('Open Discord to complete the purchase.');
          onSuccess();
          return;
        }
        // Immediate (Dummy): subscription active.
        setSuccessMsg('✓ Subscription active! Updating…');
        setTimeout(() => onSuccess(), 1200);
      } else {
        setError(res.error || 'Subscription failed');
      }
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  function selectOffering(id) {
    setSelectedOfferingId(id);
    const picked = offerings.find(o => o.id === id);
    const opts = picked ? offeringProviderOptions(picked) : [];
    setSelectedProviderId(opts.length === 1 ? opts[0].id : '');
  }

  const overlayStyle = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  };
  const modalStyle = {
    background: '#2c2f33', borderRadius: '12px', padding: '26px',
    width: '560px', maxWidth: '92vw', maxHeight: '90vh', overflow: 'auto',
    border: '1px solid #444',
  };
  const inputStyle = {
    width: '100%', padding: '9px 12px', borderRadius: '6px', border: '1px solid #555',
    background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.9rem', boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', color: '#aaa', fontSize: '0.82rem', marginBottom: '8px', marginTop: '14px' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <h3 style={{ margin: 0, color: '#fff' }}>Subscribe to</h3>
          <h3 style={{ margin: 0, color: '#f5af19' }}>{tier.displayName}</h3>
        </div>
        <p style={{ color: '#888', fontSize: '0.82rem', margin: '4px 0 0 0' }}>
          Choose a plan and payment method.
        </p>

        {willBePaused && (
          <div style={{
            marginTop: '12px', padding: '10px 12px',
            background: 'rgba(230, 126, 34, 0.08)', border: '1px solid rgba(230, 126, 34, 0.3)',
            borderRadius: '6px', color: '#e8a55a', fontSize: '0.82rem', lineHeight: 1.5,
          }}>
            This tier is lower than your current paid plan{activeTierName ? ` (${activeTierName})` : ''}.
            The purchase will be queued and start after that plan ends: its days stay frozen until then.
          </div>
        )}

        <label style={labelStyle}>Plan</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
          {offerings.map(o => {
            const selected = o.id === selectedOfferingId;
            const price = formatPrice(o);
            const duration = formatDuration(o);
            return (
              <div
                key={o.id}
                onClick={() => selectOffering(o.id)}
                style={{
                  background: selected ? 'rgba(88, 101, 242, 0.12)' : '#36393f',
                  border: selected ? '2px solid #5865F2' : '1px solid #444',
                  borderRadius: '10px',
                  padding: '12px 14px',
                  cursor: 'pointer',
                  transition: 'border-color 0.12s, background 0.12s',
                  display: 'flex', flexDirection: 'column', gap: '4px',
                }}
              >
                <div style={{ color: '#fff', fontSize: '0.95rem', fontWeight: 600 }}>{o.label}</div>
                {price ? (
                  <div style={{ color: '#ddd', fontSize: '0.9rem' }}>
                    <strong>{price}</strong>
                    <span style={{ color: '#888', marginLeft: '4px', fontSize: '0.78rem' }}>{duration}</span>
                  </div>
                ) : (
                  <div style={{ color: '#888', fontSize: '0.82rem' }}>{duration}</div>
                )}
                {o.autoRenewEligible && (
                  <div style={{ color: '#3ba55d', fontSize: '0.7rem' }}>auto-renewable</div>
                )}
                {o.description && (
                  <div style={{ color: '#aaa', fontSize: '0.78rem', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
                    {o.description}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {offering && providerOptions.length > 0 && (
          <React.Fragment>
            <label style={labelStyle}>Payment Method</label>
            <select style={inputStyle} value={selectedProviderId}
              onChange={e => setSelectedProviderId(e.target.value)}>
              <option value="">Select a payment method…</option>
              {providerOptions.map(p => (<option key={p.id} value={p.id}>{p.displayName}</option>))}
            </select>
          </React.Fragment>
        )}

        {offering && provider?.capabilities?.supportsCoupons && (
          <React.Fragment>
            <label style={labelStyle}>Coupon (optional)</label>
            <input type="text" style={inputStyle} value={couponCode}
              onChange={e => { setCouponCode(e.target.value); setCouponPreview(null); }}
              onBlur={handleCouponBlur}
              placeholder="Enter coupon code" />
            {couponChecking && (
              <div style={{ color: '#888', fontSize: '0.78rem', marginTop: '6px' }}>Checking...</div>
            )}
            {!couponChecking && couponPreview && couponPreview.valid && (
              <div style={{
                color: '#3ba55d', fontSize: '0.82rem', marginTop: '6px',
                background: 'rgba(59, 165, 93, 0.08)', border: '1px solid rgba(59, 165, 93, 0.3)',
                padding: '6px 10px', borderRadius: '4px',
              }}>
                Coupon valid: {couponPreview.effectText || 'applied at checkout'}
              </div>
            )}
            {!couponChecking && couponPreview && !couponPreview.valid && couponCode.trim() && (
              <div style={{
                color: '#ed4245', fontSize: '0.82rem', marginTop: '6px',
                background: 'rgba(237, 66, 69, 0.08)', border: '1px solid rgba(237, 66, 69, 0.3)',
                padding: '6px 10px', borderRadius: '4px',
              }}>
                {couponPreview.reason || 'Coupon not accepted'}
              </div>
            )}
          </React.Fragment>
        )}

        {error && (
          <div style={{ color: '#ed4245', fontSize: '0.85rem', marginTop: '12px' }}>{error}</div>
        )}
        {successMsg && (
          <div style={{
            color: '#3ba55d', fontSize: '0.88rem', marginTop: '12px',
            background: 'rgba(59, 165, 93, 0.08)', border: '1px solid rgba(59, 165, 93, 0.35)',
            padding: '8px 12px', borderRadius: '6px',
          }}>{successMsg}</div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
          <button onClick={onClose} disabled={!!successMsg} style={{
            background: '#40444b', color: '#ddd', border: 'none',
            padding: '9px 18px', borderRadius: '6px',
            cursor: successMsg ? 'not-allowed' : 'pointer', opacity: successMsg ? 0.5 : 1,
          }}>Cancel</button>
          <button onClick={handleSubmit} disabled={!offering || !selectedProviderId || saving || !!successMsg} style={{
            background: (!offering || !selectedProviderId || saving || successMsg) ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
            color: '#fff', border: 'none', padding: '9px 20px', borderRadius: '6px',
            cursor: (!offering || !selectedProviderId || saving || successMsg) ? 'not-allowed' : 'pointer', fontWeight: 600,
          }}>{saving ? 'Processing…' : successMsg ? 'Subscribed' : 'Subscribe'}</button>
        </div>
      </div>
    </div>
  );
}

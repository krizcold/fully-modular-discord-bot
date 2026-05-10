// Guild Subscription Panel: current-status summary + tier browser + per-tier subscribe modal.
// Uses `subData` supplied by guildApp (single fetch point). Calls `onRefresh()` after any mutation.

const { useState: useSubState, useEffect: useSubEffect } = React;

function GuildSubscriptionPanel({ guild, subData, onRefresh }) {
  const [processing, setProcessing] = useSubState(false);
  const [error, setError] = useSubState(null);
  const [subscribeModalTierId, setSubscribeModalTierId] = useSubState(null);
  // Orphans: provider-side subs the local cache doesn't track. Reloaded
  // on mount, on guild change, and after every mutation that could
  // resolve one (adopt / cancel / cancel-active / etc.).
  const [orphans, setOrphans] = useSubState([]);
  const [orphansLoading, setOrphansLoading] = useSubState(false);
  // Provider-return banner state. Read from URL on mount; URL is cleaned up
  // immediately so a manual refresh doesn't re-show the banner.
  // Values:
  //   'processing' - sync return from a redirect provider, waiting for
  //                  webhook + cache to reflect the new sub. Asserts nothing
  //                  to the user yet (no "Payment confirmed" until we see
  //                  the sub land).
  //   'success'    - sub appeared in the cache OR was auto-adopted from
  //                  the orphan list; safe to confirm now.
  //   'timeout'    - polled for 60s without seeing the sub. Surfaces a
  //                  hint to refresh + falls through to the orphan-adopt UI.
  //   'cancel'     - user cancelled at the provider. Friendly notice only.
  const [returnBanner, setReturnBanner] = useSubState(null);
  // Snapshot of subscription IDs the cache had at return time. The poll
  // detects success when this set grows, so we don't false-positive on a
  // pre-existing sub that was already there before the checkout returned.
  const baselineSubIdsRef = React.useRef(null);
  // Wall-clock time the 'processing' state began. Tracked in a ref because
  // the polling effect re-runs every time subData updates (the poll itself
  // calls onRefresh), and a re-derived state value would reset the timeout
  // window each tick.
  const processingStartedAtRef = React.useRef(null);
  // Surface auto-adoption results so the user understands why their tier
  // suddenly switched on page load.
  const [autoAdoptedCount, setAutoAdoptedCount] = useSubState(0);
  // Per-guild notifications channel state. Channels are fetched on demand
  // when the user opens the picker; persisted via guildApi.setNotificationsChannel.
  const [notifChannels, setNotifChannels] = useSubState([]);
  const [notifChannelsLoading, setNotifChannelsLoading] = useSubState(false);
  const [notifChannelsLoaded, setNotifChannelsLoaded] = useSubState(false);
  const [notifChannelDraft, setNotifChannelDraft] = useSubState('');
  const [notifSaving, setNotifSaving] = useSubState(false);
  // Pending migrations affecting this guild (Stage 5). Loaded on mount and
  // after each decision to keep the cards fresh.
  const [pendingMigrations, setPendingMigrations] = useSubState([]);
  const [migrationDeciding, setMigrationDeciding] = useSubState({}); // migrationId -> bool

  async function loadOrphans() {
    if (!guild?.id) return;
    // Don't auto-adopt against an empty subData snapshot - the auto-adopt
    // safety check reads `paid` and `pausedPaid` from the closure, and
    // those are derived from subData. If subData hasn't loaded yet,
    // safeAuto could be wrong (treat "unknown" as if "no local sub" and
    // adopt prematurely).
    if (!subData) return;
    setOrphansLoading(true);
    try {
      const res = await guildApi.listOrphans(guild.id);
      if (!res.success) { setOrphans([]); return; }
      const all = res.orphans || [];
      if (all.length === 0) { setOrphans([]); return; }

      // Auto-adoption rule: if the local cache currently has NO paid sub
      // (and no paused queue), and the orphan has full metadata, install
      // it automatically. The bot was the source of truth for the
      // payment flow that created this sub - the only reason it isn't in
      // cache is a webhook miss or earlier soft-cancel bug, both of
      // which the user wants resolved silently. With any local sub
      // present we leave orphans for manual review to avoid surprising
      // installs into a stacking queue.
      const hasLocalPaid = !!paid;
      const hasLocalPaused = pausedPaid.length > 0;
      const safeAuto = !hasLocalPaid && !hasLocalPaused;

      const remaining = [];
      let adoptedCount = 0;
      for (const orphan of all) {
        const ref = orphan.ref;
        const canAdoptAuto = safeAuto
          && !!ref.metadata.tierId
          && !!ref.metadata.offeringId
          && !!tiers[ref.metadata.tierId];
        if (!canAdoptAuto) {
          remaining.push(orphan);
          continue;
        }
        try {
          const adopted = await guildApi.adoptOrphan(guild.id, orphan.providerId, ref.providerSubId);
          if (adopted.success) adoptedCount++;
          else remaining.push(orphan);
        } catch { remaining.push(orphan); }
      }
      setOrphans(remaining);
      if (adoptedCount > 0) {
        setAutoAdoptedCount(adoptedCount);
        // Refresh subData so the active subscription card / current tier
        // updates without the user clicking refresh.
        await onRefresh();
      }
    } catch { setOrphans([]); }
    finally { setOrphansLoading(false); }
  }

  useSubEffect(() => { loadOrphans(); }, [guild?.id, subData]);

  // On mount: surface success/cancel from a provider redirect, then strip
  // those query params so refresh / share-this-link doesn't re-show.
  // Note: 'success' starts in 'processing' state - we don't claim the
  // payment is confirmed until the new sub actually appears in the cache
  // (via webhook OR auto-adopt from orphan list).
  useSubEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('subscribe');
    if (outcome === 'success') {
      setReturnBanner('processing');
      params.delete('subscribe');
      params.delete('session');
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
    } else if (outcome === 'cancel') {
      setReturnBanner('cancel');
      params.delete('subscribe');
      params.delete('session');
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  // While in 'processing' state: snapshot the current sub IDs once, then
  // poll every 2s for a new sub to appear. After 60s without a hit, drop
  // to 'timeout' so the user knows something is off and the orphan-adopt
  // UI takes over. The startedAt timestamp lives in a ref because this
  // effect re-runs each time onRefresh updates subData; resetting it
  // every tick would mean the 60s timeout never fires.
  useSubEffect(() => {
    if (returnBanner !== 'processing') {
      processingStartedAtRef.current = null;
      return;
    }
    if (!subData) return;
    if (baselineSubIdsRef.current === null) {
      const ids = new Set();
      const baseSubs = subData.subscriptions || {};
      if (baseSubs.active?.id) ids.add(baseSubs.active.id);
      for (const p of (baseSubs.paused || [])) {
        if (p?.id) ids.add(p.id);
      }
      baselineSubIdsRef.current = ids;
    }
    if (processingStartedAtRef.current === null) {
      processingStartedAtRef.current = Date.now();
    }
    const baseline = baselineSubIdsRef.current;
    const currentSubs = subData.subscriptions || {};
    const grew = (currentSubs.active?.id && !baseline.has(currentSubs.active.id))
      || (currentSubs.paused || []).some(p => p?.id && !baseline.has(p.id));
    if (grew) {
      setReturnBanner('success');
      baselineSubIdsRef.current = null;
      processingStartedAtRef.current = null;
      return;
    }
    if (Date.now() - processingStartedAtRef.current > 60000) {
      setReturnBanner('timeout');
      baselineSubIdsRef.current = null;
      processingStartedAtRef.current = null;
      return;
    }
    const poll = setTimeout(() => {
      void onRefresh();
    }, 2000);
    return () => clearTimeout(poll);
  }, [returnBanner, subData]);

  // If the auto-adopt path resolved this purchase (i.e. while processing,
  // an orphan got picked up and installed), treat that as success too.
  useSubEffect(() => {
    if (returnBanner === 'processing' && autoAdoptedCount > 0) {
      setReturnBanner('success');
      baselineSubIdsRef.current = null;
    }
  }, [autoAdoptedCount, returnBanner]);

  async function loadNotifChannels() {
    if (!guild?.id || notifChannelsLoading) return;
    setNotifChannelsLoading(true);
    try {
      const res = await guildApi.listGuildChannels(guild.id);
      if (res.success && Array.isArray(res.channels)) {
        // Discord text-channel type ids: 0 (GUILD_TEXT), 5 (ANNOUNCEMENT).
        // Plus threads we should NOT offer (they get deleted unexpectedly).
        const writable = res.channels.filter(c => c.type === 0 || c.type === 5);
        setNotifChannels(writable);
      } else {
        setNotifChannels([]);
      }
    } catch {
      setNotifChannels([]);
    } finally {
      setNotifChannelsLoading(false);
      setNotifChannelsLoaded(true);
    }
  }

  // Sync the draft with whatever the server thinks is currently set, so
  // navigating away and back doesn't show a stale draft.
  useSubEffect(() => {
    setNotifChannelDraft(subData?.subscriptions?.notificationsChannelId || '');
  }, [subData?.subscriptions?.notificationsChannelId]);

  async function handleSaveNotifChannel() {
    if (notifSaving) return;
    setNotifSaving(true);
    setError(null);
    try {
      const res = await guildApi.setNotificationsChannel(guild.id, notifChannelDraft || null);
      if (res.success) await onRefresh();
      else setError(res.error || 'Failed to save notifications channel');
    } catch (err) { setError(err.message); }
    finally { setNotifSaving(false); }
  }

  async function loadPendingMigrations() {
    if (!guild?.id) return;
    try {
      const res = await guildApi.listPendingMigrations(guild.id);
      setPendingMigrations(res.success && Array.isArray(res.migrations) ? res.migrations : []);
    } catch { setPendingMigrations([]); }
  }

  useSubEffect(() => { loadPendingMigrations(); }, [guild?.id]);

  async function handleMigrationDecision(migrationId, decision) {
    if (migrationDeciding[migrationId]) return;
    setMigrationDeciding(m => ({ ...m, [migrationId]: true }));
    setError(null);
    try {
      const res = await guildApi.recordMigrationDecision(guild.id, migrationId, decision);
      if (res.success) await loadPendingMigrations();
      else setError(res.error || 'Failed to record decision');
    } catch (err) { setError(err.message); }
    finally {
      setMigrationDeciding(m => { const n = { ...m }; delete n[migrationId]; return n; });
    }
  }

  if (!subData) {
    return <FirstLoadPlaceholder label="Loading subscription…" />;
  }

  const { subscriptions = {}, effective, tiers = {}, providers = [] } = subData;
  // New model: single active slot + paused queue. Derive view-friendly slices:
  //   active source-segregated for the cards (manual vs paid),
  //   pausedAll = full queue for the queued-cards section.
  const active = subscriptions.active;
  const pausedAll = Array.isArray(subscriptions.paused) ? subscriptions.paused : [];
  const manual = active?.source === 'manual' ? active : null;
  const paid = active?.source === 'paid' ? active : null;
  // Backwards-shape variable for code inside this file that still references
  // pausedPaid: it's the paused queue as a whole. Manual paused entries also
  // appear here, so the user can see + cancel any queued entitlement.
  const pausedPaid = pausedAll;

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
    const links = Array.isArray(o.providerLinks) ? o.providerLinks : [];
    return links.filter(l => l && l.enabled).map(l => l.providerId);
  }
  /**
   * Tier is purchasable when at least one offering has at least one enabled
   * link whose provider is configured AND has at least one active variant
   * cached. Without cached variants the user has nothing to click on.
   */
  function tierIsPurchasable(t) {
    return (t.offerings || []).some(o => {
      const links = Array.isArray(o.providerLinks) ? o.providerLinks : [];
      return links.some(l => {
        if (!l.enabled) return false;
        const provider = providers.find(p => p.id === l.providerId);
        if (!provider) return false;
        const variants = l.cache?.variants || [];
        return variants.some(v => v.active);
      });
    });
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
   * True if buying this tier right now would be queued behind the active sub.
   * Compares against `active` (any source), since stacking is unified now.
   */
  function tierWouldBePaused(t) {
    if (!active || active.status !== 'active') return false;
    const activePriority = tiers[active.tierId]?.priority ?? 0;
    return (t.priority ?? 0) < activePriority;
  }
  function tierOfferings(t) { return t.offerings || []; }
  /**
   * Cheapest cached variant across all enabled provider links of all offerings
   * on this tier, used as the price hint on tier cards.
   */
  function tierCheapestMoney(t) {
    let best = null;
    for (const o of tierOfferings(t)) {
      const links = Array.isArray(o.providerLinks) ? o.providerLinks : [];
      for (const link of links) {
        if (!link.enabled) continue;
        for (const v of (link.cache?.variants || [])) {
          if (!v.active) continue;
          if (!best || v.amount < best.amount) best = { amount: v.amount, currency: v.currency };
        }
      }
    }
    return best;
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

  async function handleCancelImmediately() {
    const tierName = paid ? getTierName(paid.tierId) : 'this subscription';
    const remainingMsg = paid && paid.endDate
      ? ` You'll lose any remaining time on it.`
      : '';
    if (!confirm(
      `Cancel '${tierName}' immediately?${remainingMsg} ` +
      `If you have a queued subscription it will resume in this slot. ` +
      `This cannot be undone.`
    )) return;
    setProcessing(true); setError(null);
    try {
      const res = await guildApi.cancelPaidSubscriptionImmediately(guild.id);
      if (res.success) await onRefresh();
      else setError(res.error || 'Failed to cancel');
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  async function handleUnlinkPatreon() {
    if (!confirm(
      'Unlink your Patreon account from this server?\n\n' +
      'This stops the Patreon-backed tier here. Your Patreon pledge itself stays untouched on patreon.com; ' +
      'unlinking just frees the account so you can link it to a different Discord server.'
    )) return;
    setProcessing(true); setError(null);
    try {
      const res = await guildApi.unlinkProvider(guild.id, 'patreon');
      if (res.success) await onRefresh();
      else setError(res.error || 'Failed to unlink Patreon');
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  async function handleOpenBillingPortal() {
    // Same-tab navigation. The portal is a short detour - the user
    // manages their sub and Stripe redirects them back via return_url.
    // returnUrl points straight at this guild's subscription page so the
    // "Return to ..." button on Stripe lands the user where they were,
    // not on the generic guild selector.
    setProcessing(true); setError(null);
    try {
      const returnUrl = `${window.location.origin}/guild/${encodeURIComponent(guild.id)}/subscription`;
      const res = await guildApi.openBillingPortal(guild.id, returnUrl);
      if (res.success && res.portalUrl) {
        window.location.href = res.portalUrl;
        return;
      }
      setError(res.error || 'Could not open billing portal');
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  async function handleAdoptOrphan(orphan) {
    if (!confirm(
      `Re-link this ${orphan.providerId} subscription (${orphan.ref.providerSubId}) into your guild's tier? ` +
      `It will be installed under '${orphan.ref.metadata.tierId || '?'}' as if you'd just subscribed.`
    )) return;
    setProcessing(true); setError(null);
    try {
      const res = await guildApi.adoptOrphan(guild.id, orphan.providerId, orphan.ref.providerSubId);
      if (res.success) {
        await onRefresh();
        await loadOrphans();
      } else {
        setError(res.error || 'Failed to adopt orphan');
      }
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  async function handleCancelOrphan(orphan) {
    if (!confirm(
      `Cancel this ${orphan.providerId} subscription (${orphan.ref.providerSubId}) at the provider? ` +
      `Billing stops; nothing changes locally because the bot wasn't tracking it.`
    )) return;
    setProcessing(true); setError(null);
    try {
      const res = await guildApi.cancelOrphan(guild.id, orphan.providerId, orphan.ref.providerSubId);
      if (res.success) {
        await loadOrphans();
      } else {
        setError(res.error || 'Failed to cancel orphan');
      }
    } catch (err) { setError(err.message); }
    finally { setProcessing(false); }
  }

  async function handleCancelPaused(ps) {
    if (!ps?.id) {
      setError('Cannot cancel: this queued entry has no id.');
      return;
    }
    const tierName = getTierName(ps.tierId);
    const isPaid = ps.source === 'paid';
    if (!confirm(
      isPaid
        ? `Cancel your queued '${tierName}' subscription? It will not resume when your current plan ends, and the provider will stop billing for it.`
        : `Cancel your queued '${tierName}' grant? It will not resume when your current plan ends.`,
    )) return;
    setProcessing(true); setError(null);
    try {
      const res = await guildApi.cancelPausedSubscription(guild.id, ps.id);
      if (res.success) await onRefresh();
      else setError(res.error || 'Failed to cancel queued subscription');
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

      {autoAdoptedCount > 0 && (
        <div style={{
          background: 'rgba(59, 165, 93, 0.12)', border: '1px solid rgba(59, 165, 93, 0.5)',
          color: '#3ba55d', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        }}>
          <span>
            ✓ Imported {autoAdoptedCount} existing subscription{autoAdoptedCount === 1 ? '' : 's'} from your payment provider into this guild.
          </span>
          <button onClick={() => setAutoAdoptedCount(0)} style={{
            background: 'transparent', color: '#3ba55d', border: '1px solid #3ba55d',
            padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem',
          }}>Dismiss</button>
        </div>
      )}

      {pendingMigrations.length > 0 && (
        <div style={{
          background: 'rgba(245, 175, 25, 0.08)', border: '1px solid rgba(245, 175, 25, 0.5)',
          borderRadius: '10px', padding: '14px 16px', marginBottom: '18px',
        }}>
          <h3 style={{ margin: '0 0 4px 0', color: '#f5af19' }}>Action required: subscription change</h3>
          <p style={{ color: '#bbb', fontSize: '0.82rem', margin: '0 0 12px 0' }}>
            The host has scheduled a change to one or more of your paid subscriptions. Choose for each
            before the effective date or the host's default policy applies automatically.
          </p>
          {pendingMigrations.map(m => {
            const myDecision = m.decisions?.[0]?.decision || 'pending';
            const sourceTier = tiers[m.sourceTierId];
            const targetTier = tiers[m.targetTierId];
            const effective = m.effectiveDate ? new Date(m.effectiveDate) : null;
            const busy = !!migrationDeciding[m.id];
            return (
              <div key={m.id} style={{
                background: '#36393f', borderRadius: '8px', padding: '12px 14px',
                marginBottom: '8px', borderLeft: '3px solid #f5af19',
              }}>
                <div style={{ color: '#fff', fontSize: '0.92rem', fontWeight: 600 }}>
                  {sourceTier?.displayName || m.sourceTierId} → {targetTier?.displayName || m.targetTierId}
                </div>
                <div style={{ color: '#aaa', fontSize: '0.78rem', marginTop: '2px' }}>
                  via {m.providerId}
                  {effective && <> · effective {effective.toLocaleDateString()} {effective.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}
                </div>
                {m.message && (
                  <div style={{
                    color: '#ccc', fontSize: '0.82rem', margin: '8px 0', padding: '6px 10px',
                    background: '#2c2f33', borderRadius: '5px', whiteSpace: 'pre-wrap',
                  }}>{m.message}</div>
                )}
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => handleMigrationDecision(m.id, 'accepted')}
                    disabled={busy}
                    style={{
                      background: myDecision === 'accepted' ? '#3ba55d' : 'transparent',
                      color: myDecision === 'accepted' ? '#fff' : '#3ba55d',
                      border: '1px solid #3ba55d',
                      padding: '5px 14px', borderRadius: '5px', cursor: busy ? 'not-allowed' : 'pointer',
                      fontSize: '0.82rem', fontWeight: 600,
                      ...disabledButtonStyle(busy),
                    }}>
                    {myDecision === 'accepted' ? '✓ Accepted' : 'Accept'}
                  </button>
                  <button onClick={() => handleMigrationDecision(m.id, 'declined')}
                    disabled={busy}
                    style={{
                      background: myDecision === 'declined' ? '#ed4245' : 'transparent',
                      color: myDecision === 'declined' ? '#fff' : '#ed4245',
                      border: '1px solid #ed4245',
                      padding: '5px 14px', borderRadius: '5px', cursor: busy ? 'not-allowed' : 'pointer',
                      fontSize: '0.82rem', fontWeight: 600,
                      ...disabledButtonStyle(busy),
                    }}>
                    {myDecision === 'declined' ? '✓ Declined' : 'Decline'}
                  </button>
                  {myDecision === 'pending' && (
                    <span style={{ color: '#888', fontSize: '0.75rem' }}>
                      No decision yet - host's default policy applies if no choice by the effective date.
                    </span>
                  )}
                  {myDecision !== 'pending' && (
                    <span style={{ color: '#888', fontSize: '0.75rem' }}>
                      You can change your decision until the effective date.
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {returnBanner === 'processing' && (
        <div style={{
          background: 'rgba(88, 101, 242, 0.1)', border: '1px solid rgba(88, 101, 242, 0.5)',
          color: '#a8b1ff', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              display: 'inline-block', width: '14px', height: '14px',
              border: '2px solid rgba(168, 177, 255, 0.3)', borderTopColor: '#a8b1ff',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite',
            }} />
            Processing payment... waiting for the provider's confirmation. This usually takes a few seconds.
          </span>
        </div>
      )}
      {returnBanner === 'success' && (
        <div style={{
          background: 'rgba(59, 165, 93, 0.12)', border: '1px solid rgba(59, 165, 93, 0.5)',
          color: '#3ba55d', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        }}>
          <span>
            ✓ Payment confirmed. Your subscription is active below.
          </span>
          <button onClick={() => setReturnBanner(null)} style={{
            background: 'transparent', color: '#3ba55d', border: '1px solid #3ba55d',
            padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem',
          }}>Dismiss</button>
        </div>
      )}
      {returnBanner === 'timeout' && (
        <div style={{
          background: 'rgba(230, 126, 34, 0.1)', border: '1px solid rgba(230, 126, 34, 0.5)',
          color: '#e67e22', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        }}>
          <span>
            Still waiting on the provider's confirmation. If your subscription doesn't appear below or in the orphan list within a minute, refresh the page or contact support.
          </span>
          <button onClick={() => setReturnBanner(null)} style={{
            background: 'transparent', color: '#e67e22', border: '1px solid #e67e22',
            padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem',
          }}>Dismiss</button>
        </div>
      )}
      {returnBanner === 'cancel' && (
        <div style={{
          background: 'rgba(230, 126, 34, 0.1)', border: '1px solid rgba(230, 126, 34, 0.5)',
          color: '#e67e22', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
        }}>
          <span>
            Checkout was cancelled. No charge was made. You can try again any time.
          </span>
          <button onClick={() => setReturnBanner(null)} style={{
            background: 'transparent', color: '#e67e22', border: '1px solid #e67e22',
            padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem',
          }}>Dismiss</button>
        </div>
      )}

      {error && (
        <div style={{
          background: 'rgba(237, 66, 69, 0.1)', border: '1px solid #ed4245',
          color: '#ed4245', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px',
        }}>{error}</div>
      )}

      {/* Current status. Wrapped in RefetchOverlay so any in-flight
          mutation (cancel, reactivate, adopt, etc.) dims the previous
          tier value and shows a spinner instead of letting the user see
          a brief misleading "Free" while subData is being refetched. */}
      <RefetchOverlay loading={processing}>
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
      </RefetchOverlay>

      {/* Active subscriptions. Same RefetchOverlay treatment so a click
          on Cancel / Reactivate / Cancel-and-remove dims the cards
          underneath while the API + refetch round-trip completes. */}
      {(manual || paid || pausedPaid.length > 0) && (
        <RefetchOverlay loading={processing}>
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
                <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
                  {paid.autoRenew === true ? (
                    <button onClick={handleCancel} disabled={processing} style={{
                      background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                      padding: '5px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem',
                      ...disabledButtonStyle(processing),
                    }}
                    title="Stop auto-renewing. You keep access until the current period ends.">
                      {processing ? 'Cancelling…' : 'Cancel'}
                    </button>
                  ) : paid.status === 'active' ? (
                    <button onClick={handleReactivate} disabled={processing} style={{
                      background: '#3ba55d', color: '#fff', border: 'none',
                      padding: '5px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600,
                      ...disabledButtonStyle(processing),
                    }}>{processing ? 'Reactivating…' : 'Reactivate'}</button>
                  ) : null}
                  <button onClick={handleCancelImmediately} disabled={processing} style={{
                    background: '#ed4245', color: '#fff', border: 'none',
                    padding: '5px 12px', borderRadius: '5px',
                    cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600,
                    ...disabledButtonStyle(processing),
                  }}
                  title="End this subscription right now and free the slot. Loses remaining time. If you have a queued sub, it resumes here.">
                    {processing ? 'Cancelling…' : 'Cancel & remove now'}
                  </button>
                  <button onClick={handleOpenBillingPortal} disabled={processing} style={{
                    background: 'transparent', color: '#aaa', border: '1px solid #555',
                    padding: '5px 12px', borderRadius: '5px',
                    cursor: 'pointer', fontSize: '0.78rem',
                    ...disabledButtonStyle(processing),
                  }}
                  title="Open the provider's hosted billing page to update payment methods or see invoices.">
                    {processing ? 'Opening…' : 'Manage at provider ↗'}
                  </button>
                  {paid.providerId === 'patreon' && (
                    <button onClick={handleUnlinkPatreon} disabled={processing} style={{
                      background: 'transparent', color: '#aaa', border: '1px solid #555',
                      padding: '5px 12px', borderRadius: '5px',
                      cursor: 'pointer', fontSize: '0.78rem',
                      ...disabledButtonStyle(processing),
                    }}
                    title="Free your Patreon account from this server so you can link it to a different one. Your pledge on patreon.com is unaffected.">
                      {processing ? 'Unlinking…' : 'Unlink Patreon'}
                    </button>
                  )}
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
              const isPaid = ps.source === 'paid';
              return (
                <div key={ps.id || `${ps.tierId}:${idx}`} style={{
                  ...cardStyle,
                  borderLeft: `3px solid ${isPaid ? '#888' : '#7289da'}`,
                  opacity: 0.85,
                }}>
                  <div style={{ color: isPaid ? '#888' : '#7289da', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {isPaid ? 'Paid · Queued' : 'Manual · Queued'}
                  </div>
                  <div style={{ color: '#ddd', fontSize: '1.05rem', fontWeight: 600, marginTop: '4px' }}>
                    {getTierName(ps.tierId)}
                  </div>
                  <div style={{ color: '#aaa', fontSize: '0.82rem', marginTop: '2px' }}>{remainingText}</div>
                  {isPaid && (
                    <div style={{ color: '#888', fontSize: '0.78rem', marginTop: '4px' }}>
                      via <strong style={{ color: '#ccc' }}>{getProviderName(ps.providerId)}</strong>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                    <button onClick={() => handleCancelPaused(ps)} disabled={processing} style={{
                      background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                      padding: '5px 12px', borderRadius: '5px',
                      cursor: 'pointer', fontSize: '0.78rem',
                      ...disabledButtonStyle(processing),
                    }}
                    title="Stop this queued entry so it won't resume when your active plan ends.">
                      {processing ? 'Cancelling…' : 'Cancel & remove'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        </RefetchOverlay>
      )}

      {/* Orphans: provider-side subs the local cache doesn't track. Hidden
          when there are none. Appears between Active Subscriptions and
          Available Plans so the user notices it before trying to subscribe
          again. */}
      {orphans.length > 0 && (
        <div style={{
          ...sectionStyle,
          background: 'rgba(230, 126, 34, 0.08)',
          border: '1px solid rgba(230, 126, 34, 0.3)',
        }}>
          <h3 style={{ margin: '0 0 6px 0', color: '#e8a55a' }}>Subscriptions needing attention</h3>
          <p style={{ color: '#aaa', fontSize: '0.84rem', margin: '0 0 14px 0', lineHeight: 1.5 }}>
            These were found at the payment provider but the bot doesn't
            track them. Adopt one to re-link it to a tier, or cancel it to
            stop billing. You'll need to clear them before you can
            subscribe to that provider again for this guild.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
            {orphans.map((orphan, idx) => {
              const ref = orphan.ref;
              const tierName = ref.metadata.tierId
                ? (tiers[ref.metadata.tierId]?.displayName || ref.metadata.tierId)
                : '(unknown tier)';
              const canAdopt = !!(ref.metadata.tierId && ref.metadata.offeringId);
              return (
                <div key={`${orphan.providerId}:${ref.providerSubId}:${idx}`} style={{
                  ...cardStyle,
                  borderLeft: '3px solid #e67e22',
                }}>
                  <div style={{ color: '#e67e22', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {orphan.providerId} · {ref.display.statusLabel}
                  </div>
                  <div style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, marginTop: '4px' }}>
                    {tierName}
                  </div>
                  <div style={{ color: '#aaa', fontSize: '0.82rem', marginTop: '2px' }}>
                    {ref.display.amountLabel} {ref.display.periodLabel}
                  </div>
                  <div style={{ color: '#666', fontSize: '0.7rem', marginTop: '4px', wordBreak: 'break-all' }}>
                    id: {ref.providerSubId}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
                    {canAdopt && (
                      <button onClick={() => handleAdoptOrphan(orphan)} disabled={processing} style={{
                        background: '#3ba55d', color: '#fff', border: 'none',
                        padding: '5px 12px', borderRadius: '5px',
                        cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600,
                        ...disabledButtonStyle(processing),
                      }} title="Install this subscription locally as if it had just been purchased.">
                        {processing ? 'Adopting…' : 'Adopt'}
                      </button>
                    )}
                    <button onClick={() => handleCancelOrphan(orphan)} disabled={processing} style={{
                      background: 'transparent', color: '#ed4245', border: '1px solid #ed4245',
                      padding: '5px 12px', borderRadius: '5px',
                      cursor: 'pointer', fontSize: '0.78rem',
                      ...disabledButtonStyle(processing),
                    }} title="Cancel this subscription at the provider. Local state isn't affected (it had no record).">
                      {processing ? 'Cancelling…' : 'Cancel at provider'}
                    </button>
                  </div>
                  {!canAdopt && (
                    <div style={{ color: '#888', fontSize: '0.72rem', marginTop: '6px', lineHeight: 1.4 }}>
                      Missing tier metadata - can only be cancelled.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {orphansLoading && (
            <div style={{ color: '#888', fontSize: '0.78rem', marginTop: '10px' }}>Refreshing…</div>
          )}
        </div>
      )}

      {/* Available plans: one card per tier the user does NOT already own.
          Owned tiers (active or paused) are managed in the section above
          with cancel/reactivate buttons; showing them again here as
          read-only "Already owned" cards just confused users who tried to
          click them. */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 12px 0', color: '#ddd' }}>Available Plans</h3>
        {sortedTiers.every(([id]) => id === 'free' || tierAlreadyOwned(id)) && (
          <div style={{ color: '#888', fontSize: '0.85rem', padding: '8px 0' }}>
            You already own every paid tier. Cancel one above to free up a slot.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '14px' }}>
          {sortedTiers
            .filter(([id]) => id === 'free' || !tierAlreadyOwned(id))
            .map(([id, t]) => {
            const isFree = id === 'free';
            const isCurrent = effective && effective.tierId === id;
            const purchasable = !isFree && tierIsPurchasable(t);
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

      {/* Notifications channel: fallback for when the bot can't DM the
          guild owner. Default behavior (empty value) is to use the guild's
          system channel; admins can pick a specific channel here.
          Channels are fetched lazily so we don't pay the IPC roundtrip
          on every page load. */}
      <div style={sectionStyle}>
        <h3 style={{ margin: '0 0 4px 0', color: '#ddd' }}>Notifications</h3>
        <p style={{ color: '#888', fontSize: '0.82rem', margin: '0 0 12px 0' }}>
          When the bot can't DM you (DMs disabled, or you're no longer in the server),
          subscription updates fall back to a channel here. Leave on "System channel" to use
          the server's default; pick a specific channel to override.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <select
            value={notifChannelDraft}
            onFocus={() => { if (!notifChannelsLoaded) void loadNotifChannels(); }}
            onChange={e => setNotifChannelDraft(e.target.value)}
            disabled={notifSaving}
            style={{
              padding: '7px 10px', borderRadius: '6px', border: '1px solid #555',
              background: '#1a1a1a', color: '#e0e0e0', fontSize: '0.85rem',
              minWidth: '260px',
            }}>
            <option value="">System channel (default)</option>
            {notifChannelsLoading && <option disabled>Loading channels...</option>}
            {!notifChannelsLoading && notifChannelsLoaded && notifChannels.length === 0 && (
              <option disabled>No accessible text channels</option>
            )}
            {notifChannels.map(ch => (
              <option key={ch.id} value={ch.id}>#{ch.name}</option>
            ))}
            {/* Show the currently-saved id even if it's not in the loaded list
                (channel deleted, missing perms, etc.) so the user can see what
                they have configured and clear it. */}
            {notifChannelDraft
              && notifChannelsLoaded
              && !notifChannels.some(c => c.id === notifChannelDraft) && (
                <option value={notifChannelDraft}>(unknown channel id: {notifChannelDraft})</option>
              )}
          </select>
          <button onClick={handleSaveNotifChannel}
            disabled={notifSaving || (notifChannelDraft || '') === (subData?.subscriptions?.notificationsChannelId || '')}
            style={{
              background: notifSaving ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
              color: '#fff', border: 'none', padding: '7px 14px', borderRadius: '6px',
              cursor: notifSaving ? 'not-allowed' : 'pointer', fontSize: '0.82rem', fontWeight: 600,
              ...disabledButtonStyle(notifSaving || (notifChannelDraft || '') === (subData?.subscriptions?.notificationsChannelId || '')),
            }}>
            {notifSaving ? 'Saving...' : 'Save'}
          </button>
          {(subData?.subscriptions?.notificationsChannelId) && (
            <span style={{ color: '#888', fontSize: '0.78rem' }}>
              Currently overrides the system channel.
            </span>
          )}
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
//
// Per-provider mode independence: each providerLink on the offering picks
// its own mode (Price or Product) with its own variant list. The modal
// renders one section per enabled link, with variants from `link.cache`.
// User picks a single variant -> implies provider + variantId -> subscribe.
function SubscribeModal({ guildId, tierId, tier, providers, willBePaused, activeTierName, onClose, onSuccess }) {
  const [selectedOfferingId, setSelectedOfferingId] = useSubState('');
  // Selection key: 'providerId:variantId' or '' for none.
  const [selectionKey, setSelectionKey] = useSubState('');
  const [couponCode, setCouponCode] = useSubState('');
  const [couponPreview, setCouponPreview] = useSubState(null);
  const [couponChecking, setCouponChecking] = useSubState(false);
  const [autoRenewOptOut, setAutoRenewOptOut] = useSubState(false);
  const [saving, setSaving] = useSubState(false);
  const [error, setError] = useSubState(null);
  const [successMsg, setSuccessMsg] = useSubState(null);

  function purchasableLinks(o) {
    const links = Array.isArray(o.providerLinks) ? o.providerLinks : [];
    return links.filter(l => {
      if (!l.enabled) return false;
      const provider = providers.find(p => p.id === l.providerId);
      if (!provider) return false;
      const variants = l.cache?.variants || [];
      return variants.some(v => v.active);
    });
  }
  function offeringIsPurchasable(o) { return purchasableLinks(o).length > 0; }

  const offerings = (tier.offerings || []).filter(offeringIsPurchasable);
  const offering = offerings.find(o => o.id === selectedOfferingId);
  const offeringLinks = offering ? purchasableLinks(offering) : [];

  // Decode the selectionKey into providerId + variantId + cached variant data.
  const selectedSplit = selectionKey ? selectionKey.split(':') : null;
  const selectedProviderId = selectedSplit ? selectedSplit[0] : '';
  const selectedVariantId = selectedSplit ? selectedSplit.slice(1).join(':') : '';
  const selectedProvider = selectedProviderId ? providers.find(p => p.id === selectedProviderId) : null;
  const selectedVariant = (() => {
    if (!offering || !selectedProviderId || !selectedVariantId) return null;
    const link = offeringLinks.find(l => l.providerId === selectedProviderId);
    if (!link) return null;
    return (link.cache?.variants || []).find(v => v.variantId === selectedVariantId) || null;
  })();

  function variantPeriodLabel(v) {
    if (v.durationDays === null) return 'Lifetime';
    if (v.durationDays === 30) return 'per month';
    if (v.durationDays === 365) return 'per year';
    if (v.durationDays === 90) return 'per 3 months';
    if (v.durationDays === 180) return 'per 6 months';
    if (v.durationDays === 7) return 'per week';
    return `per ${v.durationDays} days`;
  }

  /**
   * Display label for a variant on a link. Product mode keeps the cached
   * `OfferingVariant.label` raw (provider's truth) and applies the admin's
   * per-variant override here at render time. Price mode bakes the override
   * into the cache during refresh, so the cached label is already correct.
   */
  function variantDisplayLabel(link, v) {
    if (link?.mode === 'product') {
      const override = link.productConfig?.variantLabelOverrides?.[v.variantId];
      if (override) return override;
    }
    return v.label;
  }

  async function handleCouponBlur() {
    const code = (couponCode || '').trim();
    if (!code) { setCouponPreview(null); return; }
    if (!selectedProviderId) { setCouponPreview(null); return; }
    setCouponChecking(true);
    try {
      const res = await guildApi.previewCoupon(guildId, selectedProviderId, code, selectedVariantId || undefined);
      setCouponPreview(res);
    } catch (err) {
      setCouponPreview({ valid: false, reason: err.message });
    } finally {
      setCouponChecking(false);
    }
  }

  async function handleSubmit() {
    if (!selectedOfferingId || !selectedProviderId || !selectedVariantId) return;
    setSaving(true); setError(null);
    try {
      const res = await guildApi.subscribePaid(
        guildId, tierId, selectedOfferingId, selectedProviderId, selectedVariantId,
        couponCode || undefined, autoRenewOptOut,
      );
      if (res.success) {
        const result = res.result || {};
        if (result.redirectUrl) { window.location.href = result.redirectUrl; return; }
        if (result.oauthUrl)    { window.location.href = result.oauthUrl;    return; }
        if (result.clientHandoff) {
          const msg = result.clientHandoff.instruction
            || 'Open Discord to complete the purchase.';
          alert(msg);
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
    setSelectionKey('');
    setAutoRenewOptOut(false);
    setCouponCode('');
    setCouponPreview(null);
  }

  // User may opt out of auto-renew when the picked variant is recurring AND
  // the offering doesn't lock auto-renew on. Non-recurring (one-time/Lifetime)
  // never renews regardless.
  const canOptOutAutoRenew = !!selectedVariant
    && selectedVariant.recurring
    && !offering?.forceAutoRenew;

  const overlayStyle = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  };
  const modalStyle = {
    background: '#2c2f33', borderRadius: '12px', padding: '26px',
    width: '640px', maxWidth: '92vw', maxHeight: '90vh', overflow: 'auto',
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
          Choose a plan, then pick a payment method + billing variant.
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
        {offerings.length === 0 ? (
          <div style={{ color: '#888', fontSize: '0.85rem', padding: '8px 0' }}>
            No purchasable plans on this tier yet. (The host needs to wire variants on at least one provider.)
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' }}>
            {offerings.map(o => {
              const selected = o.id === selectedOfferingId;
              const links = purchasableLinks(o);
              const variantTotal = links.reduce((n, l) => n + (l.cache?.variants || []).filter(v => v.active).length, 0);
              return (
                <div key={o.id} onClick={() => selectOffering(o.id)}
                  style={{
                    background: selected ? 'rgba(88, 101, 242, 0.12)' : '#36393f',
                    border: selected ? '2px solid #5865F2' : '1px solid #444',
                    borderRadius: '10px', padding: '12px 14px', cursor: 'pointer',
                    transition: 'border-color 0.12s, background 0.12s',
                    display: 'flex', flexDirection: 'column', gap: '4px',
                  }}>
                  <div style={{ color: '#fff', fontSize: '0.95rem', fontWeight: 600 }}>{o.label}</div>
                  <div style={{ color: '#888', fontSize: '0.78rem' }}>
                    {variantTotal} variant{variantTotal !== 1 ? 's' : ''} across {links.length} method{links.length !== 1 ? 's' : ''}
                  </div>
                  {o.description && (
                    <div style={{ color: '#aaa', fontSize: '0.78rem', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
                      {o.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {offering && (
          <React.Fragment>
            <label style={labelStyle}>Pick a Variant</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {offeringLinks.map(link => {
                const provider = providers.find(p => p.id === link.providerId);
                const variants = (link.cache?.variants || []).filter(v => v.active);
                if (!provider || variants.length === 0) return null;
                const useHostedPicker = link.mode === 'product'
                  && !!link.productConfig?.useProviderHostedPicker
                  && provider.capabilities?.supportsHostedPicker;
                if (useHostedPicker) {
                  // Hand variant selection off to the provider's hosted page
                  // by sending the FIRST active variant; the provider's
                  // hosted page will display the full picker.
                  const firstActive = variants[0];
                  const key = `${provider.id}:${firstActive.variantId}`;
                  const selected = selectionKey === key;
                  return (
                    <div key={provider.id} style={{
                      background: '#36393f', borderRadius: '10px', padding: '12px 14px',
                      border: selected ? '2px solid #5865F2' : '1px solid #444',
                    }}>
                      <div style={{ color: '#fff', fontSize: '0.92rem', fontWeight: 600 }}>{provider.displayName}</div>
                      <div style={{ color: '#aaa', fontSize: '0.78rem', marginTop: '2px' }}>
                        Pick your billing option on {provider.displayName}'s checkout page.
                      </div>
                      <button onClick={() => setSelectionKey(key)}
                        style={{
                          marginTop: '10px',
                          background: selected ? 'linear-gradient(135deg, #5865F2, #4752C4)' : '#40444b',
                          color: '#fff', border: 'none', padding: '7px 14px', borderRadius: '6px',
                          cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem',
                        }}>
                        {selected ? '✓ Selected' : `Subscribe via ${provider.displayName}`}
                      </button>
                    </div>
                  );
                }
                return (
                  <div key={provider.id} style={{
                    background: '#36393f', borderRadius: '10px', padding: '12px 14px',
                    border: '1px solid #444',
                  }}>
                    <div style={{ color: '#fff', fontSize: '0.92rem', fontWeight: 600, marginBottom: '8px' }}>
                      {provider.displayName}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                      {variants.map(v => {
                        const key = `${provider.id}:${v.variantId}`;
                        const selected = selectionKey === key;
                        return (
                          <div key={v.variantId} onClick={() => setSelectionKey(key)}
                            style={{
                              background: selected ? 'rgba(88, 101, 242, 0.18)' : '#1a1a1a',
                              border: selected ? '2px solid #5865F2' : '1px solid #444',
                              borderRadius: '8px', padding: '8px 12px', cursor: 'pointer',
                              transition: 'border-color 0.12s, background 0.12s',
                            }}>
                            <div style={{ color: '#fff', fontSize: '0.86rem', fontWeight: 600 }}>{variantDisplayLabel(link, v)}</div>
                            <div style={{ color: '#ddd', fontSize: '0.86rem' }}>
                              <strong>{(v.amount / 100).toFixed(2)} {v.currency}</strong>
                              <span style={{ color: '#888', marginLeft: '4px', fontSize: '0.75rem' }}>{variantPeriodLabel(v)}</span>
                            </div>
                            {v.recurring && (
                              <div style={{ color: '#3ba55d', fontSize: '0.7rem', marginTop: '2px' }}>auto-renewable</div>
                            )}
                            {v.trialDays && (
                              <div style={{ color: '#7289da', fontSize: '0.7rem', marginTop: '2px' }}>
                                {v.trialDays}-day trial
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </React.Fragment>
        )}

        {canOptOutAutoRenew && (
          <label style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            marginTop: '14px', color: '#ddd', fontSize: '0.85rem', cursor: 'pointer',
          }}>
            <input type="checkbox" checked={autoRenewOptOut}
              onChange={e => setAutoRenewOptOut(e.target.checked)}
              style={{ cursor: 'pointer' }} />
            Buy as a one-time purchase (do not auto-renew)
          </label>
        )}

        {selectedProvider?.capabilities?.supportsCoupons && (
          <React.Fragment>
            <label style={labelStyle}>Coupon (optional)</label>
            <input type="text" style={inputStyle} value={couponCode}
              onChange={e => { setCouponCode(e.target.value); setCouponPreview(null); }}
              onBlur={handleCouponBlur}
              placeholder={`Enter ${selectedProvider.displayName} coupon code`} />
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
          <button onClick={handleSubmit} disabled={!offering || !selectedProviderId || !selectedVariantId || saving || !!successMsg} style={{
            background: (!offering || !selectedProviderId || !selectedVariantId || saving || successMsg) ? '#555' : 'linear-gradient(135deg, #5865F2, #4752C4)',
            color: '#fff', border: 'none', padding: '9px 20px', borderRadius: '6px',
            cursor: (!offering || !selectedProviderId || !selectedVariantId || saving || successMsg) ? 'not-allowed' : 'pointer', fontWeight: 600,
          }}>{saving ? 'Processing…' : successMsg ? 'Subscribed' : 'Subscribe'}</button>
        </div>
      </div>
    </div>
  );
}

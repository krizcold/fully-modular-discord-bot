/**
 * The master's synchronous posture (PLAN_REPLICATION 20.5, B6 map F12-F17, F24).
 *
 * Active mode promises that a stand-in's data IS the truth, which is only
 * honest if the master was already waiting for that copy before it died. So
 * the master's own bot holds synchronous_standby_names on its own primary
 * while, and only while, one designated active backup is provably keeping up,
 * and drops it the instant that stops being true. The manager is not involved:
 * this must work in a hand-deployed fleet, and the relax has to be immediate
 * (F12).
 *
 * Four properties the rest of this file exists to hold:
 *
 *  - THE CONNECTION IS DEDICATED. An armed cluster stalls every write, so a
 *    relax issued through a pool would queue behind the very stall it is
 *    trying to end. Nothing else may share it. Neither statement it runs
 *    writes WAL, so both return against a fully stalled backend.
 *  - THE KEY IS VERIFIED, NEVER ASSUMED. application_name is only the slot
 *    name as a side effect of how the manager seeds, and naming a copy that
 *    is not there hangs every fleet write with NO timeout of any kind
 *    (measured: statement_timeout is disabled before the commit's wait
 *    begins). So the master arms only a name it has SEEN streaming,
 *    cross-checked against the slot that node reports in its heartbeat (F13).
 *  - THE DROP DETECTOR CANNOT USE "WAL IS ADVANCING". During a stall no WAL
 *    advances, because every writer is blocked; the signal is a GAP that stops
 *    closing, not a gap that appears (F16).
 *  - THE DATABASE, NOT THIS PROCESS, IS THE AUTHORITY ON WHAT IS ARMED. Every
 *    poll re-reads the live setting and corrects this engine's own idea of it,
 *    because a state variable that says "relaxed" while the cluster is armed
 *    would disable every path that could relax it.
 *
 * The budget this pays for is ruled: about one to two seconds of fleet-wide
 * write stall on a drop (F3).
 */

import { Client } from 'pg';
import { armSyncPosture, isArmableSlotName, relaxSyncPosture } from './syncPosture';
import { clearSyncWaitCancel, getSyncWaitCancel } from '../utils/syncWaitCancel';

/** F16's "about 1 s". The clean-drop budget is one of these plus the relax round trip. */
const POLL_MS = 1000;

/**
 * How far behind a copy may be at the moment of arming (F17). The first commit
 * after an arm waits for the standby to flush up to that commit, so this is
 * the arm's own worst-case contribution to a stall.
 */
const ARM_MAX_GAP_BYTES = 1024 * 1024;

/** An arm that never reaches sync_state='sync' relaxes and reports rather than waiting (F17). */
const ARM_TIMEOUT_MS = 10_000;

/** Consecutive polls with an unclosing gap before the posture drops; the stall budget's second term. */
const STALL_TICKS = 2;

/** After any drop, the quiet period before this master pays the stall price again. */
const REARM_COOLDOWN_MS = 30_000;

/**
 * Consecutive polls a copy must have been streaming before it may be armed.
 * Counted PER CANDIDATE: a permanently broken first-priority backup must cost
 * a healthy second-priority one nothing, which a shared cooldown could not do.
 */
const STEADY_TICKS = 2;

/**
 * How long after this engine's own write the reconcile leaves the setting
 * alone. Measured, a reload IS visible to this session on its very next query,
 * so this is margin rather than a known lag: the cost of being wrong here is a
 * relax the fleet did not need, every poll.
 */
const RECONCILE_GRACE_MS = 3000;

/**
 * Lowered from the one-minute default so a vanished machine's walsender is
 * torn down promptly, which is what makes "the row is gone" a timely signal
 * rather than a blind minute (F16). It is NOT a bound on the stall itself:
 * measured, a commit waiting on a named copy with no walsender at all waits
 * forever. Twice the standby's default status interval, the relationship
 * postgres documents: at the interval itself a healthy WAN link would be torn
 * down as readily as a dead one.
 */
const WAL_SENDER_TIMEOUT_MS = 20_000;

/** Commit levels under which a commit actually waits for a standby; the rest make the posture a decoration (F15). */
const DURABLE_COMMIT_LEVELS = ['on', 'remote_write', 'remote_apply'];

const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 4000;

/** How long stop() waits for a tick that is already mid-arm before relaxing anyway. */
const STOP_FENCE_MS = 6000;

/**
 * How often an unchanged ARMED posture is re-attested (B6 map F23). Each
 * refresh moves the position the guarantee reaches, and while armed the write
 * that carries it is itself synchronous, which is what makes the standby's
 * replayed copy of it evidence.
 */
const PUBLISH_REFRESH_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

export type SyncPostureState = 'relaxed' | 'arming' | 'armed';

export interface SyncPostureStatus {
  state: SyncPostureState;
  /** The copy currently named, or being named; null while relaxed. */
  slotName: string | null;
  nodeId: string | null;
  /** When the state was entered. */
  since: number;
  /** Why the posture last dropped, for the operator and for the fact B6-d publishes. */
  lastDrop: { reason: string; at: number } | null;
}

export interface SyncPostureTarget {
  nodeId: string;
  slotName: string;
}

export interface SyncPostureEngine {
  getStatus(): SyncPostureStatus;
  /** Relax and stop. Awaited where the caller can, fire-and-forget where it cannot. */
  stop(): Promise<void>;
}

/**
 * One poll. The LEFT JOIN is what makes this always return exactly one row:
 * the settings and the write position have to be readable in the tick where
 * no candidate is streaming at all, which is precisely a drop.
 */
const SAMPLE_SQL = `
  SELECT (SELECT CASE WHEN pg_is_in_recovery() THEN NULL ELSE pg_current_wal_lsn()::text END) AS current_lsn,
         current_setting('synchronous_standby_names') AS armed_names,
         current_setting('synchronous_commit') AS commit_level,
         r.application_name,
         r.state,
         r.sync_state,
         r.flush_lsn::text AS flush_lsn,
         CASE WHEN r.flush_lsn IS NULL OR pg_is_in_recovery() THEN NULL
              ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), r.flush_lsn) END AS gap_bytes,
         CASE WHEN r.flush_lsn IS NULL OR $2::pg_lsn IS NULL THEN NULL
              ELSE pg_wal_lsn_diff(r.flush_lsn, $2::pg_lsn) END AS barrier_bytes
    FROM (SELECT 1) AS one
    LEFT JOIN pg_stat_replication r ON r.application_name = ANY($1::text[])`;

interface Link {
  state: string;
  syncState: string;
  flushLsn: string | null;
  gapBytes: number | null;
  barrierBytes: number | null;
}

interface Sample {
  currentLsn: string | null;
  armedNames: string;
  commitLevel: string;
  links: Map<string, Link>;
}

export function startSyncPostureEngine(inputs: {
  /** Every backup this master may arm for, highest priority first; empty when none qualifies. */
  targets: () => SyncPostureTarget[];
  /** This node's own primary; re-read every tick because a repoint replaces it. */
  url: () => string | null;
  /**
   * Record what this master is attesting. Called fire and forget, never
   * awaited: the watchdog owes the fleet a relax within a second and must not
   * queue behind a control-store write to deliver it. The caller stamps
   * identity and serialises, because publishes can overtake each other.
   */
  publish?: (fact: { state: 'armed' | 'relaxed'; slotName: string | null; nodeId: string | null; heldToLsn: string | null }) => void;
}): SyncPostureEngine {
  let client: Client | null = null;
  let clientUrl = '';
  let state: SyncPostureState = 'relaxed';
  let since = Date.now();
  let named: SyncPostureTarget | null = null;
  let armedAt = 0;
  let wroteAt = 0;
  let lastDrop: { reason: string; at: number } | null = null;
  let lastFlushLsn: string | null = null;
  let frozenTicks = 0;
  let cooldownUntil = 0;
  /**
   * Set when a wait was cancelled: the copy is no longer known to hold every
   * acknowledged write, so re-arming needs proof it has passed the position
   * the primary had reached at that moment, not merely that it is close (F24).
   */
  let caughtUpBarrier: string | null = null;
  let handledCancelAt = 0;
  /** Consecutive streaming polls per candidate slot; reset the moment one is not streaming. */
  const steadyTicks = new Map<string, number>();
  let complainedAboutCommitLevel = '';
  let publishedAt = 0;
  let stopped = false;
  let ticking = false;

  const enter = (next: SyncPostureState, target: SyncPostureTarget | null): void => {
    state = next;
    named = target;
    since = Date.now();
  };

  const closeClient = async (): Promise<void> => {
    const dying = client;
    client = null;
    clientUrl = '';
    if (dying) await dying.end().catch(() => { /* already gone */ });
  };

  const connect = async (url: string): Promise<Client | null> => {
    if (client && clientUrl === url) return client;
    await closeClient();
    const fresh = new Client({
      connectionString: url,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      keepAlive: true,
    });
    // An idle-client error on a dedicated connection must never reach the
    // process's unhandled path; the next tick reconnects.
    fresh.on('error', () => { /* surfaced by the next query */ });
    try {
      await fresh.connect();
    } catch (error) {
      await fresh.end().catch(() => { /* never connected */ });
      if (state !== 'relaxed') {
        console.error(`[Fleet] SYNC POSTURE: armed on ${named?.slotName} but the watchdog connection is down, so it cannot be relaxed from here: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
    client = fresh;
    clientUrl = url;
    return fresh;
  };

  /** Returns true once the cluster is actually relaxed; false leaves the state alone so every later tick retries. */
  const drop = async (live: Client, reason: string): Promise<boolean> => {
    const was = named;
    try {
      await relaxSyncPosture(live);
    } catch (error) {
      // Deliberately keeps the state: until this lands the fleet's writes are
      // still waiting on a copy that is gone.
      console.error(`[Fleet] SYNC POSTURE: could not relax after ${reason}; fleet writes stay stalled until this succeeds: ${error instanceof Error ? error.message : String(error)}`);
      await closeClient();
      return false;
    }
    wroteAt = Date.now();
    // AFTER the relax landed, never before: writing this while still armed
    // would be a synchronous write waiting on the copy that just went away,
    // so the disarm would hang on itself.
    publishedAt = Date.now();
    inputs.publish?.({ state: 'relaxed', slotName: null, nodeId: null, heldToLsn: null });
    lastDrop = { reason, at: Date.now() };
    cooldownUntil = Date.now() + REARM_COOLDOWN_MS;
    frozenTicks = 0;
    lastFlushLsn = null;
    enter('relaxed', null);
    console.warn(`[Fleet] SYNC POSTURE RELAXED (${reason}); writes no longer wait for ${was?.slotName ?? 'any copy'} and the fleet is back to asynchronous replication`);
    return true;
  };

  const sample = async (live: Client, names: string[]): Promise<Sample | null> => {
    try {
      const res = await live.query(SAMPLE_SQL, [names, caughtUpBarrier]);
      const links = new Map<string, Link>();
      for (const row of res.rows) {
        const name = row.application_name === null || row.application_name === undefined ? '' : String(row.application_name);
        if (name === '') continue;
        const link: Link = {
          state: String(row.state || ''),
          syncState: String(row.sync_state || ''),
          flushLsn: row.flush_lsn === null || row.flush_lsn === undefined ? null : String(row.flush_lsn),
          gapBytes: row.gap_bytes === null || row.gap_bytes === undefined ? null : Number(row.gap_bytes),
          barrierBytes: row.barrier_bytes === null || row.barrier_bytes === undefined ? null : Number(row.barrier_bytes),
        };
        // Two walsenders can share an application_name across a reconnect; the
        // least advanced one is the honest answer about what the copy holds.
        const seen = links.get(name);
        if (!seen || (link.gapBytes ?? Number.MAX_SAFE_INTEGER) > (seen.gapBytes ?? Number.MAX_SAFE_INTEGER)) links.set(name, link);
      }
      const first = res.rows[0] ?? {};
      return {
        currentLsn: first.current_lsn === null || first.current_lsn === undefined ? null : String(first.current_lsn),
        armedNames: String(first.armed_names ?? ''),
        commitLevel: String(first.commit_level ?? ''),
        links,
      };
    } catch (error) {
      console.warn(`[Fleet] SYNC POSTURE: could not read the primary's replication view: ${error instanceof Error ? error.message : String(error)}`);
      await closeClient();
      return null;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const url = (inputs.url() || '').trim();
      if (!url) return;
      const live = await connect(url);
      if (!live) return;

      const candidates = inputs.targets().filter(t => isArmableSlotName(t.slotName));
      const watched = state === 'relaxed' || !named ? candidates : [named, ...candidates.filter(c => c.slotName !== named!.slotName)];
      const now = await sample(live, watched.map(t => t.slotName));
      if (!now) return;

      // The cluster is the authority on what is armed. Outside the window
      // where this engine's own write is still propagating, a disagreement is
      // corrected here, before anything reads state as a fact.
      if (Date.now() - wroteAt > RECONCILE_GRACE_MS) {
        if (state !== 'relaxed' && now.armedNames.trim() === '') {
          // A relax, not just a re-label: the setting reads empty while an arm
          // that wrote auto.conf and never reached its reload would ALSO read
          // empty, and only a RESET clears that copy off the volume.
          console.warn('[Fleet] SYNC POSTURE: the database does not report the posture this node armed; relaxing to be sure nothing is left on the volume');
          await drop(live, 'the live setting disagreed with the armed posture');
          return;
        }
        if (state === 'relaxed' && now.armedNames.trim() !== '') {
          // Nothing else in either repo writes this setting, so it is either a
          // half-finished arm of this engine's or an operator's; either way the
          // master owns it and nothing is watching it.
          console.error(`[Fleet] SYNC POSTURE: the database is armed (${now.armedNames.trim()}) with nothing watching it; relaxing`);
          await drop(live, 'an armed posture was found with no watchdog behind it');
          return;
        }
      }

      // A cancelled wait means an acknowledged write may live on this machine
      // alone, so the posture stops meaning what it claims immediately (F24).
      // The barrier is read from THIS tick: the cancelled commit is at or
      // before the primary's position now, never after it.
      const cancel = getSyncWaitCancel();
      if (cancel && cancel.at > handledCancelAt) {
        if (now.currentLsn !== null) caughtUpBarrier = now.currentLsn;
        // The latch is only consumed once the disarm it demanded has landed;
        // it is the one drop reason no later sample can re-derive.
        if (state !== 'relaxed' && !(await drop(live, 'a write\'s synchronous wait was cancelled'))) return;
        handledCancelAt = cancel.at;
        // Only the latch that was acted on: the drop above is awaited, and a
        // cancel raised while it ran is a different hole that still needs one.
        if (getSyncWaitCancel()?.at === cancel.at) clearSyncWaitCancel();
      }

      if (!DURABLE_COMMIT_LEVELS.includes(now.commitLevel)) {
        // sync_state reports a standby's RANK in the name list and reads 'sync'
        // regardless, so without this the engine would publish a guarantee that
        // the commit level had already cancelled.
        if (state !== 'relaxed') {
          await drop(live, `synchronous_commit is '${now.commitLevel}', so commits never wait for a standby`);
          return;
        }
        if (complainedAboutCommitLevel !== now.commitLevel) {
          complainedAboutCommitLevel = now.commitLevel;
          console.warn(`[Fleet] SYNC POSTURE: not arming because synchronous_commit is '${now.commitLevel}'; active mode needs a commit level that waits (on, remote_write or remote_apply)`);
        }
        return;
      }
      complainedAboutCommitLevel = '';

      if (state !== 'relaxed' && named) {
        if (!candidates.some(c => c.slotName === named!.slotName)) {
          await drop(live, 'the copy it was standing by for is no longer an eligible active backup');
          return;
        }
        const link = now.links.get(named.slotName);
        if (!link) {
          lastFlushLsn = null;
          await drop(live, 'the standby stopped streaming');
          return;
        }
        if (link.state !== 'streaming') {
          lastFlushLsn = link.flushLsn;
          await drop(live, `the standby left streaming (${link.state || 'unknown'})`);
          return;
        }
        // The gap is the whole detector: an unclosing one is what a stall
        // looks like from here, and an idle fleet's gap is zero, so silence
        // never trips it.
        if (link.gapBytes !== null && link.gapBytes > 0 && link.flushLsn !== null && link.flushLsn === lastFlushLsn) frozenTicks += 1;
        else frozenTicks = 0;
        lastFlushLsn = link.flushLsn;
        if (frozenTicks >= STALL_TICKS) {
          await drop(live, `the standby stopped acknowledging writes (${link.gapBytes} bytes behind and not moving)`);
          return;
        }
        if (state === 'armed' && Date.now() - publishedAt >= PUBLISH_REFRESH_MS && now.currentLsn) {
          publishedAt = Date.now();
          inputs.publish?.({ state: 'armed', slotName: named.slotName, nodeId: named.nodeId, heldToLsn: now.currentLsn });
        }
        if (state === 'arming') {
          if (link.syncState === 'sync') {
            enter('armed', named);
            publishedAt = Date.now();
            inputs.publish?.({ state: 'armed', slotName: named.slotName, nodeId: named.nodeId, heldToLsn: now.currentLsn });
            console.log(`[Fleet] SYNC POSTURE ARMED on ${named.slotName}: fleet writes now wait for that copy, and a drop costs about a second of stall`);
          } else if (Date.now() - armedAt > ARM_TIMEOUT_MS) {
            await drop(live, `the standby never reached synchronous state within ${Math.round(ARM_TIMEOUT_MS / 1000)}s`);
          }
        }
        return;
      }

      // Relaxed: the first candidate, in the operator's priority order, that
      // is actually streaming and close enough to arm without a long first
      // wait. A broken one is skipped rather than blocking the rest (F14).
      let choice: { target: SyncPostureTarget; link: Link } | null = null;
      for (const [slotName] of steadyTicks) {
        if (!candidates.some(c => c.slotName === slotName)) steadyTicks.delete(slotName);
      }
      for (const candidate of candidates) {
        const link = now.links.get(candidate.slotName);
        if (!link || link.state !== 'streaming') { steadyTicks.set(candidate.slotName, 0); continue; }
        const steady = (steadyTicks.get(candidate.slotName) ?? 0) + 1;
        steadyTicks.set(candidate.slotName, steady);
        // Every candidate's streak is counted, not just the winner's, so the
        // one below a broken backup is already proven when its turn comes.
        if (choice || steady < STEADY_TICKS) continue;
        if (link.gapBytes === null || link.gapBytes > ARM_MAX_GAP_BYTES) continue;
        // Both gates, never one instead of the other: the barrier says the copy
        // holds the cancelled write, the bound says arming will not itself
        // stall the fleet.
        if (caughtUpBarrier !== null && (link.barrierBytes === null || link.barrierBytes < 0)) continue;
        choice = { target: candidate, link };
      }
      if (!choice || Date.now() < cooldownUntil || stopped) return;

      // The state is entered BEFORE the write, so a half-applied arm is a state
      // every relax path can still see. The reverse order would let one failed
      // statement leave the cluster armed with the engine recording 'relaxed',
      // which disables every path that could undo it.
      armedAt = Date.now();
      wroteAt = Date.now();
      frozenTicks = 0;
      lastFlushLsn = choice.link.flushLsn;
      enter('arming', choice.target);
      try {
        await armSyncPosture(live, choice.target.slotName, WAL_SENDER_TIMEOUT_MS);
      } catch (error) {
        console.error(`[Fleet] SYNC POSTURE: arming on ${choice.target.slotName} failed: ${error instanceof Error ? error.message : String(error)}`);
        await drop(live, 'the arm did not complete');
        return;
      }
      caughtUpBarrier = null;
      console.log(`[Fleet] SYNC POSTURE arming on ${choice.target.slotName} (${choice.link.gapBytes} bytes behind, streaming): waiting for postgres to report it synchronous`);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  void tick();

  return {
    getStatus: () => ({
      state,
      slotName: named?.slotName ?? null,
      nodeId: named?.nodeId ?? null,
      since,
      lastDrop,
    }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Fence a tick that is already mid-arm: its write would otherwise land
      // AFTER the relax below and leave the cluster armed with nothing running.
      for (let waited = 0; ticking && waited < STOP_FENCE_MS; waited += 25) await sleep(25);
      // Unconditional: this engine's own state cannot be trusted to say what
      // is on the cluster, and a master that stops being one must leave
      // nothing armed behind it. The next boot's clear is the backstop, not
      // the plan.
      const url = (inputs.url() || '').trim();
      const live = url ? await connect(url) : null;
      let relaxed = false;
      if (live) {
        relaxed = await relaxSyncPosture(live).then(() => true).catch(error => {
          console.error(`[Fleet] SYNC POSTURE: could not relax while standing down; the next master boot clears it: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        });
      }
      // Only once the relax has landed, for drop()'s reason: on a cluster that
      // is still armed this publish is a synchronous write waiting on a copy
      // that may be gone, so it would hang the shutdown instead of ending it.
      if (relaxed) inputs.publish?.({ state: 'relaxed', slotName: null, nodeId: null, heldToLsn: null });
      enter('relaxed', null);
      await closeClient();
    },
  };
}

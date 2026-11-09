// @ts-check
/**
 * The oracle's verdict engine (VERIFY.md section 5.3). Pure: writer logs and
 * copies in, verdicts out.
 *
 * Time is compared only inside one writer log (one process, one monotonic
 * clock), never across logs or hosts [A16]. A copy is one view of the run's
 * docs: a database listing (complete: a key it lacks is absent) or reads
 * through a node's app path (a key it did not read is unknown). A judged copy
 * must hold every acknowledged effect; a lagging copy (an async standby) is
 * judged only for content, phantoms and divergence.
 *
 * The result is FAIL on any verdict, INCONCLUSIVE when something needed to
 * judge the run is missing, and PASS only when nothing is.
 *
 * A writer's file log gets each line before the request it names goes out,
 * so even a killed writer's file holds every request it sent. A streamed
 * copy can be cut on its way, losing requests the store still saw, so one
 * with no end line is refused.
 */
import { MARK, hashOf, presentState } from './oracle.mjs';

/** @typedef {import('./oracle.mjs').AnswerClass} AnswerClass */
/** @typedef {import('./oracle.mjs').DocState} DocState */
/** @typedef {import('./oracle.mjs').FleetFacts} FleetFacts */
/**
 * @typedef {{ log: number, id: number, lane: string, op: 'write' | 'delete', kind: 'u' | 'h', key: string, c: number,
 *   h: string | null, at: number, cls: AnswerClass, definite: boolean, ansAt: number, status: number, remote?: boolean }} Op
 * @typedef {{ log: number, id: number, lane: string, key: string, kind: 'u' | 'h', at0: number, at1: number, state: DocState }} Read
 * @typedef {{ log: number, name: string, begin: number, end: number }} Window
 * @typedef {{ kind: 'u' | 'h', writes: Op[], deletes: Op[] }} KeyHistory
 * @typedef {{ run: string, guild: string, keys: Map<string, KeyHistory>, reads: Read[], windows: Window[], ops: Op[],
 *   logs: { lanes: string[], ended: boolean, startedAt: string | null, endedAt: string | null }[], problems: string[] }} History
 * @typedef {{ name: string, mode: 'judged' | 'lagging', complete: boolean, docs: Map<string, DocState>,
 *   run?: string, guild?: string, sample?: boolean }} Copy
 * @typedef {{ v: string, key?: string, copy?: string, during?: boolean, detail: string }} Verdict
 * @typedef {{ id: string, op: string, state: string, key: string | null, h: string | null, taken: boolean, reply: string | null }} RequestRow
 * @typedef {{ name: string, rows: RequestRow[], snapshots?: string[] }} RequestListing
 * @typedef {'none' | 'open' | 'ok' | 'held' | 'refused'} RequestOutcome
 */

export const VERDICTS = ['LOST', 'ROLLBACK', 'FORK', 'PHANTOM', 'HELD-MISSING', 'RESURRECTED', 'WRONG-CONTENT', 'CONTROL', 'TWICE', 'FALSE-ANSWER'];
/** The slowest marks poll whose window edges are still judged, in ms. */
const MARKS_EVERY_MAX = 1000;

/**
 * @param {any[][]} logs parsed events, one array per writer log
 * @returns {History}
 */
export function buildHistory(logs) {
  /** @type {Map<string, KeyHistory>} */
  const keys = new Map();
  /** @type {Read[]} */
  const reads = [];
  /** @type {Window[]} */
  const windows = [];
  /** @type {Op[]} */
  const ops = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<string>} */
  const runs = new Set();
  /** @type {Set<string>} */
  const guilds = new Set();
  /** @type {Map<string, number>} */
  const laneLog = new Map();
  /** @type {{ lanes: string[], ended: boolean, startedAt: string | null, endedAt: string | null }[]} */
  const logInfo = [];

  logs.forEach((events, log) => {
    const start = events.find(e => e.t === 'start');
    if (!start) throw new Error(`log ${log + 1} has no start line`);
    runs.add(start.run);
    guilds.add(start.guild);
    const lanes = start.lanes.map((/** @type {{ name: string }} */ l) => l.name);
    for (const lane of lanes) {
      if (laneLog.has(lane)) throw new Error(`lane ${lane} appears in two logs; lane names must differ across writers`);
      laneLog.set(lane, log);
    }
    const ended = events.some(e => e.t === 'end');
    if (start.sink !== 'file' && start.sink !== 'stream') throw new Error(`log ${log + 1}'s start line names no sink ('file' or 'stream')`);
    if (!ended && start.sink === 'stream') {
      throw new Error(`log ${log + 1} is a streamed copy with no end line, which may have lost requests the store saw: judge the writer's own log file instead`);
    }
    const endLine = events.find(e => e.t === 'end');
    logInfo.push({
      lanes, ended,
      startedAt: typeof start.startedAt === 'string' ? start.startedAt : null,
      endedAt: typeof endLine?.endedAt === 'string' ? endLine.endedAt : null,
    });

    /** @type {Map<number, any>} */
    const answers = new Map();
    for (const e of events) if (e.t === 'ans') answers.set(e.id, e);
    /** @type {Map<string, number>} */
    const open = new Map();
    let last = 0;
    for (const e of events) {
      if (typeof e.at === 'number') last = Math.max(last, e.at);
      if (typeof e.at1 === 'number') last = Math.max(last, e.at1);
      if (e.t === 'send') {
        const ans = answers.get(e.id);
        /** @type {Op} */
        const op = {
          log, id: e.id, lane: e.lane, op: e.op, kind: e.kind, key: e.key, c: e.c, h: e.h ?? null, at: e.at,
          // A send with no answer in the log is unknown: it may have landed.
          cls: ans ? ans.cls : 'UNKNOWN',
          definite: ans ? ans.definite === true : false,
          ansAt: ans ? ans.at : Infinity,
          status: ans ? ans.status : 0,
          // Answered with the name of the machine that ran it: the send went through a request row.
          remote: ans ? ans.remote === true : false,
        };
        ops.push(op);
        let entry = keys.get(op.key);
        if (!entry) {
          entry = { kind: op.kind, writes: [], deletes: [] };
          keys.set(op.key, entry);
        }
        if (entry.kind !== op.kind) throw new Error(`key ${op.key} is both unique and hot`);
        (op.op === 'write' ? entry.writes : entry.deletes).push(op);
      } else if (e.t === 'read') {
        const state = /** @type {DocState} */ (e.s === 'present' ? { s: 'present', h: e.h } : e.s === 'absent' ? { s: 'absent' } : { s: 'error', err: e.err ?? '' });
        reads.push({ log, id: e.id, lane: e.lane, key: e.key, kind: e.kind, at0: e.at0, at1: e.at1, state });
      } else if (e.t === 'mark') {
        // A mark the checker cannot pair is a window it cannot judge [A13].
        const m = MARK.exec(e.label ?? '');
        if (!m) problems.push(`mark "${e.label}" in log ${log + 1} is not "begin NAME" or "end NAME"`);
        else if (m[1] === 'begin' && open.has(m[2])) problems.push(`window ${m[2]} in log ${log + 1} begins again before it ends`);
        else if (m[1] === 'begin') open.set(m[2], e.at);
        else if (!open.has(m[2])) problems.push(`window ${m[2]} in log ${log + 1} ends without a begin`);
        else {
          windows.push({ log, name: m[2], begin: /** @type {number} */ (open.get(m[2])), end: e.at });
          open.delete(m[2]);
        }
      }
    }
    // A window still open when the log ends is counted to its last line, but
    // its fault may have outlasted it, so it cannot pass.
    for (const [name, begin] of open) {
      windows.push({ log, name, begin, end: last });
      problems.push(`window ${name} in log ${log + 1} begins but never ends`);
    }
    // The end line's counts must match the lines above it: a log missing an
    // answer line would read an acknowledged write as unknown.
    const end = events.find(e => e.t === 'end');
    if (end?.counts) {
      /** @type {Record<string, number>} */
      const held = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0 };
      for (const e of events) {
        if (e.t === 'ans') held[e.cls] = (held[e.cls] ?? 0) + 1;
        if (e.t === 'read') {
          held.reads += 1;
          if (e.s === 'error') held.readErrors += 1;
        }
      }
      const mismatched = Object.keys(held).filter(key => end.counts[key] !== held[key]);
      if (mismatched.length > 0) {
        problems.push(`log ${log + 1}'s end line counts ${mismatched.map(key => `${key} ${end.counts[key]}`).join(', ')}, but its lines hold ${mismatched.map(key => `${key} ${held[key]}`).join(', ')}: lines are missing`);
      }
    }
    // Marks are stamped when the writer polls its marks file.
    const every = start.settings?.marksEvery ?? 50;
    if (every > MARKS_EVERY_MAX && events.some(e => e.t === 'mark')) {
      problems.push(`log ${log + 1} polled its marks every ${every} ms, so its window edges may be that late`);
    }
  });

  if (runs.size !== 1) throw new Error('the logs must hold exactly one run');
  if (guilds.size !== 1) throw new Error('the logs must hold exactly one guild');
  for (const [key, entry] of keys) {
    if (entry.kind === 'u' && entry.writes.length !== 1) throw new Error(`unique key ${key} was written ${entry.writes.length} times`);
  }
  return {
    run: [...runs][0], guild: [...guilds][0], keys, reads, windows, ops, logs: logInfo, problems,
  };
}

/** A definite refusal is the only answer that rules an effect out. @param {Op} op */
const possiblyApplied = op => !(op.cls === 'REFUSED' && op.definite);
/** @param {Op} op */
const committed = op => op.cls === 'ACKED' || op.cls === 'HELD';

/**
 * @param {Copy} copy
 * @param {string} key
 * @returns {DocState | undefined}
 */
function stateIn(copy, key) {
  const state = copy.docs.get(key);
  if (state) return state;
  return copy.complete ? { s: 'absent' } : undefined;
}

/**
 * The write whose content a present doc holds.
 * @param {KeyHistory} entry
 * @param {string} h
 */
const writeWithHash = (entry, h) => entry.writes.find(w => w.h === h);

/**
 * Hot-doc ordering: given the write `shown` that a read or copy holds, the
 * committed writes that must have replaced it. Same lane: a later counter
 * (the lane is sequential). Other lane in the same log: sent after `shown`
 * was answered, so it was applied after `shown` was.
 * @param {KeyHistory} entry
 * @param {Op} shown
 * @param {number} before only writes answered before this time (Infinity: all)
 */
function supersedersOf(entry, shown, before) {
  if (!committed(shown)) return [];
  return entry.writes.filter(w => committed(w) && w.ansAt < before && w !== shown && (
    (w.lane === shown.lane && w.c > shown.c)
    || (w.lane !== shown.lane && w.log === shown.log && w.at > shown.ansAt)));
}

/**
 * Committed writes that came after an unanswered write. If one of these was
 * answered and the doc still shows the unanswered write, it either landed
 * late or the doc rolled back to it: the checker cannot tell which.
 * @param {KeyHistory} entry
 * @param {Op} shown
 * @param {number} before
 */
function committedAfterUnanswered(entry, shown, before) {
  if (committed(shown)) return [];
  return entry.writes.filter(w => committed(w) && w.ansAt < before && w !== shown && (
    (w.lane === shown.lane && w.c > shown.c)
    || (w.lane !== shown.lane && w.log === shown.log && w.at > shown.ansAt)));
}

/**
 * @param {History} history
 * @param {Copy} copy
 * @returns {{ verdicts: Verdict[], unread: string[], reasons: string[] }}
 */
export function judgeCopy(history, copy) {
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {string[]} */
  const unread = [];
  /** @type {string[]} */
  const reasons = [];
  const judged = copy.mode === 'judged';
  const add = (/** @type {string} */ v, /** @type {string} */ key, /** @type {string} */ detail) => verdicts.push({ v, key, copy: copy.name, detail });

  for (const [key, entry] of history.keys) {
    const state = stateIn(copy, key);
    if (!state || state.s === 'error') {
      if (entry.writes.some(committed)) unread.push(key);
      continue;
    }
    if (entry.kind === 'u') {
      const w = entry.writes[0];
      const del = entry.deletes.find(possiblyApplied);
      if (state.s === 'present') {
        if (state.h !== w.h) add('WRONG-CONTENT', key, `holds content that was never written to it (write #${w.id} ${w.cls})`);
        else if (judged && del && del.cls === 'ACKED') add('RESURRECTED', key, `present after delete #${del.id} was acknowledged`);
        else if (judged && del && del.cls === 'HELD') add('HELD-MISSING', key, `present after delete #${del.id} was held`);
        else if (!possiblyApplied(w)) add('PHANTOM', key, `present though write #${w.id} was refused before applying (${w.status})`);
      } else if (judged && !del) {
        if (w.cls === 'ACKED') add('LOST', key, `absent though write #${w.id} was acknowledged`);
        else if (w.cls === 'HELD') add('HELD-MISSING', key, `absent though write #${w.id} was held`);
      }
      continue;
    }
    // Hot doc: whole-document writes from several lanes.
    if (state.s === 'present') {
      const shown = writeWithHash(entry, state.h);
      if (!shown) {
        add('WRONG-CONTENT', key, 'holds content that no lane wrote');
        continue;
      }
      if (!possiblyApplied(shown)) add('PHANTOM', key, `holds write #${shown.id} (${shown.lane} c=${shown.c}), refused before applying`);
      if (!judged) continue;
      const after = supersedersOf(entry, shown, Infinity);
      const acked = after.filter(w => w.cls === 'ACKED');
      if (acked.length > 0) {
        const same = acked.filter(w => w.lane === shown.lane);
        const w = same.length > 0 ? same[same.length - 1] : acked[acked.length - 1];
        add(w.lane === shown.lane ? 'ROLLBACK' : 'LOST', key,
          `holds ${shown.lane} c=${shown.c} (#${shown.id}) though ${w.lane} c=${w.c} (#${w.id}) was acknowledged after it`);
      } else if (after.length > 0) {
        const w = after[after.length - 1];
        add('HELD-MISSING', key, `holds ${shown.lane} c=${shown.c} (#${shown.id}) though ${w.lane} c=${w.c} (#${w.id}) was held after it`);
      }
      const late = committedAfterUnanswered(entry, shown, Infinity);
      if (late.length > 0) {
        reasons.push(`${copy.name} ${key} holds unanswered write #${shown.id} though #${late[late.length - 1].id} was committed after it: a late landing or a rollback`);
      }
    } else if (judged) {
      const acked = entry.writes.filter(w => w.cls === 'ACKED');
      const held = entry.writes.filter(w => w.cls === 'HELD');
      if (acked.length > 0) add('LOST', key, `absent though ${acked.length} writes were acknowledged (last #${acked[acked.length - 1].id})`);
      else if (held.length > 0) add('HELD-MISSING', key, `absent though ${held.length} writes were held`);
    }
  }

  // A database listing also shows docs of this run that no writer sent.
  if (copy.complete) {
    for (const [key, state] of copy.docs) {
      if (!history.keys.has(key) && state.s === 'present') add('PHANTOM', key, 'a doc of this run that no writer sent');
    }
  }
  return { verdicts, unread, reasons };
}

/**
 * Reads made during the scenario through each lane's own app path [A15].
 * Order is judged on the writer's clock: an effect counts only when its
 * answer came before the read was sent.
 * @param {History} history
 * @returns {{ verdicts: Verdict[], reasons: string[] }}
 */
export function judgeReads(history) {
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {string[]} */
  const reasons = [];
  for (const r of history.reads) {
    const entry = history.keys.get(r.key);
    if (!entry || r.state.s === 'error') continue;
    const add = (/** @type {string} */ v, /** @type {string} */ detail) => verdicts.push({ v, key: r.key, copy: `read #${r.id} via ${r.lane}`, during: true, detail });
    const sameLog = (/** @type {Op} */ op) => op.log === r.log;
    if (entry.kind === 'u') {
      const w = entry.writes[0];
      if (!sameLog(w)) continue;
      const delSent = entry.deletes.find(d => d.at <= r.at1 && possiblyApplied(d));
      const delDone = entry.deletes.find(d => d.cls === 'ACKED' && d.ansAt < r.at0);
      if (r.state.s === 'present') {
        if (r.state.h !== w.h) add('WRONG-CONTENT', `served content never written to it (write #${w.id})`);
        else if (delDone) add('RESURRECTED', `served after delete #${delDone.id} was acknowledged`);
      } else if (w.cls === 'ACKED' && w.ansAt < r.at0 && !delSent) {
        add('LOST', `served as absent after write #${w.id} was acknowledged`);
      }
      continue;
    }
    if (r.state.s === 'present') {
      const shown = writeWithHash(entry, r.state.h);
      if (!shown) {
        add('WRONG-CONTENT', 'served content that no lane wrote');
        continue;
      }
      if (shown.log !== r.log) continue;
      const after = supersedersOf(entry, shown, r.at0).filter(w => w.cls === 'ACKED' && w.log === r.log);
      if (after.length > 0) {
        const same = after.filter(w => w.lane === shown.lane);
        const w = same.length > 0 ? same[same.length - 1] : after[after.length - 1];
        add(w.lane === shown.lane ? 'ROLLBACK' : 'LOST',
          `served ${shown.lane} c=${shown.c} (#${shown.id}) after ${w.lane} c=${w.c} (#${w.id}) was acknowledged`);
      }
      const late = committedAfterUnanswered(entry, shown, r.at0).filter(w => w.cls === 'ACKED' && w.log === r.log);
      if (late.length > 0) {
        reasons.push(`read #${r.id} via ${r.lane} served unanswered write #${shown.id} of ${r.key} after #${late[late.length - 1].id} was acknowledged: a late landing or a rollback`);
      }
    } else {
      const acked = entry.writes.filter(w => w.cls === 'ACKED' && w.log === r.log && w.ansAt < r.at0);
      if (acked.length > 0) add('LOST', `served as absent after write #${acked[acked.length - 1].id} was acknowledged`);
    }
  }
  return { verdicts, reasons };
}

/**
 * Divergence between copies: each holds a live unique doc the other lacks,
 * which lag alone cannot explain (unique docs are only added, and deleted
 * docs are left out). Copies named in `agree` must also match key for key.
 * @param {History} history
 * @param {Copy[]} copies
 * @param {string[]} agree
 * @returns {Verdict[]}
 */
export function judgeForks(history, copies, agree) {
  /** @type {Verdict[]} */
  const verdicts = [];
  const live = [...history.keys].filter(([, e]) => e.kind === 'u' && e.deletes.length === 0).map(([k]) => k);
  for (let i = 0; i < copies.length; i++) {
    for (let j = i + 1; j < copies.length; j++) {
      const A = copies[i];
      const B = copies[j];
      /** @type {string[]} */
      const onlyA = [];
      /** @type {string[]} */
      const onlyB = [];
      for (const key of live) {
        const a = stateIn(A, key);
        const b = stateIn(B, key);
        if (!a || !b || a.s === 'error' || b.s === 'error') continue;
        if (a.s === 'present' && b.s === 'absent') onlyA.push(key);
        if (b.s === 'present' && a.s === 'absent') onlyB.push(key);
      }
      if (onlyA.length > 0 && onlyB.length > 0) {
        verdicts.push({
          v: 'FORK', copy: `${A.name} | ${B.name}`,
          detail: `${A.name} alone holds ${onlyA.length} docs (${onlyA.slice(0, 3).join(', ')}) and ${B.name} alone holds ${onlyB.length} (${onlyB.slice(0, 3).join(', ')})`,
        });
      }
    }
  }
  const group = copies.filter(c => agree.includes(c.name));
  for (const name of agree) if (!group.some(c => c.name === name)) throw new Error(`--agree names ${name}, which is no copy`);
  for (let i = 1; i < group.length; i++) {
    /** @type {string[]} */
    const differ = [];
    for (const key of history.keys.keys()) {
      const a = stateIn(group[0], key);
      const b = stateIn(group[i], key);
      if (!a || !b || a.s === 'error' || b.s === 'error') continue;
      if (a.s !== b.s || (a.s === 'present' && b.s === 'present' && a.h !== b.h)) differ.push(key);
    }
    if (differ.length > 0) {
      verdicts.push({ v: 'FORK', copy: `${group[0].name} | ${group[i].name}`, detail: `copies that must agree differ on ${differ.length} docs (${differ.slice(0, 3).join(', ')})` });
    }
  }
  return verdicts;
}

/**
 * @typedef {{ holders: Map<string, Set<string>>, owners: Map<string, Set<string>>, counts: Map<string, Set<string>>,
 *   guildShards: Map<string, Set<string>>, outOfRange: Map<string, Set<string>>,
 *   unleased: Map<string, Set<string>>, claims: Map<string, Set<string>>, stale: Map<string, Set<string>> }} ControlFacts
 * @typedef {Map<string, { claim: number, process: string, released: boolean }>} ClaimsListing keyed by "count shard"
 */

/**
 * Who reports the facts: the process (decision 3: a process id is minted at
 * each boot), named with its node; a node with no process id (a JSON bot) by
 * its node id.
 * @param {{ name: string, state: FleetFacts }} n
 */
function holderOf(n) {
  const node = n.state.nodeId ?? n.name;
  return n.state.processId ? `${node} (process ${n.state.processId})` : node;
}

/**
 * Control facts after the scenario [A20], as each process reports them (its
 * in-memory view), keyed by process id so that the order and names of the
 * files do not matter. With a claims listing, every lease that carries a
 * claim is compared with the shard_claims row of its shard: the row must name
 * the same claim and the same process, and not be released.
 * @param {{ name: string, state: FleetFacts }[]} nodes
 * @param {ClaimsListing | null} [listing]
 * @returns {ControlFacts}
 */
export function controlFacts(nodes, listing = null) {
  /** @type {ControlFacts} */
  const f = {
    holders: new Map(), owners: new Map(), counts: new Map(), guildShards: new Map(), outOfRange: new Map(), unleased: new Map(), claims: new Map(),
    stale: new Map(),
  };
  const put = (/** @type {Map<string, Set<string>>} */ map, /** @type {string} */ key, /** @type {string} */ value) => {
    map.set(key, (map.get(key) ?? new Set()).add(value));
  };
  for (const n of nodes.filter(x => x.state.initialized)) {
    const id = holderOf(n);
    // Keyed by count: a stuck process of the old count can still answer after a reshard is done (NB9 C4).
    const count = n.state.shardCount;
    for (const l of n.state.leases) {
      put(f.holders, `${count} ${l.shardId}`, id);
      if (typeof l.claim !== 'number') continue;
      put(f.claims, String(l.claim), `shard ${l.shardId} by ${id}`);
      if (listing && !holdsLease(listing.get(`${n.state.shardCount} ${l.shardId}`), l.claim, n.state.processId)) {
        put(f.stale, `${l.shardId} ${l.claim}`, id);
      }
    }
    for (const row of n.state.shardTable) {
      put(f.owners, `${count} ${row.shardId}`, id);
      if (!n.state.leases.some(l => l.shardId === row.shardId)) put(f.unleased, `${count} ${row.shardId}`, id);
    }
    if (typeof count === 'number' && count > 0) put(f.counts, 'all', String(count));
    for (const [guild, shard] of Object.entries(n.state.guildMap)) {
      put(f.guildShards, `${guild} ${count}`, String(shard));
      if (typeof count === 'number' && count > 0 && (typeof shard !== 'number' || shard < 0 || shard >= count)) {
        // Keyed without the count, so a count that changed between two sets does not hide it.
        put(f.outOfRange, `${guild} ${shard}`, 'out');
      }
    }
  }
  return f;
}

/**
 * @param {{ claim: number, process: string, released: boolean } | undefined} row
 * @param {number} claim
 * @param {string | null} processId
 */
function holdsLease(row, claim, processId) {
  return row !== undefined && row.claim === claim && row.process === processId && !row.released;
}

/**
 * The facts both sets show. Each set is read one node at a time, so a handoff
 * can fall between two reads; what both sets show did not.
 * @param {ControlFacts} a
 * @param {ControlFacts} b
 * @returns {ControlFacts}
 */
export function commonFacts(a, b) {
  const meet = (/** @type {Map<string, Set<string>>} */ x, /** @type {Map<string, Set<string>>} */ y) => {
    /** @type {Map<string, Set<string>>} */
    const out = new Map();
    for (const [key, values] of x) {
      const shared = new Set([...values].filter(v => y.get(key)?.has(v)));
      if (shared.size > 0) out.set(key, shared);
    }
    return out;
  };
  return {
    holders: meet(a.holders, b.holders), owners: meet(a.owners, b.owners), counts: meet(a.counts, b.counts),
    guildShards: meet(a.guildShards, b.guildShards), outOfRange: meet(a.outOfRange, b.outOfRange),
    unleased: meet(a.unleased, b.unleased), claims: meet(a.claims, b.claims), stale: meet(a.stale, b.stale),
  };
}

/**
 * No shard leased to two processes, every shard table row leased by the
 * process reporting it, one shard count, every guild mapped to one shard in
 * range, each claim on one shard of one process, and every lease's claim the
 * one shard_claims holds for it. Shards and guilds are judged within one count;
 * a second count is allowed only as a reshard listing row's {from, to}.
 * @param {ControlFacts} f
 * @param {{ rows: { from: number, to: number }[] } | null} [reshard]
 * @returns {Verdict[]}
 */
export function controlVerdicts(f, reshard = null) {
  /** @type {Verdict[]} */
  const verdicts = [];
  const add = (/** @type {string} */ detail) => verdicts.push({ v: 'CONTROL', detail });
  const sorted = (/** @type {Set<string>} */ s) => [...s].sort();
  const shardOf = (/** @type {string} */ key) => key.split(' ')[1];
  for (const [key, set] of f.holders) {
    if (set.size > 1) add(`shard ${shardOf(key)} is leased to ${set.size} processes at once: ${sorted(set).join(', ')}`);
  }
  for (const [key, owners] of f.owners) {
    const set = f.holders.get(key) ?? new Set();
    for (const owner of sorted(owners)) {
      for (const holder of sorted(set)) {
        if (holder !== owner) add(`shard ${shardOf(key)} is leased by ${holder}, but it is in the shard table of ${owner}`);
      }
    }
  }
  for (const [key, owners] of f.unleased) {
    for (const owner of sorted(owners)) add(`shard ${shardOf(key)} is in the shard table of ${owner}, which does not lease it`);
  }
  const counts = f.counts.get('all');
  const ofAttempt = counts !== undefined && counts.size === 2
    && (reshard?.rows ?? []).some(r => counts.has(String(r.from)) && counts.has(String(r.to)));
  if (counts && counts.size > 1 && !ofAttempt) add(`nodes disagree on the shard count: ${sorted(counts).join(', ')}`);
  for (const [key, set] of f.guildShards) {
    if (set.size > 1) add(`guild ${key.split(' ')[0]} is mapped to ${set.size} shards across nodes: ${sorted(set).join(', ')}`);
  }
  for (const guildShard of f.outOfRange.keys()) {
    const [guild, shard] = guildShard.split(' ');
    add(`a node maps guild ${guild} to shard ${shard}, outside the shard count it reports`);
  }
  for (const [claim, set] of f.claims) {
    if (set.size > 1) add(`claim ${claim} is reported ${set.size} times: ${sorted(set).join(', ')}`);
  }
  for (const [key, set] of f.stale) {
    const [shard, claim] = key.split(' ');
    for (const holder of sorted(set)) add(`${holder} holds a lease on shard ${shard} under claim ${claim}, which shard_claims does not hold for it`);
  }
  return verdicts;
}

/**
 * @typedef {{ attempt: string, state: string, from: number, to: number, fromRows: number }} ReshardRow
 * @typedef {{ rows: ReshardRow[], meta: number | null }} ReshardListing
 */

const OPEN_STATES = new Set(['standby', 'flipped', 'stopping']);

/**
 * The shard a guild routes to under a count, as Discord routes it: (id >> 22) % count.
 * @param {string} guild
 * @param {number} count
 */
export function shardOfGuild(guild, count) {
  try {
    return Number((BigInt(guild) >> 22n) % BigInt(count));
  } catch {
    return null;
  }
}

/**
 * NB9 decision 22 on one set of facts and the reshard listing taken after it: no guild in the granted shards of two
 * live processes, whatever count each runs, and no grant of an attempt's new count before the attempt is done (from
 * the listing, and from each process's own view of the attempt).
 * @param {{ name: string, state: FleetFacts }[]} nodes
 * @param {ReshardListing | null} [listing]
 * @returns {Verdict[]}
 */
export function reshardFleetVerdicts(nodes, listing = null) {
  /** @type {Verdict[]} */
  const verdicts = [];
  const add = (/** @type {string} */ detail) => verdicts.push({ v: 'CONTROL', detail });
  const live = nodes.filter(n => n.state.initialized);
  const guilds = [...new Set(live.flatMap(n => Object.keys(n.state.guildMap)))].sort();
  for (const guild of guilds) {
    const holders = new Set(live.filter(n => {
      const count = n.state.shardCount;
      return typeof count === 'number' && count > 0 && n.state.leases.some(l => l.shardId === shardOfGuild(guild, count));
    }).map(holderOf));
    if (holders.size > 1) add(`guild ${guild} is in the granted shards of ${holders.size} processes at once: ${[...holders].sort().join(', ')}`);
  }
  /** @type {{ attempt: string, state: string, from: number, to: number }[]} */
  const open = [];
  // From the listing only: a stuck process's own view can still read 'flipped' after the attempt is done (NB9 C4).
  for (const r of listing?.rows ?? []) if (OPEN_STATES.has(r.state)) open.push(r);
  for (const n of live) {
    const count = n.state.shardCount;
    const attempt = open.find(r => r.to === count && r.from !== count);
    if (attempt && n.state.leases.length > 0) add(`${holderOf(n)} holds a grant of the ${count}-shard set while the reshard to ${count} shards is ${attempt.state}`);
  }
  return verdicts;
}

/**
 * NB9 decision 22 on one reshard listing: at most one attempt open, no shard_claims row of the old count once an
 * attempt is done, and meta 'shard_count' at the new count once it is flipped or done.
 * @param {ReshardListing} listing
 * @returns {Verdict[]}
 */
export function reshardListingVerdicts(listing) {
  /** @type {Verdict[]} */
  const verdicts = [];
  const add = (/** @type {string} */ detail) => verdicts.push({ v: 'CONTROL', detail });
  const open = listing.rows.filter(r => OPEN_STATES.has(r.state));
  if (open.length > 1) add(`the reshard listing holds ${open.length} open attempts: ${open.map(r => r.attempt).sort().join(', ')}`);
  for (const r of listing.rows) {
    if (r.state === 'done' && r.fromRows > 0) add(`the reshard from ${r.from} to ${r.to} shards is done, but shard_claims still holds ${r.fromRows} row(s) of the ${r.from}-shard set`);
    if ((r.state === 'flipped' || r.state === 'done') && listing.meta !== r.to) add(`the reshard to ${r.to} shards is ${r.state}, but meta 'shard_count' holds ${listing.meta ?? 'no count'}`);
  }
  return verdicts;
}

/**
 * The reshard listing (oracle.mjs sql reshard under psql -At): one line,
 * {"rows": [{"attempt": text, "state": text, "from": n, "to": n, "fromRows": n}, ...], "meta": n or null}.
 * @param {string} text
 * @returns {ReshardListing}
 */
export function parseReshard(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length !== 1) throw new Error(`it has ${lines.length} lines, not one`);
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(lines[0]);
  } catch {
    throw new Error(`its line is not JSON: ${lines[0].slice(0, 80)}`);
  }
  const meta = doc?.meta === null ? null : doc?.meta;
  if (!Array.isArray(doc?.rows) || (meta !== null && !Number.isSafeInteger(meta))) {
    throw new Error(`its line is not {"rows": [...], "meta": n or null}: ${lines[0].slice(0, 80)}`);
  }
  for (const r of doc.rows) {
    if (typeof r?.attempt !== 'string' || typeof r.state !== 'string' || !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to)
      || !Number.isSafeInteger(r.fromRows)) {
      throw new Error(`a row is not {"attempt": text, "state": text, "from": n, "to": n, "fromRows": n}: ${JSON.stringify(r).slice(0, 80)}`);
    }
  }
  return { rows: doc.rows.map((/** @type {any} */ r) => ({ attempt: r.attempt, state: r.state, from: r.from, to: r.to, fromRows: r.fromRows })), meta };
}

/** @typedef {{ last: number, called: boolean, highest: number | null, claims: number | null }} OwnershipListing */

/**
 * The claim the next take would draw, as the take draws it: the sequence's
 * next value, raised above the highest guild_ownership and shard_claims
 * claims. A live process that holds that claim or a higher one on a lease
 * means the sequence went back (a restore that did not raise it), so a new
 * take can draw a live claim.
 * @param {{ name: string, state: FleetFacts }[]} nodes
 * @param {OwnershipListing} listing
 * @returns {Verdict[] | null} null when no live process reports a claim
 */
export function ownershipVerdicts(nodes, listing) {
  const live = nodes.filter(n => n.state.initialized).flatMap(n => n.state.leases.map(l => l.claim)).filter(c => typeof c === 'number');
  if (live.length === 0) return null;
  const highestLive = Math.max(.../** @type {number[]} */ (live));
  const fromSeq = listing.called ? listing.last + 1 : listing.last;
  const next = Math.max(fromSeq, (listing.highest ?? 0) + 1, (listing.claims ?? 0) + 1);
  if (highestLive < next) return [];
  return [{
    v: 'CONTROL',
    detail: `a live process holds claim ${highestLive}, and the next take would draw claim ${next} (claim_seq at ${listing.last}, ${listing.called ? 'called' : 'not called'}; highest guild_ownership claim ${listing.highest ?? 'none'}; highest shard_claims claim ${listing.claims ?? 'none'}): the claim sequence went back`,
  }];
}

/**
 * The ownership listing (oracle.mjs sql ownership under psql -At): one line,
 * {"last": claim_seq.last_value, "called": claim_seq.is_called, "highest": max guild_ownership claim or null,
 * "claims": max shard_claims claim or null}.
 * @param {string} text
 * @returns {OwnershipListing}
 */
export function parseOwnership(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length !== 1) throw new Error(`it has ${lines.length} lines, not one`);
  /** @type {any} */
  let row;
  try {
    row = JSON.parse(lines[0]);
  } catch {
    throw new Error(`its line is not JSON: ${lines[0].slice(0, 80)}`);
  }
  const last = Number(row?.last);
  const highest = row?.highest === null ? null : Number(row?.highest);
  const claims = row?.claims === null ? null : Number(row?.claims);
  if (!Number.isSafeInteger(last) || typeof row.called !== 'boolean' || (highest !== null && !Number.isSafeInteger(highest))
    || (claims !== null && !Number.isSafeInteger(claims))) {
    throw new Error(`its line is not {"last": n, "called": bool, "highest": n or null, "claims": n or null}: ${lines[0].slice(0, 80)}`);
  }
  return { last, called: row.called, highest, claims };
}

/**
 * The shard claims listing (oracle.mjs sql claims under psql -At): one line,
 * {"rows": [{"count": n, "shard": n, "claim": n, "process": text, "released": bool}, ...]}.
 * @param {string} text
 * @returns {ClaimsListing}
 */
export function parseClaims(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (lines.length !== 1) throw new Error(`it has ${lines.length} lines, not one`);
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(lines[0]);
  } catch {
    throw new Error(`its line is not JSON: ${lines[0].slice(0, 80)}`);
  }
  if (!Array.isArray(doc?.rows)) throw new Error(`its line is not {"rows": [...]}: ${lines[0].slice(0, 80)}`);
  /** @type {ClaimsListing} */
  const listing = new Map();
  for (const r of doc.rows) {
    if (!Number.isSafeInteger(r?.count) || !Number.isSafeInteger(r.shard) || !Number.isSafeInteger(r.claim)
      || typeof r.process !== 'string' || typeof r.released !== 'boolean') {
      throw new Error(`a row is not {"count": n, "shard": n, "claim": n, "process": text, "released": bool}: ${JSON.stringify(r).slice(0, 80)}`);
    }
    listing.set(`${r.count} ${r.shard}`, { claim: r.claim, process: r.process, released: r.released });
  }
  return listing;
}

/**
 * The control check on one set of facts.
 * @param {{ name: string, state: FleetFacts }[]} nodes
 * @param {ClaimsListing | null} [listing]
 * @param {ReshardListing | null} [reshard]
 */
export function judgeFleet(nodes, listing = null, reshard = null) {
  return controlVerdicts(controlFacts(nodes, listing), reshard);
}

/** NB15 decision 16: the holder's cleanup deletes an answered row this long after its answer. */
export const ANSWERED_ROW_KEPT_S = 120;
/** The longest gap between two snapshots of the request rows that no answered row can fall through. */
export const SNAPSHOT_GAP_MAX_S = 110;
/** The slack between the writer's clock and the database's, as for the listing's span. */
export const SNAPSHOT_CLOCK_SLACK_S = 30;

/**
 * The request listing (oracle.mjs sql requests under psql -At, taken every
 * 30 s during the run and once at its end, appended to one file). Each
 * snapshot is one line per guild_requests row of the run, {"id", "op",
 * "state", "k": the body's filename, "c": its contentJson or null, "taken":
 * bool, "reply": text or null}, then {"snapshot": the database's time, "rows":
 * how many row lines it holds}. A row's content is judged by its hash, as a
 * copy's doc is. A row a holder claimed has an empty body (NB15 decision 16),
 * so its "k" and "c" are null; the cleanup deletes it 2 minutes after its
 * answer. The rows are the union of the snapshots by row id: a row keeps the
 * key and hash any snapshot showed, and takes its state and reply from the
 * latest. Lines with no snapshot line at all are one snapshot of unknown time.
 * @param {string} name
 * @param {string} text
 * @returns {RequestListing}
 */
export function parseRequests(name, text) {
  /** @type {{ at: string | null, rows: RequestRow[] }[]} */
  const snaps = [];
  /** @type {RequestRow[]} */
  let current = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    /** @type {any} */
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${name} line ${i + 1} is not a JSON row`);
    }
    if (row !== null && typeof row === 'object' && 'snapshot' in row) {
      if (typeof row.snapshot !== 'string' || !Number.isFinite(Date.parse(row.snapshot)) || !Number.isInteger(row.rows)) {
        throw new Error(`${name} line ${i + 1} is a snapshot line that needs "snapshot" (a time) and "rows" (a count)`);
      }
      if (row.rows !== current.length) {
        throw new Error(`${name} line ${i + 1} ends a snapshot of ${current.length} rows, but counts ${row.rows}: the snapshot is not whole`);
      }
      snaps.push({ at: row.snapshot, rows: current });
      current = [];
      return;
    }
    if (typeof row?.id !== 'string' || typeof row.op !== 'string' || typeof row.state !== 'string' || (row.k !== null && typeof row.k !== 'string')
      || (row.k === null && row.c !== null) || typeof row.taken !== 'boolean' || (row.c !== null && typeof row.c !== 'string') || (row.reply !== null && typeof row.reply !== 'string')) {
      throw new Error(`${name} line ${i + 1} needs "id", "op", "state", "k", "c", "taken" and "reply"`);
    }
    if (current.some(r => r.id === row.id)) throw new Error(`${name} line ${i + 1} lists row ${row.id} twice in one snapshot`);
    /** @type {string | null} */
    let h = null;
    if (row.c !== null) {
      try {
        h = hashOf(JSON.parse(row.c));
      } catch {
        h = `unparseable:${row.c.length}`;
      }
    }
    current.push({ id: row.id, op: row.op, state: row.state, key: row.k, h, taken: row.taken, reply: row.reply });
  });
  if (current.length > 0) {
    if (snaps.length > 0) throw new Error(`${name} ends with ${current.length} rows and no snapshot line: its last snapshot was cut short`);
    snaps.push({ at: null, rows: current });
  }
  const ordered = snaps.map((snap, i) => ({ ...snap, i })).sort((a, b) => (a.at === null || b.at === null ? 0 : Date.parse(a.at) - Date.parse(b.at)) || a.i - b.i);
  /** @type {Map<string, RequestRow>} */
  const byId = new Map();
  for (const snap of ordered) {
    for (const row of snap.rows) {
      const seen = byId.get(row.id);
      if (!seen) {
        byId.set(row.id, row);
        continue;
      }
      if (seen.op !== row.op) throw new Error(`${name} lists row ${row.id} as ${seen.op} and as ${row.op}`);
      if (row.key !== null && seen.key !== null && (row.key !== seen.key || row.h !== seen.h)) {
        throw new Error(`${name} lists row ${row.id} with two different bodies, but a body is only ever emptied`);
      }
      byId.set(row.id, {
        ...row,
        key: seen.key ?? row.key, h: seen.key !== null ? seen.h : row.h, taken: seen.taken || row.taken,
      });
    }
  }
  return { name, rows: [...byId.values()], snapshots: snaps.flatMap(s => (s.at === null ? [] : [s.at])) };
}

/**
 * Whether the snapshots of a request listing hold every row of the run. The
 * cleanup deletes a row 2 minutes after its answer, so a row answered before
 * the first snapshot, or between two snapshots more than 110 s apart, may be
 * gone from all of them, and one answered after the last may be missing too.
 * Each is a reason the run cannot pass, never a verdict.
 * @param {History} history
 * @param {RequestListing} listing
 * @returns {string[]}
 */
export function requestCoverage(history, listing) {
  const times = (listing.snapshots ?? []).map(t => Date.parse(t)).sort((a, b) => a - b);
  if (times.length === 0) {
    return [`${listing.name} holds no snapshot line (oracle.mjs sql requests ends each snapshot with one), so whether the cleanup deleted rows of the run before it was taken is unknown`];
  }
  /** @type {string[]} */
  const reasons = [];
  const starts = history.logs.flatMap(l => (l.startedAt === null ? [] : [Date.parse(l.startedAt)])).filter(Number.isFinite);
  const first = Math.min(...starts);
  if (starts.length > 0 && times[0] > first + (ANSWERED_ROW_KEPT_S - SNAPSHOT_CLOCK_SLACK_S) * 1000) {
    reasons.push(`${listing.name}'s first snapshot was taken ${Math.round((times[0] - first) / 1000)} s after the run started, more than ${ANSWERED_ROW_KEPT_S - SNAPSHOT_CLOCK_SLACK_S} s: rows answered before it may have been deleted`);
  }
  let gap = 0;
  for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1]);
  if (gap > SNAPSHOT_GAP_MAX_S * 1000) {
    reasons.push(`${listing.name} has ${Math.round(gap / 1000)} s between two snapshots, more than ${SNAPSHOT_GAP_MAX_S} s: rows answered between them may have been deleted`);
  }
  const ends = history.logs.map(l => (l.endedAt === null ? NaN : Date.parse(l.endedAt)));
  if (ends.length > 0 && (!ends.every(Number.isFinite) || times[times.length - 1] < Math.max(...ends) + SNAPSHOT_CLOCK_SLACK_S * 1000)) {
    reasons.push(`${listing.name}'s last snapshot was not taken at least ${SNAPSHOT_CLOCK_SLACK_S} s after the run's last end line, so rows of its last requests may have changed or gone missing after it`);
  }
  return reasons;
}

/**
 * What a request row shows a holder did with it (NB7 decisions 7 and 9):
 * 'none' when no holder started it (never taken, or answered as never
 * applied: unapplied, or not-held, which the holder gives before doing
 * anything); 'open' when a holder took it and its answer is not in the row,
 * so it may have been applied; otherwise the holder's own answer.
 * @param {RequestRow} row
 * @returns {RequestOutcome}
 */
export function requestOutcome(row) {
  if (!row.taken) return 'none';
  if (row.state !== 'done' || row.reply === null) return 'open';
  /** @type {any} */
  let reply;
  try {
    reply = JSON.parse(row.reply);
  } catch {
    return 'open';
  }
  if (reply === null || typeof reply !== 'object') return 'open';
  if (reply.unapplied === true || reply.code === 'not-held') return 'none';
  if (reply.ok === true) return reply.pending === true ? 'held' : 'ok';
  return 'refused';
}

/**
 * Each send's answer against the request rows that carry it. A send is
 * carried by the row of its op with its key, and for a write its content's
 * hash: every send of a run writes content no other send writes, and a doc
 * is deleted at most once. TWICE: more than one of a send's rows was started
 * by a holder. FALSE-ANSWER: a 200 with no row the holder answered ok, a 202
 * with no row it answered accepted, or a refusal given as never applied whose
 * row a holder started and did not refuse. PHANTOM: a started row no writer
 * sent. A row with no key (no snapshot showed its body before the claim emptied it) can carry any send
 * of its op that no keyed row shows started, one each: they are judged by
 * count. More started keyless rows than such sends is TWICE; more than such
 * sends not refused as never applied is FALSE-ANSWER; fewer keyless rows
 * answered ok (or accepted) than such sends answered 200 (or 202) with the
 * name of the machine that ran them (servedBy: through a row) is
 * FALSE-ANSWER. When the snapshots may have missed rows (requestCoverage),
 * the run is INCONCLUSIVE for those reasons, and no verdict that a missing
 * row can cause is given: none from counts, and no FALSE-ANSWER for an
 * acknowledged or held send whose rows show no such answer. The verdicts that
 * the rows the snapshots hold prove (TWICE of one send, PHANTOM, a refusal
 * whose row a holder started) still stand.
 * @param {History} history
 * @param {RequestListing} listing
 * @returns {{ verdicts: Verdict[], reasons: string[] }}
 */
export function judgeRequests(history, listing) {
  /** @type {Verdict[]} */
  const verdicts = [];
  const reasons = requestCoverage(history, listing);
  const complete = reasons.length === 0;
  if (!complete) reasons.push(`${listing.name}: the answers of sends that no listed row proves, and the counts of rows with no key, were not judged, because the snapshots may have missed rows`);
  const add = (/** @type {string} */ v, /** @type {string} */ key, /** @type {string} */ detail) => verdicts.push({ v, key, copy: listing.name, detail });
  /** @type {Map<Op, RequestRow[]>} */
  const bySend = new Map();
  /** @type {Record<string, RequestRow[]>} */
  const loose = { write: [], delete: [] };
  for (const row of listing.rows) {
    if (row.op !== 'write' && row.op !== 'delete') continue;
    if (row.key === null) {
      loose[row.op].push(row);
      continue;
    }
    const entry = history.keys.get(row.key);
    const send = row.op === 'write' ? entry?.writes.find(w => w.h === row.h) : entry?.deletes[0];
    if (!send) {
      if (requestOutcome(row) !== 'none') add('PHANTOM', row.key, `request ${row.id} (${row.op}, ${row.state}) was taken by a holder, but no writer sent it`);
      continue;
    }
    bySend.set(send, [...(bySend.get(send) ?? []), row]);
  }
  const rowsText = (/** @type {RequestRow[]} */ rows) => rows.map(r => `${r.id} ${r.state}${r.taken ? ' taken' : ''}${r.reply ? ` ${r.reply.slice(0, 80)}` : ''}`).join('; ');
  const anyLoose = loose.write.length + loose.delete.length > 0;
  /** @type {Record<string, Op[]>} */
  const free = { write: [], delete: [] };
  for (const [, entry] of history.keys) {
    for (const send of [...entry.writes, ...entry.deletes]) {
      const rows = bySend.get(send) ?? [];
      const outcomes = rows.map(requestOutcome);
      if (!outcomes.some(o => o !== 'none')) free[send.op].push(send);
    }
  }
  /** @type {Set<Op>} */
  const unmatched = new Set();
  for (const [send, rows] of bySend) {
    const outcomes = rows.map(requestOutcome);
    const started = rows.filter((_, i) => outcomes[i] !== 'none');
    if (started.length > 1) add('TWICE', send.key, `${send.op} #${send.id} was started by holders ${started.length} times: ${rowsText(started)}`);
    if (complete && send.cls === 'ACKED' && !outcomes.includes('ok')) {
      if (anyLoose && started.length === 0) unmatched.add(send);
      else add('FALSE-ANSWER', send.key, `${send.op} #${send.id} was acknowledged, but no holder answered ok in its request: ${rowsText(rows)}`);
    } else if (complete && send.cls === 'HELD' && !outcomes.includes('held')) {
      if (anyLoose && started.length === 0) unmatched.add(send);
      else add('FALSE-ANSWER', send.key, `${send.op} #${send.id} was held, but no holder answered it accepted in its request: ${rowsText(rows)}`);
    } else if (send.cls === 'REFUSED' && send.definite && outcomes.some(o => o === 'open' || o === 'ok' || o === 'held')) {
      add('FALSE-ANSWER', send.key, `${send.op} #${send.id} was refused as never applied (${send.status}), but a holder started its request: ${rowsText(rows)}`);
    }
  }
  if (!anyLoose || !complete) return { verdicts, reasons };
  for (const op of /** @type {const} */ (['write', 'delete'])) {
    const rows = loose[op];
    const outcomes = rows.map(requestOutcome);
    const started = outcomes.filter(o => o !== 'none').length;
    const carriers = free[op];
    const startable = carriers.filter(send => !(send.cls === 'REFUSED' && send.definite)).length;
    const what = `${started} ${op} rows a holder started have no key left to name their send`;
    if (started > carriers.length) {
      add('TWICE', `(${op} rows with no key)`, `${what}, more than the ${carriers.length} ${op} sends no keyed row shows started: ${rowsText(rows.filter((_, i) => outcomes[i] !== 'none'))}`);
    } else if (started > startable) {
      add('FALSE-ANSWER', `(${op} rows with no key)`, `${what}, more than the ${startable} ${op} sends that were not refused as never applied`);
    }
    for (const [cls, outcome, words] of /** @type {const} */ ([['ACKED', 'ok', 'acknowledged'], ['HELD', 'held', 'held']])) {
      const need = carriers.filter(send => send.cls === cls && send.remote && (unmatched.has(send) || !bySend.has(send)));
      const have = outcomes.filter(o => o === outcome).length;
      if (need.length > have) {
        const keys = need.map(send => `${send.key} #${send.id}`).join(', ');
        add('FALSE-ANSWER', `(${op} rows with no key)`, `${need.length} ${op} sends were ${words} with no keyed row answering them, but only ${have} rows with no key were answered ${outcome}: ${keys}`);
      }
    }
  }
  return { verdicts, reasons };
}

/**
 * Window coverage [A13]: at least k acknowledged operations answered inside
 * each marked window, or k in the whole run when nothing was marked; and
 * every window the scenario names must appear.
 * @param {History} history
 * @param {number} k
 * @param {string[]} required
 * @returns {string[]} reasons the run is inconclusive
 */
export function coverage(history, k, required = []) {
  /** @type {string[]} */
  const reasons = [];
  const acked = history.ops.filter(op => op.cls === 'ACKED');
  for (const name of required) {
    if (!history.windows.some(w => w.name === name)) reasons.push(`window ${name} was required but never marked`);
  }
  if (history.windows.length === 0) {
    if (acked.length < k) reasons.push(`only ${acked.length} acknowledged operations in the run, ${k} needed`);
    return reasons;
  }
  for (const w of history.windows) {
    const inside = acked.filter(op => op.log === w.log && op.ansAt >= w.begin && op.ansAt <= w.end).length;
    if (inside < k) reasons.push(`window ${w.name}: ${inside} acknowledged operations inside it, ${k} needed`);
  }
  return reasons;
}

/**
 * A database copy from psql lines of {"k": filename, "d": doc text}.
 * @param {string} name
 * @param {'judged' | 'lagging'} mode
 * @param {string} text
 * @returns {Copy}
 */
export function dbCopy(name, mode, text) {
  /** @type {Map<string, DocState>} */
  const docs = new Map();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${name} line ${i + 1} is not a JSON row`);
    }
    if (typeof row.k !== 'string' || typeof row.d !== 'string') throw new Error(`${name} line ${i + 1} needs "k" and "d"`);
    /** @type {DocState} */
    let state;
    try {
      state = presentState(JSON.parse(row.d));
    } catch {
      state = { s: 'present', h: `unparseable:${row.d.length}` };
    }
    docs.set(row.k, state);
  });
  return { name, mode, complete: true, docs };
}

/**
 * An app-path copy written by `oracle.mjs read`.
 * @param {string} text
 * @returns {Copy}
 */
export function appCopy(text) {
  const lines = text.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
  const header = lines[0];
  if (!header || header.t !== 'copy') throw new Error('an app copy starts with its copy line');
  /** @type {Map<string, DocState>} */
  const docs = new Map();
  for (const row of lines.slice(1)) {
    docs.set(row.k, row.s === 'present'
      ? { s: 'present', h: row.h, ...(row.lane !== undefined ? { lane: row.lane, c: row.c } : {}) }
      : row.s === 'absent' ? { s: 'absent' } : { s: 'error', err: row.err ?? '' });
  }
  return { name: header.name, mode: 'judged', complete: false, docs, run: header.run, guild: header.guild, sample: header.sample === true };
}

/**
 * Everything at once: the result the checker prints.
 * @param {{ history: History, copies: Copy[], agree?: string[], fleet?: { name: string, state: FleetFacts }[],
 *   fleetAgain?: { name: string, state: FleetFacts }[], noFleet?: boolean, windows?: string[], k?: number,
 *   ownership?: string, claims?: string[], requests?: RequestListing[], reshard?: string[] }} input
 */
export function judge(input) {
  const { history, copies } = input;
  const k = input.k ?? 5;
  for (const c of copies) {
    if (c.run !== undefined && (c.run !== history.run || c.guild !== history.guild)) {
      throw new Error(`copy ${c.name} is of run ${c.run} on guild ${c.guild}, not run ${history.run} on guild ${history.guild}`);
    }
  }
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {string[]} */
  const inconclusive = [...history.problems];
  /** @type {string[]} */
  const notes = [];
  const committedKeys = [...history.keys].filter(([, e]) => e.writes.some(committed)).map(([key]) => key);
  for (const copy of copies) {
    const r = judgeCopy(history, copy);
    verdicts.push(...r.verdicts);
    inconclusive.push(...r.reasons);
    if (copy.mode === 'judged' && r.unread.length > 0) {
      // A read that failed is a doc this copy did not judge [A15]; a sample leaves the rest out on purpose.
      const failed = r.unread.filter(key => copy.docs.has(key));
      const missing = copy.sample ? [] : r.unread.filter(key => !copy.docs.has(key));
      if (failed.length > 0) inconclusive.push(`${copy.name} could not read ${failed.length} committed docs (${failed.slice(0, 3).join(', ')})`);
      if (missing.length > 0) inconclusive.push(`${copy.name} has no row for ${missing.length} committed docs (${missing.slice(0, 3).join(', ')})`);
    }
    if (copy.sample) {
      const judgedHere = committedKeys.filter(key => copy.docs.has(key)).length;
      notes.push(`${copy.name} read a sample: ${judgedHere} of ${committedKeys.length} committed docs`);
      if (judgedHere === 0 && committedKeys.length > 0) inconclusive.push(`${copy.name} is a sample that holds no committed doc`);
    }
  }
  const reads = judgeReads(history);
  verdicts.push(...reads.verdicts);
  inconclusive.push(...reads.reasons);
  verdicts.push(...judgeForks(history, copies, input.agree ?? []));
  for (const listing of input.requests ?? []) {
    const judged = judgeRequests(history, listing);
    verdicts.push(...judged.verdicts);
    inconclusive.push(...judged.reasons);
    if (listing.rows.length === 0) notes.push(`${listing.name} holds no request row of this run, so no answer was compared with one`);
  }

  const fleet = input.fleet ?? [];
  const again = input.fleetAgain ?? [];
  if (fleet.length === 0 && !input.noFleet) inconclusive.push('no control facts were given (--fleet) [A20]');
  for (const n of [...fleet, ...again]) {
    if (!n.state.initialized) inconclusive.push(`${n.name} gave no control facts: its bot child was down or did not answer`);
  }
  const claimTexts = input.claims ?? [];
  const listings = claimTexts.map((text, i) => {
    try {
      return parseClaims(text);
    } catch (error) {
      notes.push(`claims listing ${i + 1} was not judged: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  });
  // One listing serves both sets; with two, the first goes with --fleet and the second with --fleet-again.
  const firstListing = listings[0] ?? null;
  const secondListing = listings.length > 1 ? listings[1] : firstListing;
  const leasesWithClaims = [...fleet, ...again].some(n => n.state.initialized && n.state.leases.some(l => typeof l.claim === 'number'));
  if (leasesWithClaims && claimTexts.length === 0) notes.push('leases were not compared with shard_claims: no claims listing was given (--claims)');
  const reshardTexts = input.reshard ?? [];
  const reshardOpen = [...fleet, ...again].some(n => n.state.initialized && OPEN_STATES.has(n.state.reshard?.state ?? ""));
  if (reshardOpen && reshardTexts.length === 0) notes.push('grants were not compared with the reshard attempt: no reshard listing was given (--reshard)');
  const reshardListings = reshardTexts.map((text, i) => {
    try {
      return parseReshard(text);
    } catch (error) {
      notes.push(`reshard listing ${i + 1} was not judged: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  });
  // With two sets, the first listing goes with --fleet and the second with --fleet-again, and only what both show counts.
  const firstReshard = reshardListings[0] ?? null;
  const secondReshard = reshardListings.length > 1 ? reshardListings[1] : firstReshard;
  if (fleet.length > 0 && again.length === 0) verdicts.push(...judgeFleet(fleet, firstListing, firstReshard));
  if (fleet.length > 0 && again.length > 0) {
    // Only what both sets show counts, so both must cover the same nodes.
    const ids = (/** @type {typeof fleet} */ set) => new Set(set.map(n => n.state.nodeId ?? n.name));
    const inFirst = ids(fleet);
    const inSecond = ids(again);
    for (const id of inFirst) if (!inSecond.has(id)) inconclusive.push(`node ${id} is in the first set of control facts only`);
    for (const id of inSecond) if (!inFirst.has(id)) inconclusive.push(`node ${id} is in the second set of control facts only`);
    const first = controlFacts(fleet, firstListing);
    const second = controlFacts(again, secondListing);
    const eitherReshard = { rows: [...(firstReshard?.rows ?? []), ...(secondReshard?.rows ?? [])] };
    const both = controlVerdicts(commonFacts(first, second), eitherReshard);
    verdicts.push(...both);
    const counted = new Set(both.map(v => v.detail));
    for (const detail of new Set([...controlVerdicts(first, firstReshard), ...controlVerdicts(second, secondReshard)].map(v => v.detail))) {
      if (!counted.has(detail)) notes.push(`CONTROL seen in one set of control facts only: ${detail}`);
    }
  }
  const listingDetails = new Set();
  for (const listing of reshardListings) {
    if (!listing) continue;
    for (const v of reshardListingVerdicts(listing)) {
      if (listingDetails.has(v.detail)) continue;
      listingDetails.add(v.detail);
      verdicts.push(v);
    }
  }
  if (again.length === 0 && fleet.length > 0) verdicts.push(...reshardFleetVerdicts(fleet, firstReshard));
  if (fleet.length > 0 && again.length > 0) {
    const inSecond = new Set(reshardFleetVerdicts(again, secondReshard).map(v => v.detail));
    for (const v of reshardFleetVerdicts(fleet, firstReshard)) {
      if (inSecond.has(v.detail)) verdicts.push(v);
      else notes.push(`CONTROL seen in one set of control facts only: ${v.detail}`);
    }
    const inFirst = new Set(reshardFleetVerdicts(fleet, firstReshard).map(v => v.detail));
    for (const v of reshardFleetVerdicts(again, secondReshard)) {
      if (!inFirst.has(v.detail)) notes.push(`CONTROL seen in one set of control facts only: ${v.detail}`);
    }
  }
  if (input.ownership !== undefined) {
    /** @type {OwnershipListing | null} */
    let listing = null;
    try {
      listing = parseOwnership(input.ownership);
    } catch (error) {
      notes.push(`the ownership listing was not judged: ${error instanceof Error ? error.message : String(error)}`);
    }
    const found = listing ? ownershipVerdicts([...fleet, ...again], listing) : undefined;
    if (found === null) notes.push('the ownership listing was not judged: no live process reports a claim');
    else if (found) verdicts.push(...found);
  }

  inconclusive.push(...coverage(history, k, input.windows ?? []));
  if (!copies.some(c => c.mode === 'judged')) inconclusive.push('no judged copy was given');
  // A file log with no end line was cut short, so the run cannot pass; the
  // reason names what to check.
  history.logs.forEach((l, i) => {
    if (!l.ended) {
      inconclusive.push(`log ${i + 1} (${l.lanes.join(', ')}) has no end line: its writer did not finish (it was killed, or stopped on an error its stderr names), so the run was cut short, or this is a copy of its file cut short in transit (compare its size with the writer's own file). If the writer's host went down, the file's last lines may be lost too: rerun`);
    }
  });
  const readErrors = history.reads.filter(r => r.state.s === 'error').length;
  if (readErrors > 0) notes.push(`${readErrors} of ${history.reads.length} reads during the run got no answer`);

  const result = verdicts.length > 0 ? 'FAIL' : inconclusive.length > 0 ? 'INCONCLUSIVE' : 'PASS';
  /** @type {Record<string, number>} */
  const answers = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0 };
  for (const op of history.ops) answers[op.cls] += 1;
  return { result, verdicts, inconclusive, notes, answers, reads: history.reads.length, copies: copies.map(c => `${c.name} (${c.mode})`) };
}

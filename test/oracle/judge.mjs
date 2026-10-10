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
import { MARK, presentState } from './oracle.mjs';

/** @typedef {import('./oracle.mjs').AnswerClass} AnswerClass */
/** @typedef {import('./oracle.mjs').DocState} DocState */
/** @typedef {import('./oracle.mjs').FleetFacts} FleetFacts */
/**
 * @typedef {{ log: number, id: number, lane: string, op: 'write' | 'delete', kind: 'u' | 'h', key: string, c: number,
 *   h: string | null, at: number, cls: AnswerClass, definite: boolean, ansAt: number, status: number }} Op
 * @typedef {{ log: number, id: number, lane: string, key: string, kind: 'u' | 'h', at0: number, at1: number, state: DocState }} Read
 * @typedef {{ log: number, name: string, begin: number, end: number }} Window
 * @typedef {{ kind: 'u' | 'h', writes: Op[], deletes: Op[] }} KeyHistory
 * @typedef {{ run: string, guild: string, keys: Map<string, KeyHistory>, reads: Read[], windows: Window[], ops: Op[],
 *   logs: { lanes: string[], ended: boolean }[], problems: string[] }} History
 * @typedef {{ name: string, mode: 'judged' | 'lagging', complete: boolean, docs: Map<string, DocState>,
 *   run?: string, guild?: string, sample?: boolean }} Copy
 * @typedef {{ v: string, key?: string, copy?: string, during?: boolean, detail: string }} Verdict
 */

export const VERDICTS = ['LOST', 'ROLLBACK', 'FORK', 'PHANTOM', 'HELD-MISSING', 'RESURRECTED', 'WRONG-CONTENT', 'CONTROL'];
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
  /** @type {{ lanes: string[], ended: boolean }[]} */
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
    logInfo.push({ lanes, ended });

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
          // A send with no answer (the writer died, or stopped mid-request) is unknown.
          cls: ans ? ans.cls : 'UNKNOWN',
          definite: ans ? ans.definite === true : false,
          ansAt: ans ? ans.at : Infinity,
          status: ans ? ans.status : 0,
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
 *   guildShards: Map<string, Set<string>>, outOfRange: Map<string, Set<string>> }} ControlFacts
 */

/**
 * Control facts after the scenario [A20], as each node reports them (its
 * in-memory view, not the control store's rows), keyed by node id so that
 * the order and names of the files do not matter.
 * @param {{ name: string, state: FleetFacts }[]} nodes
 * @returns {ControlFacts}
 */
export function controlFacts(nodes) {
  /** @type {ControlFacts} */
  const f = { holders: new Map(), owners: new Map(), counts: new Map(), guildShards: new Map(), outOfRange: new Map() };
  const put = (/** @type {Map<string, Set<string>>} */ map, /** @type {string} */ key, /** @type {string} */ value) => {
    map.set(key, (map.get(key) ?? new Set()).add(value));
  };
  for (const n of nodes.filter(x => x.state.initialized && x.state.running)) {
    const id = n.state.nodeId ?? n.name;
    for (const l of n.state.leases) put(f.holders, String(l.shardId), id);
    for (const row of n.state.shardTable) {
      // A grant not yet confirmed names its target while the old holder may still let go.
      if (row.nodeId !== null && row.status !== 'pending') put(f.owners, String(row.shardId), row.nodeId);
    }
    const count = n.state.shardCount;
    if (typeof count === 'number' && count > 0) put(f.counts, 'all', String(count));
    for (const [guild, shard] of Object.entries(n.state.guildMap)) {
      put(f.guildShards, guild, String(shard));
      if (typeof count === 'number' && count > 0 && (typeof shard !== 'number' || shard < 0 || shard >= count)) {
        // Keyed without the count, so a count that changed between two sets does not hide it.
        put(f.outOfRange, `${guild} ${shard}`, 'out');
      }
    }
  }
  return f;
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
  };
}

/**
 * No shard leased to two nodes, no lease held against a master's shard
 * table, one shard count, and every guild mapped to one shard in range.
 * @param {ControlFacts} f
 * @returns {Verdict[]}
 */
export function controlVerdicts(f) {
  /** @type {Verdict[]} */
  const verdicts = [];
  const add = (/** @type {string} */ detail) => verdicts.push({ v: 'CONTROL', detail });
  const sorted = (/** @type {Set<string>} */ s) => [...s].sort();
  for (const [shard, set] of f.holders) {
    if (set.size > 1) add(`shard ${shard} is leased to ${set.size} nodes at once: ${sorted(set).join(', ')}`);
    for (const owner of sorted(f.owners.get(shard) ?? new Set())) {
      for (const holder of sorted(set)) {
        if (holder !== owner) add(`shard ${shard} is leased by ${holder}, but a shard table gives it to ${owner}`);
      }
    }
  }
  const counts = f.counts.get('all');
  if (counts && counts.size > 1) add(`nodes disagree on the shard count: ${sorted(counts).join(', ')}`);
  for (const [guild, set] of f.guildShards) {
    if (set.size > 1) add(`guild ${guild} is mapped to ${set.size} shards across nodes: ${sorted(set).join(', ')}`);
  }
  for (const guildShard of f.outOfRange.keys()) {
    const [guild, shard] = guildShard.split(' ');
    add(`a node maps guild ${guild} to shard ${shard}, outside the shard count it reports`);
  }
  return verdicts;
}

/**
 * The control check on one set of facts.
 * @param {{ name: string, state: FleetFacts }[]} nodes
 */
export function judgeFleet(nodes) {
  return controlVerdicts(controlFacts(nodes));
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
 *   fleetAgain?: { name: string, state: FleetFacts }[], noFleet?: boolean, windows?: string[], k?: number }} input
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

  const fleet = input.fleet ?? [];
  const again = input.fleetAgain ?? [];
  if (fleet.length === 0 && !input.noFleet) inconclusive.push('no control facts were given (--fleet) [A20]');
  for (const n of [...fleet, ...again]) {
    if (!n.state.initialized || !n.state.running) inconclusive.push(`${n.name} gave no control facts: its bot child was down or did not answer`);
  }
  if (fleet.length > 0 && again.length === 0) verdicts.push(...judgeFleet(fleet));
  if (fleet.length > 0 && again.length > 0) {
    // Only what both sets show counts, so both must cover the same nodes.
    const ids = (/** @type {typeof fleet} */ set) => new Set(set.map(n => n.state.nodeId ?? n.name));
    const inFirst = ids(fleet);
    const inSecond = ids(again);
    for (const id of inFirst) if (!inSecond.has(id)) inconclusive.push(`node ${id} is in the first set of control facts only`);
    for (const id of inSecond) if (!inFirst.has(id)) inconclusive.push(`node ${id} is in the second set of control facts only`);
    const first = controlFacts(fleet);
    const second = controlFacts(again);
    const both = controlVerdicts(commonFacts(first, second));
    verdicts.push(...both);
    const counted = new Set(both.map(v => v.detail));
    for (const detail of new Set([...controlVerdicts(first), ...controlVerdicts(second)].map(v => v.detail))) {
      if (!counted.has(detail)) notes.push(`CONTROL seen in one set of control facts only: ${detail}`);
    }
  }

  inconclusive.push(...coverage(history, k, input.windows ?? []));
  if (!copies.some(c => c.mode === 'judged')) inconclusive.push('no judged copy was given');
  // A file log with no end line is a killed writer's: every request is in it,
  // so its verdicts stand, but the run was cut short and cannot pass. A copy
  // of the file cut short in transit looks the same.
  history.logs.forEach((l, i) => {
    if (!l.ended) {
      inconclusive.push(`log ${i + 1} (${l.lanes.join(', ')}) has no end line: its writer was killed, so the run was cut short, or this is a copy of its file cut short in transit (compare its size with the writer's own file). If the writer's host went down, the file's last lines may be lost too: rerun`);
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

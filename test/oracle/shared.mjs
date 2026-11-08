// @ts-check
/**
 * The oracle's verdicts on shared files (NB6, sheet section 9), for a Postgres bot of two machines. Pure: writer logs
 * and copies in, verdicts out; check.mjs adds them to judge.mjs's result.
 *
 * Every shared write names the hash of the version it read (`prev`), and the bot stores it only over that version. So
 * the versions a copy holds form a chain: its version's write, the write that version was built on, and so on. Every
 * acknowledged write must be on the chain of the row and of each machine's mirror (else SHARED-LOST), no two
 * acknowledged writes can be built on one version (else SHARED-OVERWRITE: one was stored over a version it had not
 * read), and two machines' mirrors must hold the same version once the bound has passed (else SHARED-FORK). A copy whose
 * chain passes through a write refused before applying is a PHANTOM.
 */
import { presentState } from './oracle.mjs';

/** @typedef {import('./oracle.mjs').AnswerClass} AnswerClass */
/** @typedef {import('./oracle.mjs').DocState} DocState */
/** @typedef {import('./judge.mjs').Verdict} Verdict */
/**
 * @typedef {{ log: number, id: number, lane: string, key: string, c: number, h: string, prev: string | null,
 *   cls: AnswerClass, definite: boolean }} SharedWrite
 * @typedef {{ run: string, keys: Map<string, SharedWrite[]>, ends: (number | null)[], problems: string[] }} SharedHistory
 * @typedef {{ name: string, kind: 'row' | 'mirror', at: number | null, run?: string, docs: Map<string, DocState> }} SharedCopy
 */

export const SHARED_VERDICTS = ['SHARED-LOST', 'SHARED-OVERWRITE', 'SHARED-FORK', 'PHANTOM'];
/**
 * Seconds after the writer's end before a mirror is judged: decision 11's bound is 60 s for a notice that was lost
 * (the 60 s pass), and the pass itself takes up to its 10 s reads.
 */
export const SHARED_BOUND_S = 90;

/**
 * @param {any[][]} logs parsed events, one array per writer log
 * @returns {SharedHistory}
 */
export function buildSharedHistory(logs) {
  /** @type {Map<string, SharedWrite[]>} */
  const keys = new Map();
  /** @type {(number | null)[]} */
  const ends = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<string>} */
  const runs = new Set();
  logs.forEach((events, log) => {
    const start = events.find(e => e.t === 'start');
    if (!start) throw new Error(`log ${log + 1} has no start line`);
    runs.add(start.run);
    /** @type {Map<number, any>} */
    const answers = new Map();
    for (const e of events) if (e.t === 'shared-ans') answers.set(e.id, e);
    for (const e of events) {
      if (e.t !== 'shared-send') continue;
      const ans = answers.get(e.id);
      const list = keys.get(e.key) ?? [];
      list.push({
        log, id: e.id, lane: e.lane, key: e.key, c: e.c, h: e.h, prev: e.prev ?? null,
        // A send with no answer in the log is unknown: it may have landed.
        cls: ans ? ans.cls : 'UNKNOWN', definite: ans ? ans.definite === true : false,
      });
      keys.set(e.key, list);
    }
    const end = events.find(e => e.t === 'end');
    const endedAt = end && typeof end.endedAt === 'string' ? Date.parse(end.endedAt) : NaN;
    ends.push(Number.isFinite(endedAt) ? endedAt : null);
    const sends = events.filter(e => e.t === 'shared-send').length;
    if (end && sends > 0) {
      /** @type {Record<string, number>} */
      const held = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0, reads: 0, readErrors: 0 };
      for (const e of events) {
        if (e.t === 'shared-ans') held[e.cls] = (held[e.cls] ?? 0) + 1;
        if (e.t === 'shared-read') {
          held.reads += 1;
          if (e.s === 'error') held.readErrors += 1;
        }
      }
      const counted = end.counts?.shared ?? {};
      const mismatched = Object.keys(held).filter(key => counted[key] !== held[key]);
      if (mismatched.length > 0) {
        problems.push(`log ${log + 1}'s end line counts shared ${mismatched.map(key => `${key} ${counted[key]}`).join(', ')}, but its lines hold ${mismatched.map(key => `${key} ${held[key]}`).join(', ')}: lines are missing`);
      }
    }
  });
  if (runs.size !== 1) throw new Error('the logs must hold exactly one run');
  return { run: [...runs][0], keys, ends, problems };
}

/**
 * A database listing written by the query of `oracle.mjs sql shared`: one {"k": id, "b": base64 body} line per row. A
 * key the listing lacks has no row.
 * @param {string} name
 * @param {string} text
 * @returns {SharedCopy}
 */
export function rowCopy(name, text) {
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
    if (typeof row.k !== 'string' || typeof row.b !== 'string') throw new Error(`${name} line ${i + 1} needs "k" and "b"`);
    const body = Buffer.from(row.b, 'base64').toString('utf8');
    /** @type {DocState} */
    let state;
    try {
      state = presentState(JSON.parse(body));
    } catch {
      state = { s: 'present', h: `unparseable:${body.length}` };
    }
    docs.set(row.k, state);
  });
  return { name, kind: 'row', at: null, docs };
}

/**
 * One machine's mirror files, written by `oracle.mjs mirror`.
 * @param {string} text
 * @returns {SharedCopy}
 */
export function mirrorCopy(text) {
  const lines = text.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
  const header = lines[0];
  if (!header || header.t !== 'copy' || header.kind !== 'mirror') throw new Error('a mirror copy starts with its copy line');
  /** @type {Map<string, DocState>} */
  const docs = new Map();
  for (const row of lines.slice(1)) {
    docs.set(row.k, row.s === 'present' ? { s: 'present', h: row.h } : row.s === 'absent' ? { s: 'absent' } : { s: 'error', err: row.err ?? '' });
  }
  const at = Date.parse(header.at);
  return { name: header.name, kind: 'mirror', at: Number.isFinite(at) ? at : null, run: header.run, docs };
}

/** @param {SharedWrite} w */
const writeName = w => `${w.lane} c=${w.c} (log ${w.log + 1}, send ${w.id})`;
/** @param {DocState | undefined} state */
const shown = state => (!state ? 'nothing' : state.s === 'present' ? `version ${state.h.slice(0, 12)}` : state.s === 'absent' ? 'no file' : 'an unreadable file');

/**
 * The writes on the chain that ends on a copy's version: that version's write, the write it was built on, and so on,
 * up to a version no write of the run made (the file as the run found it).
 * @param {SharedWrite[]} writes
 * @param {DocState} state
 */
function chainOf(writes, state) {
  /** @type {Map<string, SharedWrite>} */
  const byHash = new Map(writes.map(w => [w.h, w]));
  /** @type {SharedWrite[]} */
  const chain = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let at = state.s === 'present' ? state.h : null;
  while (at !== null && byHash.has(at) && !seen.has(at)) {
    seen.add(at);
    const w = /** @type {SharedWrite} */ (byHash.get(at));
    chain.push(w);
    at = w.prev;
  }
  return chain;
}

/**
 * One copy against the writes of each key: SHARED-LOST for acknowledged writes off its chain, PHANTOM for a refusal
 * given before applying that is on it.
 * @param {SharedHistory} history
 * @param {SharedCopy} copy
 * @returns {Verdict[]}
 */
function judgeChains(history, copy) {
  /** @type {Verdict[]} */
  const verdicts = [];
  for (const [key, writes] of history.keys) {
    const state = copy.docs.get(key) ?? (copy.kind === 'row' ? { s: 'absent' } : undefined);
    if (!state || state.s === 'error') continue;
    const chain = chainOf(writes, state);
    const onChain = new Set(chain);
    const refused = chain.filter(w => w.cls === 'REFUSED' && w.definite);
    if (refused.length > 0) {
      verdicts.push({ v: 'PHANTOM', key, copy: copy.name, detail: `${copy.name} holds a version made by, or built on, a write refused before applying: ${refused.map(writeName).join(', ')}` });
    }
    const lost = writes.filter(w => w.cls === 'ACKED' && !onChain.has(w));
    if (lost.length > 0) {
      verdicts.push({ v: 'SHARED-LOST', key, copy: copy.name, detail: `${lost.length} acknowledged write(s) are not in the history of the ${shown(state)} ${copy.name} holds: ${lost.slice(0, 3).map(writeName).join(', ')}` });
    }
  }
  return verdicts;
}

/**
 * @param {SharedHistory} history
 * @returns {Verdict[]}
 */
function judgeOverwrites(history) {
  /** @type {Verdict[]} */
  const verdicts = [];
  for (const [key, writes] of history.keys) {
    /** @type {Map<string, SharedWrite[]>} */
    const byPrev = new Map();
    for (const w of writes) {
      // Only acknowledged writes: a held or unanswered one may never land.
      if (w.cls !== 'ACKED') continue;
      const base = w.prev ?? 'absent';
      byPrev.set(base, [...(byPrev.get(base) ?? []), w]);
    }
    for (const [base, group] of byPrev) {
      if (group.length < 2) continue;
      const on = base === 'absent' ? 'no stored version' : `version ${base.slice(0, 12)}`;
      verdicts.push({ v: 'SHARED-OVERWRITE', key, detail: `acknowledged writes ${group.map(writeName).join(' and ')} were all built on ${on}: at most one of them was stored over the version it read` });
    }
  }
  return verdicts;
}

/**
 * @param {SharedHistory} history
 * @param {SharedCopy[]} mirrors the mirrors judged (taken after the bound)
 * @returns {Verdict[]}
 */
function judgeMirrorForks(history, mirrors) {
  /** @type {Verdict[]} */
  const verdicts = [];
  for (const key of history.keys.keys()) {
    const states = mirrors.map(m => ({ m, state: m.docs.get(key) })).filter(x => x.state && x.state.s !== 'error');
    const sig = (/** @type {DocState | undefined} */ s) => (s && s.s === 'present' ? s.h : 'absent');
    if (new Set(states.map(x => sig(x.state))).size > 1) {
      verdicts.push({
        v: 'SHARED-FORK', key, copy: states.map(x => x.m.name).join(','),
        detail: `the mirrors differ: ${states.map(x => `${x.m.name} holds ${shown(x.state)}`).join(', ')}`,
      });
    }
  }
  return verdicts;
}

/**
 * Everything the shared files add to the result.
 * @param {{ history: SharedHistory, rows: SharedCopy[], mirrors: SharedCopy[], boundS?: number }} input
 * @returns {{ verdicts: Verdict[], inconclusive: string[], notes: string[] }}
 */
export function judgeShared(input) {
  const { history } = input;
  const boundS = input.boundS ?? SHARED_BOUND_S;
  for (const m of input.mirrors) {
    if (m.run !== undefined && m.run !== history.run) throw new Error(`mirror copy ${m.name} is of run ${m.run}, not run ${history.run}`);
  }
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {string[]} */
  const inconclusive = [];
  /** @type {string[]} */
  const notes = [];
  if (history.keys.size === 0) return { verdicts, inconclusive, notes };
  inconclusive.push(...history.problems);
  const acked = [...history.keys.values()].flat().filter(w => w.cls === 'ACKED').length;
  if (acked === 0) inconclusive.push('no shared write was acknowledged, so the shared files were not tested');
  if (input.rows.length === 0) inconclusive.push('no database listing of the shared files was given (--shared-db)');

  // A mirror is judged only once the bound has passed since the last writer ended, by the mirror's clock.
  const ends = history.ends;
  const lastEnd = ends.some(e => e === null) ? null : Math.max(...ends.map(e => /** @type {number} */ (e)));
  /** @type {SharedCopy[]} */
  const mirrors = [];
  for (const m of input.mirrors) {
    if (lastEnd === null) {
      inconclusive.push(`mirror copy ${m.name} was not judged: a writer log has no end time, so the bound cannot be counted from it`);
    } else if (m.at === null || m.at < lastEnd + boundS * 1000) {
      const after = m.at === null ? 'at no recorded time' : `${Math.round((m.at - lastEnd) / 1000)} s after the writer ended`;
      inconclusive.push(`mirror copy ${m.name} was taken ${after}, before the ${boundS} s bound in which a machine takes every stored change: take it again`);
    } else {
      mirrors.push(m);
    }
  }
  if (mirrors.length < 2) {
    inconclusive.push(`${mirrors.length} machine(s)' mirror copies were judged; SHARED-FORK and each mirror's SHARED-LOST need one from each of two machines (--mirror)`);
  }
  for (const m of mirrors) {
    const unread = [...history.keys.keys()].filter(key => m.docs.get(key)?.s === 'error' || !m.docs.has(key));
    if (unread.length > 0) inconclusive.push(`mirror copy ${m.name} could not read ${unread.length} shared file(s) (${unread.slice(0, 3).join(', ')})`);
  }

  verdicts.push(...judgeOverwrites(history));
  for (const copy of [...input.rows, ...mirrors]) verdicts.push(...judgeChains(history, copy));
  verdicts.push(...judgeMirrorForks(history, mirrors));
  const held = [...history.keys.values()].flat().filter(w => w.cls === 'HELD').length;
  if (held > 0) notes.push(`${held} shared write(s) were answered held (202): judged as writes that may have landed, never as acknowledged`);
  return { verdicts, inconclusive, notes };
}

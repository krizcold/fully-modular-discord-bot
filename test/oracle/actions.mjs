// @ts-check
/**
 * The verdict rules of an act run (NB15 test 12): panel button presses and command invokes sent through a web UI to
 * the bot process that holds the guild, each judged against the docs the oracle's action module saved for it. Each run
 * of an action saves one doc `<nonce>.<tag>.json` (oracle.mjs ACTION_DOC), so the listing counts how often each
 * action ran and saved.
 */
import { ACTION_DOC } from './oracle.mjs';

/** @typedef {import('./oracle.mjs').AnswerClass} AnswerClass */
/** @typedef {import('./judge.mjs').Verdict} Verdict */
/**
 * @typedef {{ log: number, id: number, lane: string, kind: 'button' | 'invoke', nonce: string, at: number,
 *   cls: AnswerClass, definite: boolean, ansAt: number, status: number, err?: string }} Action
 * @typedef {{ actions: Action[], problems: string[] }} ActionHistory
 * @typedef {{ name: string, runs: Map<string, number>, other: string[] }} ActionListing
 */

/** Whether a parsed log is an act log. @param {any[]} events */
export const isActLog = events => events.find(e => e.t === 'start')?.mode === 'act';

/**
 * The actions of the act logs, each with its answer; a send with no answer line is unknown.
 * @param {any[][]} logs
 * @returns {ActionHistory}
 */
export function buildActions(logs) {
  /** @type {Action[]} */
  const actions = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<string>} */
  const nonces = new Set();
  logs.forEach((events, log) => {
    /** @type {Map<number, any>} */
    const answers = new Map();
    for (const e of events) if (e.t === 'act-ans') answers.set(e.id, e);
    for (const e of events) {
      if (e.t !== 'act-send') continue;
      if (nonces.has(e.nonce)) throw new Error(`action nonce ${e.nonce} was sent twice`);
      nonces.add(e.nonce);
      const ans = answers.get(e.id);
      actions.push({
        log, id: e.id, lane: e.lane, kind: e.kind, nonce: e.nonce, at: e.at,
        cls: ans ? ans.cls : 'UNKNOWN', definite: ans ? ans.definite === true : false,
        ansAt: ans ? ans.at : Infinity, status: ans ? ans.status : 0, ...(ans?.err ? { err: ans.err } : {}),
      });
    }
    const end = events.find(e => e.t === 'end');
    const counted = end?.counts?.act;
    if (counted && typeof counted === 'object') {
      /** @type {Record<string, number>} */
      const held = { ACKED: 0, HELD: 0, REFUSED: 0, UNKNOWN: 0 };
      for (const e of events) if (e.t === 'act-ans') held[e.cls] = (held[e.cls] ?? 0) + 1;
      const mismatched = Object.keys(held).filter(key => counted[key] !== held[key]);
      if (mismatched.length > 0) {
        problems.push(`log ${log + 1}'s end line counts actions ${mismatched.map(key => `${key} ${counted[key]}`).join(', ')}, but its lines hold ${mismatched.map(key => `${key} ${held[key]}`).join(', ')}: lines are missing`);
      }
    }
  });
  return { actions, problems };
}

/**
 * An action listing (oracle.mjs sql actions under psql -At): {"k": filename, "d": doc} lines. Each doc named as
 * ACTION_DOC counts one run of its action; any other doc of the run's prefix is listed under `other`.
 * @param {string} name
 * @param {string} text
 * @returns {ActionListing}
 */
export function actionListing(name, text) {
  /** @type {Map<string, number>} */
  const runs = new Map();
  /** @type {string[]} */
  const other = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    /** @type {any} */
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${name} line ${i + 1} is not a JSON row`);
    }
    if (typeof row?.k !== 'string' || typeof row.d !== 'string') throw new Error(`${name} line ${i + 1} needs "k" and "d"`);
    const m = ACTION_DOC.exec(row.k);
    if (m) runs.set(m[1], (runs.get(m[1]) ?? 0) + 1);
    else other.push(row.k);
  });
  return { name, runs, other };
}

/**
 * Each action's answer against the runs the listing shows. TWICE: an action ran and saved more than once.
 * FALSE-ANSWER: an action answered as ran and saved (a 200 with success) whose save is not stored, or one refused as
 * never run (a code or `ran: false` that proves it) that saved. PHANTOM: a run of an action no writer sent. An answer
 * that may have run (can't confirm, no answer, a failure after the action ran) allows none or one run.
 * @param {ActionHistory} history
 * @param {ActionListing[]} listings
 * @returns {{ verdicts: Verdict[], inconclusive: string[], notes: string[] }}
 */
export function judgeActions(history, listings) {
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {string[]} */
  const inconclusive = [...history.problems];
  /** @type {string[]} */
  const notes = [];
  const sent = new Map(history.actions.map(a => [a.nonce, a]));
  for (const listing of listings) {
    const add = (/** @type {string} */ v, /** @type {string} */ key, /** @type {string} */ detail) => verdicts.push({ v, key, copy: listing.name, detail });
    for (const a of history.actions) {
      const runs = listing.runs.get(a.nonce) ?? 0;
      const what = `${a.kind} #${a.id} (${a.lane})`;
      if (runs > 1) add('TWICE', a.nonce, `${what} ran and saved ${runs} times`);
      if (a.cls === 'ACKED' && runs === 0) add('FALSE-ANSWER', a.nonce, `${what} was answered as ran and saved (${a.status}), but no save of it is stored`);
      if (a.cls === 'REFUSED' && a.definite && runs > 0) add('FALSE-ANSWER', a.nonce, `${what} was refused as never run (${a.status}${a.err ? `: ${a.err.slice(0, 80)}` : ''}), but it saved ${runs} times`);
    }
    for (const [nonce, runs] of listing.runs) {
      if (!sent.has(nonce)) add('PHANTOM', nonce, `${runs} saves of an action no writer sent`);
    }
    if (listing.other.length > 0) notes.push(`${listing.name} holds ${listing.other.length} docs of the run that are not action saves (${listing.other.slice(0, 3).join(', ')})`);
  }
  if (listings.length === 0) inconclusive.push('no action listing was given (--actions)');
  for (const kind of /** @type {const} */ (['button', 'invoke'])) {
    if (!history.actions.some(a => a.kind === kind && a.cls === 'ACKED')) inconclusive.push(`no ${kind === 'button' ? 'panel button' : 'command invoke'} was answered as ran and saved, so that route was not proven`);
  }
  return { verdicts, inconclusive, notes };
}

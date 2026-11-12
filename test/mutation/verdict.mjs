// What the L5 gate concludes from its passes (mutation/README.md). Pure: the
// caller runs Stryker and reads vitest's reports.

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {'a' | 'a2' | 'b' | 'b2'} PassName
 * @typedef {{ id: string | null, dir?: string, status: string, statusReason?: string, killedBy?: string, timeout?: string,
 *   inconclusive?: string, recheck?: string, voided?: string, unreached?: boolean, pending?: 'alone-a' | 'alone-a2', bounded?: boolean }}
 *   PassResult dir: the report dir the
 *   id's runs are in (Stryker numbers each run's mutants anew); recheck: the test that failed only on the machine's
 *   texts, so the mutant reruns alone; voided: why a rerun's kill or timeout no longer counts; unreached: no test
 *   file reached the mutant in the pass's run with no mutant (pass A or its run with no checker, or pass B), so its run
 *   there ran none; a
 *   CompileError with an inconclusive is one only of an unused `@ts-expect-error` (TS2578), which no test met; pending:
 *   the check with no mutant (touched.mjs aloneCheck or setCheck) that covers the result and has not finished; bounded:
 *   the runner, not Stryker, ended the run at the bound built from its files' costs (endedByBound)
 * @typedef {{ file: string, location: Location, mutator: string, original: string, replacement: string, gating: boolean,
 *   passes: Partial<Record<PassName, PassResult>> }} MutantRecord
 * @typedef {{ name: string, status?: string, message?: string,
 *   assertionResults?: { status: string, fullName: string, failureMessages?: string[] }[] }} FileReport
 */

// A failure the machine may cause as well as the mutant: a connection or a
// container that would not come up, a resource that ran out, a file held or
// refused (on Windows, a temp dir a test removes while a run beside it or the
// indexer holds a file in it). Matched against the first line of a failure
// unless it is an AssertionError (a stack or a child's stderr is never read),
// and only in a pass's first run: a run whose failures all match reruns the
// mutant alone (toConfirm), where the texts are not read, since a failure that
// repeats with the mutant alone, while the run with no mutant after the reruns
// passes, is the mutant's. The list only spares reruns, so it need not be complete.
export const INFRASTRUCTURE = new RegExp([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EMFILE', 'ENOMEM', 'ENOSPC', 'heap out of memory',
  'EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES',
  'Connection terminated', 'timeout exceeded when trying to connect', 'too many clients', 'not queryable',
  'the database system is', 'Health check not healthy', 'Wait strategy', 'waiting for container', 'Container failed to start',
  'container runtime', 'HTTP code 5\\d\\d', 'toomanyrequests',
].join('|'));
// A test or its hook that ran out of vitest's time: the mutant may hang it, or
// the host was slow. A child scenario step's own bound ("did not finish in N
// ms", helpers/child.ts) is not one: it is the test's assertion that the step
// ends, and fails like any other.
export const TIMEOUT = /(Test|Hook) timed out in \d+ ?ms/;

/** @param {string} name */
const testFile = name => name.split('\\').join('/').replace(/^.*\/\.stryker-tmp\/sandbox-[^/]+\/test\//, '');
/** @param {string} text */
const firstLine = text => text.split('\n')[0];

/**
 * What a run that Stryker counted as a kill shows, from the vitest reports it
 * left: a kill when a test itself failed, in a first run for a reason other
 * than the machine's texts; a timeout only when every failing test timed out
 * and, in a first run, nothing else failed on the machine's texts (a file that
 * could not start included); a recheck when a first run's failing tests failed
 * only on them, or timed out beside them; anything else (no report, a failure
 * only in a beforeAll or afterAll hook or at file level, an unhandled error)
 * proves nothing. vitest counts a beforeEach or afterEach failure as its
 * test's, so it counts as a test's.
 * @param {{ testResults?: FileReport[] }[]} reports
 * @param {boolean} [alone] a rerun of the mutant alone: the machine's texts are not read
 * @returns {{ killedBy: string } | { timeout: string } | { recheck: string, inconclusive: string } | { inconclusive: string }}
 */
export function classifyKill(reports, alone = false) {
  if (reports.length === 0) return { inconclusive: 'no vitest report was written' };
  /** @type {{ test: string, message: string }[]} */
  const failed = [];
  /** @type {string[]} */
  const fileMessages = [];
  for (const report of reports) {
    for (const file of report.testResults ?? []) {
      if (file.status === 'failed' && file.message) fileMessages.push(firstLine(file.message));
      for (const test of file.assertionResults ?? []) {
        if (test.status === 'failed') failed.push({ test: `${testFile(file.name)} > ${test.fullName}`, message: (test.failureMessages ?? []).join('\n') });
      }
    }
  }
  if (failed.length === 0) {
    return { inconclusive: `no test failed: the run failed in a hook, at file level or on an unhandled error${fileMessages[0] ? ` (${fileMessages[0]})` : ''}` };
  }
  /** @param {{ message: string }} f */
  const assertion = f => f.message.startsWith('AssertionError');
  /** @param {{ message: string }} f */
  const machine = f => !alone && !assertion(f) && INFRASTRUCTURE.test(firstLine(f.message));
  /** @param {{ message: string }} f */
  const timedOutTest = f => !assertion(f) && TIMEOUT.test(firstLine(f.message));
  const real = failed.find(f => !machine(f) && !timedOutTest(f));
  if (real) return { killedBy: real.test };
  const machineText = [...failed.filter(machine).map(f => firstLine(f.message)), ...(alone ? [] : fileMessages.filter(text => INFRASTRUCTURE.test(text)))][0];
  const timedOut = failed.find(timedOutTest);
  if (timedOut && machineText === undefined) return { timeout: timedOut.test };
  const recheck = (failed.find(machine) ?? failed[0]).test;
  return { recheck, inconclusive: timedOut ? `a test timed out while the machine failed: ${machineText}` : `only the machine failed: ${firstLine(failed[0].message)}` };
}

/**
 * Whether a type checker's reason (tsc's formatted errors) names only unused
 * `@ts-expect-error` directives (TS2578): the mutated code type-checks, and the
 * one error is that a line under such a directive no longer needs it, so the
 * checker proves nothing and the mutant must meet the tests: a gating one meets
 * pass A's tests again with no checker, and that run is its pass A.
 * @param {string} reason
 */
export function onlyUnusedDirective(reason) {
  const codes = [...reason.matchAll(/error TS(\d+):/g)].map(m => m[1]);
  return codes.length > 0 && codes.every(code => code === '2578');
}

/**
 * A run of named files that the runner ended at its bound (runner.mjs,
 * `<id>-bound.json`; `mark`: what that file holds, `{}` when it is there but
 * cannot be read, null when it is not there): Stryker counts the run's
 * non-zero exit as a kill, and it is recorded as a timeout, as a result
 * Stryker itself reports as Timeout is. In pass A that bound is the gate's
 * own; in a2 (`alone`) it is the run's own budget. null when the result stands
 * as Stryker reported it: no mark, or any status but Killed.
 * @param {string} status Stryker's
 * @param {unknown} mark
 * @param {boolean} [alone] an a2 rerun
 * @returns {{ status: 'Timeout', statusReason: string, bounded: true } | null}
 */
export function endedByBound(status, mark, alone = false) {
  if (status !== 'Killed' || mark === null || mark === undefined) return null;
  const ms = typeof mark === 'object' ? /** @type {{ ms?: unknown }} */ (mark).ms : undefined;
  const known = typeof ms === 'number' && Number.isFinite(ms);
  if (alone) {
    const budget = known ? `${Math.round(ms / 1000)} s` : 'a time that could not be read';
    return { status: 'Timeout', statusReason: `ran past its own budget alone (${budget}: four times what its files take in a2's run with no mutant, plus a minute)`, bounded: true };
  }
  const after = known ? `after ${Math.round(ms / 1000)} s` : 'after a time that could not be read';
  return { status: 'Timeout', statusReason: `the gate's bound on the run ended it ${after}`, bounded: true };
}

/**
 * One pass's outcome for a mutant.
 * @param {PassResult} result
 */
export function outcomeOf(result) {
  if (result.status === 'Killed') return result.killedBy ? 'Killed' : result.timeout ? 'Timeout' : result.recheck ? 'Recheck' : 'Inconclusive';
  if (result.status === 'CompileError' && result.inconclusive) return 'Inconclusive';
  return result.status;
}

/** @param {MutantRecord} m */
export const latest = m => /** @type {PassResult} */ (m.passes.b2 ?? m.passes.b ?? m.passes.a2 ?? m.passes.a);

export const UNREACHED = 'no fast test reached it';

/**
 * Whether no fast test reached the mutant in the run with no mutant of its
 * last pass of pass A's tests, so that pass ran no test on it.
 * @param {MutantRecord} m
 */
export const unreached = m => Boolean((m.passes.a2 ?? m.passes.a)?.unreached);

export const UNREACHED_B = 'no test of pass B reached it';

/**
 * Whether no integration or child test reached the mutant in pass B's run with
 * no mutant, so pass B ran no test on it.
 * @param {MutantRecord} m
 */
export const unreachedInB = m => Boolean(m.passes.b?.unreached);

/** @param {PassResult | undefined} b what pass B found, which sent the mutant to a rerun alone */
const failedInB = b => (b?.killedBy ? `killed in pass B by ${b.killedBy}` : `failed in pass B only on the machine's texts (${b?.recheck})`);

/**
 * A mutant's outcome, counting for a gating one only what its rerun alone
 * confirmed. In pass A a timeout counts when the rerun, with four times the
 * config's time limits, times out alone (a test or its beforeEach or afterEach
 * hook, or the whole run past its budget: its own when it takes named files and
 * their costs are known, else Stryker's) or fails a test, and so does a
 * run that failed only on the machine's texts. In pass B, where containers and children can be
 * slow on their own, a hang never counts, and a kill (or a run that failed only
 * on the machine's texts) counts only when the test file that failed fails for
 * it again when run alone; when that file passes alone, the tests after it in
 * pass B never ran on the mutant, so it is no survivor either. One the gate
 * never reran, or whose rerun was voided (the run with no mutant after it
 * failed) or never checked by that run (the gate stopped first), is
 * inconclusive. So is an a2 result whose set of files, run with no mutant
 * (alone-a2/, voidFailedSets), failed, ran past its bound, left no result or,
 * for a timeout, was too slow, and, when the gate stopped, a pass A or a2
 * result whose run with no mutant (alone-a or alone-a2) never finished.
 * @param {MutantRecord} m
 * @param {boolean} [stopped] the gate stopped before it finished: a survivor pass B never ran on is no survivor, and
 *   a b2 kill, pass A kill or a2 result no run with no mutant checked is no kill
 * @returns {{ outcome: string, why?: string }}
 */
export function confirmed(m, stopped = false) {
  const { a2, b, b2 } = m.passes;
  const last = outcomeOf(latest(m));
  if (last === 'Recheck') return { outcome: 'Inconclusive', why: `${latest(m).inconclusive}, ${b ? 'in pass B, ' : ''}never rerun alone` };
  // Only a later pass can find no mutant at a place pass A made one: a rerun,
  // pass B, pass A again with no checker, or pass A on the mutants a stopped
  // run has no result for, which the plan it saved holds.
  if (last === 'Missing') {
    const dir = m.passes.a?.dir;
    const inA = dir === undefined || dir.startsWith('a-unchecked') ? 'A with no checker' : `A in ${dir}/`;
    return { outcome: 'Inconclusive', why: `pass ${b2 ? 'b2' : b ? 'b' : a2 ? 'a2' : inA} made no mutant at this place, so it ran no test on it` };
  }
  if (m.gating && b2 && last === 'Survived') {
    return { outcome: 'Inconclusive', why: `${failedInB(b)}, but not when that file ran alone, and the tests after it in pass B never ran on it` };
  }
  if (stopped && m.gating && !b && (last === 'Survived' || last === 'NoCoverage')) return { outcome: 'Inconclusive', why: 'pass B never ran on it: the gate stopped first' };
  if (!m.gating || (last !== 'Killed' && last !== 'Timeout')) return { outcome: last };
  const { voided } = latest(m);
  if (voided) return { outcome: 'Inconclusive', why: voided };
  const { pending, killedBy } = latest(m);
  if (stopped && pending === 'alone-a') return { outcome: 'Inconclusive', why: `killed in pass A by ${killedBy}, but the gate stopped before its file ran with no mutant` };
  if (stopped && pending === 'alone-a2') {
    return { outcome: 'Inconclusive', why: `${last === 'Timeout' ? 'timed out' : `killed by ${killedBy}`} in a2, but the gate stopped before its set ran with no mutant` };
  }
  if (b && outcomeOf(b) === 'Timeout') return { outcome: 'Inconclusive', why: 'hung in pass B, where a hang is not counted' };
  if (b2 && last === 'Timeout') return { outcome: 'Inconclusive', why: `${failedInB(b)}, but hung instead of failing when run alone` };
  // The run with no mutant after b2 comes after every b2 run, and the gate only
  // finishes once it passes, so a stopped gate's b2 kill was never checked by it.
  if (stopped && b2) return { outcome: 'Inconclusive', why: `${failedInB(b)}, and again alone, but the gate stopped before the run with no mutant after the reruns` };
  if (b && !b2) return { outcome: 'Inconclusive', why: 'killed in pass B, never rerun alone' };
  if (!b && !a2 && last === 'Timeout') return { outcome: 'Inconclusive', why: 'timed out, never rerun alone' };
  return { outcome: last };
}
/** @param {MutantRecord} m */
export const outcome = m => confirmed(m).outcome;

// A gating mutant that ends in one of these fails the gate.
export const FAILING = ['Survived', 'NoCoverage', 'Inconclusive', 'RuntimeError', 'Ignored'];

/**
 * The gating mutants a pass sends to a confirming run of their own (one at a
 * time, with four times the config's time limits): pass A's timeouts, which
 * count when the rerun alone times out or fails a test, and pass B's kills,
 * which count only when the test file that killed them fails for them again;
 * in both, the runs that failed only on the machine's texts, which count when
 * they fail alone.
 * @param {MutantRecord[]} mutants
 * @param {'a' | 'b'} pass
 */
export const toConfirm = (mutants, pass) => mutants.filter(m => {
  const result = m.passes[pass];
  const status = result && outcomeOf(result);
  return m.gating && (status === 'Recheck' || status === (pass === 'a' ? 'Timeout' : 'Killed'));
});

/**
 * The gating mutants whose only type error in pass A was an unused
 * `@ts-expect-error`: they meet pass A's tests again with no checker.
 * @param {MutantRecord[]} mutants
 */
export const toUncheck = mutants => mutants.filter(m => m.gating && m.passes.a?.status === 'CompileError' && Boolean(m.passes.a.inconclusive));

/**
 * The pass B runs to confirm (kills, and runs that failed only on the
 * machine's texts), grouped by the test file that failed in each, in order:
 * each file reruns alone on its own mutants.
 * @param {MutantRecord[]} mutants
 */
export function byKiller(mutants) {
  /** @type {Map<string, MutantRecord[]>} */
  const groups = new Map();
  for (const m of mutants) {
    const file = (m.passes.b?.killedBy ?? m.passes.b?.recheck ?? '').split(' > ')[0];
    groups.set(file, [...(groups.get(file) ?? []), m]);
  }
  return groups;
}

/**
 * Pass A's kills (with no checker included), by the test file that failed in
 * each, in order: each such file runs alone with no mutant (touched.mjs
 * aloneCheck), since a mutant's run there took only some of the fast files.
 * @param {MutantRecord[]} mutants
 */
export function killedInA(mutants) {
  /** @type {Map<string, MutantRecord[]>} */
  const groups = new Map();
  for (const m of mutants) {
    const a = m.passes.a;
    if (!a || outcomeOf(a) !== 'Killed') continue;
    const file = (a.killedBy ?? '').split(' > ')[0];
    groups.set(file, [...(groups.get(file) ?? []), m]);
  }
  return groups;
}

/**
 * Takes back each pass A kill whose test file failed when run alone with no
 * mutant, or left no exit there (`codes`: per file, the exit of its run alone,
 * as dry-alone.json holds them): the kill becomes a run that failed only on the
 * machine, so a gating one reruns alone in a2, and one that is not stays
 * inconclusive. Returns, per such file, why.
 * @param {Map<string, MutantRecord[]>} killed killedInA's groups
 * @param {Record<string, unknown>} codes
 * @param {string} dir the dir of the runs alone
 * @returns {Map<string, string>}
 */
export function uncreditFailedAlone(killed, codes, dir) {
  /** @type {Map<string, string>} */
  const taken = new Map();
  for (const [file, on] of killed) {
    const code = Object.hasOwn(codes, file) ? codes[file] : undefined;
    if (code === 0) continue;
    const why = code === undefined ? `its run alone with no mutant (${dir}/) left no result` : `it failed alone with no mutant (${dir}/)`;
    taken.set(file, why);
    for (const m of on) {
      const a = /** @type {PassResult} */ (m.passes.a);
      const { killedBy, ...rest } = a;
      m.passes.a = { ...rest, recheck: killedBy, inconclusive: `killed in pass A by ${killedBy}, but ${file}: ${why}, so the kill proves nothing` };
    }
  }
  return taken;
}

/**
 * The a2 kills and timeouts whose run took only some of the fast test files,
 * by that set, in order: each set runs once with no mutant (touched.mjs
 * setCheck), since the run with no mutant after the reruns took every related
 * file. `taken` gives the files a mutant's a2 run took: 'related' for every
 * related file, or null when that could not be read, which groups as a set of
 * its own with no files.
 * @param {MutantRecord[]} mutants
 * @param {(m: MutantRecord) => string[] | 'related' | null} taken
 * @returns {{ files: string[] | null, on: MutantRecord[] }[]}
 */
export function bySet(mutants, taken) {
  /** @type {Map<string | null, { files: string[] | null, on: MutantRecord[] }>} */
  const groups = new Map();
  for (const m of mutants) {
    const a2 = m.passes.a2;
    if (!a2 || a2.voided || !['Killed', 'Timeout'].includes(outcomeOf(a2))) continue;
    const files = taken(m);
    if (files === 'related') continue;
    const key = files === null ? null : JSON.stringify(files);
    const group = groups.get(key) ?? { files, on: [] };
    group.on.push(m);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Voids each a2 kill or timeout of bySet's groups whose set of files failed
 * together with no mutant, left no result there, or could not be read, and
 * each a2 timeout whose set took longer with no mutant than the budget that
 * rerun had: for one the runner ended at its own budget (bounded), the set's
 * own, `ownBudget(files)` (NaN when unknown); for one Stryker ended, `budget`,
 * the ms Stryker gave each a2 run (NaN when unknown). Either budget can be
 * given per mutant, for a2 results from more than one dir of a2 (a resume's).
 * `runs` is what dry-alone.json holds: per set, its files, exit and time, and
 * the dir it ran in when that is not `dir`. Returns a report line per set and
 * reason whose results were voided, and the number of sets any result was
 * voided in.
 * @param {{ files: string[] | null, on: MutantRecord[] }[]} sets
 * @param {unknown} runs
 * @param {string} dir the dir of the runs with no mutant
 * @param {number | ((m: MutantRecord) => number)} budget
 * @param {(files: string[], m: MutantRecord) => number} [ownBudget]
 * @returns {{ lines: string[], voided: number }}
 */
export function voidFailedSets(sets, runs, dir, budget, ownBudget = () => NaN) {
  /** @type {string[]} */
  const lines = [];
  let count = 0;
  /** @type {{ files?: unknown, code?: unknown, ms?: unknown, dir?: unknown }[]} */
  const list = Array.isArray(runs) ? runs.filter(r => r !== null && typeof r === 'object') : [];
  /** @param {number} ms */
  const seconds = ms => `${Math.round(ms / 1000)} s`;
  for (const { files, on } of sets) {
    const run = files ? list.find(r => JSON.stringify(r.files) === JSON.stringify(files)) : undefined;
    const at = typeof run?.dir === 'string' ? run.dir : dir;
    const named = files ? files.join(', ') : '';
    const ms = typeof run?.ms === 'number' && Number.isFinite(run.ms) ? run.ms : NaN;
    const failed = !files
      ? 'the files its a2 run took could not be read'
      : run?.code === undefined || typeof run.code !== 'number' ? `${named}, run together with no mutant (${at}/), left no result`
        : run.code !== 0 ? `${named} failed together with no mutant (${at}/)` : '';
    const took = `${named} took ${Number.isFinite(ms) ? seconds(ms) : 'a time that could not be read'} together with no mutant (${at}/)`;
    /** @param {MutantRecord} m */
    const slowStryker = m => {
      const limit = typeof budget === 'function' ? budget(m) : budget;
      return ms <= limit ? '' : `${took}, not within the ${Number.isFinite(limit) ? seconds(limit) : 'unknown budget'} Stryker gave each a2 run`;
    };
    /** @param {MutantRecord} m */
    const slowOwn = m => {
      const own = files ? ownBudget(files, m) : NaN;
      return ms <= own ? ''
        : `${took}, not within ${Number.isFinite(own) ? `the ${seconds(own)}` : 'an unknown'} budget of that set alone (four times what its files take in a2's run with no mutant, plus a minute)`;
    };
    /** @type {Map<string, number>} */
    const voided = new Map();
    for (const m of on) {
      const a2 = /** @type {PassResult} */ (m.passes.a2);
      const timeout = outcomeOf(a2) === 'Timeout';
      const why = failed || (timeout ? (a2.bounded ? slowOwn(m) : slowStryker(m)) : '');
      if (!why) continue;
      voided.set(why, (voided.get(why) ?? 0) + 1);
      m.passes.a2 = { ...a2, voided: `${timeout ? 'timed out' : `killed by ${a2.killedBy}`} in a2, but ${why}, so it proves nothing` };
    }
    if (voided.size > 0) count += 1;
    for (const [why, count] of voided) lines.push(`${why}, so ${count} a2 result(s) that ran on it do not count`);
  }
  return { lines, voided: count };
}

/**
 * The gating mutants pass B takes: the ones no in-process test killed.
 * @param {MutantRecord[]} mutants
 */
export const toPassB = mutants => mutants.filter(m => m.gating && ['Survived', 'NoCoverage'].includes(outcome(m)));

/**
 * The verdict and the L5 report.
 * `stopped` names why the gate stopped before it finished (a pass that could
 * not run); the passes it did finish are still reported. `treeChanged` names
 * the files that changed during the run (tree.mjs), so no one tree was tested.
 * `controls` names the runs with no mutant made to check a pass: each file
 * that killed in pass A run alone, each set of files an a2 result ran on, and
 * the run after the reruns, each entry with what failed there, if anything.
 * `standIn` is set when a test replaced vitest (runner.mjs's
 * SMDB_MUTATION_VITEST): such a run proves nothing about the code.
 * `resumed` says, for a run that resumed a stopped one (touched.mjs
 * --resume), what each stage it found saved kept and what it ran now.
 * @param {{ stamp: string, scope: string, emptyScope: boolean, skipped: { file: string, why: string }[], mutants: MutantRecord[],
 *   noMutant: { file: string, lines: number[] }[], brackets?: { file: string, lines: number[] }[], deleted?: { file: string, lines: number[] }[],
 *   unmatched: string[], report: string, stopped?: string[], treeChanged?: string[], controls?: string[], resumed?: string[], standIn?: string }} run
 *   brackets: the changed lines that can move others (ranges.mjs structureLines): brackets and separators only, a brace
 *   of a block, or an else, case, default, catch or finally; deleted: where lines of code were taken out with fewer or
 *   none put back, each after the line named (0: the top)
 * @returns {{ verdict: 'PASS' | 'FAIL' | 'NO RESULT', code: 0 | 1 | 2, lines: string[] }}
 */
export function judge(run) {
  /** @param {MutantRecord} m */
  const confirmedIn = m => confirmed(m, Boolean(run.stopped));
  /** @param {MutantRecord} m */
  const outcomeIn = m => confirmedIn(m).outcome;
  const gating = run.mutants.filter(m => m.gating);
  const context = run.mutants.filter(m => !m.gating);
  const failing = gating.filter(m => FAILING.includes(outcomeIn(m)));
  const made = [...new Set(run.mutants.map(m => m.file))];
  /** @type {'PASS' | 'FAIL' | 'NO RESULT'} */
  let verdict = failing.length > 0 ? 'FAIL' : 'PASS';
  let why = '';
  if (run.standIn) { verdict = 'NO RESULT'; why = `vitest was replaced by a test's stand-in (SMDB_MUTATION_VITEST=${run.standIn})`; }
  else if (run.stopped) { verdict = 'NO RESULT'; why = 'the gate stopped before it finished'; }
  else if (run.treeChanged?.length) { verdict = 'NO RESULT'; why = 'the tree changed during the run, so no one tree was tested'; }
  else if (run.emptyScope) { verdict = 'NO RESULT'; why = 'no src file changed; for a job already committed, pass --base the commit before it'; }
  else if (gating.length === 0) {
    verdict = 'NO RESULT';
    why = `no gating mutant was made, so L5 tested nothing (see what was not mutated, and why${(run.deleted ?? []).length > 0 ? ', and where lines of code were taken out' : ''})`;
  }
  else if (gating.every(m => outcomeIn(m) === 'CompileError')) { verdict = 'NO RESULT'; why = 'every gating mutant was a type error, so no test ran against the change'; }

  /** @param {MutantRecord} m */
  const where = m => `${m.file}:${m.location.start.line}:${m.location.start.column}`;
  /** @param {MutantRecord} m */
  const note = m => {
    const last = latest(m);
    const why = confirmedIn(m).why ?? last.inconclusive ?? last.statusReason
      ?? (outcomeIn(m) === 'Timeout' ? (last.timeout ? `timed out alone: ${last.timeout}` : "ran past Stryker's budget alone") : '');
    const labels = [...(unreachedSurvivor(m) ? [UNREACHED] : []), ...(unreachedInBSurvivor(m) ? [UNREACHED_B] : [])];
    return labels.length > 0 ? [...labels, why].filter(Boolean).join('; ') : why;
  };
  /** @param {MutantRecord} m */
  const unreachedSurvivor = m => unreached(m) && ['Survived', 'NoCoverage'].includes(outcomeIn(m));
  /** @param {MutantRecord} m */
  const unreachedInBSurvivor = m => unreachedInB(m) && ['Survived', 'NoCoverage'].includes(outcomeIn(m));
  /** @param {MutantRecord} m */
  const show = m => `  ${where(m)} ${m.mutator}: \`${m.original}\` -> \`${m.replacement}\`${note(m) ? ` (${note(m)})` : ''}`;
  /** @param {MutantRecord[]} list */
  const tally = list => ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Inconclusive', 'RuntimeError', 'Ignored', 'CompileError']
    .map(status => `${list.filter(m => outcomeIn(m) === status).length} ${status}`).filter(entry => !entry.startsWith('0 ')).join(', ') || 'none';
  /**
   * @param {string} title
   * @param {MutantRecord[]} list
   */
  const section = (title, list) => (list.length > 0 ? [title, ...list.map(show)] : []);
  /** @param {string} status */
  const gatingAt = status => gating.filter(m => outcomeIn(m) === status);

  const lines = [
    `L5 touched-line mutation, ${run.stamp}`,
    `Scope: ${run.scope}`,
    ...(run.resumed?.length ? ['Resumed a stopped run (each stage goes on where it stopped, and no item of it runs twice):', ...run.resumed.map(line => `  ${line}`)] : []),
    `Mutated: ${made.length > 0 ? made.join(', ') : 'nothing'}`,
    ...(run.skipped.length > 0 ? ['Not mutated:', ...run.skipped.map(s => `  ${s.file}: ${s.why}`)] : []),
    ...(run.unmatched.length > 0 ? ['Patterns that made no mutant:', ...run.unmatched.map(p => `  ${p}`)] : []),
    ...(run.noMutant.length > 0 ? ['Changed lines of code no mutant lies wholly on (L5 says nothing about them; types, imports, signatures, and the code lines of a multi-line object, array, arrow body, call or condition with no mutant of their own; a changed line of brackets and separators only, in a diff, is listed apart):',
      ...run.noMutant.map(n => `  ${n.file}: ${n.lines.join(', ')}`)] : []),
    ...((run.brackets ?? []).length > 0 ? ['Changed lines that can move the unchanged lines beside them into or out of a block (brackets and separators only, a brace of a block, or an else, case, default, catch or finally; the lines they move are not gated, so check them):',
      ...(run.brackets ?? []).map(n => `  ${n.file}: ${n.lines.join(', ')}`)] : []),
    ...((run.deleted ?? []).length > 0 ? ['Places where lines of code were taken out with fewer or none put back (a line made a comment or a blank line included), so what was taken out is left nowhere to mutate (each after the line named, as the file is now; 0 is its top); check the code around each:',
      ...(run.deleted ?? []).map(n => `  ${n.file}: after ${n.lines.join(', ')}`)] : []),
    `Gating mutants (they touch a changed line that holds code, not one blank or a comment only): ${gating.length}: ${tally(gating)}`,
    `  killed in pass A: ${gating.filter(m => !m.passes.b && outcomeIn(m) === 'Killed').length}; run in pass B: ${gating.filter(m => m.passes.b).length}, killed there: ${gating.filter(m => m.passes.b && outcomeIn(m) === 'Killed').length}`,
    ...(gating.some(unreachedSurvivor) ? [`  survivors no fast test reached (none ran their code in the run with no mutant, so pass A ran no test on them): ${gating.filter(unreachedSurvivor).length}`] : []),
    ...(gating.some(unreachedInBSurvivor) ? [`  survivors no test of pass B reached (none ran their code in pass B's run with no mutant, so pass B ran no test on them): ${gating.filter(unreachedInBSurvivor).length}`] : []),
    ...section('Survivors (each needs a test that kills it, or a justification in the notes):', [...gatingAt('Survived'), ...gatingAt('NoCoverage')]),
    ...section('Silenced by a Stryker disable comment (each needs a justification in the notes):', gatingAt('Ignored')),
    ...section("Inconclusive (no test failed for the mutant itself; rerun, or add a test that fails on it: a failure the mutant itself causes only at load, in a beforeAll or afterAll, or as an unhandled error repeats on every rerun, so that test must fail inside its own body, where no static import or failing hook stops it first; mutation/README.md says where):", [...gatingAt('Inconclusive'), ...gatingAt('RuntimeError')]),
    ...section("Timeouts (each timed out when run alone with four times the config's limit, or past the limit a test or hook sets itself: a test or its beforeEach or afterEach hook, or the whole run past its budget; counted as killed, so check each replacement):", gatingAt('Timeout')),
    `Context mutants (in the widened statements, not gating: they touch no changed line that holds code): ${context.length}: ${tally(context)}`,
    ...section('Context survivors:', context.filter(m => outcomeIn(m) === 'Survived')),
    ...(run.controls?.length ? ['Runs with no mutant that checked what a pass counted:',...run.controls.map(line => `  ${line}`)] : []),
    ...(run.stopped ? ['Stopped:', ...run.stopped.map(line => `  ${line}`)] : []),
    ...(run.treeChanged?.length ? ['Changed during the run (so no one tree was tested):',
      `  ${run.treeChanged.slice(0, 10).join(', ')}${run.treeChanged.length > 10 ? ` and ${run.treeChanged.length - 10} more` : ''}`] : []),
    `Report: ${run.report} (mutants.json has every mutant, its passes and what killed it)`,
    `Verdict: ${verdict}${why ? ` (${why})` : ''}`,
  ];
  return { verdict, code: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2, lines };
}

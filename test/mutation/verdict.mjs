// What the L5 gate concludes from its passes (mutation/README.md). Pure: the
// caller runs Stryker and reads vitest's reports.

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {'a' | 'a2' | 'b' | 'b2'} PassName
 * @typedef {{ id: string | null, status: string, statusReason?: string, killedBy?: string, timeout?: string, inconclusive?: string }} PassResult
 * @typedef {{ file: string, location: Location, mutator: string, original: string, replacement: string, gating: boolean,
 *   passes: Partial<Record<PassName, PassResult>> }} MutantRecord
 * @typedef {{ name: string, status?: string, message?: string,
 *   assertionResults?: { status: string, fullName: string, failureMessages?: string[] }[] }} FileReport
 */

// A failure the machine causes, not the mutant: a connection or a container
// that would not come up, a resource that ran out. Matched against the first
// line of a failure (the error's own message), never against an assertion, a
// stack or a child's stderr, which may name such an error as the thing under
// test. The list cannot be complete, so every kill in pass B, where machines
// fail, must also repeat when the mutant runs alone (toConfirm).
export const INFRASTRUCTURE = new RegExp([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EMFILE', 'ENOMEM', 'ENOSPC', 'heap out of memory',
  'Connection terminated', 'timeout exceeded when trying to connect', 'too many clients', 'not queryable',
  'the database system is', 'Health check not healthy', 'Wait strategy', 'waiting for container', 'Container failed to start',
  'container runtime', 'HTTP code 5\\d\\d', 'toomanyrequests',
].join('|'));
// A test or its hook that ran out of time: the mutant may hang it, or the host was slow.
export const TIMEOUT = /(Test|Hook) timed out in \d+ ?ms|did not finish in \d+ ms/;

/** @param {string} name */
const testFile = name => name.split('\\').join('/').replace(/^.*\/\.stryker-tmp\/sandbox-[^/]+\/test\//, '');
/** @param {string} text */
const firstLine = text => text.split('\n')[0];

/**
 * What a run that Stryker counted as a kill shows, from the vitest reports it
 * left: a kill only when a test itself failed for a reason other than the
 * machine; a run whose failing tests all timed out is a timeout; anything
 * else (no report, a failure in a hook or at file level, an unhandled error,
 * only machine failures) proves nothing.
 * @param {{ testResults?: FileReport[] }[]} reports
 * @returns {{ killedBy: string } | { timeout: string } | { inconclusive: string }}
 */
export function classifyKill(reports) {
  if (reports.length === 0) return { inconclusive: 'no vitest report was written' };
  /** @type {{ test: string, message: string }[]} */
  const failed = [];
  let fileMessage = '';
  for (const report of reports) {
    for (const file of report.testResults ?? []) {
      if (file.status === 'failed' && file.message && !fileMessage) fileMessage = firstLine(file.message);
      for (const test of file.assertionResults ?? []) {
        if (test.status === 'failed') failed.push({ test: `${testFile(file.name)} > ${test.fullName}`, message: (test.failureMessages ?? []).join('\n') });
      }
    }
  }
  if (failed.length === 0) {
    return { inconclusive: `no test failed: the run failed in a hook, at file level or on an unhandled error${fileMessage ? ` (${fileMessage})` : ''}` };
  }
  /** @param {{ message: string }} f */
  const assertion = f => f.message.startsWith('AssertionError');
  /** @param {{ message: string }} f */
  const machine = f => !assertion(f) && INFRASTRUCTURE.test(firstLine(f.message));
  /** @param {{ message: string }} f */
  const timedOutTest = f => !assertion(f) && TIMEOUT.test(firstLine(f.message));
  const real = failed.find(f => !machine(f) && !timedOutTest(f));
  if (real) return { killedBy: real.test };
  const timedOut = failed.find(timedOutTest);
  if (timedOut) return { timeout: timedOut.test };
  return { inconclusive: `only the machine failed: ${firstLine(failed[0].message)}` };
}

/**
 * One pass's outcome for a mutant.
 * @param {PassResult} result
 */
export function outcomeOf(result) {
  if (result.status === 'Killed') return result.killedBy ? 'Killed' : result.timeout ? 'Timeout' : 'Inconclusive';
  return result.status;
}

/** @param {MutantRecord} m */
export const latest = m => /** @type {PassResult} */ (m.passes.b2 ?? m.passes.b ?? m.passes.a2 ?? m.passes.a);

/**
 * A mutant's outcome, counting for a gating one only what its rerun alone
 * confirmed: a timeout counts when the rerun hangs too or fails a test, and a
 * pass B kill only when the rerun fails a test again (a hang is not the same
 * evidence). One the gate never reran is inconclusive.
 * @param {MutantRecord} m
 * @returns {{ outcome: string, why?: string }}
 */
export function confirmed(m) {
  const { a2, b, b2 } = m.passes;
  const last = outcomeOf(latest(m));
  if (!m.gating || (last !== 'Killed' && last !== 'Timeout')) return { outcome: last };
  if (b2 && b && outcomeOf(b) === 'Killed' && last === 'Timeout') {
    return { outcome: 'Inconclusive', why: `killed in pass B by ${b.killedBy}, but hung instead of failing when run alone` };
  }
  if (b && !b2) return { outcome: 'Inconclusive', why: last === 'Killed' ? 'killed in pass B, never rerun alone' : 'timed out, never rerun alone' };
  if (!b && !a2 && last === 'Timeout') return { outcome: 'Inconclusive', why: 'timed out, never rerun alone' };
  return { outcome: last };
}
/** @param {MutantRecord} m */
export const outcome = m => confirmed(m).outcome;

// A gating mutant that ends in one of these fails the gate.
export const FAILING = ['Survived', 'NoCoverage', 'Missing', 'Inconclusive', 'RuntimeError', 'Ignored'];

/**
 * The gating mutants a pass sends to a confirming run of their own (one at a
 * time, with a larger budget): its timeouts, which count as kills only when the
 * mutant hangs the tests alone too, and in pass B its kills as well, which
 * count only when a test fails for the mutant again.
 * @param {MutantRecord[]} mutants
 * @param {'a' | 'b'} pass
 */
export const toConfirm = (mutants, pass) => mutants.filter(m => {
  const result = m.passes[pass];
  const status = result && outcomeOf(result);
  return m.gating && (status === 'Timeout' || (pass === 'b' && status === 'Killed'));
});

/**
 * The gating mutants pass B takes: the ones no in-process test killed.
 * @param {MutantRecord[]} mutants
 */
export const toPassB = mutants => mutants.filter(m => m.gating && ['Survived', 'NoCoverage'].includes(outcome(m)));

/**
 * The verdict and the L5 report.
 * `stopped` names why the gate stopped before it finished (a pass that could
 * not run); the passes it did finish are still reported.
 * `controls` names the runs with no mutant made after the reruns, each passed.
 * @param {{ stamp: string, scope: string, emptyScope: boolean, skipped: { file: string, why: string }[], mutants: MutantRecord[],
 *   noMutant: { file: string, lines: number[] }[], unmatched: string[], report: string, stopped?: string[], controls?: string[] }} run
 * @returns {{ verdict: 'PASS' | 'FAIL' | 'NO RESULT', code: 0 | 1 | 2, lines: string[] }}
 */
export function judge(run) {
  const gating = run.mutants.filter(m => m.gating);
  const context = run.mutants.filter(m => !m.gating);
  const failing = gating.filter(m => FAILING.includes(outcome(m)));
  const made = [...new Set(run.mutants.map(m => m.file))];
  /** @type {'PASS' | 'FAIL' | 'NO RESULT'} */
  let verdict = failing.length > 0 ? 'FAIL' : 'PASS';
  let why = '';
  if (run.stopped) { verdict = 'NO RESULT'; why = 'the gate stopped before it finished'; }
  else if (run.emptyScope) { verdict = 'NO RESULT'; why = 'no src file changed; for a job already committed, pass --base the commit before it'; }
  else if (gating.length === 0) { verdict = 'NO RESULT'; why = 'no gating mutant was made, so L5 tested nothing (see what was not mutated, and why)'; }
  else if (gating.every(m => outcome(m) === 'CompileError')) { verdict = 'NO RESULT'; why = 'every gating mutant was a type error, so no test ran against the change'; }

  /** @param {MutantRecord} m */
  const where = m => `${m.file}:${m.location.start.line}:${m.location.start.column}`;
  /** @param {MutantRecord} m */
  const note = m => {
    const last = latest(m);
    return confirmed(m).why ?? last.inconclusive ?? last.statusReason ?? (outcome(m) === 'Timeout' ? `hung alone too: ${last.timeout ?? 'Stryker timeout'}` : '');
  };
  /** @param {MutantRecord} m */
  const show = m => `  ${where(m)} ${m.mutator}: \`${m.original}\` -> \`${m.replacement}\`${note(m) ? ` (${note(m)})` : ''}`;
  /** @param {MutantRecord[]} list */
  const tally = list => ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Inconclusive', 'Missing', 'RuntimeError', 'Ignored', 'CompileError']
    .map(status => `${list.filter(m => outcome(m) === status).length} ${status}`).filter(entry => !entry.startsWith('0 ')).join(', ') || 'none';
  /**
   * @param {string} title
   * @param {MutantRecord[]} list
   */
  const section = (title, list) => (list.length > 0 ? [title, ...list.map(show)] : []);
  /** @param {string} status */
  const gatingAt = status => gating.filter(m => outcome(m) === status);

  const lines = [
    `L5 touched-line mutation, ${run.stamp}`,
    `Scope: ${run.scope}`,
    `Mutated: ${made.length > 0 ? made.join(', ') : 'nothing'}`,
    ...(run.skipped.length > 0 ? ['Not mutated:', ...run.skipped.map(s => `  ${s.file}: ${s.why}`)] : []),
    ...(run.unmatched.length > 0 ? ['Patterns that made no mutant:', ...run.unmatched.map(p => `  ${p}`)] : []),
    ...(run.noMutant.length > 0 ? ['Changed lines no mutant touches (L5 says nothing about them; types and imports land here):',
      ...run.noMutant.map(n => `  ${n.file}: ${n.lines.join(', ')}`)] : []),
    `Gating mutants (they touch a changed line): ${gating.length}: ${tally(gating)}`,
    `  killed in pass A: ${gating.filter(m => !m.passes.b && outcome(m) === 'Killed').length}; sent to pass B: ${gating.filter(m => m.passes.b).length}, killed there: ${gating.filter(m => m.passes.b && outcome(m) === 'Killed').length}`,
    ...section('Survivors (each needs a test that kills it, or a justification in the notes):', [...gatingAt('Survived'), ...gatingAt('NoCoverage'), ...gatingAt('Missing')]),
    ...section('Silenced by a Stryker disable comment (each needs a justification in the notes):', gatingAt('Ignored')),
    ...section('Inconclusive (no test failed for the mutant itself; rerun, or add a test that fails on it):', [...gatingAt('Inconclusive'), ...gatingAt('RuntimeError')]),
    ...section('Timeouts (each hung the tests again when run alone; counted as killed):', gatingAt('Timeout')),
    `Context mutants (in the widened statements, not on a changed line; not gating): ${context.length}: ${tally(context)}`,
    ...section('Context survivors:', context.filter(m => outcome(m) === 'Survived')),
    ...(run.controls?.length ? ['Runs with no mutant after the reruns:', ...run.controls.map(line => `  ${line}`)] : []),
    ...(run.stopped ? ['Stopped:', ...run.stopped.map(line => `  ${line}`)] : []),
    `Report: ${run.report} (mutants.json has every mutant, its passes and what killed it)`,
    `Verdict: ${verdict}${why ? ` (${why})` : ''}`,
  ];
  return { verdict, code: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2, lines };
}

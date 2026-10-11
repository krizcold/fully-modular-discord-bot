# The touched-line mutation gate (L5)

Documentation/process/VERIFY.md section 2, L5: every job runs mutation on the lines it touched before review, and ends
with zero surviving mutants or each survivor justified in the notes. Stryker runs through its command runner, never its
vitest runner (on vitest 5 that runner silently skips every test inside a describe: stryker-js issue #6210), so the
active mutant travels in `__STRYKER_ACTIVE_MUTANT__` and reaches child processes too [A2].

| File | What it does |
|---|---|
| touched.mjs | the gate: finds the touched lines, runs the passes, writes the report; exit 0 PASS, 1 FAIL, 2 NO RESULT |
| ranges.mjs | (library) the touched lines from `git diff -U0` and how far each widens; unit/mutationRanges.test.ts |
| verdict.mjs | (library) when a run counts as a kill, which mutants go to which pass, the verdict; unit/mutationVerdict.test.ts |
| runner.mjs | the command every pass runs inside Stryker's sandbox; unit/mutationRunner.test.ts |
| control.mjs | (library) the run with no mutant after the reruns; unit/mutationRunner.test.ts |
| passes.mjs | (data) each pass's Stryker options and budget; unit/mutationRunner.test.ts |
| ../helpers/time.mjs | the factor on every test's time limits (4 in a rerun alone) |
| ../helpers/build.cjs | builds dist the way `npm run build` does, stamped and locked; pass B's buildCommand |
| ../helpers/child.ts | runs a child scenario (test/child/scenarios/) and checks what it loaded |

## Running it

From the bot root, with Node 22.12 or newer (or SMDB_TEST_NODE set, as for `npm test`):

    npm run test:mutate -- [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
    npm run test:mutate > l5.txt; test $? -eq 0

- With no option it mutates the change from HEAD to the working tree: the job before it is committed. For a job already
  committed, pass `--base` the commit before it; `--base main` takes everything since the merge-base with main (a
  branch). Untracked files under src are taken whole.
- `--mutate src/x.ts:10-20` (a file in the bot root that exists, or such a file and lines, repeatable; never a glob)
  skips git; every mutant it makes gates. The file is taken under the name git gives it, however it was spelled
  (`./`, backslashes, `..`, another case on Windows).
- `--concurrency N` sets pass A's parallel runs (default: half the cores); pass B uses half of that.
- `--keep` keeps the sandboxes in `.stryker-tmp/` for a look after the run. Without it every sandbox is removed, a
  failed pass's too.
- Exit 0 is PASS, 1 FAIL, 2 NO RESULT (nothing was tested, or the gate stopped: the report says which) or a usage
  error. Any other code means the run was interrupted. Trust 0 and 1 only after the report's `Verdict:` line: a process
  killed on Windows exits 1 too.

Pass A needs nothing running. Pass B runs the integration tests that import the mutated files, so it needs Docker when
there are any. The git diff sets every option a user's git config could change (path prefixes, rename and copy
detection, hunk joining).

## What it mutates

- Each changed line widens to the statement it sits in, taken whole even when a block-bodied callback sits inside, so
  every mutant of a changed operator, condition or call exists. Stryker makes a mutant only when one range holds all of
  it. A line wholly inside a body (a callback's included) widens within that body.
- The headers of compound statements and declarations (an `if`, `for`, `while` or `switch` header, a `catch`, the
  signature of a function declaration, method, constructor or accessor, a class header) widen to that header only,
  never to the body. Any other line holding the start or end of a callback (a route's `router.get('/x', async (req,
  res) => {`, a `});`, a property whose value is an arrow with a body, a plain line of an object that holds a method)
  takes its whole statement: the callback's body runs as context, and the emptying of that body, which touches the
  line, gates.
- **Gating** mutants touch a changed line. Two kinds that touch one are not made: the whole callback around a changed
  line of its body, and the emptying of a block that only begins or ends on a changed compound header; a block wholly
  made of changed lines is made. unit/mutationRanges.test.ts holds this rule to Stryker's own instrumenter, line by
  line, on made-up shapes and on two real files.
- The other mutants in the widened ranges are **context**: they run in pass A and are listed, but never fail the gate.
- A pure deletion has no line left to mutate: its two neighbouring lines are context only.
- Not mutated, and named in the report with the reason: files outside src, files that are not code, `.d.ts` files, and
  the browser views under src/webui/public (copied into dist, never compiled, and no test loads them yet).
- A changed line of code that no mutant lies wholly on, in a diff, an untracked file or a `--mutate` pattern, is named
  in the report: L5 says nothing about it. A mutant that spans several lines (emptying a body, an object or an array,
  flipping a condition split over lines, a chained call) counts for none of them, since it says nothing about each
  line it spans; a mutant on one line counts for that whole line, as Stryker counts it. So types, imports, signatures,
  a bare `await f();`, and every line of a multi-line object, array, arrow body, call or condition with no mutant of
  its own land in the list. A file taken whole names the same lines as each of its lines changed alone. The list can
  name a line some mutant reaches; it never leaves out one that no mutant lies on. A deleted src file is named too.

## The passes

1. **Pass A, in-process.** Stryker instruments the ranges in a sandbox copy of the repo: the tracked files and the
   untracked ones git does not ignore (git's ignored files, `.env` and the data dirs among them, stay out). The
   TypeScript checker turns type-invalid mutants into CompileError. Each mutant run is `vitest related <mutated files>`
   on the fast tier with one worker, so only tests that import them run. There is no coverage analysis: every mutant
   runs those tests.
2. **Pass B, the rest, on pass A's gating survivors only.** The sandbox's dist is built from the instrumented src
   (build.cjs), then each survivor runs `vitest related` on the integration tier and then the whole child tier, whose
   scenarios start real processes on that dist. A child sees the mutant through the env.
3. **Reruns alone.** Every run stops at its first failure. A rerun runs one mutant at a time and gives every test, hook
   and child scenario step four times its time limit (a test's own explicit limit is not scaled), and Stryker a larger
   budget for the whole run.
   - A gating mutant that timed out in pass A reruns with pass A's tests. It counts as killed when the rerun hangs the
     tests again or fails a test; one that then survives goes on to pass B.
   - In pass B, where containers and children can be slow or fail on their own, a hang never counts: a mutant that
     only hangs a test there is inconclusive. A test that waits must bound its wait and fail, as a child scenario step
     does ("did not finish in N ms" is a failure, not a hang). A child test's own limit is fifteen steps' bounds, so in
     a test of up to fourteen steps a hung step fails by its bound first.
   - A gating kill of pass B reruns with the one test file that killed it, alone (one rerun per such file), so no
     other file's order or hang can decide it. It counts only when that file fails for the mutant again. Its Stryker
     budget is an hour, above anything vitest's own limits let the file take after its first failure, so a rerun that
     fails always leaves its report.
   - A mutant the gate never reran (it stopped first) is inconclusive.
4. **A run with no mutant after the reruns.** When a rerun counted a kill or a timeout, the same tests run once more
   with no mutant, in the checkout itself, the way the reruns ran them (mutation/control.mjs). If they fail, the
   machine or a container went bad during the reruns, so what the reruns counted is inconclusive and the gate ends NO
   RESULT. What it cannot see: a machine that was four times slower for one rerun only and well again by the end (a
   pass A rerun that timed out, or a pass B rerun whose child step ran past its bound).

A run Stryker counts as a kill is checked against vitest's report of it: it is a kill only when a test itself failed for
a reason other than the machine. When every failing test (or its hook) timed out, and nothing in the run failed for the
machine, it is a timeout.
Anything else is **inconclusive**: no report, a failure only in a hook or at file level, an unhandled error with every
test passing, or only machine failures (refused or reset connections, a container that would not start, a database
connection dropped, exhausted resources). The machine's texts are matched against the first line of each failure only,
never an assertion or a child's stderr, which may name such an error as the thing under test; the list cannot be
complete, which is why pass B's kills must repeat.

## The report

`test/mutation/reports/<time>/` (ignored by git; delete it whenever you like):

- `summary.txt` is the L5 report for the review packet: the scope, what was not mutated and why, patterns or lines no
  mutant touched, the gating mutants by outcome, every survivor, silenced and inconclusive mutant with its place and
  replacement (with why a kill or timeout did not count), the confirmed timeouts, the context mutants, the runs with no
  mutant after the reruns, and the verdict.
- `mutants.json` has every mutant: its place, original text and replacement, whether it gates, and per pass its status
  and the test that killed it.
- `a/`, `a2/`, `b/` and `b2-1/`, `b2-2/` (one per test file that killed in pass B) hold one vitest JSON report and log
  per mutant run (`dry-*` is the run with no mutant); `control-a2/` and `control-b2/` hold the runs with no mutant
  after the reruns.

The verdict is FAIL when a gating mutant ends Survived, NoCoverage, Missing, inconclusive, RuntimeError, or Ignored (a
`// Stryker disable` comment needs the same justification in the notes as a survivor). A confirmed timeout counts as
killed and is listed. CompileError counts as killed by the type checker. The verdict is NO RESULT when no src file
changed, when no gating mutant was made, when every gating mutant was a type error (no test ran against the change),
when a pass could not run, when Stryker mutated a file no target names, when the run with no mutant after the reruns
failed, or when a test's stand-in replaced vitest (SMDB_MUTATION_VITEST, for the gate's own tests only); the report then
says why, with the passes that did finish.

## Child scenarios

test/child/*.test.ts run scripts from test/child/scenarios/ through helpers/child.ts, one step per process, so module
state starts clean the way it does after a real restart. The rules, which make a mutant visible in a child and keep a
child away from anything real:

- the bot root comes from the file's own place (never a fixed path), so a sandbox runs its own dist;
- the child's cwd is its own data dir (the bot's `dotenv/config` imports read `.env` from the cwd, and the root `.env`
  of a main checkout holds the real token);
- its env is the test's minus every bot configuration key (helpers/env.ts: every key src reads from process.env by name
  and the payment providers' prefixes envLoader copies; unit/envScrub.test.ts holds the list to src), with NODE_ENV
  `test` and its own DATA_DIR; the active mutant passes. Not covered: configManager also reads process.env[key] for any
  config key; DEVS and testMode are scrubbed, a module's own config key is not;
- every wait is bounded, and a step prints one `RESULT` line with its result and the bot modules it loaded; the helper
  fails unless every one sits under this root's dist.

The child tier's globalSetup runs build.cjs `--if-stale`: it rebuilds dist unless the stamp matches both what dist was
built from (src, tsconfig.json, build.cjs, the typescript version) and what dist holds now, so a dist that another
build, a branch switch or a hand edit changed is rebuilt. The source is hashed before the build, and its files' sizes
and write times are checked after it, so an edit saved meanwhile, even one undone again (a stash, then a pop), fails the
build unstamped. A fresh dist is seen without taking the lock. The lock, `dist/.build-lock`, is a file that holds its
owner's process id, taken only to build, and keeps two runs in one checkout from building over each other: a live owner
is waited for up to ten minutes. A lock is never taken from another process, so one left by a build that died (killed
mid-build) stops the next run, which names the file to remove. Like `npm run build`, it never deletes the output of a
removed source file.

## Proven locally

- The bite, integration/mutationBite.test.ts: one gate run on two lines of nodeIdentity.ts. consentsToActiveMode's
  return dies in pass A to unit/backupMode.test.ts; the stand-in carry in consumeTakeoverFlags, which only a restart
  shows, survives pass A and dies in pass B to child/fleetIdentity.test.ts, again when rerun alone, and the run with no
  mutant after that rerun passes. One mutant of the first line is equivalent (`''` and the replacement both read as "not
  active"), so the run also shows the FAIL verdict and how a survivor is listed. The same file checks that an unknown
  base and a pattern that makes no mutant both end NO RESULT, exit 2, and that a glob or a missing file is refused.
- A gate run on a stand-in for vitest (every mutant times out, then the run with no mutant after the reruns fails)
  ends NO RESULT, with every timeout the reruns confirmed listed as inconclusive.
- The bite fails when the plumbing breaks: with the active mutant dropped from the child's env the child-only mutants
  survive, and with the scenario loading another checkout's dist pass B refuses at its first run.

## Not yet covered

- The old harnesses (fp_harness.js and its children) hard-code the main checkout's path, so pass B cannot run them: in a
  sandbox they would load an unmutated dist. Until they take the bot root from their own place or an env variable
  (VERIFY.md section 11, step 2), code that only they reach keeps the dist mutation scripts (mut_*).
- src/index.ts pins its alias base to /app/dist: a child scenario that boots the parent process from a sandbox needs that
  base to come from the file's own place first.
- Browser views are never mutated (no render tests yet).

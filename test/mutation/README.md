# The touched-line mutation gate (L5)

Documentation/process/VERIFY.md section 2, L5: every job runs mutation on the lines it touched before review, and ends
with zero surviving mutants or each survivor justified in the notes. Stryker runs through its command runner, never its
vitest runner (on vitest 5 that runner silently skips every test inside a describe: stryker-js issue #6210), so the
active mutant travels in `__STRYKER_ACTIVE_MUTANT__` and reaches child processes too [A2].

| File | What it does |
|---|---|
| touched.mjs | the gate: finds the touched lines, runs the passes, writes the report; exit 0 PASS, 1 FAIL, 2 NO RESULT |
| ranges.mjs | (library) the files git names as changed, their changed lines from the gate's own line diff, and how far each widens; unit/mutationRanges.test.ts |
| verdict.mjs | (library) when a run counts as a kill, which mutants go to which pass, the verdict; unit/mutationVerdict.test.ts |
| runner.mjs | the command every pass runs inside Stryker's sandbox; unit/mutationRunner.test.ts |
| control.mjs | (library) the run with no mutant after the reruns; unit/mutationRunner.test.ts |
| passes.mjs | (data) the Stryker options every pass shares, and each pass's own options and budget; unit/mutationRunner.test.ts |
| stryker.json | (data) empty on purpose: every pass names it as its config file, so Stryker never reads one it finds in the bot root |
| keys.mjs | (library) how a file and a mutant are named across passes; unit/mutationRanges.test.ts |
| targets.mjs | (Stryker reporter) which mutant ids a later pass runs tests for; unit/mutationRunner.test.ts and the bite |
| ../helpers/time.mjs | the factor on every test's time limits (4 in a rerun alone) |
| ../helpers/env.ts, setup.ts | what a test and its children keep of the environment, and the run's fast-check seed |
| ../helpers/build.cjs | builds dist the way `npm run build` does, stamped and locked; pass B's buildCommand |
| ../helpers/child.ts | runs a child scenario (test/child/scenarios/) and checks what it loaded |

## Running it

From the bot root, with Node 22.12 or newer (or SMDB_TEST_NODE set, as for `npm test`):

    npm run test:mutate -- [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
    npm run test:mutate > l5.txt; test $? -eq 0

- With no option it mutates the change from HEAD to the working tree: the job before it is committed. For a job already
  committed, pass `--base` the commit before it; `--base main` takes everything since the merge-base with main (a
  branch). A file new to src is taken whole: an untracked one, one added, and one moved in from outside src (or from a
  browser view, or from a name that is not code). A file renamed within src gates its changed lines only.
- `--mutate src/x.ts:10-20` (a file in the bot root that exists, or such a file and lines, repeatable; never a glob,
  never columns) skips git; every mutant it makes gates. The file is taken under the name it has on disk, from the bot root with
  forward slashes (its case, and its path once links are resolved), however it was spelled: `./`, `..`, and on Windows
  backslashes or another case. A file in a diff is matched by that name too, for Stryker matches the names on disk.
- `--concurrency N` sets pass A's parallel runs (default: half the cores); pass B uses half of that.
- `--keep` keeps the sandboxes in `.stryker-tmp/` for a look after the run. Without it every sandbox is removed, a
  failed pass's too.
- Exit 0 is PASS, 1 FAIL, 2 NO RESULT (nothing was tested, or the gate stopped: the report says which) or a usage
  error. Any other code means the run was interrupted. Trust 0 and 1 only after the report's `Verdict:` line: a process
  killed on Windows exits 1 too.

Pass A needs nothing running. Pass B runs the integration tests that import the mutated files, so it needs Docker when
there are any. git only names the files that changed, over the whole repo (a rename found by git's own measure, with no
limit on how many files it compares), and gives each one's text at the base; the gate finds the changed lines itself, a
shortest line diff of the two texts, so no git setting, attribute or variable moves them (unit/mutationRanges.test.ts
runs it under a hostile config).

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
- **Gating** mutants touch a changed line. Some that touch one are not made: one that touches it only through a block
  holding the line (the emptying of that block, or the whole callback around it), and the emptying of a block that
  only begins or ends on a changed compound header; a block wholly made of changed lines is made.
  unit/mutationRanges.test.ts holds this rule to Stryker's own instrumenter, line by line, on made-up shapes and on two
  real files.
- The other mutants in the widened ranges are **context**: they run in pass A and are listed, but never fail the gate.
- A pure deletion has no line left to mutate: its two neighbouring lines are context only.
- A run of lines only added, or only taken out, that could sit in more than one place because the lines beside it repeat
  it (an `if` block added after an equal one) counts in every place it could sit, so the copy that changed is never
  left to the diff's choice.
- Not mutated, and named in the report with the reason: files outside src (the root scripts, updaters/, tests, docs and
  images), files that are not code, `.d.ts` files, the browser views under src/webui/public (copied into dist, never
  compiled, and no test loads them yet), a file deleted or moved out of src, an untracked git repository under src (git
  lists none of its files), a change that leaves no line changed (a rename, a mode change, line endings only), and a
  file that holds a line break Stryker counts and the gate does not (a lone CR, U+2028 or U+2029), whose lines the two
  would number differently; `--mutate` refuses such a file.
- A changed line of code that no mutant lies wholly on, in a diff, an untracked file or a `--mutate` pattern, is named
  in the report: L5 says nothing about it. A mutant that spans several lines (emptying a body, an object or an array,
  flipping a condition split over lines, a chained call) counts for none of them, since it says nothing about each
  line it spans; a mutant on one line counts for that whole line, as Stryker counts it. So types, imports, signatures,
  a bare `await f();`, an `else`, `try`, `finally` or `do` line, and every line of a multi-line object, array, arrow
  body, call or condition with no mutant of its own land in the list. A file taken whole names the same lines as each
  of its lines changed alone. The list can name a line some mutant reaches; it never leaves out a line of code that no
  mutant lies on. A line of brackets and separators only is not a line of code: what was taken out of it (`}, 100);`
  made `});`), like a pure deletion, is neither mutated nor named. A deleted file is named too. A `--mutate` pattern that
  made no mutant is named on its own, beside other patterns on the same file.

## The passes

1. **Pass A, in-process.** Stryker instruments the ranges in a sandbox copy of the repo: the tracked files and the
   untracked ones git does not ignore (git's ignored files, `.env` and the data dirs among them, stay out). The
   TypeScript checker turns type-invalid mutants into CompileError. Each mutant run is `vitest related <mutated files>`
   on the fast tier with one worker, so only tests that import them run. There is no coverage analysis: every mutant
   runs those tests.
2. **Pass B, the rest, on pass A's gating survivors only.** The sandbox's dist is built from the instrumented src
   (build.cjs), then each survivor runs `vitest related` on the integration tier and then the whole child tier, whose
   scenarios start real processes on that dist. A child sees the mutant through the env. Stryker makes every mutant a
   span holds, so a survivor that spans lines brings in the mutants nested inside it; in pass B and every rerun those
   run no test (targets.mjs gives the runner the ids the pass is for) and their results are dropped.
3. **Reruns alone.** Every run stops at its first failure. A rerun runs one mutant at a time and gives every test, hook
   and child scenario step four times its time limit (a test's own explicit limit is not scaled), and Stryker a larger
   budget for the whole run.
   - A gating mutant that timed out in pass A reruns with pass A's tests. It counts as killed when the rerun fails a
     test, or times out again: a test or a hook past four times its limit, or the whole run past Stryker's budget for
     it, which is four times what those tests take with no mutant, plus a minute. That budget fires first whenever
     those tests take under 15 seconds, so a mutant that only slows several tests, each within its own limit, by that
     much in all counts as killed; each confirmed timeout is listed with its replacement, to check. One that survives
     the rerun goes on to pass B.
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

Every run of the gate draws one fast-check seed (named on the Scope line; set SMDB_TEST_SEED to run with a given one),
so a property draws the same inputs in every mutant's run as in the run with no mutant: a property that fails in a
mutant's run fails for the mutant. A test that is random in another way (its own Math.random, the clock) can still fail
by chance in one mutant's run, and a pass A kill stands on that one run.

## The report

`test/mutation/reports/<time>/` (ignored by git; delete it whenever you like):

- `summary.txt` is the L5 report for the review packet: the scope, what was not mutated and why, patterns or lines no
  mutant touched, the gating mutants by outcome, every survivor, silenced and inconclusive mutant with its place and
  replacement (with why a kill or timeout did not count), the confirmed timeouts, the context mutants, the runs with no
  mutant after the reruns, and the verdict.
- `mutants.json` has the run's fast-check seed and every mutant: its place, original text and replacement, whether it
  gates, and per pass its status and the test that killed it.
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
- its env, like each test's own (helpers/setup.ts), keeps only the platform's variables, the test tools' (vitest,
  Docker, testcontainers, the active mutant) and the suite's own SMDB_ ones (helpers/env.ts): every other variable is
  taken out, whoever would read it (src by name or through configManager, pg, dotenv, discord.js, git), and
  unit/envScrub.test.ts holds the list against what src reads. pg is pointed at no server (PGHOST, PGPASSFILE) and git
  at no repository above the bot root (GIT_CEILING_DIRECTORIES: a sandbox sits inside the checkout and holds no .git),
  with NODE_ENV `test` and its own DATA_DIR;
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
  base and a pattern that makes no mutant both end NO RESULT, exit 2, and that a glob, a missing file, a pattern with
  columns and a file holding a line break the gate does not count are refused.
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

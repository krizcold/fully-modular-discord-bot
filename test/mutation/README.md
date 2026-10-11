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
| runner.mjs | the command every pass runs inside Stryker's sandbox |
| ../helpers/build.cjs | builds dist the way `npm run build` does, stamped and locked; pass B's buildCommand |
| ../helpers/child.ts | runs a child scenario (test/child/scenarios/) and checks what it loaded |

## Running it

From the bot root, with Node 22.12 or newer (or SMDB_TEST_NODE set, as for `npm test`):

    npm run test:mutate -- [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
    npm run test:mutate > l5.txt; test $? -eq 0

- With no option it mutates the change from HEAD to the working tree: the job before it is committed. For a job already
  committed, pass `--base` the commit before it; `--base main` takes everything since the merge-base with main (a
  branch). Untracked files under src are taken whole.
- `--mutate src/x.ts:10-20` (Stryker's pattern, repeatable) skips git; every mutant it makes gates.
- `--concurrency N` sets pass A's parallel runs (default: half the cores); pass B uses half of that.
- `--keep` keeps the sandboxes in `.stryker-tmp/` for a look after the run. Without it every sandbox is removed, a
  failed pass's too.
- Exit 0 is PASS, 1 FAIL, 2 NO RESULT (nothing was tested, or the gate stopped: the report says which). Any other code
  means the run was interrupted.

Pass A needs nothing running. Pass B runs the integration tests that import the mutated files, so it needs Docker when
there are any. The git diff sets every option a user's git config could change (path prefixes, rename and copy
detection, hunk joining).

## What it mutates

- Each changed line widens to the statement it sits in, or to the part of a compound statement it sits in (an `if`
  condition, a signature, a loop header), taken whole even when a block-bodied callback sits inside, so every mutant of a
  changed operator, condition or call exists. A body is never taken because its header line changed; a line inside a
  body (a callback's included) widens within that body. Stryker makes a mutant only when one range holds all of it.
- **Gating** mutants touch a changed line. Two kinds that touch one are not made: the whole callback around a changed
  line of its body, and the emptying of a block that only begins or ends on the changed line (the body of a changed
  `if (...) {` or signature); a block wholly made of changed lines is made. unit/mutationRanges.test.ts holds this rule
  to Stryker's own instrumenter, line by line, on made-up shapes and on two real files.
- The other mutants in the widened ranges are **context**: they run in pass A and are listed, but never fail the gate.
- A pure deletion has no line left to mutate: its two neighbouring lines are context only.
- Not mutated, and named in the report with the reason: files outside src, files that are not code, `.d.ts` files, and
  the browser views under src/webui/public (copied into dist, never compiled, and no test loads them yet).
- A changed line of code that no mutant touches (types and imports land here) is named in the report: L5 says nothing
  about it.

## The passes

1. **Pass A, in-process.** Stryker instruments the ranges in a sandbox copy of the repo: the tracked files and the
   untracked ones git does not ignore (git's ignored files, `.env` and the data dirs among them, stay out). The
   TypeScript checker turns type-invalid mutants into CompileError. Each mutant run is `vitest related <mutated files>`
   on the fast tier with one worker, so only tests that import them run. There is no coverage analysis: every mutant
   runs those tests.
2. **Pass B, the rest, on pass A's gating survivors only.** The sandbox's dist is built from the instrumented src
   (build.cjs), then each survivor runs `vitest related` on the integration tier and then the whole child tier, whose
   scenarios start real processes on that dist. A child sees the mutant through the env.
3. **Timeouts are rerun.** A gating mutant that timed out in pass A or B runs again alone, one at a time, with a larger
   budget. It counts as killed only if it hangs the tests alone too; one that then survives pass A goes on to pass B.

A run Stryker counts as a kill is checked against vitest's report of it: it is a kill only when a test itself failed for
a reason other than the machine. When every failing test timed out it is a timeout (rerun as above). Anything else is
**inconclusive**: no report, a failure only in a hook or at file level, an unhandled error with every test passing, or
only machine failures (refused or reset connections, a container that would not start, a database connection dropped,
exhausted resources).

## The report

`test/mutation/reports/<time>/` (ignored by git; delete it whenever you like):

- `summary.txt` is the L5 report for the review packet: the scope, what was not mutated and why, patterns or lines no
  mutant touched, the gating mutants by outcome, every survivor, silenced and inconclusive mutant with its place and
  replacement, the confirmed timeouts, the context mutants, and the verdict.
- `mutants.json` has every mutant: its place, original text and replacement, whether it gates, and per pass its status
  and the test that killed it.
- `a/`, `a2/`, `b/` and `b2/` hold one vitest JSON report and log per mutant run (`dry-*` is the run with no mutant).

The verdict is FAIL when a gating mutant ends Survived, NoCoverage, Missing, inconclusive, RuntimeError, or Ignored (a
`// Stryker disable` comment needs the same justification in the notes as a survivor). A confirmed timeout counts as
killed and is listed. CompileError counts as killed by the type checker. The verdict is NO RESULT when nothing changed,
when no gating mutant was made, or when a pass could not run; the report then says why, with the passes that did finish.

## Child scenarios

test/child/*.test.ts run scripts from test/child/scenarios/ through helpers/child.ts, one step per process, so module
state starts clean the way it does after a real restart. The rules, which make a mutant visible in a child and keep a
child away from anything real:

- the bot root comes from the file's own place (never a fixed path), so a sandbox runs its own dist;
- the child's cwd is its own data dir (the bot's `dotenv/config` imports read `.env` from the cwd, and the root `.env`
  of a main checkout holds the real token);
- its env is the test's minus every bot configuration key (helpers/env.ts: every key src reads from process.env and the
  payment providers' prefixes envLoader copies; unit/envScrub.test.ts holds the list to src), plus DATA_DIR; the active
  mutant passes;
- every wait is bounded, and a step prints one `RESULT` line with its result and the bot modules it loaded; the helper
  fails unless every one sits under this root's dist.

The child tier's globalSetup runs build.cjs `--if-stale`: it rebuilds dist unless the stamp matches both what dist was
built from (src, tsconfig.json, build.cjs, the typescript version) and what dist holds now, so a dist that another build,
a branch switch or a hand edit changed is rebuilt. A lock in dist keeps two runs in one checkout from building over each
other. Like `npm run build`, it never deletes the output of a removed source file.

## Proven locally

- The bite, integration/mutationBite.test.ts: one gate run on two lines of nodeIdentity.ts. consentsToActiveMode's
  return dies in pass A to unit/backupMode.test.ts; the stand-in carry in consumeTakeoverFlags, which only a restart
  shows, survives pass A and dies in pass B to child/fleetIdentity.test.ts. One mutant of the first line is equivalent
  (`''` and the replacement both read as "not active"), so the run also shows the FAIL verdict and how a survivor is
  listed. The same file checks that an unknown base and a pattern that makes no mutant both end NO RESULT, exit 2.
- The bite fails when the plumbing breaks: with the active mutant dropped from the child's env the child-only mutants
  survive, and with the scenario loading another checkout's dist pass B refuses at its first run.

## Not yet covered

- The old harnesses (fp_harness.js and its children) hard-code the main checkout's path, so pass B cannot run them: in a
  sandbox they would load an unmutated dist. Until they take the bot root from their own place or an env variable
  (VERIFY.md section 11, step 2), code that only they reach keeps the dist mutation scripts (mut_*).
- src/index.ts pins its alias base to /app/dist: a child scenario that boots the parent process from a sandbox needs that
  base to come from the file's own place first.
- Browser views are never mutated (no render tests yet).

# The touched-line mutation gate (L5)

Documentation/process/VERIFY.md section 2, L5: every job runs mutation on the lines it touched before review, and ends
with zero surviving mutants or each survivor justified in the notes. Stryker runs through its command runner, never its
vitest runner (on vitest 5 that runner silently skips every test inside a describe: stryker-js issue #6210), so the
active mutant travels in `__STRYKER_ACTIVE_MUTANT__` and reaches child processes too [A2].

| File | What it does |
|---|---|
| touched.mjs | the gate: finds the touched lines, runs pass A and pass B, writes the report; exit 0 PASS, 1 FAIL, 2 no result |
| ranges.mjs | (library) the touched lines from `git diff -U0`, widened to whole statements; unit-tested in unit/mutationRanges.test.ts |
| runner.mjs | the command both passes run inside Stryker's sandbox |
| ../helpers/build.cjs | builds dist the way `npm run build` does, stamped with a hash of src; pass B's buildCommand |
| ../helpers/child.ts | runs a child scenario (test/child/scenarios/) and checks what it loaded |

## Running it

From the bot root, with Node 22.12 or newer (or SMDB_TEST_NODE set, as for `npm test`):

    npm run test:mutate -- [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
    npm run test:mutate > l5.txt; test $? -eq 0

- With no option it mutates the change from HEAD to the working tree: the job before it is committed. `--base main`
  takes everything since the merge-base with main instead (a branch). Untracked files under src are taken whole.
- `--mutate src/x.ts:10-20` (Stryker's pattern, repeatable) skips git; every mutant it makes gates.
- `--concurrency N` sets pass A's parallel runs (default: half the cores); pass B uses half of that.
- `--keep` keeps the sandboxes in `.stryker-tmp/` for a look after the run.

Pass A needs nothing running. Pass B runs the integration tests that import the mutated files, so it needs Docker when
there are any.

## What it mutates

- Each changed line widens to the outermost syntax around it that holds no block: a whole statement, or the condition or
  parameters of one that holds a body. A change to one line of a three-line condition therefore gets the mutants of the
  whole condition, and not those of the body it guards (Stryker makes a mutant only when one range holds all of it).
- **Gating** mutants touch a changed line. The other mutants in the widened ranges are **context**: they run in pass A
  and are listed, but never fail the gate.
- A pure deletion has no line left to mutate: its two neighbouring lines are context only.
- Not mutated, and named in the report with the reason: files outside src, files that are not code, `.d.ts` files, and
  the browser views under src/webui/public (copied into dist, never compiled, and no test loads them yet).

## The two passes

1. **Pass A, in-process.** Stryker instruments the ranges in a sandbox copy of the repo (what a clean checkout holds:
   git's ignored files, `.env` and the data dirs among them, stay out). The TypeScript checker turns type-invalid mutants
   into CompileError. Each mutant run is `vitest related <mutated files>` on the fast tier, so only tests that import
   them run. There is no coverage analysis: every mutant runs those tests.
2. **Pass B, the rest, on pass A's gating survivors only.** The sandbox's dist is built from the instrumented src
   (build.cjs), then each survivor runs `vitest related` on the integration tier and then the whole child tier, whose
   scenarios start real processes on that dist. A child sees the mutant through the env.

A kill counts only when a test failed for a reason other than the machine: a kill whose every failure is a refused or
reset connection, a hook timeout, a missing container runtime or exhausted resources is **inconclusive**. A run whose
vitest wrote no report is inconclusive too.

## The report

`test/mutation/reports/<time>/` (ignored by git; delete it whenever you like):

- `summary.txt` is the L5 report for the review packet: the scope, what was not mutated and why, the gating mutants by
  outcome, every survivor and inconclusive kill with its place and replacement, timeouts listed apart, the context
  mutants, and the verdict.
- `mutants.json` has every mutant: its place, original text and replacement, whether it gates, and per pass its status
  and the test that killed it.
- `a/` and `b/` hold one vitest JSON report and log per mutant run (`dry-*` is the run with no mutant).

The verdict is FAIL when a gating mutant ends Survived, NoCoverage or inconclusive. A Timeout counts as killed but is
listed, since a slow host can cause one. CompileError, RuntimeError and Ignored are counted, never gating.

## Child scenarios

test/child/*.test.ts run scripts from test/child/scenarios/ through helpers/child.ts, one step per process, so module
state starts clean the way it does after a real restart. The rules, which make a mutant visible in a child and keep a
child away from anything real:

- the bot root comes from the file's own place (never a fixed path), so a sandbox runs its own dist;
- the child's cwd is its own data dir (the bot's `dotenv/config` imports read `.env` from the cwd, and the root `.env`
  of a main checkout holds the real token);
- its env is the test's minus every fleet, database, manager and token key (helpers/env.ts), plus DATA_DIR; the active
  mutant passes;
- every wait is bounded, and a step prints one `RESULT` line with its result and the bot modules it loaded; the helper
  fails unless every one sits under this root's dist.

The child tier's globalSetup builds dist when src changed since the last build (build.cjs `--if-stale`), so `npm test`
never runs a scenario on a stale dist.

## Proven locally

- The bite, integration/mutationBite.test.ts: one gate run on two lines of nodeIdentity.ts. consentsToActiveMode's
  return dies in pass A to unit/backupMode.test.ts; the stand-in carry in consumeTakeoverFlags, which only a restart
  shows, survives pass A and dies in pass B to child/fleetIdentity.test.ts. One mutant of the first line is equivalent
  (`''` and the replacement both read as "not active"), so the run also shows the FAIL verdict and how a survivor is
  listed. About 80 seconds.
- The bite fails when the plumbing breaks: with the active mutant dropped from the child's env the child-only mutants
  survive, and with the scenario loading another checkout's dist pass B refuses at its first run.

## Not yet covered

- The old harnesses (fp_harness.js and its children) hard-code the main checkout's path, so pass B cannot run them: in a
  sandbox they would load an unmutated dist. Until they take the bot root from their own place or an env variable
  (VERIFY.md section 11, step 2), code that only they reach keeps the dist mutation scripts (mut_*).
- src/index.ts pins its alias base to /app/dist: a child scenario that boots the parent process from a sandbox needs that
  base to come from the file's own place first.
- Browser views are never mutated (no render tests yet).

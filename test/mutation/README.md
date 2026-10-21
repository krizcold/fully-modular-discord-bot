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
| control.mjs | (library) the time checks: Stryker's clock in pass B and in each b2 pass where a run timed out, and the run with no mutant after the reruns; unit/mutationRunner.test.ts |
| passes.mjs | (data) the Stryker options every pass shares, and each pass's own options and budget; unit/mutationRunner.test.ts |
| stryker.json | (data) empty on purpose: every pass names it as its config file, so Stryker never reads one it finds in the bot root |
| keys.mjs | (library) how a file and a mutant are named across passes; unit/mutationRanges.test.ts |
| targets.mjs | (Stryker reporter) which mutant ids a later pass runs tests for, and Stryker's own time for each run with no mutant; unit/mutationRunner.test.ts and the bite |
| tree.mjs | (library) the fingerprint of the tree a run reads and of the packages it loads, taken before the plan and before the verdict; unit/mutationRanges.test.ts and the bite |
| ../helpers/time.mjs | the factor on the config's test and hook limits and a child step's default bound (4 in a rerun alone and in the run with no mutant after the reruns; a limit a test, hook or step sets itself is not scaled) |
| ../helpers/env.ts, setup.ts | what a test and its children keep of the environment, and the run's fast-check seed |
| ../helpers/forkGuard.cjs | a process started with an env of its own that lacks DATA_DIR throws (fork, spawn, exec, execFile, a Worker), in a test and in a child step |
| ../helpers/build.cjs | builds dist the way `npm run build` does, stamped and locked; pass B's buildCommand |
| ../helpers/child.ts | runs a child scenario (test/child/scenarios/) and checks what it loaded |
| ../helpers/endTree.mjs | ends a process and those it started: a child step past its bound |

## Running it

From the bot root, with Node 22.12 or newer (or SMDB_TEST_NODE set, as for `npm test`):

    npm run test:mutate -- [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
    npm run test:mutate > l5.log; test $? -eq 0

- With no option it mutates the change from HEAD to the working tree: the job before it is committed. For a job already
  committed, pass `--base` the commit before it; `--base main` takes everything since the merge-base with main (a
  branch). A file new to src is taken whole: an untracked one, one added, and one moved in from outside src (or from a
  browser view, or from a name that is not code). A file renamed within src gates its changed lines only when git sees
  the rename: the new name is staged (`git add`, or `git add -N`) and the file is like enough to the old one for git's
  own measure (half its content, by default) to pair them. Otherwise it is a deletion and a new file, taken whole: a
  move whose new name is not staged (a plain `mv`, an editor's rename), or one that changed most of the file. A file
  only taken out of the index (`git rm --cached`, kept on disk and not ignored) is diffed against the base as a changed
  one; one git ignores is out of the tree, so it is a deletion. A name that leads through a link (a link in src, a file
  under a junction) is not mutated, and is named (below): a file is mutated under its own name only, when git lists it
  changed. Two changed names git lists for one file that differ only in case (on a disk that does not tell case apart)
  are mutated and gated as one diff of all their changed lines would be.
- `--mutate src/x.ts:10-20` (a file in the bot root that exists and that a diff would mutate, or such a file and lines,
  repeatable; never a glob, never columns, never the suite's own files) skips git's diff (git still lists the tree, which
  is what a sandbox holds); every mutant it makes gates. A file git neither tracks nor would add (one it ignores, or one
  inside a submodule or an untracked repository) is refused: no sandbox holds it. The file is taken under the name it has on disk, from the bot root with
  forward slashes (its case, and its path once links are resolved), however it was spelled: `./`, `..`, and on Windows
  backslashes or another case. A file in a diff is matched by that name too, for Stryker matches the names on disk.
  Either way the name must be one Stryker reads as itself (ranges.mjs strykerTakes: no glob magic in it, and its whole
  path matches itself as Stryker matches it), so `( ) ! + @` in a name are taken unless they make an extglob such as
  `+(x)` or `@(x)`, and `[id].ts` or `a{1,2}.ts` is not.
- `--concurrency N` sets pass A's parallel runs (default: half the cores): up to N test commands at once, and two at
  N = 1, since Stryker hands the type checker's slot to a test runner once checking ends. Pass B uses half of N, at
  least one.
- `--keep` keeps the sandboxes in `.stryker-tmp/` for a look after the run. Without it every sandbox is removed, a
  failed pass's too, unless the run is interrupted: Stryker then exits at once and leaves that pass's sandbox (and,
  in pass A, `.stryker-tmp/tsconfig.l5-<pid>.json`), which is safe to delete (its node_modules are links, which a
  delete removes and does not follow) and which no later run reads. A signal or kill that reaches the gate's process
  alone (`kill <pid>`, `taskkill /F` without `/T`) also leaves the test commands it was running going, with nothing to
  bound them: as many as pass A or pass B runs at once (above), each a runner.mjs and the vitest under
  it. End each of those trees: find them by `runner.mjs` in their command line (on Windows the shell above each is
  already gone, and ending a runner.mjs ends the Node processes under it). On POSIX, when the gate relaunched itself
  under SMDB_TEST_NODE (two touched.mjs processes are listed), a kill of the first alone leaves the relaunched one
  going on to its next passes: end it first (on Windows it ends with the first). Ctrl-C in the gate's terminal
  reaches all of it.
- The gate fingerprints every file git tracks or would add (below), so its output goes to a file git ignores (`l5.log`
  above, under the root's `*.log`) or one outside the checkout: a file in the tree that the run writes to changes
  during the run, which ends it NO RESULT.
- Exit 0 is PASS, 1 FAIL, 2 NO RESULT (nothing was tested, the tree changed during the run, or the gate stopped: the
  report says which; or, with no report, the test packages are missing (`npm run test:install`) or test/node_modules
  is a link (below), the checkout's path
  does not match itself read as a glob, as Stryker reads it (a `[ ]` class, a `{ }` with a comma or a range, an extglob
  such as `+( )`, or one minimatch cannot read: Stryker then matches no file to mutate), .stryker-tmp could not be made, git could not list the tree,
  or the report itself could not be written; every `Verdict:` line goes to
  stdout, and the gate exits only once stdout has taken the whole report) or a usage error. A mutant id left in the shell (`__STRYKER_ACTIVE_MUTANT__`)
  is ignored. Any other code means the run was interrupted. Trust 0 and 1 only after the report's `Verdict:` line: a process
  killed on Windows exits 1 too.

Pass A needs nothing running. Pass B runs the integration tests that import the mutated files, so it needs Docker when
there are any. git only names the files that changed, over the whole repo (a rename found by git's own measure, with no
limit on how many files it compares), and gives each one's text at the base; the gate finds the changed lines itself, a
shortest line diff of the two texts, so no git setting, attribute or variable moves them (unit/mutationRanges.test.ts
runs it under a hostile config). git does not look at every file (below), so the gate checks every tracked file git
does not name by its content.

## What it mutates

- Each changed line widens to the statement it sits in, taken whole even when a block-bodied callback sits inside, so
  every mutant of a changed operator, condition or call exists. Stryker makes a mutant only when one range holds all of
  it. A line wholly inside a body (a callback's included) widens within that body.
- The headers of compound statements and declarations (an `if`, `for`, `while` or `switch` header, a `catch`, a
  `case` or `default` label, the signature of a function declaration, or of a method, constructor or accessor of a
  class declaration, a class header) widen to that header only, never to the body: a case clause's statements are its
  body, braces or not. Any other line holding the start or end of a callback or a body (a route's
  `router.get('/x', async (req, res) => {`, a `});`, a property whose value is an arrow with a body, a method of an
  object or of a class expression) takes its whole statement: the body runs as context, and its emptying, which
  touches the line, gates.
- A changed line that holds no token (blank, or a comment only; a blank line inside a multi-line template holds one)
  changes no code: it widens to itself only and gates nothing, so a comment edited inside an object or a call brings in
  none of its mutants. It still joins the ranges on either side of it, so a new function whose body holds a blank line
  is made whole. A file where only such lines changed, and no code was taken out, is not mutated (below); a line of
  code made a comment or a blank line is code taken out (below). Such a line can still change the code of unchanged
  lines (a `/*` or `*/` on it), and so can a line of code (a backtick, a string's line continuation, a JSX tag): see
  "Only the lines" below.
- **Gating** mutants touch a changed line that holds code (a token, brackets and separators included). Some that touch one are not made: one that touches it only through a block
  holding the line (the emptying of that block, or the whole callback around it), the emptying of the body of a
  compound statement or declaration (above), or of a bare block, that only begins or ends on the changed line: its
  header or its closing brace, and the false condition Stryker gives a `for` with no condition, which spans the whole
  loop: it is made only where one range holds the whole loop (a loop on one line, one whose every line changed, one
  inside a statement taken whole), and then gates as any mutant does. A reviewer checks a changed header of a longer
  loop: the no-mutant list below names it when it has no mutant of its own, and the structure list when it holds the
  body's `{`; one with a mutant of its own (`for (let i = 0; ; i++)`) and no `{` is named in neither. The emptying of
  a case clause spans the clause, so it is made the same way: only where one range holds the whole clause (a clause
  on one line, one whose every line changed, as a clause a job adds, one inside a statement a changed line takes
  whole, or a changed line that takes whole a label or a statement, neither a block nor a compound statement, that
  starts on the label line and ends the clause), and then gates as any mutant does; otherwise a changed label widens
  to the label only and a body line to its statement within the clause, and neither makes it. A changed label is in
  the structure list, and in the no-mutant list too when no mutant lies wholly on its line (`case 1:` alone, not
  `case 1: return 1;`). Each of these exceptions holds outside a statement a changed line takes whole: there one range
  holds everything inside it. A block wholly made of
  changed lines is made, and so is every other body's emptying. unit/mutationRanges.test.ts holds this rule to
  Stryker's own instrumenter, line by line, both what is made and what is not, on made-up shapes and on two real files.
- The other mutants in the widened ranges are **context**: they run in pass A and are listed, but never fail the gate.
- What was taken out has no line left to mutate, and the lines beside it are mutated only where a changed line widens
  to them. The report names each place where lines of code (a token on them) were taken out with fewer or none put
  back (a pure deletion, a line deleted beside an edited one, one made a comment or a blank line, an unchanged one that
  a change on another line left with fewer tokens, a block taken away with its body re-indented), so a reviewer checks the code around each; a line of code replaced one for one by code, or a
  block taken away where as many or more lines of code are put back, shows only as changed lines. A job that only
  takes code out makes no mutant: the gate names the places and ends NO RESULT, with no pass run.
- Lines added in one place, or only taken out, count also over each unchanged line beside them that repeats one of
  them, and on through each further one that does (an `if` block added after an equal one counts in both places, an
  edited line beside it or not): every place their first or last lines, or the whole run, could slide to passes only
  such lines. This can gate an unchanged line no shortest diff changes. The window starts from the pieces the diff
  makes, though: with another change in the same file, the diff can split a run added or taken out in one place into
  several pieces, and then which of its copies count is again the diff's choice: a line the job added can go unmutated,
  and be named nowhere, while an unchanged copy of it gates. So is it where repeated lines are spread among other
  changes.
- Only the lines the diff changed count, and the unchanged ones whose code changed: an unchanged line holds the same
  text in both, so its code is the kinds of the tokens on it (a comment holds none, a template's parts are one kind),
  read in both texts, in order. When they differ, whatever on another line made them (for example a comment, a
  string, a template or JSX text opened or closed over all or part of it, or a regex read as a division, a type as a
  value), the line counts as changed if it holds code after (it widens and gates), and as a place where code was
  taken out if it holds fewer tokens. A change can also
  move an unchanged line into or out of a block (a bracket,
  an `else`, a `finally` or a `case` moved past it, a header put around it, an if's two bodies swapped): that line is
  not gated, so its mutants run as context at most. The changed lines that make such a move are named under their own
  heading, mutants of their own or not: a line of brackets and separators only, one holding a brace of a block (a
  header's `{`, a closer with code of its own such as `} while (x);` or `}).catch(log);`), and one holding an `else`,
  `case`, `default` (in a switch), `catch` or `finally`, so a reviewer checks the lines beside each; a block taken
  away (its header and bracket deleted) is named with the places code was taken out when fewer lines of code are put
  back there. Not named: a block taken away where as many or more lines of code are put back, a line moved into or
  out of a braceless body (an `if (x)` with no brace put above a line, or lines swapped below one), and a changed
  line that gains or loses its ending `;` where the next line starts with `(`, `[`, a backtick, `+`, `-` or `/`, which
  joins that unchanged line into its statement or splits it out with the same token kinds; a reviewer reads each
  changed braceless header and each such `;` for these.
- git does not look at every file: not at one its index marks assume-unchanged or skip-worktree (core.ignoreStat marks
  every file it adds), not at one a file-system monitor says is unchanged, and not at one whose cached size and time
  (and, on Windows, creation time) still hold, so a same-size edit whose time was set back shows in no diff. So the
  gate checks every tracked file git does not name by its content: it hashes the file with git's filters, and names it
  changed when that differs from git's index and its lines differ from the base's (the index can hold an edit staged
  and then undone, and the hash reads no index, so a blob that holds CRLF under text=auto hashes as LF: either differs
  with nothing changed); and it names one that is gone as
  deleted, unless skip-worktree left it out (a sparse checkout) or the base never held it (a new file staged, then
  taken off the disk).
- Not mutated, and named in the report with the reason: files outside src (the root scripts, updaters/, tests, docs and
  images), files that are not code (code is `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.cjs` and `.mjs`), declaration files
  (`.d.ts`, `.d.mts`, `.d.cts`), the browser views under src/webui/public (copied into dist, never
  compiled, and no test loads them yet), a file under a node_modules dir in src (git ignores such a dir, but a file there is in the tree whenever the index
  holds it: added with -f, moved in with git mv, tracked before the rule, or let in by a deeper .gitignore that lifts
  it; Stryker links such a dir into a sandbox and never copies it), a file deleted or moved out of src,
  an untracked git repository (git lists
  none of its files, and none is copied into a sandbox) or a git submodule under src, a file whose name Stryker would read as a glob (`[id].ts`,
  `a{1,2}.ts`; rename it), a name that leads through a link, as the disk tells it (a link in src, one that differs
  from its file only in case included, a file under a junction, one out of the bot root: a file is mutated under its
  own name only, when git lists it changed, for Stryker's copy does not follow a link to a directory, and a copy made
  through a link to a file is not the file the tests import; `--mutate` takes the file a link leads to under its own
  name when the tree lists it so, and refuses one it does not, such as one out of the bot root),
  a change that leaves no code changed (a rename git sees, a mode change, line endings only, only blank lines or
  comments, a file only taken out of the index), and a
  file that holds a line break Stryker counts and the gate does not (a lone CR, U+2028 or U+2029), whose lines the two
  would number differently; `--mutate` refuses such a file.
- Never mutated, on any machine, and named: a file whose code names the DATA_DIR variable, or holds as a string or as
  the head of a template the `'/data'` root or a path under it (`'/data/global'`, `` `/data/${x}` ``;
  src/utils/dataRoot.ts today, under any name) or the image's `'/app'` root or a path under it (`'/app/build'`,
  `` `/app/${x}` ``: the module path helpers, the snapshot and update code and src/index.ts today), in any case and
  with either slash (Windows reads `/Data`, `\data` and `data_dir` as the same), in every file: a route path that
  reads like a path under `/data` counts too, so src/webui/routes/config.ts, whose data routes are `'/data/get'` and
  the like, is named and never mutated (a route path of another shape would let it be). The rule reads one file at a
  time: a root built at run time (`path.join('/', 'data')`), or
  a check that takes the variable's name or a fixed root from another file (an imported constant, a function that
  returns a root it does not choose), is not seen, so the check that picks a root and the root it picks stay in one
  file (the module path helpers return a root their own check chose). unit/mutationRanges.test.ts runs the gate's
  planner on every file in src that git tracks or would add, pins the files it names for this rule (these six today)
  and fails when that list changes, so one that a split leaves holding neither the name nor a root, whatever took
  them (a constants file, an enum, a JSON file), is looked at, and so is a file the gate would mutate that gains a
  fixed path (route it through src/utils/dataRoot.ts). A file the gate never mutates (a browser view, a declaration or
  JSON file, one under a node_modules dir) is not pinned, and a check that takes its root from such a file falls under
  what follows. Not seen: a check, written new or moved out of one of these files, in a file the rule never named, that
  takes its root or the name from another file (one of these included). A mutant of a file
  the rule names (the DATA_DIR check made false, the
  image's marker taken as found, the fallback chosen) sends the tests to such a root, on a developer's machine a real
  data root (on Windows at the root of the drive of the process's cwd: the checkout's for a test, the temp dir's for a
  child step, so `D:\app` or `C:\data` for a checkout on D: with TEMP on C:) and anywhere else one the run would make
  outside the sandbox. `--mutate` refuses a file the rule names, and each pass's run with no mutant, which comes
  before any mutant's, checks the files as that pass copied them, so a file that gains such code after the plan stops
  the pass (NO RESULT, naming it), as does one it cannot read.
- A changed line of code that no mutant lies wholly on, in a diff, an untracked file or a `--mutate` pattern, is named
  in the report: L5 says nothing about it. A mutant that spans several lines (emptying a body, an object or an array,
  flipping a condition split over lines, a chained call) counts for none of them, since it says nothing about each
  line it spans; a mutant on one line counts for that whole line, as Stryker counts it. So types, imports, signatures,
  a bare `await f();`, an `else`, `try`, `finally` or `do` line, and every line of a multi-line object, array, arrow
  body, call or condition with no mutant of its own land in the list. A file taken whole names the same lines as each
  of its lines changed alone. The list can name a line some mutant reaches; it never leaves out a line of code the
  diff marks changed that no mutant lies on (a line the job added can still go unmarked, as the window's limit above
  says). A line of brackets and separators only is left out of this list (the one place it is not counted as code): what was taken out of it (`}, 100);`
  made `});`), like a pure deletion, is not mutated, and a changed one in a diff is named under its own heading. A
  deleted file is named too. A `--mutate` pattern that
  made no mutant is named on its own, beside other patterns on the same file.

## The passes

1. **Pass A, in-process.** Stryker instruments the ranges in a sandbox copy of the repo that holds the files the gate
   fingerprints and nothing else: the tracked files and the untracked ones git does not ignore, those under a
   node_modules dir aside, which Stryker links instead (ranges.mjs sandboxPatterns gives Stryker a pattern that leaves
   everything out, then lets each of those files back in). So
   git's ignored files (`.env`, the data dirs, dist), the files of an untracked git repository or a submodule (git
   lists only its dir, which lets nothing in; code that needs them fails there, NO RESULT) and any file made after the
   gate started stay out of every sandbox. Stryker's copy does not follow a link to a directory either: the files git
   lists under a junction in the tree (Windows) stay out (the plan names them as links and mutates none), and a tracked
   link to a directory (POSIX) fails the copy, so code that reaches files through such a link fails there too (NO
   RESULT). A name Stryker would read as a glob even when escaped (on POSIX, one holding
   a backslash and a brace) stops the gate with NO RESULT, since the sandbox would lack it. Stryker matches names with
   no regard to case, so on a disk that tells case apart, a file whose path differs from a listed one's only in case
   is copied too. Stryker also walks every dir of the checkout, ignored ones too, for node_modules to link:
   a dir the user cannot read (a data dir a container made as root) stops the pass. The TypeScript checker turns type-invalid mutants
   into CompileError. It compiles the checkout, not the sandbox, so it is given a tsconfig that extends the root's and
   lists the tree's files only (ranges.mjs treeTsconfig), so a file git ignores (a module cloned into src) is not
   judged for being in src. TypeScript still follows a tree file's imports and references (a type-only one included),
   so when the checker would judge a file outside the tree, the gate stops before pass A with NO RESULT and names it
   (ranges.mjs beyondTree): a mutant that broke only that file would count as killed with no test run. A file under a
   node_modules dir, wherever that dir is, is a package and never named; only the root's install and test/'s
   TypeScript are held (below). The way on: make the tree's file stop importing or referencing it, or add it to the
   tree if it belongs there. What the checker reads is held to the root lockfile, which the build that ships installs
   (npm ci in the image and in CI): it runs test/'s installed TypeScript, which must be the lockfile's, and reads the
   packages installed at the root (another checkout's, when the root node_modules is a link), whose record npm keeps
   there (`node_modules/.package-lock.json`): that record must hold the lockfile's packages and no other (an optional one
   may be absent), each at its version with the content the lockfile names (its integrity; a git dependency, which
   has none, its resolved commit). When test/'s TypeScript or that record differs, the gate stops before pass A too,
   with NO RESULT naming the first difference (ranges.mjs checkerDiffers): a mutant the checker rejects and the
   shipped build accepts would count as killed with no test run. Of the @types it takes with no import, the checker
   takes the root's node_modules' only, as the image's build does, not a node_modules' above the checkout, unless the
   root's tsconfig sets typeRoots of its own. The way on is to pin test/package.json and its lockfile to the root
   lockfile's TypeScript and run `npm run test:install` in a checkout whose test/node_modules is a dir of its own, or
   to run `npm ci --install-strategy=hoisted --include=dev` at the root of one whose node_modules is. While either
   dir is a link, remove the link itself first, never what it names: any npm command that changes packages run
   through a link, the pin's npm install included, writes the other checkout's install. The
   gate reads npm's default layout with the dev packages, whatever a config or `NODE_ENV=production` sets: a linked
   install (`install-strategy=linked`) records links, not versions, and one that omits dev packages lacks them, so
   either always stops. Not seen: a package placed at the root, or a package's files changed, after npm recorded its
   install (by hand, by another tool, or by an `npm rebuild`, which never rewrites the record), since the gate reads
   no package's own files; any node_modules
   other than the root's install that TypeScript reads (a mutant only its declarations reject counts as killed): one
   inside the checkout (made by hand in src, which TypeScript takes before the root's for a file below it, and which
   an image built from a clean checkout never has while git does not track it; a tracked one ships in that image
   too, so there the checker agrees with it), and one above the checkout or above the dir the root's
   node_modules links to (in bt1 or hf1, above the main checkout; a stray install in a home dir), which an import or a
   reference the root's install does not satisfy reaches, a `@typescript/lib-*` replacement included, and which the
   image's build never has; and what the image compiles that
   the checker does not. The image builds with tsconfigprod.json (only `.ts` roots, under build/) and puts updaters/updater_local (the published image) or
   updaters/updater_managed (the manager's builds) in place of src/updater, while the checker judges the tree's
   program, whose src/updater is the managed copy. So a type error only the managed updater's types give (its
   UpdateStatus requires `mode`), or one only in a `.tsx`, `.mts` or `.cts` root that no `.ts` file imports, counts as
   killed, though the published image accepts the mutant. dist and pass B's build compile with the root's install too,
   but no mutant meets their type judgment. A unit test holds the two lockfiles to one TypeScript and runs this check
   on the bot root, so npm test fails too wherever npm's record of the root install (a shared one, through a link,
   included) differs from the root lockfile. A gating mutant whose only type error is an unused `@ts-expect-error`
   (TS2578) type-checks, so it meets pass A's tests again with no checker (`a-unchecked/`), and that run is its pass
   A: from there it goes on like any other mutant. Each mutant run is `vitest related <mutated files>` on the fast tier with one worker: every pass
   and rerun, and each run with no mutant, is given every file the gate mutates, and pass A gives Stryker those files
   only (each file a target can gate in: not a changed file it does not mutate, nor one where code was only taken out
   or only comments changed), and where it runs related tests (pass A, its run with no checker, a2 and the run after
   it, pass B's integration tier) only tests that import one of them, directly or through other files, run: by an ES
   import or an `import()` of a written-out name. A test that reaches them any other way does not: by any require,
   written out or computed (src's lazy requires), a file read or a child process. Pass B's child tier runs whole; each b2 run runs the one file that failed, and the run after them runs every such file. There is no coverage analysis: every mutant runs those tests. The files go on vitest's
   command line relative to test/; a change of many hundreds of files can pass Windows' limit on a command line, and
   then the run's log says vitest could not start.
2. **Pass B, the rest, on pass A's gating survivors only.** The sandbox's dist is built from the instrumented src
   (build.cjs), then each survivor runs `vitest related <mutated files>` on the integration tier and then the whole child tier, whose
   scenarios start real processes on that dist. A child sees the mutant through the env. Stryker makes every mutant a
   span holds, so a survivor that spans lines brings in the mutants nested inside it; in pass B and every rerun those
   run no test (targets.mjs gives the runner the ids the pass is for) and their results are dropped.
3. **Reruns alone.** Every run stops at its first failure. A rerun runs one mutant at a time and gives the config's
   limit for each test and hook, and a child scenario step's default bound, four times their time (a limit a test,
   hook or step sets itself is not scaled), and Stryker a larger budget for the whole run.
   - A gating mutant that timed out in pass A, or whose run there failed only on the machine's texts (below), reruns
     with pass A's fast tests. It counts as killed when the rerun fails a test, whatever the failure says, or times out when run alone: a test or its beforeEach or afterEach hook past four times its limit, or past its own limit when it sets one (a beforeAll or
     afterAll hook's timeout is inconclusive, below), or the whole run past Stryker's budget for
     it, which is four times what those tests take with no mutant, plus a minute. That budget fires first whenever
     those tests take under 15 seconds, so a mutant that only slows several tests, each within its own limit, by that
     much in all counts as killed; each confirmed timeout is listed with its replacement, to check. One that survives
     the rerun goes on to pass B.
   - In pass B, where containers and children can be slow or fail on their own, a hang never counts: a mutant that
     only hangs a test there is inconclusive. A test that waits must bound its wait and fail, as a child scenario step
     does ("did not finish in N ms" is a failure, not a hang). A child test's own limit is fifteen steps' bounds, so in
     a test of up to fourteen steps a hung step fails by its bound first. Stryker's budget for a pass B run is twice
     its run with no mutant plus a minute. While that run takes under a minute, the budget is below vitest's limit on a
     hook, so a run that fails a test and then waits in an afterAll past the budget (a `pool.end()` held by a client
     still checked out) counts as a hang too; past a minute, vitest's limit can end the afterAll first, and the failed
     test counts as a kill. Either way an afterAll must bound its waits as a test does (the suite's own end their pools
     through helpers/endPool.ts).
   - A gating kill of pass B, or a run there that failed only on the machine's texts, reruns with the one test file
     that failed, alone (one rerun per such file), so no other file's order or hang can decide it (vitest takes the
     name as part of a path, ignoring case, so a test file whose path holds it runs too). It counts only when
     that file fails for the mutant again, whatever the failure says; when the file passes alone, the mutant is
     inconclusive, not a survivor, since pass B stopped at that failure and its later tests never ran on it. Its Stryker
     budget is four times that file's own run with no mutant, plus an hour, plus Stryker's overhead, above anything
     vitest's own limits let the file take after its first failure, so a rerun that fails always leaves its report.
   - A timeout in pass B or in a b2 rerun counts against its mutant (hung, never a kill) with no run after it to
     clear it, so it stands on the budget Stryker built from that pass's own run with no mutant. When a run there
     timed out, that pass's time is checked as the reruns' is below (Stryker's own time against the run's monotonic
     one): where the clock of Stryker's process stepped during that run, every budget there was wrong (a step back can
     make it negative), so the gate ends NO RESULT naming the pass rather than count its mutants hung, and it does
     the same where those times could not be read. Not seen in time: a forward step (on Linux, a suspend too) during
     any pass's run with no mutant raises that pass's budget by up to `timeoutFactor` times the step, so a mutant
     that loops without yielding (vitest's own limit cannot fire in a blocked worker) holds its slot that long before
     anything reads the clock: pass A and A with no checker never read it (their timeouts rerun in a2), and a2, B and
     b2 read it only after the whole pass. The verdict stays right; the run can take hours, or never end for a step
     of days.
   - A mutant the gate never reran (it stopped first) is inconclusive, and so is a survivor of pass A that the stopped
     gate never ran through pass B, and a pass B kill that failed again alone in one b2 run while a later one stopped
     the gate before the run with no mutant after them.
4. **A run with no mutant after the reruns.** When a rerun counted a kill or a timeout, the same tests run once more
   with no mutant, the way the reruns ran them: a Stryker run of its own over the reruns' spans, in a fresh sandbox of
   the tree, with the same code made and none of it active (the tree's files only, git-ignored ones never, and pass
   B's dist built from that code), which ends after its run with no mutant (`dryRunOnly`). If they fail, the
   machine or a container went bad during the reruns, so what the reruns counted is inconclusive and the gate ends NO
   RESULT. When a rerun of pass A confirmed a timeout, the run must also fit in the budget Stryker gave each rerun (four
   times the reruns' own run with no mutant, plus a minute, plus Stryker's overhead), by a monotonic clock, which no
   clock step moves, or the machine was as slow as the mutant seemed and the gate ends NO RESULT the same way. The
   budget is Stryker's own: its reporter leaves Stryker's time for the reruns' run with no mutant (dry-timing.json),
   and runner.mjs times that run by a monotonic clock (dry-ms.txt). Where the two disagree by more than a second plus
   a tenth of the run, the clock of Stryker's process stepped, so the budget is not what the reruns took (a step
   forward of days overflows Node's timer, which then holds each rerun to 1 ms), and the gate ends NO RESULT the same
   way (mutation/control.mjs). A step within that margin moves the budget by at most four times it. Its bound is
   an hour, above the budget any rerun of pass A had (its own run with no mutant ran under Stryker's five minutes), so
   the budget, not the bound, judges its time.
   What it cannot see: a machine that was
   four times slower for one rerun only and well again by the end (a pass A rerun that timed out, or a pass B rerun
   whose child step ran past its bound), or, for a test, hook or step that sets its own limit, which is not scaled,
   one only as much slower as that limit allows (no test that reaches src sets one today); nor what an earlier rerun,
   or the pass's own run with no mutant, left inside that pass's one sandbox (a file written under its test or src
   through a path a mutant made relative, a module a scenario put into its dist), which can fail a later rerun: its
   sandbox is fresh, so it holds none of it (no test or scenario writes there today).

The tree is fingerprinted (every file git tracks or would add, which is what each sandbox holds: size, time and
content) before the plan reads a file,
and again before the verdict: the plan reads the tree then, and each pass, and each run with no mutant after the
reruns, copies it as it is when it starts, so a tree that changed during the run (an edit, a formatter, another
session) ends NO RESULT, naming the files. The packages are not copied, so each run loads them as they are then:
Stryker links into each sandbox every node_modules under the root that is a dir, not a link, and a run reaches the
root's from the sandbox through the parent dirs when it is a link (a worktree sharing the main checkout's). The print
holds npm's hidden lockfile (`.package-lock.json`) of the two dirs the runs load, the root's node_modules (src's
packages) and test/node_modules (the suite's), read through a link to the dir it names; npm rewrites it at the end of
an install that changes the dir and npm ci removes it first, so an install during the run ends NO RESULT too.
test/node_modules must be a dir of the checkout's own: as a link Stryker would link none of the suite's packages, so
the gate stops at its start, before it loads a package through the link. Remove the link itself first, never what it
names (from the bot root, `node -e "require('fs').rmSync('test/node_modules')"`, which refuses a real dir), and only
then run `npm run test:install`: npm ci through the link empties the other checkout's test/node_modules. Not seen: an install still running when the
last print is taken, or one stopped before it finished (npm writes the record last); an `npm rebuild` (it never
rewrites the record); packages changed by any other tool; and packages in any other node_modules (a module's own, in
a clone under src), which Stryker links too.

A run Stryker counts as a kill is checked against vitest's report of it: it is a kill when a test itself failed, and a
timeout when every failing test (or its beforeEach or afterEach hook) timed out. In a pass's first run (A, its run
with no checker included, or B), a
failure that reads like the machine's proves nothing by itself, for the machine may cause it as well as the mutant:
refused or reset connections, a container that would not start, a database connection dropped, exhausted resources,
a file held or refused (EBUSY, EPERM, ENOTEMPTY or EACCES, as on Windows when a test removes its temp dir while a run
beside it or the indexer holds a file in it, or when code unlinks or renames onto a directory). When every failing test
failed so, or timed out beside such a failure, the mutant reruns alone (above), where the texts are not read: a failure
that repeats with the mutant alone, while the run with no mutant after the reruns passes, is the mutant's. The texts
are matched against the first line of each failure unless it is an AssertionError (a sync `expect` or `assert`; a failed
`.resolves`, `.rejects` or `expect.poll` begins `Error:` and is read like any error, which at most sends it to a rerun),
never against a stack or a child's stderr. So the list only spares reruns, and need not be complete. What the reruns
cannot see: a chance failure (a timeout included) that hits a mutant's first run, and one that hits its rerun alone,
while the run with no mutant after passes, credits a kill; so does what an earlier rerun left in the rerun sandbox
(above).
Anything else is **inconclusive**: no report, a failure (a timeout included) only in a beforeAll or afterAll hook or at
file level, an unhandled error with every test passing, or a first run that failed only on the machine's texts and was
never rerun (the gate stopped first), or a type error only of an unused `@ts-expect-error` that never met the tests
(the gate stopped first, or it is a context mutant). vitest counts a failure in a beforeEach or afterEach hook as its test's, so such a
failure counts as the test's too. A failure the mutant itself causes only at load (a module that throws while a test
file imports it), only in a beforeAll or afterAll, or only as an unhandled error repeats on every rerun, so no rerun
clears it: the test that does must fail inside its own body, where nothing stops it first. Import the module with
`import()` in a test file none of whose static imports reaches it, directly or through other files; call the hook's
code in a test of a file or describe that hook does not run for; await what rejects. A machine's failure in such a
hook (a container that would not start) is the other kind: a rerun of the gate on a sound machine can clear it.

Every run of the gate draws one fast-check seed (named on the Scope line; set SMDB_TEST_SEED to an integer to run with a
given one, anything else is refused), so a property draws the same inputs in every mutant's run as in the run with no
mutant: a property that fails in a mutant's run fails for the mutant. A pass A kill stands on one run, so a test that
can fail by chance there still credits a kill: one random in another way (its own Math.random, the clock), one that
fails for the machine in a way the list above does not hold, and one that uses a fixed port or path, since every mutant's run in pass A shares one sandbox and one temp dir: a run beside it
can hold the port or the path, and a run before it can leave the path behind. Fast tests use mkdtemp and port 0. No
`--concurrency` rules out a run beside a pass A run (pass A runs two at 1, above); only the reruns alone (a2, b2) and
the runs with no mutant after them run one at a time, and so do the unchecked pass A runs at 1 and pass B below 4
(it runs half of `--concurrency`, at least one).

## The report

`test/mutation/reports/<time>-<process id>/` (ignored by git; delete it whenever you like):

- `summary.txt` is the L5 report for the review packet: the scope, what was not mutated and why, patterns or lines no
  mutant touched, the changed lines that can move others, the places code was taken out, the gating mutants by
  outcome, every survivor, silenced and inconclusive mutant with its place and replacement (with why a kill or timeout
  did not count), the confirmed timeouts, the context mutants, the runs with no mutant after the reruns, why the gate
  stopped or which files changed during the run, and the verdict.
- `mutants.json` has the run's fast-check seed and every mutant: its place, original text and replacement, whether it
  gates, and per pass its status, the report dir its id is in (Stryker numbers each run's mutants anew) and the test
  that killed it (for a mutant pass A met again with no checker, its pass A is that run, in `a-unchecked/`).
- `a/`, `a-unchecked/` (pass A again with no checker), `a2/`, `b/` and `b2-1/`, `b2-2/` (one per test file that failed in pass B: a kill, or a failure only on the machine's texts) hold, for each mutant run, one vitest
  JSON report and log per tier it ran (`<id>-<tier>.json` and `.log`; a run in `b/` can reach both integration and
  child; a nested mutant a pass is not for runs nothing; `dry-*` is the run with no mutant, `dry-ms.txt` its monotonic time and `dry-timing.json` Stryker's).
  `a-unchecked/`, `a2/`, `b/` and `b2-*/` also hold targets.json and run-ids.json, the mutants the pass is for. `control-a2/` and
  `control-b2/` hold the runs with no mutant after the reruns.

The verdict is FAIL when a gating mutant ends Survived, NoCoverage, inconclusive (a pass that made no mutant at its place included), RuntimeError, or Ignored (a
`// Stryker disable` comment needs the same justification in the notes as a survivor). A confirmed timeout counts as
killed and is listed. CompileError counts as killed by the type checker, unless its only error is an unused
`@ts-expect-error` (a gating one then meets pass A's tests with no checker, above). The verdict is NO RESULT when no src file
changed, when no gating mutant was made, when every gating mutant was a type error (no test ran against the change),
when the type checker would judge a file outside the tree, when what it reads is not what the root lockfile ships
(test/'s TypeScript, or npm's record of the root install) or that lockfile names no TypeScript or cannot be read,
when a pass could not run, when a run of pass B or b2 timed out while the clock of Stryker's process stepped during
that pass's run with no mutant (or its times could not be read), when Stryker mutated a file no target names, when
the run with no mutant after the reruns failed (or ran past the reruns' budget, or its times could not be read),
when the tree changed during the run, or when a test's stand-in replaced vitest (SMDB_MUTATION_VITEST, for the
gate's own tests only); the report then says why, with the passes that did finish.

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
  at no repository above the bot root or the temp dir (GIT_CEILING_DIRECTORIES: a sandbox sits inside the checkout and
  holds no .git, and test data dirs and child cwds sit under the temp dir), with NODE_ENV `test` and its own DATA_DIR;
  the code that reads DATA_DIR or holds a fixed root (`/data`, `/app`) is never mutated (What it mutates), and a process started
  with an env of its own that lacks DATA_DIR throws, in a test and in every child step: fork, spawn, exec, execFile,
  their sync forms, a promisified exec or execFile, and a worker_threads Worker (helpers/forkGuard.cjs, which setup.ts
  loads and child.ts preloads; src/webui/botManager.ts forks the bot so, and a mutant that empties that env must fail,
  not reach `/data`);
- every wait is bounded, and a step past its bound is ended with every process it started that still descends from it
  (helpers/endTree.mjs, by parent links: one whose parent already exited is not found, and none is where ps is
  missing, so a scenario that starts processes keeps each one's parent alive; a step that already exited is not
  walked, since its pid can be another process's by then, so what it started and left holding its output is not
  ended either); a step prints one `RESULT`
  line with its result and the modules it loaded; the helper fails unless the fork guard is among them and every other
  one sits under this root's dist.

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
  active"), so the run also shows the FAIL verdict and how a survivor is listed. Each of its real passes leaves
  Stryker's own time for its run with no mutant and runner.mjs's monotonic one, and the two agree, so a sound run is
  never taken for a clock step. The same file checks that an unknown
  base and a pattern that makes no mutant both end NO RESULT, exit 2, and that a glob, a missing file, a pattern with
  columns, a file holding a line break the gate does not count, a file in src that git ignores or that sits in an
  untracked repository, src/utils/dataRoot.ts and the suite's own helpers/env.ts and vitest.config.ts are refused (each
  with a stand-in for vitest that does not exist, so a refusal that broke would run no test).
- Gate runs on a stand-in for vitest (every mutant times out) end NO RESULT: when the run with no mutant after the
  reruns fails, with every timeout the reruns confirmed listed as inconclusive (that run also adds a file and stamps
  test/node_modules' lockfile anew, as an install would, and the verdict names both as changed); when it passes past
  the reruns' budget;
  and when the target (a throwaway untracked file) gains a way to `/data` during pass A, which pass A2's run with no
  mutant refuses, or during pass A2's reruns, which the run with no mutant after them refuses. Each is run with a
  mutant id left in the env, which the gate ignores.
- The bite fails when the plumbing breaks: with the active mutant dropped from the child's env the child-only mutants
  survive, and with the scenario loading another checkout's dist pass B refuses at its first run.

## Not yet covered

- The old harnesses (fp_harness.js and its children) hard-code the main checkout's path, so pass B cannot run them: in a
  sandbox they would load an unmutated dist. Until they take the bot root from their own place or an env variable
  (VERIFY.md section 11, step 2), code that only they reach keeps the dist mutation scripts (mut_*).
- src/index.ts pins its alias base to /app/dist: a child scenario that boots the parent process from a sandbox needs that
  base to come from the file's own place first.
- Browser views are never mutated (no render tests yet).
- The CLI (src/cli) falls back to 127.0.0.1:8080 (WEBUI_PORT, which the scrub takes out) and to the manager's 8090,
  where a developer's own bot and manager listen and take a loopback request unasked. No test runs the CLI yet; one
  that does must give it a port of its own.

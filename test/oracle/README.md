# The data-loss oracle

Documentation/process/VERIFY.md section 5. A writer posts numbered saves through a node's operator data route and logs
every answer. Copies of the run's docs are taken afterwards, and the checker judges the logs against them.

| File | Runs where | What it does |
|---|---|---|
| oracle.mjs | the dev box, or a node image on a host | `write`, `read` (a copy through one node's app read path), `fleet` (the control facts), `sql` (the database listing query; `sql ownership` lists the claim sequence and the highest guild_ownership and shard_claims claims for check.mjs `--ownership`; `sql claims` lists the shard_claims rows for check.mjs `--claims`; `sql requests` lists the run's guild_requests rows for check.mjs `--requests`; `sql shared` lists the run's shared files in shared_docs for check.mjs `--shared-db`), `mirror` (one machine's mirror files of the shared files), `bite`, `cleanup` |
| check.mjs | the dev box | judges logs and copies; exit 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 64 usage |
| judge.mjs | (library) | the verdict rules |
| shared.mjs | (library) | the verdict rules of the shared files (NB6) |
| model.ts, fakeApp.ts | tests only | the model of a correct store with every check, and a stand-in node on real Postgres with injectable faults |

oracle.mjs and check.mjs need Node 18 or newer and nothing from npm.

## What the writer sends

- **Unique docs** `<run>-<lane>-u<n>.json`:
  - each is written once, with a random payload (escapes, multi-byte text, a surrogate pair) of log-uniform size up to
    `--max-size`, cut to fit `--max-body`;
  - some are deleted later, but only a doc that was acknowledged and that reads back as written just before the delete.
    The bot answers 200 to a delete of a doc that is already gone, so deleting without that read could hide a loss. A
    loss in the one round trip between that read and the delete can still hide behind it.
- **Hot docs** `<run>-h<k>.json`, written whole by every lane. Each lane keeps its own counter per doc. A hot doc's
  content is logged in full, so `bite` can put an older version back.
- **Reads** through the lane's own node every `--read-every` writes.
- Everything is under module `oracle` of the `--guild` guild, except the shared files.
- **Shared files** (`--shared ID`, NB6; a Postgres bot of two machines): global files, named as the route names them
  (`module/file.json` under /data/global), which every machine's lane rewrites, a share `--shared-ratio` (0.2) of its
  operations. A lane first reads the file through its own node (`shared-read`), then sends content that names the
  hash of what it read (`prev`) with the read's sha as `loadedSha`, the base the bot stores it over and nothing else.
  The send (`shared-send`, the content logged whole) and its answer (`shared-ans`) are lines of their own, counted
  under `shared` in the end line, so the guild checks never see them. The route writes only files it lists, so each
  file must exist on the bot before the run; the run replaces its content, so name files no module reads, or a test
  module's.

The log has one JSON line per event. A `send` line comes before every request and an `ans` line after it, both stamped
by this process's monotonic clock:
- `ACKED`: 200;
- `HELD`: 202, accepted but not yet durable;
- `REFUSED`: any other status, with `definite` true only for refusals given before anything was applied;
- `UNKNOWN`: no answer, including requests cut short when the writer stops.

A `read` line names the lane that read, and under `by` the lane that the served content names.

Each log's start line names its sink. A `file` log (`--log FILE`) gets each send line, whole, before its request goes
out (a line that cannot be written ends the writer at once, with no end line), so even a killed writer's file holds
every request it sent. A `stream` log (`--log -`, stdout) can be cut on its way. The end line counts the answers and
reads, and the checker calls a log whose lines do not match those counts inconclusive.

On a stop (`--duration` elapsed, a `stop` line in the marks file, SIGINT, SIGTERM or SIGHUP), the writer sends nothing
new and gives in-flight requests 5 seconds. Then it cuts them short, logs them as UNKNOWN, and writes its end line. A
second signal ends it at once: it writes its end line to each file log and exits (a stream may lose its last lines), and
its in-flight requests stay unanswered, so they read as UNKNOWN.

Lines in the marks file mark critical windows on the same clock, and inside a window the writer runs `--burst` times
faster. A line must be exactly `begin NAME`, `end NAME` or `stop`; anything else makes the run inconclusive. A mark is
stamped when the writer reads it: it polls the file every `--marks-every` ms (50), and once more before its end line.

## The web UI's limits

webui/server.ts admits 10 requests at once, then 2 a second, per client address. It also refuses bodies over 10 kb,
answering 500 "An error occurred" from its error handler.
- **Every request waits for a token.** The writer, `read`, `cleanup` and `fleet` all take a token from a bucket that
  mirrors the limiter (9 at once, one per 520 ms; `--limiter`). So outside a window the writer stays at `--rate`, 1.5 a
  second.
- **Inside a window the writer spends the reserve.** It goes up to 9 requests faster, then holds at about 2 a second.
- **Lanes on one node share one bucket.**
- **Bodies are cut to fit:** `--max-body` defaults to 10000 bytes, which stays under the 10 kb limit.
- **A 429 still counts.** A 429 that comes anyway (another client sharing the address) is a definite refusal, and
  `read`, `cleanup` and `fleet` retry it.
- **Reading and cleaning up a run takes about as long as writing it:** about 2 docs a second. `read --limit N` (N of 1
  or more) reads an evenly spread sample instead, which the checker reports as a sample.
- **More acknowledged writes in a window** come from repeating the scenario with jitter, not from a higher rate [A13].

## Verdicts

| Verdict | Meaning |
|---|---|
| LOST | An acknowledged doc is absent, or a hot doc holds a value that an acknowledged later write by another lane should have replaced. |
| ROLLBACK | A hot doc holds a counter lower than one its own lane had acknowledged. |
| FORK | Two copies each hold docs the other lacks, or copies named in `--agree` differ. |
| PHANTOM | A doc is present though its write was refused before applying, or a run doc that no writer sent is present, or a holder took a request row of the run that no writer sent (`--requests`), or the history of a shared file's version holds a write refused before applying. |
| HELD-MISSING | A held (202) effect never arrived. |
| RESURRECTED | A doc is back after its delete was acknowledged. |
| WRONG-CONTENT | A doc holds bytes that no one wrote to it. |
| CONTROL | A shard is leased to two live processes at once, a shard in a process's shard table is not leased by that process or is leased by another one, nodes disagree on the shard count, a guild maps to two shards or out of range, one claim is reported on two shards or by two processes, a lease's claim is not the one the shard_claims row of its shard holds for that process (`--claims`), or a live claim is at or above the claim the next take would draw (`--ownership`). Facts are keyed by process id (a JSON bot's by node id). With two sets of control facts, only a CONTROL that both sets show counts. |
| TWICE | Holders started more than one request row carrying one send (`--requests`): the change was taken twice. |
| FALSE-ANSWER | A send's answer contradicts its request rows (`--requests`): a 200 with no row the holder answered ok, a 202 with no row it answered accepted, or a refusal given as never applied whose row a holder took and left unanswered or answered as applied. |
| SHARED-LOST | An acknowledged shared write is not in the history of the version the database row (`--shared-db`) or a machine's mirror (`--mirror`, after the bound) holds: that version's write, the write it was built on, and so on. |
| SHARED-OVERWRITE | Two acknowledged shared writes were built on one version: at most one of them was stored over the version it read. |
| SHARED-FORK | Two machines' mirrors of one shared file hold different versions after the bound. |

`(during)` marks a verdict from a read made during the run, judged against what was acknowledged before that read was
sent.

How the checker judges:
- **One clock per log.** Order is judged only inside one log. Two writer processes on two hosts never have their clocks
  compared, so ordering across their lanes goes unjudged [A16]; per-lane checks still apply.
- **Late landings.** A write that got no answer may land at any time, so it never counts as superseded. A doc that ends
  on such a write after committed ones makes the run inconclusive, because a late landing and a rollback look the same.
- **Shared files (NB6).** A version's history is followed through `prev`, back to a version no write of the run made
  (the file as the run found it), so order is judged by content, never by clocks. An answer that may have applied (no
  answer, a held 202, a refusal not on the list below) is a write that may have landed: it can be on a history, and
  only acknowledged (200) writes must be. A refusal is one given before anything was stored when its text holds
  "nothing was" or NB6's two "so your change was not saved." forms (decision 26 and T22: another machine stored the
  file after this one read it). A mirror is judged only from `--shared-bound` seconds (90) after the last writer's
  end line, by the copy's own clock against the writer's: decision 11's bound is 60 s for a lost notice, plus the
  pass's reads. The database row needs no wait: it is the stored version.
- **Request rows (NB7).** A change sent to the machine that runs the guild is a row of smdb_data.guild_requests that
  the holder takes, applies and answers. A send is matched to its rows by op, key and, for a write, its content's hash.
  A row shows what the holder did: nothing (never taken, or answered `unapplied` or `not-held`, both given before
  anything is applied), the holder's answer, or taken with no answer, which may have been applied. A send with no row
  went by the local route and is judged by the copies alone. A listing with no row of the run is judged, with a note.

A streamed log with no end line is refused (exit 64): it may have lost requests the store still saw. Judge the writer's
own file log instead (step 2).

The result is FAIL on any verdict. It is INCONCLUSIVE, never PASS, in any of these cases:
- a mark is malformed, unpaired (a begin with no end, or an end with no begin) or repeated;
- a log with marks polled its marks file less often than once a second, so its window edges may be that late;
- a log's end line counts answers or reads that its lines do not hold, so lines are missing;
- a window named with `--window` was never marked;
- a marked window holds fewer than `--k` acknowledged operations, or, with no window marked, the whole run does;
- no judged copy was given;
- a judged app copy could not read a committed doc, has no row for one (unless it is a sample), or is a sample that
  holds no committed doc;
- a file log has no end line: its writer did not finish. It was killed, or it stopped on an error its stderr names (one
  is a log line that could not be written: free the space before a rerun). The file still holds every request it sent,
  so its verdicts fail the run, but a run cut short cannot pass. If the writer's host went down, the file's last
  lines may be lost too: repeat the run. A copy of a file cut short in transit looks the same and would raise false
  verdicts, so a copy is judged only once its size matches the writer's own file (step 2);
- a doc ends on an unanswered write after committed ones;
- a run with shared files has no `--shared-db` listing, fewer than two mirror copies judged, a mirror copy taken
  before the bound or that could not read a shared file, a writer log with no end time, or no acknowledged shared
  write;
- no control facts were given, or a node gave none (its bot child down or not answering). `--no-fleet` waives this
  only where there is no fleet to check.

The checker never prints "zero loss". Its result line says "operator route; module path unproven" until the owner rules
on what "saved" means for module saves [A18].

## Proven locally

`npm test` holds the tool's behaviour described above. The live procedure below is the main session's to prove on the
fleet.
- **test/oracle/model.ts** holds a model of a correct store and every check, written against a judge module:
  - **No false verdict.** The checker raises no verdict on any history the model allows. That includes writes that
    land after their timeout, failed reads, partial app copies, a lagging copy, and two logs on two clocks. A writer
    killed at any point, alone or beside another that ran on, leaves a file judged without a false verdict, and the
    run is inconclusive.
  - **Each injected fault is named on its doc:** LOST, ROLLBACK (acknowledged or held), HELD-MISSING (unique or
    hot), RESURRECTED, PHANTOM, WRONG-CONTENT, FORK, and stale reads during the run.
  - **Hand-built cases** cover the ordering rules, the reads during the run, the CONTROL rules and two-set counting
    (each rule, in both orders), a killed writer's file and a cut stream, and each INCONCLUSIVE case above.
  - **The shard claim rules** pass two reads with a legal takeover, a clean stop and the next process's take, or a
    hand-over between them, also when the first listing already shows the change; they fail a lease whose claim the
    listing does not hold for its process in both reads, and one shard leased to two live processes. No rule judges
    when a take may happen: a release between two reads makes a legal take look early, so the take's timing is
    tested where the take is visible (NB4's property and Postgres tests).
  - **The request row rules** raise nothing on any listing a correct request route leaves (each answer with each row
    it allows, or none), name TWICE on a send given a second started row and FALSE-ANSWER on a send whose row
    contradicts its answer, and hand-built cases read listing lines (pretty-printed content, reordered keys, a bad
    line, a missing field) and cover not-held and unapplied answers, deletes, an unparseable reply and rows no writer
    sent.
- **test/unit/oracleJudge.test.ts** runs those checks against judge.mjs.
- **test/unit/nb6Oracle.test.ts** holds the shared files: the refusal list against the bot's own texts (`truthText`),
  each shared verdict on hand-built logs and copies and the cases that may not raise one (a write with no answer, a
  held write, a refusal that may have applied), each INCONCLUSIVE case, and the writer, `mirror`, `sql shared` and the
  checker against two stand-in machines over one row store: a run whose saves the machines compared passes, a run
  whose machines store over any version is SHARED-OVERWRITE, and a mirror put back to an older acknowledged version
  is SHARED-FORK and SHARED-LOST on that mirror.
- **test/unit/oracleMutants.test.ts** runs them against 76 mutants of judge.mjs, each breaking one rule. A hand-built
  check must kill each one, so the result does not depend on what the generator draws.
- **test/integration/oracle.test.ts** runs the tools as child processes against stand-in nodes on real Postgres, and
  takes the database copy with the exact `sql` query:
  - a clean run through two nodes, with held, refused, ambiguous and unanswered answers, passes, with the control
    facts reduced and redacted;
  - the bite test fails with exactly the LOST and the ROLLBACK it planted;
  - injected faults are named on the docs they hit and nothing else, and the writer never deletes a lost or altered
    doc;
  - a split across two databases is a FORK;
  - the writer stays inside the real rate and body limits;
  - `read` and `cleanup` go past the limiter's burst without errors;
  - a stop with hung requests ends within its grace and still writes the end line, and no delete goes out after a stop;
  - in node:24-alpine, SIGHUP ends the log, a second signal mid-request ends it at once with the request unanswered,
    a file log line that runs past a file size limit is an error, not a short write, and a writer whose log fills up
    exits 64 at once with a log the checker can still read and no end line;
  - a `stop` line in the marks file ends the writer on any host, with the marks before it logged;
  - an end mark written just before the stop is logged;
  - two writers on one run, each with its own log, are read, judged and cleaned up together, and each read line names
    its own lane;
  - `fleet` exits 1 for a node whose bot child gave no state;
  - piped mode works;
  - a streamed copy cut short is refused, and the writer's own file from the same run passes;
  - a shard leased twice is named, with one set of control facts or two (`--fleet-again`, which needs `--fleet`);
  - one claim reported by two processes is named, and so is a claim sequence whose next draw is at or below a live
    claim (`--ownership`); a later take of a higher claim that stopped is not, whichever table keeps its claim;
  - leases are compared with `sql claims` listings taken after each set of control facts: a legal takeover, a clean
    stop and the next process's take, or a hand-over and the receiving node's take, between two reads pass, and a
    lease whose claim the table does not hold in both reads, or a shard two processes lease, is named;
  - the test's own database copy fails when psql fails;
  - NB6: two stand-in machines, each with its mirror folder, store shared saves in shared_docs under the key's
    advisory lock with the bot's compare; the run passes with `sql shared`'s listing and both machines' `mirror`
    copies, a mirror put back to an older acknowledged version is SHARED-FORK and SHARED-LOST, a row put back is
    SHARED-LOST on the listing, machines that store over any version give SHARED-OVERWRITE, and the listing keeps
    multi-byte text and a body that is not text byte for byte;
  - NB7 test 12: two web UIs (one whose bot runs another shard and answers `not-held`, one whose bot is down) send
    through the real request route to the bot process that holds the guild's shard, which runs the real sweep over
    the real fenced flush. That process is killed after a claim before its apply, after its flush before its answer,
    and after its apply's accept before its flush, and each time a new process of its machine takes the shard. The
    run passes with the docs, the `sql requests` listing, the control facts, the claims and the claim sequence, with
    can't confirm answers for the killed changes and a "nothing was saved" answer for a change sent to the dead
    process; the bitten listing (a second started row of one acknowledged write, and an acknowledged write's row
    answered `unapplied`) fails with exactly TWICE and FALSE-ANSWER on those docs.

## On the live fleet (the main session's runs)

Guardrails: the secret filter on every read; `ssh <host> ...` with no flag before the host; docker by exact name only.

1. **Pick the guild and the lanes.** Use a test guild served from Postgres. Point two lanes (`m` and `o`) at the bot,
   so two writers contend on the hot docs.
2. **Start the writer where the scenario cannot kill it.**
   - **When the scenario kills only containers,** run it on a host in its own container. That reaches the web UI's
     loopback port, and a bot Update does not stop the writer. Its complete log goes to a file on the host
     (`<run>.host.jsonl`) and a copy streams back to the dev box over ssh [A17]:

         ssh contabo-dbot "mkdir -p /root/smdb-oracle && cat > /root/smdb-oracle/oracle.mjs" < test/oracle/oracle.mjs
         ssh contabo-dbot "docker run --rm --name smdb-oracle-<run> --network host -v /root/smdb-oracle:/o node:24-alpine node /o/oracle.mjs write --run <run> --guild <guild> --lane m=http://127.0.0.1:<port> --duration 1800 --marks /o/marks-<run>.txt --log /o/<run>.host.jsonl --log -" > <run>.jsonl

     If the ssh session drops, the streamed copy is cut (the checker refuses it) while the writer runs on in its
     container, and only the host file is complete. Stop it if it should not run on (below), then wait until the
     container is gone: `ssh contabo-dbot docker inspect smdb-oracle-<run>` prints "No such object" once `--rm` has
     removed it (a failed ssh proves nothing, and a stop line returns before the writer has ended). Then fetch the host
     file (`ssh contabo-dbot cat /root/smdb-oracle/<run>.host.jsonl > <run>.jsonl`), and judge it only once its size
     matches the host file's (`wc -c < <run>.jsonl` against `ssh contabo-dbot "wc -c <
     /root/smdb-oracle/<run>.host.jsonl"`); fetch again if not.

   - **When the scenario kills or cuts off a whole host,** do not run the writer on that host. Its file's last lines
     could be lost and the run would have to be repeated. Run it on the dev box instead, with its log and marks in files
     there (`--log <run>.jsonl --marks marks-<run>.txt`), through an ssh tunnel to each node's loopback port (`ssh -N -L
     <local>:127.0.0.1:<port> <host>`, flags before the host, so it needs the owner's approval once).
   - On the Windows node, run oracle.mjs on the dev box the same way, with its own log and marks files.
   - Mark a window in the marks file the writer polls: `ssh contabo-dbot "echo 'begin kill-bot' >>
     /root/smdb-oracle/marks-<run>.txt"` for a container writer, `echo 'begin kill-bot' >> marks-<run>.txt` for one
     on the dev box. Write the `end` line the same way afterwards. Pass `--window kill-bot` to the checker so that a
     missing mark cannot pass.
   - Stop early: write every `end` mark, then a `stop` line, to the same marks file (`echo stop >> ...` as above). It
     needs no signal, so it works the same for a container writer and for one on the dev box, where Windows cannot
     signal node. The writer ends within its 5-second grace. `ssh contabo-dbot docker stop smdb-oracle-<run>` also
     stops a container writer, inside docker stop's 10 seconds.
   - Lanes on two hosts need two writers: the same `--run`, distinct lane names, one log each. Name each writer's files
     with its own tag where `<run>` stands in a file name (`<run>-<w>.host.jsonl`, `<run>-<w>.jsonl`,
     `<run>-<w>.copy.jsonl`). Every later command (`sql`, `read`, `check`, `cleanup`) then gets one `--log` per writer
     log, copied to the host where it runs; given only some, `read` and `cleanup` miss the other writer's docs.
   - Piping into `node --input-type=module -` also works but leaves no file on the host: if its stream drops, no
     complete log exists and the run is repeated.
3. **Once the writer has ended, let held writes settle, then take the copies before any failback or re-seed wipes the
   evidence [A15].**
   - The writer must have ended first: its log ends with its end line, or its process is gone. A copy taken while the
     writer still runs lacks the docs it acknowledges later, and the checker calls them LOST.
   - If the log has HELD answers, wait until the owner has written its backlog (a few minutes after the scenario
     recovers).
   - A HELD-MISSING counts only if it is still there in a copy taken again later.
   - Take each copy as follows:
     - **Database, every copy that serves or stands by,** with the exact container name:

           node test/oracle/oracle.mjs sql --log <run>.jsonl | ssh contabo-dbot docker exec -i <postgres container> psql -U smdb -d smdb -At > <copy>.jsonl

       Send the output straight to a file as bytes. A tool that decodes it as text chunk by chunk can split a
       multi-byte character, and the checker rightly calls the result WRONG-CONTENT (the local tests met exactly this
       through testcontainers' exec).

     - **The app path of each serving node.** It takes about one second per two docs; `--limit N` reads a sample. On
       the writer's own host, read its complete host log. On any other host, copy the log there under its own name
       first, never over a writer's host log:

           ssh contabo-dbot "cat > /root/smdb-oracle/<run>.copy.jsonl" < <run>.jsonl
           ssh contabo-dbot "docker run --rm --network host -v /root/smdb-oracle:/o node:24-alpine node /o/oracle.mjs read --log /o/<run>.copy.jsonl --target http://127.0.0.1:<port> --name <node>-app --out -" > <node>-app.jsonl

     - **The control facts from each node, twice,** using `fleet` the same way with `--out -`: one set, then a second
       set of the same nodes once the first is complete. Each set is read one node at a time, so a shard handoff can
       fall between two reads. The checker compares the facts by process id (a JSON bot's by node id), not file order
       or name, and counts only a CONTROL that both sets show; a node in one set only makes the run inconclusive. The
       facts are reduced to shard, claim and guild facts, and URL credentials are redacted before they leave the host.
       `fleet` exits 1 when the node's bot child gave none.
     - **The shard claims, from the serving primary, once after each set of control facts:**

           node test/oracle/oracle.mjs sql claims | ssh contabo-dbot docker exec -i <postgres container> psql -U smdb -d smdb -At > claims-1.jsonl

       and `claims-2.jsonl` after the second set. The listing is one line holding every shard_claims row. The checker
       calls CONTROL when a process still reports a lease whose claim the row of its shard does not hold for it (another
       claim, another process, a released row or no row), counting only what both reads show: a takeover, a clean
       stop or a hand-over between the two reads changes the second read. Without `--claims` the leases are not
       compared, and a note says so; an empty or unreadable listing is not judged, with a note.
     - **The claim sequence, from the serving primary, after both sets of control facts.** A node that restarts after
       its facts were read then takes a claim above the one they show, so it cannot raise a false CONTROL:

           node test/oracle/oracle.mjs sql ownership | ssh contabo-dbot docker exec -i <postgres container> psql -U smdb -d smdb -At > ownership.jsonl

       The listing is one line: the sequence's value and whether it was called, and the highest guild_ownership and
       shard_claims claims. The checker works out the claim the next take would draw (as the bot draws it) and calls
       CONTROL when a live process already holds that claim or a higher one on a lease: the sequence went back, as after a restore that did not raise
       it. An empty or unreadable listing is not judged, and the checker writes a note saying so.
     - **The request rows, from the serving primary, once the web UIs have answered every request** (NB7: a guild
       another machine runs). A row is deleted an hour after its insert, so take it within the hour:

           node test/oracle/oracle.mjs sql requests --log <run>.jsonl | ssh contabo-dbot docker exec -i <postgres container> psql -U smdb -d smdb -At > requests.jsonl

       A row holds the change's content, so send the output to a file as bytes, as for the database copy.
4. **Judge:**

       node test/oracle/check.mjs --log <run>.jsonl --db primary=<p>.jsonl --lag standby=<s>.jsonl --app <node>-app.jsonl --fleet <node>-fleet-1.json --fleet-again <node>-fleet-2.json --claims claims-1.jsonl --claims claims-2.jsonl --ownership ownership.jsonl --window kill-bot

   - Use `--db` for a copy that must hold everything acknowledged (the serving primary, and a sync standby).
   - Use `--lag` for an async standby.
   - Use `--agree` for copies that must match after the chain settles.
   - Use `--requests NAME=FILE` for the request rows: each send is compared with the rows that carry it.
   - **Shared files (NB6),** for a run with `--shared` on a Postgres bot of two machines, one lane on each:
     - the row listing from the serving primary, once the writers have ended, sent to a file as bytes:

           node test/oracle/oracle.mjs sql shared --log <run>.jsonl | ssh contabo-dbot docker exec -i <postgres container> psql -U smdb -d smdb -At > shared.jsonl

     - each machine's mirror, on that machine, at least 90 seconds after the writers' end lines, with its data folder
       mounted read-only (the bot's /data volume, by its exact name):

           ssh contabo-dbot "docker run --rm -v <bot data volume>:/data:ro -v /root/smdb-oracle:/o node:24-alpine node /o/oracle.mjs mirror --log /o/<run>.copy.jsonl --data /data --name <machine> --out -" > <machine>.mirror.jsonl

     - then add `--shared-db shared=shared.jsonl --mirror <machine-1>.mirror.jsonl --mirror <machine-2>.mirror.jsonl`.
5. **The bite test, once, before trusting a baseline (VERIFY.md 5.5):** after a short clean run, `oracle.mjs bite --log
   <run>.jsonl` prints two SQL statements for the judged copy's database. Run them, dump the copy again, and check. The
   result must be FAIL, with exactly LOST and ROLLBACK on the named docs. Then run the 30-minute baseline.
6. **Clean up** once nothing more is to be judged, on a host that holds the log: the writer's own host with
   `<run>.host.jsonl`, or a host the log was copied to with `<run>.copy.jsonl` (the dev-box writer's case). It takes about
   as long as `read`:

       ssh contabo-dbot "docker run --rm --network host -v /root/smdb-oracle:/o node:24-alpine node /o/oracle.mjs cleanup --log /o/<run>.host.jsonl --target http://127.0.0.1:<port>"

## Not yet covered

- **The module route** (`smdb cmd invoke --repeat`) [A18]. It needs a command that saves through module saveData; none
  ships in the repo.
- **What modules read.**
  - The app read path (`GET /api/config/data/get`) reads through the serving bot child, queue first: for a Postgres
    guild that is the child's working set, the one modules read through loadData. Only while the bot is down does it
    fall back to the web UI's own SQL read of the store, and the answer then carries a notice; a copy taken then is
    the database's, not what a node serves to modules.
  - Reads that modules make through loadData are not taken one by one, so a value a module saw but never saved goes
    unseen.
- **Shared files the run makes.** The route writes only global files it lists, so the run cannot create a shared file;
  it rewrites files that exist, and a file written by hand on one machine of a Postgres bot is moved aside by the next
  pass. Shared files saved by modules, the App Store's files and module folders are not written by the run.
- **File mode** [A19]. The operator route cannot create a new file in a file-routed guild (it needs the file to exist
  already), and the database listing does not apply there. A file-mode reader comes before B2 deploys.
- **Step 1 of VERIFY.md section 5,** the set difference on the existing kill-drill logs. It reads live hosts, so it
  belongs to the main session.

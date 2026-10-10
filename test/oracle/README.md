# The data-loss oracle

Documentation/process/VERIFY.md section 5. A writer posts numbered saves through a node's operator data route and logs
every answer. Copies of the run's docs are taken afterwards, and the checker judges the logs against them.

| File | Runs where | What it does |
|---|---|---|
| oracle.mjs | the dev box, or a node image on a host | `write`, `read` (a copy through one node's app read path), `fleet` (the control facts), `sql` (the database listing query), `bite`, `cleanup` |
| check.mjs | the dev box | judges logs and copies; exit 0 PASS, 1 FAIL, 2 INCONCLUSIVE, 64 usage |
| judge.mjs | (library) | the verdict rules |
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
- Everything is under module `oracle` of the `--guild` guild.

The log has one JSON line per event. A `send` line comes before every request and an `ans` line after it, both stamped
by this process's monotonic clock:
- `ACKED`: 200;
- `HELD`: 202, accepted but not yet durable;
- `REFUSED`: any other status, with `definite` true only for refusals given before anything was applied;
- `UNKNOWN`: no answer, including requests cut short when the writer stops.

A `read` line names the lane that read, and under `by` the lane that the served content names.

On a stop (`--duration` elapsed, SIGINT, SIGTERM or SIGHUP), the writer sends nothing new and gives in-flight requests 5
seconds. Then it cuts them short, logs them as UNKNOWN, and writes its end line. A second signal ends it at once: it
writes its end line and exits, and its in-flight requests stay unanswered, so they read as UNKNOWN.

Lines in the marks file mark critical windows on the same clock, and inside a window the writer runs `--burst` times
faster. A line must be exactly `begin NAME` or `end NAME`; anything else makes the run inconclusive. A mark is stamped
when the writer reads it: it polls the file every `--marks-every` ms (50), and once more before its end line.

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
| PHANTOM | A doc is present though its write was refused before applying, or a run doc that no writer sent is present. |
| HELD-MISSING | A held (202) effect never arrived. |
| RESURRECTED | A doc is back after its delete was acknowledged. |
| WRONG-CONTENT | A doc holds bytes that no one wrote to it. |
| CONTROL | A shard is leased to two nodes, a node leases a shard that a master's shard table gives to another node (a grant still pending is skipped), nodes disagree on the shard count, or a guild maps to two shards or out of range. With two sets of control facts, only a CONTROL that both sets show counts. |

`(during)` marks a verdict from a read made during the run, judged against what was acknowledged before that read was
sent. `(provisional)` marks one that the lost tail of a log with no end line could explain (below).

How the checker judges:
- **One clock per log.** Order is judged only inside one log. Two writer processes on two hosts never have their clocks
  compared, so ordering across their lanes goes unjudged [A16]; per-lane checks still apply.
- **Late landings.** A write that got no answer may land at any time, so it never counts as superseded. A doc that ends
  on such a write after committed ones makes the run inconclusive, because a late landing and a rollback look the same.

The result is FAIL on any verdict that is not provisional. It is INCONCLUSIVE, never PASS, in any of these cases:
- a mark is malformed, unpaired (a begin with no end, or an end with no begin) or repeated;
- a log with marks polled its marks file less often than once a second, so its window edges may be that late;
- a window named with `--window` was never marked;
- a marked window holds fewer than `--k` acknowledged operations, or, with no window marked, the whole run does;
- no judged copy was given;
- a judged app copy could not read a committed doc, has no row for one (unless it is a sample), or is a sample that
  holds no committed doc;
- a log has no end line: the writer died, or its stream was cut while it ran on. Each send line is logged before its
  request, so such a log lacks only a tail of requests after its last line, and nothing bounds that tail (a writer whose
  stream dropped runs on in its container for the rest of `--duration`). The verdicts that tail could explain are listed
  as `(provisional)` and do not fail the run:
  - an acknowledged unique doc of a cut lane is absent (a delete in the tail);
  - a doc that no log names, or hot content that no logged write has, names a cut lane (a write in the tail);
  - another writer's read served such content;
  - a FORK in which one copy lacks only docs of cut lanes.

  Every other verdict still fails the run. To settle the provisional ones, judge the writer's complete host log instead
  (step 2). If the writer itself died (killed outright, out of memory, its host rebooted), its own file holds every
  request but no end line, so no complete log exists and the run is repeated;
- a doc ends on an unanswered write after committed ones;
- no control facts were given, or a node gave none (its bot child down or not answering). `--no-fleet` waives this
  only where there is no fleet to check.

The checker never prints "zero loss". Its result line says "operator route; module path unproven" until the owner rules
on what "saved" means for module saves [A18].

## Proven locally

`npm test` holds the tool's behaviour described above. The live procedure below is the main session's to prove on the
fleet.
- **test/oracle/model.ts** holds a model of a correct store and every check, written against a judge module:
  - **No false verdict.** The checker raises no verdict on any history the model allows. That includes writes that
    land after their timeout, failed reads, partial app copies, a lagging copy, and two logs on two clocks. With a log
    cut short at any point, whatever its tail did, every verdict it raises is provisional.
  - **Each injected fault is named on its doc:** LOST, ROLLBACK (acknowledged or held), HELD-MISSING (unique or
    hot), RESURRECTED, PHANTOM, WRONG-CONTENT, FORK, and stale reads during the run.
  - **Hand-built cases** cover the ordering rules, the reads during the run, the CONTROL rules and two-set counting
    (each rule, in both orders), what a cut log makes provisional and what it does not, and each INCONCLUSIVE case
    above.
- **test/unit/oracleJudge.test.ts** runs those checks against judge.mjs.
- **test/unit/oracleMutants.test.ts** runs them against 54 mutants of judge.mjs, each breaking one rule. A hand-built
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
  - in node:24-alpine, SIGHUP ends the log, and a second signal mid-request ends it at once with the request
    unanswered;
  - an end mark written just before the stop is logged;
  - two writers on one run, each with its own log, are read, judged and cleaned up together, and each read line names
    its own lane;
  - `fleet` exits 1 for a node whose bot child gave no state;
  - piped mode works;
  - a shard leased twice is named, with one set of control facts or two (`--fleet-again`, which needs `--fleet`);
  - the test's own database copy fails when psql fails.

## On the live fleet (the main session's runs)

Guardrails: the secret filter on every read; `ssh <host> ...` with no flag before the host; docker by exact name only.

1. **Pick the guild and the lanes.** Use a test guild served from Postgres. Point lane `m` at the master, which forwards
   to the guild's owner, and lane `o` at the owner itself, so two nodes contend on the hot docs. A node answers only for
   guilds it serves.
2. **Start the writer where the scenario cannot kill it.**
   - **When the scenario kills only containers,** run it on a host in its own container. That reaches the web UI's
     loopback port, and a bot Update does not stop the writer. Its complete log goes to a file on the host
     (`<run>.host.jsonl`) and a copy streams back to the dev box over ssh [A17]:

         ssh contabo-dbot "mkdir -p /root/smdb-oracle && cat > /root/smdb-oracle/oracle.mjs" < test/oracle/oracle.mjs
         ssh contabo-dbot "docker run --rm --name smdb-oracle-<run> --network host -v /root/smdb-oracle:/o node:24-alpine node /o/oracle.mjs write --run <run> --guild <guild> --lane m=http://127.0.0.1:<port> --duration 1800 --marks /o/marks-<run>.txt --log /o/<run>.host.jsonl --log -" > <run>.jsonl

     If the ssh session drops, the writer runs on in its container and only the host file is complete. Wait until the
     container is gone (`ssh contabo-dbot docker inspect smdb-oracle-<run>` fails once `--rm` has removed it), or end
     it with `ssh contabo-dbot docker stop smdb-oracle-<run>`. Then fetch the host file (`ssh contabo-dbot cat
     /root/smdb-oracle/<run>.host.jsonl > <run>.jsonl`) and judge that.

   - **When the scenario kills or cuts off a whole host,** do not run the writer on that host. Its tail would be lost and
     the run would only be inconclusive. Run it on the dev box instead, with its log in a file there (`--log
     <run>.jsonl`), through an ssh tunnel to each node's loopback port (`ssh -N -L <local>:127.0.0.1:<port> <host>`,
     flags before the host, so it needs the owner's approval once).
   - Mark a window: `ssh contabo-dbot "echo 'begin kill-master' >> /root/smdb-oracle/marks-<run>.txt"`, and the same
     with `end` afterwards. Pass `--window kill-master` to the checker so that a missing mark cannot pass.
   - Stop early: write every `end` mark first, then `ssh contabo-dbot docker stop smdb-oracle-<run>`. The writer reads
     the marks file once more and ends within its 5-second grace, inside docker stop's 10.
   - On the Windows node, run oracle.mjs directly with the dev box's node.
   - Lanes on two hosts need two writers: the same `--run`, distinct lane names, one log each. Name each writer's files
     with its own tag where `<run>` stands in a file name (`<run>-<w>.host.jsonl`, `<run>-<w>.jsonl`,
     `<run>-<w>.copy.jsonl`). Every later command (`sql`, `read`, `check`, `cleanup`) then gets one `--log` per writer
     log, copied to the host where it runs; given only some, `read` and `cleanup` miss the other writer's docs.
   - Piping into `node --input-type=module -` also works but leaves no file on the host: if its stream drops, no
     complete log exists and the run is repeated.
3. **Once the writer has ended, let held writes settle, then take the copies before any failback or re-seed wipes the
   evidence [A15].**
   - The writer must have ended first: the log to be judged ends with its end line. A copy taken while the writer still
     runs lacks the docs it acknowledges later, and the checker calls them LOST.
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
       fall between two reads. The checker compares the facts by node id, not file order or name, and counts only a
       CONTROL that both sets show; a node in one set only makes the run inconclusive. The facts are reduced to shard
       and guild facts, and URL credentials are redacted before they leave the host. `fleet` exits 1 when the node's
       bot child gave none.
4. **Judge:**

       node test/oracle/check.mjs --log <run>.jsonl --db primary=<p>.jsonl --lag standby=<s>.jsonl --app <node>-app.jsonl --fleet <node>-fleet-1.json --fleet-again <node>-fleet-2.json --window kill-master

   - Use `--db` for a copy that must hold everything acknowledged (the serving primary, and a sync standby).
   - Use `--lag` for an async standby.
   - Use `--agree` for copies that must match after the chain settles.
5. **The bite test, once, before trusting a baseline (VERIFY.md 5.5):** after a short clean run, `oracle.mjs bite --log
   <run>.jsonl` prints two SQL statements for the judged copy's database. Run them, dump the copy again, and check. The
   result must be FAIL, with exactly LOST and ROLLBACK on the named docs. Then run the 30-minute baseline.
6. **Clean up** once nothing more is to be judged, on a host that holds the log: the writer's own host with
   `<run>.host.jsonl`, or a host the log was copied to with `<run>.copy.jsonl` (the dev-box writer's case). It takes about
   as long as `read`:

       ssh contabo-dbot "docker run --rm --network host -v /root/smdb-oracle:/o node:24-alpine node /o/oracle.mjs cleanup --log /o/<run>.host.jsonl --target http://127.0.0.1:<master port>"

## Not yet covered

- **The module route** (`smdb cmd invoke --repeat`) [A18]. It needs a command that saves through module saveData; none
  ships in the repo.
- **What modules read.**
  - For a Postgres guild, the app read path (`GET /api/config/data/get`) is the web UI's own SQL read of the store the
    bot child reported. It is not the child's working set, which modules read through loadData, so stale data that a
    node serves to modules from memory goes unseen.
  - A read through the bot child exists only for file-routed guilds.
- **File mode** [A19]. The operator route cannot create a new file in a file-routed guild (it needs the file to exist
  already), and the database listing does not apply there. A file-mode reader comes before B2 deploys.
- **The control store's own rows.** `fleet` reads each node's in-memory view, not smdb_control.
- **Step 1 of VERIFY.md section 5,** the set difference on the existing kill-drill logs. It reads live hosts, so it
  belongs to the main session.

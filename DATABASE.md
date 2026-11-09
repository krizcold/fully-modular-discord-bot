# Database Backend (PostgreSQL)

The bot stores per-guild data either as JSON files under `/data` (the default) or in a central
PostgreSQL database. File mode is right for most single-server deployments: everything is
hand-editable and portable, and needs no extra service. Postgres mode suits large bots: the data
lives in one database that standard Postgres tools back up, replicate and restore.

## Choosing a backend

| | File (default) | PostgreSQL |
|---|---|---|
| Extra services | none | one Postgres database |
| Data location | this machine's `/data` | the database |
| Hand editing | JSON files on disk | web UI data browser |
| Blast radius when storage fails | this machine | every bot on that database (see below) |

Set it with two env entries in the credential lane (`/data/.env`, the Credentials tab in
standalone mode, or the manager's env editor for managed instances):

```
DATA_BACKEND=postgres
DATA_BACKEND_URL=postgresql://smdb:password@host:5432/smdb
```

`DATA_BACKEND_URL` takes one address or a comma-separated list of addresses of the same bot's databases (the main and
its live copies; see "Several database addresses"). User and password are percent-encoded, so a comma inside them
does not split the list.

Switching `DATA_BACKEND` never moves data by itself. A bot with guild data in files refuses to start
with `DATA_BACKEND=postgres`, whatever the database holds, and says so; set the value back to start it again. Booting against the
wrong database is refused too, never served silently.

## Several database addresses

The bot checks every address at boot and every 30 seconds while it runs (every 5 seconds while its database does not
answer). It uses the one database of this bot's store that accepts writes and holds the highest main generation (the
`smdb_manager.generation` row the Bot Manager keeps; a database without it counts as generation 0). A copy, a
read-only database and another bot's database are never used. A database that accepts writes with a lower generation
than another is a replaced main, and the bot ignores it. When two databases accept writes at the same generation, the
bot stops and says it can't confirm which is the main.

After its database did not answer, ended the bot's sessions, refused its login or sent a certificate the bot refused,
whether the bot saw that while saving or while checking on it, the bot saves nothing there until a check made after it
answered again shows it is still the main. The check runs every 5 seconds, and a stop or restart in that time waits up
to its 30 seconds for it. In that time, and after it stopped writing to a replaced database, the bot takes no change
sent from another machine's web panel (that panel says nothing was saved once the 5 seconds to take it pass, or can't
confirm when the bot had taken it), and it refuses a server's data delete or restore with nothing changed.

When the database it uses is replaced while it runs, the bot stops serving at once, writes nothing more there, and once
it can reach the new main it saves there every document of every guild it had loaded. Rows the new main holds for such
a guild that the bot no longer had (documents deleted, or a guild retired, on the old main after the copy's last
received change) go to the new main's graveyard, and the log names the batch; restore it like a retired guild within
the graveyard's keep time. Until then the bot does not restart, and its maintenance answer counts those guilds as not
saved. Lines appended on the old main after the copy's last received change are not restored, except those of a save
that was being committed when the bot saw the switch. A guild retire or restore that was being committed then answers
"can't confirm"; when such a retire did not reach the new main, the bot saves the guild's data there and logs that the
retire must be repeated. Repeat it, or the restore, once the bot runs on the new main.

Before it moves, the bot checks the new main as it checks a database at boot (the server's version, the encoding,
its role's privileges, the schema version and the relations of smdb_data) and that smdb_data.meta holds the store id
this machine records in /data/.backend.json. The check runs in one transaction that the bot rolls back, within 60
seconds, so it changes nothing there, and a move never provisions a database: one without smdb_data's tables is
refused. A refusal is logged once per reason as `[Database] Not moving to <address>: <reason>; this process keeps
its unsaved changes and stays stopped`, each difference on its own line. The bot checks again at its next pass,
about every 5 seconds, so a grant or a correction made on the new main lets it move without a restart; a restart
gives up the changes it holds.

Until a main is found, the bot waits with its data closed and does not connect to Discord, and the web UI's Shards
section says why. The web panel reads only the database the bot uses. An address whose host is an IP and whose
`sslmode` is `verify-full` has its certificate checked against that IP.

## The switch notice

When the Bot Manager makes another database the main, it asks the bot there to post one message to the bot's owner (the
Discord account that owns the bot, or the team's owner): a DM titled "Main database moved" naming the machine, the date
and the generation, which the bot pins. A bot whose database holds a main generation reads the pinned and the newest 100
messages of that conversation at boot, before it opens any data, and every minute while it runs (every few seconds after
a failed read, and at once when it reconnects to Discord after reads failed). A newer generation there that no database
it reaches holds means it cannot confirm its database is still the main: it stays stopped with "can't confirm" and the
announced machine and date. When it cannot read the conversation at boot, it waits, says "can't confirm", and DMs the
owner once; `DATA_NOTICE_CHECK=off` makes it start on the databases alone.

Only the bot's own messages count, and only in the DM. When the owner has chosen a channel for owner messages (WebUI.md),
the bot also posts a copy of the notice there, which no machine reads. The owner must share a server with the bot and
accept DMs from it: otherwise the notice is not posted, and a machine whose database was the main must be kept off in
the Bot Manager until it rejoins as a live copy.

## Moving data between backends

A migration moves the data from one backend to the other: `smdb data migrate --to postgres|file` on a bot without a
manager, the manager's Migrate control on a managed one. It runs on a stopped bot or one booted in maintenance mode,
and copies every guild document, append file and graveyard entry; data of no guild (global config, sessions) stays in
local files. It checks the copy by counts and checksums before it switches the bot, and keeps the source:

- after a move to Postgres the JSON files stay in `/data`, unserved; the graveyard list then shows only the
  database's entries, since it lists `/data/_graveyard` only while `/data/.backend.json` names files;
- after a move to JSON the database store is renamed to `smdb_superseded_<ms>` before the switch, so a bot still
  pointed at it fails its queries and refuses at its next boot.

Going back is a migration back, `--to file` after a move to Postgres and `--to postgres` after a move to JSON. After a
migration `/data/.backend.json` names it, and a bot whose `DATA_BACKEND` no longer matches that marker refuses to
start, so switching the setting back alone does not work.

The migration refuses, while it reads and before it writes anything, data that a module write would be refused for:
a file that is not UTF-8 text or holds U+0000, a key with a name the data layer refuses (a part ending in `.tmp`, a
Windows device name or reserved character, a part over 200 bytes, a key starting with `.graveyard.json`), and two keys
or folders that differ only in letter case. The refusal names the file or row. The web UI checks a guild write
against these rules before it takes its backup and changes nothing on disk while checking; the process that writes the
file (the bot process, or the web UI while no bot process runs) removes an empty folder in its way.

Before a move to JSON moves the copy in, every guild folder and every `/data/_graveyard` entry already in `/data` goes
to `/data/_superseded/<UTC time>-<job id>/` (a name such as `20261029T012345678Z-<job id>`; graveyard entries go under
its `_graveyard/`), whether or not the database holds that guild. In either direction an earlier run's `.migrate-*`
staging folder goes there too. A database store this deployment served before is renamed to
`smdb_superseded_<ms>` the same way when a migration copies into that database again, unless a bot process on another
machine holds a shard claim in it and was seen within its takeover delay; the refusal names the shard and the machine,
and a clean stop of the bot there releases the claim. A database that holds a store
this deployment never served or minted is refused, and the refusal says when that store holds no guild rows, so it can
be dropped.

"can't confirm which store holds the data", from a migration, a bundle or a boot, names the files and what is wrong
with each: `/data/.backend.json` (the marker) or `/data/.migration.json` (the journal of the last migration) cannot be
read or parsed or does not hold what it should, `/data/.stores.json` cannot be read, the marker is missing beside
the journal or `/data/.stores.json`, or the journal is missing beside `/data/.stores.json` or a marker that names a
migration. Nothing writes over these files while they are in that state. A file that cannot be read needs its owner or permissions fixed. A marker that is
missing or damaged is written again from the journal:

- when the journal's `result` is `done`, or its `stage` is `env`, the switch was made: `live` is the journal's `to`,
  `storeId` its `storeId` (null for files) and `migration` its `jobId`. For a move to Postgres:

      {"live": "postgres", "storeId": "<the journal's storeId>", "flippedAt": 0,
       "migration": "<the journal's jobId>"}

- otherwise the switch may not have been made, and the marker names the source: `{"live": "file", "storeId": null,
  "flippedAt": 0}` for a journal whose `to` is `postgres`, and `{"live": "postgres", "storeId": "<the journal's
  sourceStoreId>", "flippedAt": 0}` for one whose `to` is `file` (a journal without `sourceStoreId` ended at its first checks; take the id from
  `SELECT value FROM smdb_data.meta WHERE key = 'store_id'`, without its quotes). Then
  run the same migration again: it finishes the migration or starts it over, whichever the files and the database
  show.

A journal that is missing or damaged beside a marker that reads is written as a finished migration to the marker's
backend, with the marker's `migration` as its `jobId` (when the marker names none, choose an id of 8 to 40 letters,
digits and `-` and add it to the marker as `migration`):

    {"jobId": "<the marker's migration>", "to": "<the marker's live>", "stage": "env", "result": "done",
     "startedAt": 0, "storeId": "<the marker's storeId, or null>"}

The commands, their answers and what each message asks for are in the console and web UI pages.

## Shards on several machines

A database bot keeps one claim per shard in its database (`smdb_data.shard_claims`, one row per shard: the machine
holding it, a claim number and an expiry). Expiry is measured on a claim clock the database keeps
(`smdb_data.claim_clock`), which runs only while some machine of the bot reaches the database; after a time when none
did, every claim still live gets its whole takeover delay again, so a database restart or outage moves no shard. A
machine renews its claims every takeover delay / 6, at most every 5 seconds, and leaves Discord when it has not renewed
for two thirds of the delay (20 seconds at the default 30); another machine takes a shard only after its claim
expired; every save checks that the claim it carries is the one the table holds for that machine's process, so a
machine that was cut off and comes back cannot write over the new holder's data. A machine cut off from the database
while the others reach it loses the changes it had not saved for the shards another machine takes: what it accepted
in about two thirds of the takeover delay plus 5 seconds (25 seconds at the default 30), at most 5 minutes or 64 MiB
of changes; the log names each guild and the count.

FLEET_SHARD_CAPACITY is each machine's target (default 1; 0 for none): a machine takes shards up to its target first,
takes more only when no other machine has room (it logs a warning per shard), and gives such a shard to a machine
with room once that machine has been healthy for 5 minutes. So a bot on one machine serves every shard, and with the
defaults the shards spread one per machine. FLEET_TAKEOVER_SECONDS is the takeover delay (15 to 3600, default 30), and
FLEET_SHARD_RETURN (default true; false stops returns and moves). Machines read the shard count from the database:
changing FLEET_SHARD_COUNT on one machine reshards the bot (see Resharding).

A machine's set of shards is fixed while it runs: taking a shard, giving one away and losing one restart it, so its
own shards are offline for its restart, and it restarts for a take or a give-away only while its saves succeed. A
clean stop keeps its shards for its own next start, while a crash leaves them to any machine after the delay (a
machine that restarts after the crash gets them first). Returns: a shard goes back to the machine that first held it
once that machine has been healthy for 5 minutes and has room. A machine run without the web UI (`npm run dev:bot`)
takes shards only when it starts, since nothing can restart it for a new one, so the other machines neither count it
as room nor give it shards; when it would restart (after it could not renew, lost a shard, or after maintenance), it
saves what it can, releases its shards and stops, so the other machines take them after the takeover delay; started
again by hand, it takes back those still free. A JSON bot runs every shard in one process and takes no claims.

`smdb_data.guild_requests` holds the requests one machine's web panel sends to the machine that runs a server's shard:
data changes (see "Editing a server another machine runs" in the web UI docs, WebUI.md), and panel actions, console
invokes, the lists a panel needs and the fetch of a panel's new state (see "Panels and commands for a server another
machine runs" there). A row names the bot process the panel found holding the shard and is taken only by that process,
only within 5 seconds of its sending. A request's body is emptied when it is taken, or by the next cleanup when nobody
took it; an answered row is deleted about two minutes after its answer, and every row within an hour. A request of any
kind is sent and taken only on a connection that checks the database's certificate (sslmode=verify-full with
sslrootcert), or on a local one: a database on the same machine reached over loopback or a Unix socket, or a database
reached with TLS that does not check the certificate at an address on a network the machine is attached to directly (its
Docker network, or the LAN for a bot run outside Docker). On every other connection no request is sent or taken. The
channel `smdb_panel_changed` carries "panel P of server G changed" for the panels some web panel watches, and no panel
state. The operations of this table came with new schema versions, so a database made by an earlier version of the bot is
refused at boot.

## Resharding

The bot changes its shard count (reshards) in two cases. Changing FLEET_SHARD_COUNT on any one machine reshards the
whole bot to that count; the other machines need no edit, and machines whose value did not change follow the database.
With no FLEET_SHARD_COUNT set, the bot follows Discord's recommended count upward, and only beside the running shards
(below). Discord's recommendation never lowers the count; only a lower FLEET_SHARD_COUNT does. A machine new to the bot
that starts with a FLEET_SHARD_COUNT other than the bot's count reshards nothing: its log names the count the bot runs
and where that count was set. The attempt, its state and the last count set are in `smdb_data.reshard`; the Usage tab's Capacity card shows
them.

A reshard runs in one of two ways:

- Beside the running shards. Each machine starts a second bot process that connects its share of the new shards while
  the old shards go on serving. Once every new shard is connected, the bot switches: the old shards save everything
  they hold and release their claims, and the new shards read no server before that. Each machine's second bot
  process then becomes its bot process. This needs about twice the memory for some minutes, so it runs only when
  FLEET_RESHARD_OVERLAP is true on every running machine and each machine's manager reports room in memory (the
  manager's reading reaches the bot through the web UI's `memory` hook). A reshard whose new shards are not all
  connected in time is called off, and the bot keeps its shard count.
- By stopping and starting. Every machine stops its shards, saving what they hold, and starts again under the new
  count. Members see the bot offline until the machines have started again, as at a restart, with no maintenance
  message. The bot reshards this way for a FLEET_SHARD_COUNT change when it cannot reshard beside the running shards;
  for Discord's recommendation it does not, and the Usage tab says why and how to reshard by hand.

What members notice beside the running shards: a few events are missed or handled twice at the switch. A slash command
is answered once, since Discord accepts one answer per command.

A change of FLEET_SHARD_COUNT while a reshard runs calls it off and starts one toward the new value; once the bot has
switched to the new shards, the new value waits until that reshard is done. A machine that runs the bot without the
web UI stops when the bot reshards by stopping and starting, and stays stopped until it is started by hand.

On a bot with a database, a reshard beside the running shards can be called off when a machine drops out before the
bot switches to its new shards: its bot process crashes or is killed (by the out-of-memory killer, for example), the
machine loses power, it cannot reach the database for longer than its takeover delay, or a Stop or Restart takes more
than 40 seconds. The call-off comes once another machine sees that machine's shards expire, or once the web UI on that
machine saw its bot process end while the second bot process ran. Otherwise, and always on a bot with one machine, the
reshard goes on after the restart, and a drop-out in the last seconds before the switch can let the switch go ahead.
When a killed bot process is not started again, the call-off comes once another machine sees its shards expire, or
once someone starts it. A machine that drops out after the switch calls nothing off: the reshard finishes once that
machine's old shards expire. When the database switches to its copy and the copy lost the moment the bot switched to
its new shards, the reshard is called off unless the bot can switch again on the copy before the old shards' claims
expire. Each such call-off counts as one of the two tries beside the running shards. A bot process that stops because
another process took its data files (exit code 75) releases its shards as it stops and does not count, unless that
release fails.

After a call-off the next try comes after 15 minutes. After two counted tries toward one count, a bot with
FLEET_SHARD_COUNT set reshards by stopping and starting every machine; without it, the bot does not reshard toward that
count until Discord's recommendation moves to another count, someone sets FLEET_SHARD_COUNT, or a reshard finishes, and
the log and the Usage tab give the reason with the hint to set FLEET_SHARD_COUNT.

Discord allows a bot a number of gateway logins per day, and a reshard waits until enough remain for its new shards and
one more full start. Every machine and bot process spaces its shards' logins through the database
(`smdb_data.identify_slots`): one login per Discord rate limit bucket every 5.5 seconds across the whole bot.

A JSON bot reshards only beside its shards and only on Discord's recommendation: a second bot process connects the new
shards and the bot switches once all are connected. Its FLEET_SHARD_COUNT takes effect at its next restart.

## Local development (Windows first-class)

Any reachable Postgres works:

```
docker run -d --name smdb-pg -p 5432:5432 -e POSTGRES_USER=smdb -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=smdb postgres:16-alpine
```

then `DATA_BACKEND=postgres` and `DATA_BACKEND_URL=postgresql://smdb:dev@localhost:5432/smdb`.
A wrong or absent database shows as a visible "waiting on data backend" status, not a stack trace.
The database provisions its own schema on first contact, in one transaction; there is nothing to create by hand.
The server must be PostgreSQL 13 or later, and the database's encoding UTF8; at boot the bot refuses an older server
(naming its version) and any other server_encoding, before it reads smdb_data.
Bot processes that boot at the same time run this check one after another, under a bootstrap lock that a data
migration to Postgres also holds while it copies; a process that waits for that lock logs that it is waiting.
At every boot the bot compares the relations of smdb_data with the ones it makes: each relation's kind, whether it
is logged or UNLOGGED, its table access method, partition keys and bounds, inheritance parents, row level security
(enabled and forced) and policies; the columns (type, NOT NULL, default, identity, generated expression, collation,
storage); constraints; indexes and whether each is valid; the sequences' increment, minimum, maximum, cache and
cycle; triggers and rules. It refuses a database whose smdb_data differs in any of these, naming each difference.
A store that a migration to Postgres made is checked the same way at the bot's first boot on it. Do not add tables,
indexes, triggers or columns to smdb_data. Some changes are not checked and still break the bot later, at the
statement they affect: a publication whose row filter uses a column outside a table's replica identity makes
updates and deletes on that table fail (the graveyard's sweep among them), and the rows of a table in another
schema that inherits from one of smdb_data's tables join its reads.
It also refuses a smdb_data that holds tables or other relations but no schema version, since it can't confirm
what made them or that they are complete; point the bot at another database or rename that schema aside. It
refuses a smdb_data whose version table, smdb_data.meta, it can't read (a changed column type, row level security,
a dropped primary key); correct meta to the shape the log gives, and do not rename the schema aside, since its
tables hold this bot's data and the next boot would make and serve a new, empty store beside them. A database
provisioned by another schema version of the bot is refused the same way. A store of this version and shape whose
smdb_data.meta has no store_id row gets a new one, unless the machine's /data/.backend.json records a store id: then
it is refused, since the bot can't confirm that this database holds that store, and the log prints the statement that
adds the recorded id (`INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', '"<id>"')`) for the case that this
is the database the deployment was set up with; otherwise point the bot at the deployment's database. When
/data/.backend.json exists but can't be read or parsed, the bot writes no store id and refuses nothing: the boot
logs that the marker could not be read and tries again. While the bot runs it reads the same file to tell its own
databases from another bot's. When the file can't be read or parsed, it chooses no database and moves to none,
saying it can't confirm which store this machine records, and after its database stopped answering it saves nothing
there until it can read the file again.
When the server rejects a statement that builds the copy of the schema the bot compares with, the boot is refused,
naming the server's SQLSTATE and message, and smdb_data is not changed; a privilege error gives the GRANT to run.
A lost connection, a cancelled statement, a lack of resources or an error with no SQLSTATE is retried instead.
The bot's database role needs CREATE on the database (at every boot the bot builds a copy of its schema to compare
with, and rolls it back), USAGE on smdb_data (and CREATE on it when smdb_data was made beforehand and is still
empty), SELECT, INSERT, UPDATE and DELETE on its tables, and USAGE and UPDATE on its sequences. A role that lacks
any of them is refused with each one named; grant them as the owner of smdb_data (for the schema) and of its tables
and sequences (for the others), or as a superuser (`GRANT USAGE ON SCHEMA smdb_data TO <role>`;
`GRANT CREATE ON SCHEMA smdb_data TO <role>`, for an empty schema made beforehand;
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO <role>`;
`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA smdb_data TO <role>`; `GRANT CREATE ON DATABASE <db> TO <role>`,
the last as the database's owner), or connect as the login that owns smdb_data and its tables, and never rename the
schema aside for this. On a new database the bot also refuses, and rolls back, a schema it made on which default
privileges (ALTER DEFAULT PRIVILEGES) leave its role without one of these, or that an event trigger or rule changed
(the schema_version row it wrote can't be read back, or the schema differs from its own).
In each case the bot stays online with its data layer refused, members are told the data storage is unavailable, no
guild data is saved or restored, nothing in that database is changed, and the log names what it found. A table or
partition the log names as missing may have held data that is not in that database: restore a backup rather than
creating it empty.
The graveyard sweep deletes retired guild data after `GRAVEYARD_TTL_DAYS` (14 by default); it keeps
each guild's ownership row, which stops an older bot process from writing over a newer one.
A restore copies the chosen batch into the live tables in one transaction, fenced by its claim like any save, and
keeps the batch; a plain restore runs only while the server has no data in the database, and a replace first moves the
server's rows into a new batch in the same transaction. Every new batch is named by the later of the database's clock
and the server's newest batch plus 1, and the sweep reads the same clock. A restore stamps the batch's `used_at`, and
the sweep removes a batch only when both `retired_at` and `used_at` are past the keep time; a restore and the sweep
exclude each other by an advisory lock, and a sweep that finds a restore running skips that run. On JSON a restore
records `usedAt` in the entry's note, copies the entry to a hidden folder, syncs it, and renames it into place; a
replace renames the live folder into the graveyard in between and puts it back if the copy cannot be put in place, and
a boot after a crash in between finishes the replace. The file sweep renames an expired entry to `.sweep-<name>` before
it removes it, removes leftover `.sweep-` folders at each run, and keeps an entry whose note it cannot read and logs
`Graveyard entry <name> kept`.
Each save also writes its own id on the guild's ownership row. When the answer to a save is lost (the connection
drops after the commit was sent, or no answer comes within 40 seconds), the bot reads that row, after any unfinished
save of the guild has ended, to learn whether the save was stored before it sends anything again, so no appended line
is stored twice.

## Availability: read this before you rely on it

1. **The central database is the availability floor.** When it is down, every guild's data plane
   degrades at once. Unsaved changes keep waiting through an outage of the database as long as it
   lasts (write acceptance closes after 300 seconds of unsaved changes or 64 MiB, whichever trips
   first; the window covers the whole bot, not one guild), but the bot leaves Discord when it has
   not renewed its shard claims for two thirds of the takeover delay (20 seconds at the default),
   and restarts once the database answers and its changes are saved. A hard crash loses the
   writes accepted and not yet stored: with the database healthy, a write reaches it at most 5
   seconds after it was accepted plus the time of two flush transactions; during an outage, every
   write accepted since the outage began.
2. **The managed sidecar shares its host's fate.** The manager-provisioned Postgres runs on the
   same server as the bot; your recovery point is the last nightly dump unless you snapshot the
   volume yourself. It is never published on a host port.
3. **Large bots should bring their own database.** A managed or replicated Postgres with
   point-in-time recovery (streaming replica + WAL archiving) is the real answer at scale. The
   manager never dumps external databases; their backup story belongs to their platform.
4. **Storage speed matters.** The write pattern is many small transactional flushes; NVMe-class
   storage is strongly recommended. Rough sizing: 30-80 GB at 100k guilds, 200-500 GB at 1M.
5. **Encryption reality.** Dumps and the database are not encrypted at the application layer, on
   purpose: the same disk already holds the live database volume, the manager's credential store,
   and `/data/.env` with the bot token, so an attacker with disk or root access has everything
   regardless, and any encryption key would live on that same disk. What actually protects you:
   the sidecar is never exposed on a host port; use `sslmode=require` in the URL for any remote or
   cross-host database; and if you want at-rest protection, use full-disk encryption on the host.
6. **Database HA is postgres-native.** Neither the bot nor the manager replicates the database:
   high availability of the data layer comes from the database world itself (a managed Postgres,
   or streaming replication). List the main and its copies in `DATA_BACKEND_URL` (see "Several
   database addresses"): that list is how the bot finds the main after a failover. The bot keeps
   its unsaved changes while the main fails over and leaves Discord if its claims cannot be renewed in time, a promoted replica keeps the store identity
   and is reattached to normally, and a wrong or empty database is refused outright instead of
   served. The sidecar tier's recovery point is the nightly `pg_dump`.

## Backups

- Managed sidecar: the manager takes a nightly `pg_dump` (default 04:00, keeping 7) and shows a
  warning when dumps go stale. Restoring rewinds every guild on that database at once; a fresh
  safety dump is taken automatically before any restore.
- External database: use your platform's backup and PITR tooling.
- File mode: the `/data` directory is the backup unit, as before.
- After a move to Postgres the old copy is the guild folders and `/data/_graveyard` left in `/data`; after a move to
  JSON it is the `smdb_superseded_*` schema, and the folders the move set aside are in `/data/_superseded/`; a store
  that a move to Postgres renamed aside is also a `smdb_superseded_*` schema. Nothing removes any of these on its own.

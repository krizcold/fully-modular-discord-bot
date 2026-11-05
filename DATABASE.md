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

Switching `DATA_BACKEND` never moves data by itself. A bot with guild data in files refuses to start
with `DATA_BACKEND=postgres`, whatever the database holds, and says so; set the value back to start it again. Booting against the
wrong database is refused too, never served silently.

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
FLEET_SHARD_RETURN (default true; false stops returns and moves). Machines read the shard count from the database: a
changed FLEET_SHARD_COUNT takes effect when every machine has stopped and one starts again.

A machine's set of shards is fixed while it runs: taking a shard, giving one away and losing one restart it, so its
own shards are offline for its restart, and it restarts for a take or a give-away only while its saves succeed. A
clean stop keeps its shards for its own next start, while a crash leaves them to any machine after the delay (a
machine that restarts after the crash gets them first). Returns: a shard goes back to the machine that first held it
once that machine has been healthy for 5 minutes and has room. A machine run without the web UI (`npm run dev:bot`)
takes shards only when it starts, since nothing can restart it for a new one, so the other machines neither count it
as room nor give it shards; when it would restart (after it could not renew, lost a shard, or after maintenance), it
saves what it can, releases its shards and stops, so the other machines take them after the takeover delay; started
again by hand, it takes back those still free. A JSON bot runs every shard in one process and takes no claims.

## Local development (Windows first-class)

Any reachable Postgres works:

```
docker run -d --name smdb-pg -p 5432:5432 -e POSTGRES_USER=smdb -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=smdb postgres:16-alpine
```

then `DATA_BACKEND=postgres` and `DATA_BACKEND_URL=postgresql://smdb:dev@localhost:5432/smdb`.
A wrong or absent database shows as a visible "waiting on data backend" status, not a stack trace.
The database provisions its own schema on first contact; there is nothing to create by hand.
A database provisioned by another schema version of the bot is refused the way a wrong database is:
the bot stays online with its data layer refused, members are told the data storage is unavailable,
no guild data is saved or restored, nothing is created in that database, and the log names the
version it found. Point `DATA_BACKEND_URL` at a database of this version to serve again.
The graveyard sweep deletes retired guild data after `GRAVEYARD_TTL_DAYS` (14 by default); it keeps
each guild's ownership row, which stops an older bot process from writing over a newer one.
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
   or streaming replication behind one stable URL). The bot keeps its unsaved changes while the
   URL fails over and leaves Discord if its claims cannot be renewed in time, a promoted replica keeps the store identity
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

# Database Backend (PostgreSQL)

The bot stores per-guild data either as JSON files under `/data` (the default) or in a central
PostgreSQL database. File mode is right for most single-server deployments: everything is
hand-editable, portable, and needs no extra service. Postgres mode is built for multi-machine
fleets and large bots: workers become stateless, a guild's data follows its shard wherever it is
placed, and failover is a lease re-grant instead of a disk migration.

## Choosing a backend

| | File (default) | PostgreSQL |
|---|---|---|
| Extra services | none | one Postgres database |
| Data location | this machine's `/data` | the database |
| Multi-machine fleet | data is stuck on each node | any worker can serve any guild |
| Hand editing | JSON files on disk | web UI data browser |
| Blast radius when storage fails | one node | the whole fleet (see below) |

Set it with two env entries in the credential lane (`/data/.env`, the Credentials tab in
standalone mode, or the manager's env editor for managed instances):

```
DATA_BACKEND=postgres
DATA_BACKEND_URL=postgresql://smdb:password@host:5432/smdb
```

Switching `DATA_BACKEND` never moves data by itself. The bot recognizes where the data actually
lives, keeps serving from there, and shows a banner until you run the backend transformation
(Fleet tab) or set the value back. Booting against the wrong or empty database is refused, never
served silently.

## Local development (Windows first-class)

Any reachable Postgres works:

```
docker run -d --name smdb-pg -p 5432:5432 -e POSTGRES_USER=smdb -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=smdb postgres:16-alpine
```

then `DATA_BACKEND=postgres` and `DATA_BACKEND_URL=postgresql://smdb:dev@localhost:5432/smdb`.
A wrong or absent database shows as a visible "waiting on data backend" status, not a stack trace.
The database provisions its own schema on first contact; there is nothing to create by hand.

## Availability: read this before you rely on it

1. **The central database is the availability floor.** When it is down, every guild's data plane
   degrades at once: the bot keeps running, accepts writes for a bounded window (about 5 minutes
   or 64 MiB per guild), then refuses writes with a clear user-facing message until the database
   returns. File mode has a per-node blast radius instead; postgres trades that for stateless
   workers and seconds-fast failover.
2. **The managed sidecar shares its host's fate.** The manager-provisioned Postgres runs on the
   same server as the master; your recovery point is the last nightly dump unless you snapshot the
   volume yourself. Cross-host workers reach it only if you expose it deliberately; by default it
   is never published on a host port.
3. **Serious fleets should bring their own database.** A managed or replicated Postgres with
   point-in-time recovery (streaming replica + WAL archiving) is the real answer at scale. The
   manager never dumps external databases; their backup story belongs to their platform.
4. **Storage speed matters.** The write pattern is many small transactional flushes; NVMe-class
   storage is strongly recommended. Rough sizing: 30-80 GB at 100k guilds, 200-500 GB at 1M.
5. **One trust domain.** Every node in a fleet shares one database credential, handed to workers
   over the authenticated control channel. There are no per-node database roles; anyone with the
   control secret or the master's disk effectively has the database.
6. **Encryption reality.** Dumps and the database are not encrypted at the application layer, on
   purpose: the same disk already holds the live database volume, the manager's credential store,
   and `/data/.env` with the bot token, so an attacker with disk or root access has everything
   regardless, and any encryption key would live on that same disk. What actually protects you:
   the sidecar is never exposed on a host port; use `sslmode=require` in the URL for any remote or
   cross-host database; the in-fleet credential handover requires the control secret (use `wss://`
   across untrusted networks); and if you want at-rest protection, use full-disk encryption on the
   host, where it belongs.

## Switching an existing deployment

Upgrade first, swap second: never combine an app upgrade and a backend swap in one restart wave.

- **File to postgres:** provision the database (managed sidecar or your own), restart the master
  with `DATA_BACKEND=postgres`. The fleet keeps serving from files and shows the
  transformation-required banner; workers pick the database up automatically on re-register (no
  worker restarts). Then start the backend transformation from the Fleet tab and let it convert,
  verify, and flip guild by guild.
- **Postgres to file:** the same in reverse; the fleet keeps serving from the database until the
  reverse transformation exports each guild to its owning node's disk.

## Backups

- Managed sidecar: the manager takes a nightly `pg_dump` (default 04:00, keeping 7) and shows a
  warning when dumps go stale. Restoring rewinds every guild on that database at once; a fresh
  safety dump is taken automatically before any restore.
- External database: use your platform's backup and PITR tooling.
- File mode: the `/data` directory is the backup unit, as before.

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
   or 64 MiB of buffered writes per node, whichever trips first; the window is node-wide, not
   per guild), then refuses writes with a clear user-facing message until the database
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
7. **Database HA is postgres-native, and the manager will provision it.** Today neither the bot
   nor the manager replicates the database: high availability of the data layer comes from the
   database world itself (a managed Postgres, or streaming replication behind one stable URL).
   The fleet is already built to ride a database failover: nodes coast on the bounded
   write-acceptance window while the URL fails over, a promoted replica keeps the store
   identity and is reattached to normally, and a wrong or empty database is refused outright
   instead of served. The planned replication arc makes the manager provision that standard
   setup itself: a streaming replica on the backup master's machine, promoted together with the
   backup master, so host-death coverage stops requiring hand-configured infrastructure. The
   sidecar tier's honest recovery point stays the nightly `pg_dump` until then.

## High availability: the warm standby master

Master-role failure is handled by a designated backup master. This is a postgres-mode feature:
file mode intentionally has no standby, because a standby cannot serve a dead node's local disk
(transform to postgres first).

**The one rule that decides what the standby can save you from: a takeover needs the database
to have survived whatever killed the master.** The backup master holds no copy of the data; it
holds a connection to the same central database as everyone else. So it covers the master
process or container crashing, planned rolling handovers, and the master's whole MACHINE dying
IF the database lives somewhere else (an external URL). It cannot cover the machine dying when
the database is the managed sidecar on that same machine: the backup would be a healthy bot
pointing at a dead address, so both promotion paths refuse by design (a promoted master without
a database would park at boot and serve nothing). If host death is in your threat model, put
the database on a host that outlives the master, or wait for the manager-provisioned replica
(planned; see item 7 above).

Two Discord facts shape the design. One token allows exactly ONE gateway session per shard, so a
backup can never sit connected to the master's shards "just in case"; and all fleet nodes read
the same central database, so there is nothing to copy when taking over. The only step physics
forces on a takeover is re-identifying the dead master's shards, which takes seconds and is
metered by the identify budget.

**Setup.** Pick one worker node and give it `BOT_NODE_ROLE=backup-master` (a designated
co-worker: it serves shards like any worker; any capacity works, and `FLEET_SHARD_CAPACITY=0`
makes a pure standby that serves nothing). Give EVERY fleet node `MASTER_URLS`: an ordered,
comma-separated list of every master-capable control URL, the normal master first, the backup
second. Workers cycle through the list on reconnect, so a failover needs no reconfiguration
anywhere. Set `BOT_NODE_ROLE` explicitly on every node that carries `MASTER_URLS` (`master`,
`co-worker`, or `backup-master`): the candidate list itself never changes a node's role, and
the bot logs a warning when it finds the list without an explicit role.

**Unplanned failover (master died).** Open the backup's web UI, Usage tab, Fleet section, and
press "Promote to master". One click does the whole thing: the node restarts as master, takes
the term, waits out the safety hold-down, declares the dead master lost, and takes over its
shards. Workers redial down their candidate list and reattach at zero identify cost.

**Automatic failover.** Set `FLEET_AUTO_PROMOTE=1` on the designated backup and it pulls the
same lever itself when the master's liveness stamp goes silent for about two minutes AND its
control connection to the master is down. Both signals must agree, so a master that merely lost
the database (and is riding the acceptance window) is never shot. Default off: without the flag
the backup is exactly a warm manual backup and nothing else.

**Planned handover (rolling upgrades: standby first, master last).** Promote the backup while
the old master is still alive; the confirm dialog recognizes this case. The old master is
deposed within seconds (its next stamp fences it) and KEEPS its shards; then press "Demote to
co-worker" on the old master's own UI and it rejoins the fleet and re-identifies its own shards
(the demote restart ended their sessions, so this identify cost is physics, not overhead). A
full handover costs identifies for the two restarted nodes' own shards; every other worker
reattaches for free.

**The old master comes back later.** Safe by construction: a booting master that sees another
master's liveness stamp still advancing idles with a banner instead of stealing the fleet back
(the takeover guard). Demote it from its UI whenever convenient.

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

# dbopt-engine

Self-optimizing database engine for **PostgreSQL**, **MySQL 8** and
**Microsoft SQL Server** — the Node.js edition. One process can watch a
single database or several at once (mixed engines are fine).

It watches the queries your application actually runs, finds the ones wasting
time on full table scans, **verifies** that an index would genuinely help
*before* creating anything (HypoPG hypothetical indexes on Postgres,
INVISIBLE-index trials on MySQL, trial builds on SQL Server), then acts on its
own: it creates the winning indexes and can drop unused ones. Every action is
recorded with rollback SQL. Ships with a live dashboard and an interactive
schema-topology explorer with animated query flow.

## Quick start

```bash
npm install -g dbopt-engine     # installs the `dbopt` command
```

Create a `.env` file in the directory you'll run it from, defining **all** of
the variables below (copy `.env.example` from the package as a template):

```bash
# one database — or several, comma-separated (see "Multiple databases")
DATABASE_URL=mysql://user:password@host:3306/mydb
PORT=1305
SCAN_INTERVAL_MINUTES=15
MIN_ROWS_FOR_SEQ_SCAN_FLAG=1000
MIN_IMPROVEMENT_PCT_TO_RECOMMEND=30
AUTO_CREATE_INDEXES=true
AUTO_DROP_UNUSED_INDEXES=false
INDEX_NAME_PREFIX=opt
UNUSED_INDEX_GRACE_MINUTES=60
REAPPLY_COOLDOWN_MINUTES=60
STORAGE_LIMIT_MB=0
STATE_DB_PATH=optimizer_state.db
```

Then start it:

```bash
dbopt
# dashboard: http://localhost:1305/dashboard
# topology:  http://localhost:1305/topology
```

Or per-project:

```bash
npm install dbopt-engine
cp node_modules/dbopt-engine/.env.example .env   # then edit DATABASE_URL etc.
npx dbopt-engine
```

If any variable is missing, startup fails with a list of what's not set.

## Embed in your backend (share its port)

Instead of running dbopt as a separate process on its own port, you can mount
it inside an existing Express app — the same way `swagger-ui-express` serves
docs on your API's port:

```js
const express = require("express");
const dbopt = require("dbopt-engine");

const app = express();
// ... your own routes ...

await dbopt.attach(app);                        // mounts under /dbopt
// or: await dbopt.attach(app, { prefix: "/optimizer" });

app.listen(4000);
// dashboard: http://localhost:4000/dbopt/dashboard
// topology:  http://localhost:4000/dbopt/topology
```

`attach()` mounts all routes and dashboards under the prefix, connects to the
configured targets, and starts the analysis scheduler. Configuration still
comes from environment variables / `.env` (`PORT` is ignored in this mode —
the host app owns the port). For finer control, `createApp()` returns the bare
Express app without starting the engine, and `startEngine()` starts the
scheduler on its own.

## Connection strings

The scheme picks the engine; the port is optional (engine default is used):

```
postgres://user:password@host:5432/mydb
mysql://user:password@host:3306/mydb
sqlserver://user:password@host:1433/mydb
sqlserver://host:1433;database=mydb;user=sa;password=secret   (ADO style works too)
```

URL-encode special password characters: `!`→`%21` `@`→`%40` `%`→`%25` `#`→`%23` `,`→`%2C`.

## Multiple databases

Put several comma-separated URLs in `DATABASE_URL` and one process watches
them all — each gets its own analysis cycle, recommendations, and history:

```
DATABASE_URL=postgres://user:pass@host1:5432/appdb,mysql://user:pass@host2:3306/shopdb
```

Both web pages grow a database selector in the header, and every API
endpoint accepts `?db=<name>` to pick the database (without it, the first
one is used). `GET /targets` lists the configured databases and their
names — normally just the database name, disambiguated with `@host` when
two targets share it.

## Options

All variables are **required**; set them in your `.env` (a CLI flag can
override the ones that have one — flags win).

| Flag | Env var | Suggested value | Meaning |
|---|---|---|---|
| `--database-url` | `DATABASE_URL` | — | one or more comma-separated connection strings |
| `--port` | `PORT` | 1305 | HTTP port for dashboard/API |
| `--scan-interval` | `SCAN_INTERVAL_MINUTES` | 15 | minutes between analysis cycles |
| `--auto-create` | `AUTO_CREATE_INDEXES` | true | create verified indexes automatically |
| `--auto-drop` | `AUTO_DROP_UNUSED_INDEXES` | false | drop unused indexes automatically |
| `--min-improvement` | `MIN_IMPROVEMENT_PCT_TO_RECOMMEND` | 30 | required planner-cost drop (%) |
| `--storage-limit-mb` | `STORAGE_LIMIT_MB` | 0 (off) | capacity for out-of-storage alerts |
| `--state-db` | `STATE_DB_PATH` | optimizer_state.db | SQLite action-history file |
| | `MIN_ROWS_FOR_SEQ_SCAN_FLAG` | 1000 | ignore full scans smaller than this |
| | `INDEX_NAME_PREFIX` | opt | its indexes are named `opt_idx_…` |
| | `UNUSED_INDEX_GRACE_MINUTES` | 60 | own new indexes can't be "unused" yet |
| | `REAPPLY_COOLDOWN_MINUTES` | 60 | never repeat the same action within this |

A `.env` file in the working directory is loaded automatically.

## How the cycle works

Every scan interval (and once at startup): **collect** slow queries from the
engine's own statistics (`pg_stat_statements` / `performance_schema` /
`sys.dm_exec_query_stats`) → **analyze** plans for large full scans and
extract the filtered columns (composite `a AND b` supported; partial-index
predicates on Postgres) → **verify** with a trial index against the exact
slow query → **execute** only wins above the improvement bar, using
non-blocking DDL (`CONCURRENTLY` / online DDL), recording rollback SQL.

Safety: indexes it creates live in the `opt_` namespace so they never
collide with ORM/migration-managed names; primary keys, unique constraints,
(MySQL) FK-required and FULLTEXT indexes are never drop candidates; grace and
cooldown windows prevent create/delete loops; one state file serves any
number of targets with rows scoped per database.

## HTTP API

`/targets` (the configured databases), `/health`, `/queries/slow`,
`/tables/unused-indexes`, `/tables/growth`,
`/recommendations` (list · `POST /:id/apply` · `POST /:id/rollback` ·
`/:id/reject`…), `/analytics/*` (overview, config, actions, wasted-storage),
`/topology/schema`, `/topology/table/:name`, `POST /topology/analyze-query`,
`/topology/alerts` — same API surface as the Python edition, so the bundled
dashboard and topology pages work identically. Every endpoint accepts
`?db=<name>` to pick one of the configured databases (default: the first).

## Notes

- Node.js ≥ 18 (better-sqlite3 native module installs prebuilt on common
  platforms).
- Oracle and MongoDB are available in the Python edition; they're not in
  this package yet.
- Server prerequisites are checked at startup and reported via `/health`
  and the dashboard banner (e.g. `shared_preload_libraries` on Postgres,
  `GRANT VIEW SERVER STATE` on SQL Server). MySQL needs nothing.

---
name: dbless
description: Set up and use dbless to give every git worktree its own isolated Postgres database with the same DATABASE_URL. Use when integrating dbless into a project, running parallel AI agents on the same repo, configuring per-worktree databases, working with `git worktree` flows, simulating destructive migrations safely, troubleshooting "two agents stepped on each other's data", "prisma migrate reset wiped my work", or "I want to test schema changes without polluting other branches".
---

# DBLess

Per-worktree Postgres isolation for parallel AI coding agents. Same `DATABASE_URL` in every worktree, different physical database underneath.

## Why dbless

- **Agents step on each other's data**: agent A runs `prisma migrate reset --force` and wipes agent B's seed data
- **Schema changes leak across branches**: a half-written `ALTER TABLE` on one feature branch breaks tests on another
- **Cloud branching is too slow for local iteration**: Neon, Tiger, Supabase branching all need a network roundtrip and an account
- **Schema-per-branch leaks**: extensions like `pg_cron`, `postgis`, and `pgvector` install per-database, so `search_path` tricks do not isolate them
- **Spinning up a new database is too slow**: `pg_dump` plus restore on a 1 GB schema takes minutes; agents abandon the worktree before it finishes
- **`git worktree add` is half a story**: the working tree is isolated, but every worktree still points at `postgres://localhost/myapp`
- **Reproducibility is destructive**: running tests in parallel without isolated databases means every flaky test is now a global flake

## Installation

```bash
npx skills add srizzon/dbless
```

This installs the skill into your project's `.claude/skills/dbless/` (or `~/.claude/skills/dbless/` with `-g`) and any other agent the `skills` CLI supports.

For the runtime itself, install the CLI from this repo:

```bash
git clone https://github.com/srizzon/dbless
cd dbless
npm install
npm link
```

## Quick Start

```bash
# 1. Start the daemon (Postgres 18 embedded + protocol proxy)
dbless start

# 2. From the main repo, build the template database
cd ~/code/myapp
dbless init --name myapp --migrations 'migrations/*.sql' --seed 'seed.sql'

# 3. Add a worktree and run the dev server through dbless
git worktree add ../myapp-feat-auth -b feat-auth
cd ../myapp-feat-auth
dbless run -- npm run dev
# → DATABASE_URL=postgres://dbless:dbless@localhost:7777/myapp?options=-c+dbless.worktree=feat_auth
# → database myapp__feat_auth created from template in ~75ms
```

The agent does nothing special. It reads `DATABASE_URL` from the env. dbless handles the rest.

## Integration Patterns

### Composing with portless

`dbless run` and `portless run` compose naturally because both detect the same `git worktree` independently:

```bash
dbless run -- portless run -- node server.js
```

- `dbless run` injects `DATABASE_URL` for this worktree
- `portless run` injects `PORT` and `PORTLESS_URL` for this worktree
- The app reads both env vars

Each agent gets a stable URL **and** a stable database derived from one `git rev-parse`. No coordination needed.

### Same DATABASE_URL across worktrees

The connection string is **identical** in every worktree. The routing happens via a custom Postgres GUC parameter:

```
postgres://dbless:dbless@localhost:7777/myapp?options=-c+dbless.worktree=<id>
```

The `<id>` is derived from `git rev-parse --abbrev-ref HEAD`. Drivers that pass `options` through (libpq, node-postgres, postgres.js, psycopg, sqlx, pgx, JDBC, Npgsql, Prisma via driver adapter) route correctly. The agent never has to reason about which database it is on.

### Auto-creation on first connect

When a new worktree connects for the first time and `myapp__<id>` does not yet exist, the proxy clones it from `template_myapp` before forwarding the StartupMessage. The clone uses `CREATE DATABASE TEMPLATE` with `file_copy_method=clone`, which in turn uses APFS clonefile on macOS or reflinks on Linux. Sub-second for any schema size up to tens of GB.

### Resetting after a destructive op

```bash
dbless reset
```

Drops the current worktree's database and re-clones from the template. Other worktrees are untouched. This is the safe, fast equivalent of `prisma migrate reset --force` — but it only affects this branch.

### Multiple agents in parallel

Three agents on three feature branches:

```bash
# Terminal 1
cd ../myapp-feat-streaks   && dbless run -- npm run dev   # port 3001

# Terminal 2
cd ../myapp-feat-rank      && dbless run -- npm run dev   # port 3002

# Terminal 3
cd ../myapp-feat-add-dev   && dbless run -- npm run dev   # port 3003
```

Each one writes to a different physical database. A `DROP TABLE` in one worktree leaves the other two untouched.

### Inspecting state

```bash
dbless status
# dbless · 0.1.0
#
#   daemon     ✓ running
#   postgres   :15432
#   proxy      :7777
#   project    myapp
#   template   ✓ template_myapp
#
#   ┌──────────────┬───────────────────┬────────┐
#   │ worktree     │ database          │ size   │
#   ├──────────────┼───────────────────┼────────┤
#   │ feat_streaks │ myapp__feat_str.. │ 7.9 MB │
#   │ feat_rank    │ myapp__feat_rank  │ 7.7 MB │
#   └──────────────┴───────────────────┴────────┘
```

### Reading the worktree context from inside an agent

```bash
dbless explain
```

Prints agent-readable Markdown describing project, worktree, database, and the safety contract. Read this when an agent needs to know what is and is not safe to do.

### Project AGENTS.md

`dbless init` writes (or refreshes) a `## dbless` block in the project's `AGENTS.md`, marked off with `<!-- dbless:begin -->` / `<!-- dbless:end -->` so re-running is idempotent. The block tells any agent opening the repo:

- the connection string is identical in every worktree
- destructive ops are scoped to the current worktree's database
- which underlying ports are the proxy vs the cluster

Refresh the block manually any time the project name or commands change:

```bash
dbless agents --write
```

Or print it to stdout (useful for piping into a different `AGENTS.md`-style file or reviewing the contract):

```bash
dbless agents
```

## How It Works

1. `dbless start` runs a long-lived daemon. The daemon owns:
   - An embedded PostgreSQL 18 cluster on `:15432` (binaries shipped via the `embedded-postgres` npm package — no system Postgres required)
   - A custom Postgres-protocol proxy on `:7777`
2. `dbless init` creates `template_<project>` in the cluster, applies migrations and seed against it, and locks it with `datallowconn=false`
3. `dbless run -- <cmd>` detects the current worktree from `git rev-parse`, ensures `myapp__<worktree>` exists (cloning from the template if missing), injects `DATABASE_URL`, and exec's the command
4. When the app connects to `:7777`, the proxy reads the `StartupMessage`, extracts `dbless.worktree=<id>` from the `options` parameter, rewrites the `database` field from `myapp` to `myapp__<id>`, and forwards. After the rewrite the proxy is a transparent byte pipe — extended query protocol, prepared statements, COPY, LISTEN/NOTIFY, and SSL all pass through

### Why a custom GUC, not `application_name`

The intuitive routing key is `application_name`, but Prisma silently strips it from connection URLs and observability tools (Datadog, NewRelic, Sentry) overwrite it for telemetry. Custom GUC namespaces (any parameter with a dot, per Postgres §19.16) survive both.

### Why a single cluster with many databases

A Postgres cluster handles thousands of idle databases with kilobyte-level catalog overhead. A separate cluster per worktree would cost 100–200 MB of RAM each. Single cluster is the only viable shape at parallel-agent scale.

### State directory

The daemon stores PID files, logs, and the cluster data dir under `~/.dbless/`. Override the cluster port and proxy port via `DBLESS_PG_PORT` and `DBLESS_PROXY_PORT`.

## CLI Reference

| Command                                     | Description                                                          |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `dbless start`                            | Start the daemon (Postgres on `:15432` and proxy on `:7777`)         |
| `dbless stop`                             | Stop the daemon                                                      |
| `dbless status`                           | Show daemon, project, and active branches                            |
| `dbless init --name <n> --migrations <g>` | Create `dbless.json` and build `template_<name>` (run in main repo)|
| `dbless init --seed <file>`               | Apply a seed file to the template after migrations                   |
| `dbless run -- <cmd>`                     | Inject `DATABASE_URL` for this worktree, then run `<cmd>`            |
| `dbless run`                              | Print the current worktree's `DATABASE_URL` and exit                 |
| `dbless shell`                            | Open `psql` against the current worktree's database (via proxy)      |
| `dbless reset`                            | Drop and re-clone the current worktree's database from the template  |
| `dbless prune`                            | Drop databases for worktrees that no longer exist                    |
| `dbless explain`                          | Print agent-readable Markdown for the current worktree's context     |
| `dbless agents`                           | Print the `## dbless` AGENTS.md block to stdout                    |
| `dbless agents --write`                   | Insert or refresh the `## dbless` block in `AGENTS.md` (idempotent)|
| `dbless --version` / `-v`                 | Show version                                                         |
| `dbless --help` / `-h`                    | Show help                                                            |

## Configuration

`dbless.json` lives at the project root and is read by every worktree.

| Field        | Type   | Default              | Description                                            |
| ------------ | ------ | -------------------- | ------------------------------------------------------ |
| `name`       | string | inferred from dir    | Project name. Becomes the `template_<name>` and `<name>__<worktree>` prefix |
| `migrations` | string | `migrations/*.sql`   | Glob of SQL files applied in lexical order to the template |
| `seed`       | string | none                 | A single SQL file applied after the migration glob, and excluded from it |

### Environment variables

| Variable                | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `DBLESS_PG_PORT`      | Override the embedded Postgres port (default `15432`)                |
| `DBLESS_PROXY_PORT`   | Override the proxy port apps connect to (default `7777`)             |
| `DBLESS_PG_USER`      | Override the cluster username (default `dbless`)                   |
| `DBLESS_PG_PASSWORD`  | Override the cluster password (default `dbless`)                   |
| `DBLESS_FOREGROUND`   | When set to `1`, runs the daemon in the foreground for debugging     |
| `DBLESS_WORKTREE`     | Set in child processes by `dbless run` so tools can read the id    |

### Agent contract

`dbless run` and `dbless explain` set the same env vars on every invocation:

| Variable          | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`    | The proxy URL with `options=-c+dbless.worktree=<id>` appended      |
| `DBLESS_WORKTREE` | The detected worktree id (e.g. `feat_auth`)                        |

The same `DATABASE_URL` string appears in every worktree. The agent does not need to know about branches.

## Troubleshooting

### Daemon will not start

```bash
dbless stop
tail -n 50 ~/.dbless/logs/daemon.err.log
```

Most common causes: a stale Postgres process holding the data dir, or another service already bound to `:15432` or `:7777`. Override either with the env vars above.

### "template does not exist"

The current worktree tried to auto-create its branch but `template_<project>` is missing. Run `dbless init` once from the main repo before booting linked worktrees.

### Migrations fail on `auth.users` or `pg_cron`

Some migrations depend on Supabase-specific schemas (`auth.users`) or the `pg_cron` extension that are not present in vanilla Postgres 18. dbless applies the migrations it can and reports the rest. Either skip those files via the `migrations` glob, or pre-create stub roles/extensions before `dbless init`.

### "DATABASE_URL is not set" inside the app

The app was launched without `dbless run`. Either prefix the command with `dbless run --`, or read the URL once with `dbless run` (no args) and export it manually.

### Filesystem refuses to clone fast

Copy-on-write clones require APFS on macOS, or XFS / btrfs with reflinks on Linux. ext4 has no reflink support — dbless falls back to a slower byte copy. Linux users should mount their cluster on an XFS volume created with `mkfs.xfs -m reflink=1`.

### "Permission denied" on the cluster data dir

PostgreSQL enforces `0700` on its data directory. If multiple users on the same machine try to share `~/.dbless/pgdata`, that fails by design. Each user should run their own dbless daemon under their own home directory.

### Removing dbless from the machine

```bash
dbless stop
rm -rf ~/.dbless
npm unlink -g dbless
```

### Requirements

- Node.js 22+
- macOS, Linux (XFS / btrfs recommended), or Windows via WSL2
- A reflink-capable filesystem for sub-second clone performance (APFS, XFS reflink, or btrfs)
- `git` 2.5+ (for `git worktree`)

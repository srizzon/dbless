# dbless

> Per-worktree Postgres isolation for parallel AI agents. Same `DATABASE_URL` everywhere; different physical database underneath.

[![npm](https://img.shields.io/npm/v/dbless.svg)](https://www.npmjs.com/package/dbless)
[![license](https://img.shields.io/npm/l/dbless.svg)](LICENSE)
[![node](https://img.shields.io/node/v/dbless.svg)](package.json)

```bash
# Worktree A and B see the same connection string...
$ echo $DATABASE_URL
postgres://dbless@localhost:7777/myapp

# ...but the data is fully isolated.
worktree-a $ psql -c "DELETE FROM users"
worktree-b $ psql -c "SELECT count(*) FROM users"
 1432
```

Sub-second branch creation via PostgreSQL 18 + reflinks. Zero config. The agent never knows there are branches.

---

## Install

```bash
npm install -g dbless
dbless start                       # daemon: postgres :15432, proxy :7777
cd ~/code/myapp
dbless init                        # build template from migrations/seed

git worktree add ../myapp-feat -b feat
cd ../myapp-feat
dbless run -- npm run dev          # branch created in ~75ms, DATABASE_URL injected
```

PostgreSQL 18 binaries ship with the package via `embedded-postgres` — no system Postgres required. macOS APFS only in v0.1; Linux + WSL2 in v0.2.

> Pre-1.0. The on-disk format under `~/.dbless/` may change between minor versions.

---

## The problem

Three things broke when AI agents started running in parallel:

| # | Problem | Solved by |
|---|---|---|
| 1 | Same code | `git worktree` |
| 2 | Same port | [portless](https://github.com/vercel-labs/portless) |
| 3 | **Same database** | **`dbless`** |

When five agents work in five worktrees on the same Postgres, one agent's `prisma migrate reset --force` wipes everyone's state. One agent's `DROP TABLE users` kills the other four's tests. The throughput multiplier from parallel agents collapses the moment any agent touches the DB.

This isn't theoretical:

- **Replit / SaaStr (Jul 2025)** — agent deleted the production database during a code freeze. Replit shipped "automatic separation between development and production databases" in response.
- **PocketOS (Apr 2026)** — Cursor + Claude Opus 4.6 deleted the prod DB and volume backups in 9 seconds. The agent's confession: *"I violated every principle I was given."*
- **anthropics/claude-code#34729 (Mar 2026)** — Claude ran `prisma migrate reset --force` unprompted, dropped the schema, deleted all users. Closed "not planned." Prisma shipped a TTY guardrail in response.

These are headlines. The daily, invisible version is multi-agent worktree development losing time and tokens to DB collisions every hour.

> "AI agents will use branching […] it's sort of going to be a requirement for the database to support branching."
> — *Sualeh Asif, co-founder Cursor*
>
> "Agents need branches."
> — *Andy Pavlo, CMU*

Neon already runs on this thesis: 80%+ of databases on the platform are now created by agents (Heikki Linnakangas, CTO Neon).

---

## How it works

```
[Agent in worktrees/fix-auth/]
   │  DATABASE_URL=postgres://dbless@localhost:7777/myapp
   │      ?options=-c dbless.worktree=abc123
   ▼
[dbless proxy on :7777]
   │  1. Parse StartupMessage (length-prefixed k/v pairs)
   │  2. Read options="-c dbless.worktree=abc123"
   │  3. Rewrite database field: myapp → myapp__abc123
   │  4. Re-emit StartupMessage upstream
   │  5. Raw byte pipe for the rest of the session
   ▼
[Postgres 18 cluster on :15432]
   ├─ template_myapp        (datallowconn=false, source of truth)
   ├─ myapp__abc123         (reflink clone, ~75ms)
   ├─ myapp__def456         (different worktree, different data)
   └─ myapp__ghi789
```

Three primitives, working together:

1. **PostgreSQL 18 `file_copy_method=clone`** — copy-on-write database creation in sub-second time via APFS clonefile / Linux reflinks.
2. **Custom GUC namespace** — `dbless run` injects `options=-c dbless.worktree=<id>` into the connection URL.
3. **Thin proxy** — listens on `:7777`, parses the StartupMessage, rewrites the `database` field, forwards to the real Postgres. Pure pipe after handshake.

<details>
<summary><b>Why custom GUC, not <code>application_name</code></b></summary>

The intuitive routing key is `application_name`. It doesn't survive the real world:

- **Prisma silently strips `application_name`** from connection URLs ([prisma/prisma#7804](https://github.com/prisma/prisma/issues/7804)). Prisma is dominant in JS — losing it is losing the audience.
- **Observability tools overwrite it** — Datadog, NewRelic, Sentry all set `application_name` for telemetry, clobbering the routing key.

Custom GUC namespaces (any parameter with a dot, per Postgres §19.16) survive both. Prisma forwards the `options` parameter. Observability tools don't touch unfamiliar GUCs. Routing becomes explicit, namespaced, unspoofable by libraries.

</details>

<details>
<summary><b>Why a custom proxy, not pg-gateway</b></summary>

`pg-gateway` (supabase-community) doesn't expose a first-class API for rewriting the `database` field. The library's reverse-proxy example uses `connection.detach()` plus raw socket pipe — it doesn't reserialize the StartupMessage. Forcing a rewrite means buffering the original message, parsing it, constructing a new one, writing it upstream manually — fighting the API.

The Postgres StartupMessage format is trivial: int32 length, int32 protocol version (196608), null-terminated key-value pairs, double-null terminator. A 200-LOC custom proxy in Bun is more robust than wrestling an unmaintained library (last meaningful pg-gateway activity: Sep 2024).

After the handshake rewrite, the proxy goes raw-pipe. Extended query protocol, prepared statements, COPY, LISTEN/NOTIFY, SSL — all transparent.

</details>

<details>
<summary><b>Why a single cluster, many databases</b></summary>

A Postgres cluster handles thousands of idle databases with kilobyte-level catalog overhead. A separate cluster per worktree would burn 100-200MB of RAM each — 2GB for 10 worktrees, 10GB for a heavy parallel-agent setup. Single cluster is the only viable shape.

The cost: cluster-level state (roles, tablespaces, `shared_preload_libraries`) is shared. Acceptable, since worktrees in the same repo share these by definition anyway.

</details>

<details>
<summary><b>What the proxy actually does</b></summary>

1. Listens on `127.0.0.1:7777` (configurable via `DBLESS_PROXY_PORT`).
2. Opens an upstream socket to embedded Postgres (`:15432`) on each client connection.
3. Buffers client bytes until it can parse a full `StartupMessage` (or an `SSLRequest`, which is forwarded as-is).
4. Reads the `options` field, looks for `-c dbless.worktree=<id>`.
5. If present and `myapp__<id>` does not yet exist, runs `CREATE DATABASE myapp__<id> TEMPLATE template_myapp` against the cluster, then rewrites the `database` field of the `StartupMessage` and forwards.
6. After the handshake, the proxy is a transparent byte pipe — extended query protocol, prepared statements, `COPY`, `LISTEN/NOTIFY`, SSL all pass through untouched.

`src/proxy.ts` is ~185 lines.

</details>

<details>
<summary><b>Why now</b></summary>

Everything needed to build this just landed:

- **PG18 shipped Sep 25, 2025** — the `file_copy_method=clone` GUC turned `CREATE DATABASE TEMPLATE` into a sub-second copy-on-write operation. Pre-PG18 attempts (`pgsh`, schema-per-branch) all suffered the same root problem: clone was slow, so users avoided it.
- **APFS clonefile + Linux reflinks** are mature on developer hardware. APFS default on macOS. XFS reflink default since RHEL 8 (2019). btrfs everywhere.
- **Multi-agent parallel workflows shipped** — Claude Code added native worktrees, Cursor 2.0 launched Parallel Agents, Anthropic ships background agents. Boris Cherny: *"I have dozens of Claudes running at all times."*
- **Prior attempts failed for fixable reasons** — `pgsh` died in 2019 because pre-PG15 had no fast clone. Coasts uses heavy DinD (5-15s per worktree). Worktrunk requires manual templates. Tiger Agentic Postgres is cloud-only. Neon Local proxies to cloud, not local.

The window between PG18 launch and multi-agent becoming default is the exact moment to ship this.

</details>

---

## Composition with portless

`dbless` is a sibling to [portless](https://github.com/vercel-labs/portless), not a fork or replacement.

|   | Solves | Output |
|---|---|---|
| **portless** | URL naming | `fix-auth.myapp.localhost` |
| **dbless** | DB isolation | `postgres://…/myapp?…worktree=fix_auth` |

Both detect the same `git worktree` and derive a stable identifier from it. The pipeline composes left-to-right:

```bash
dbless run -- portless run -- node server.js
   ↑              ↑                ↑
   DATABASE_URL   PORT             reads both env vars
                  PORTLESS_URL
```

- `dbless run` — detects worktree, ensures `myapp__<id>` exists (clones from template in ~75ms if missing), injects `DATABASE_URL`, execs the next command.
- `portless run` — detects the same worktree, registers route `feat-auth.myapp.localhost`, assigns `PORT`, injects `PORTLESS_URL`, execs the app.

No coordination required. Each tool runs independently; both observe the same `git rev-parse`.

---

## CLI

```
dbless start              start the daemon (postgres :15432 + proxy :7777)
dbless stop               stop the daemon
dbless status             show daemon, project, and active branches
dbless init [--name X]    build template_<project> from migrations/seed,
                            and merge a `## dbless` block into AGENTS.md
dbless run -- <cmd>       inject DATABASE_URL for current worktree, run cmd
dbless shell              psql into the current worktree's database
dbless reset              drop + re-clone the current worktree's database
dbless prune              drop databases for worktrees that no longer exist
dbless explain            print agent-readable context for the current worktree
dbless agents [--write]   print or refresh the `## dbless` AGENTS.md block
```

A typical end-to-end session:

```bash
dbless start
cd ~/code/myapp
dbless init --name myapp --migrations 'migrations/*.sql' --seed 'seed.sql'

git worktree add ../myapp-feat-auth -b feat-auth
cd ../myapp-feat-auth
dbless run -- npm run dev
# DATABASE_URL=postgres://dbless:dbless@localhost:7777/myapp?options=-c+dbless.worktree=feat_auth
# database myapp__feat_auth created from template in ~75ms
```

### `dbless.json`

Each project root carries a small config file. `dbless init` writes one if missing; `dbless run` reads it from the current worktree to know which template to clone.

```json
{
  "name": "demoapp",
  "migrations": "migrations/*.sql",
  "seed": "migrations/999_seed.sql"
}
```

---

## Demo

```
[ Two terminal panes, side by side ]

# Pane A — worktrees/feat-a
$ cat .env
DATABASE_URL=postgres://dbless@localhost:7777/myapp?options=-c+dbless.worktree=a
$ psql $DATABASE_URL -c "SELECT email FROM users"
 alice@example.com

# Pane B — worktrees/feat-b
$ cat .env
DATABASE_URL=postgres://dbless@localhost:7777/myapp?options=-c+dbless.worktree=b
$ psql $DATABASE_URL -c "SELECT email FROM users"
 bob@example.com

[ Same DATABASE_URL string. Different data. ]

# Pane A simulates an agent doing damage
$ psql $DATABASE_URL -c "DELETE FROM users"
$ psql $DATABASE_URL -c "SELECT * FROM users"
 (0 rows)

# Pane B is untouched
$ psql $DATABASE_URL -c "SELECT email FROM users"
 bob@example.com

[ Agent A burned its database. Agent B never noticed. ]
```

---

## Agent skill

`dbless` ships an [agent skill](https://skills.sh) at `skills/dbless/SKILL.md`. Install into Claude Code, Cursor, Codex, OpenCode, Cline, and 50+ other agents:

```bash
npx skills add srizzon/dbless            # project-scoped
npx skills add -g srizzon/dbless         # global (~/.claude/skills/dbless)
```

Once installed, the agent triggers on prompts like *"isolate the database for this worktree"*, *"why did the migration wipe my data"*, or *"start a new feature branch with a clean Postgres".* Inside a worktree, `dbless explain` prints the same Markdown contract straight into the agent's context.

---

## Roadmap

| Version | Status | Scope |
|---|---|---|
| **v0.1** | Shipped | macOS APFS, embedded PG18, daemon + lazy clone, full CLI, AGENTS.md block, agent skill |
| **v0.2** | Next | Linux (XFS reflink + btrfs), launchd/systemd auto-start, drift detection, dotenv/envrc env modes, ext4 refuse-to-install |
| **v0.3+** | Planned | WSL2 helper (btrfs loopback), monorepo schema-per-app, optional Redis isolation, ZFS opt-in |

**Out of scope** — new database engine (uses unmodified Postgres), Neon competitor (cloud-first vs local-first; complementary), production tool, backup/replication.

---

## Risks and tradeoffs

| Risk | Severity | Mitigation |
|---|---|---|
| ext4 lacks reflink (Linux default) | Blocker on Linux ext4 | Detect filesystem at startup, refuse to install with clear "use XFS reflink or btrfs" message. v0.3 adds slow-copy fallback opt-in. |
| Postgres 18 adoption <20% as of May 2026 | Adoption friction | `embedded-postgres` ships PG18 binaries inside `node_modules` so no system Postgres is required. |
| WSL2 9P filesystem has no reflink | Blocker for WSL2 | v0.2 documents as unsupported. v0.3 ships btrfs loopback helper. |
| timescaledb deadlocks on `CREATE DATABASE TEMPLATE` ([timescale/timescaledb#4048](https://github.com/timescale/timescaledb/issues/4048)) | Mitigatable | Detect extension at template build, pause `max_background_workers=0` before clone, restore after. |
| pg_cron jobs orphan when branch dropped | Mitigatable | Teardown purges `cron.job WHERE database='branch__X'`. |
| Prisma may bypass proxy with raw libpq driver | Mitigatable | Documented; validated against Prisma 7. Driver adapter pattern (`@prisma/adapter-pg`) supported. |
| APFS cross-volume clone fails (EXDEV) | Mitigatable | Detect at startup via `stat -f %d`, abort with clear error if pgdata and clones live on different volumes. |
| Performance: ~600ms not ~200ms on macOS APFS | Honesty | Document "sub-second cloning". Reflinks plus PG's two mandatory checkpoints land in the 400-900ms range. |
| Time Machine corrupts pgdata on restore | Documentable | Auto-add pgdata to TM exclusion list on first run via `tmutil addexclusion`. |
| Hash collisions on worktree IDs | Negligible | 16-hex-char SHA-256 truncation gives effectively zero collision probability for realistic worktree counts. |

---

## Prior art

| Tool | What it does | Why `dbless` is different |
|---|---|---|
| Tiger Agentic Postgres (Dec 2025) | CoW + MCP + free tier | Cloud-only, requires account; `dbless` is local-first, offline. |
| Neon Local Connect | Docker proxy to cloud Neon branches | Requires `NEON_API_KEY` + project ID; proxies to cloud. `dbless` is fully local. |
| Worktrunk | Per-worktree templating engine | No copy-on-write, requires manual templates. `dbless` is zero-config + sub-second. |
| Coasts | DinD per-worktree containers | Heavy: 5-15s startup, GB of RAM each, networking gymnastics. `dbless` is sub-second + ~zero RAM per idle branch. |
| Velo | ZFS-backed CoW Postgres branches | Not worktree-aware, ZFS-only (kext install pain on macOS). `dbless` integrates `git worktree` directly. |
| pg_branch | Btrfs snapshot extension | Experimental, btrfs-only. |
| Doltgres | Native branching DB | 39% Postgres regression test pass rate as of Oct 2025. Not yet drop-in. |
| pglite | Postgres in WASM | Single-user mode under the hood; not a real dev DB replacement. Useful for tests. |
| pgsh (2019, abandoned) | Shell wrapper that switches `DATABASE_URL` | Pre-PG15 had no fast clone. No daemon, users had to remember branch state. PG18 + proxy fix both. |
| Bernstein | Multi-agent orchestrator with worktree state | Heavy orchestrator. Doesn't isolate DB by default. `dbless` is a thin primitive. |

No shipping tool today provides the combination: per-worktree autodetect, copy-on-write, zero-config, local-first, agent-friendly, with Redis bundled. Tiger or Neon could ship a competing local mode; based on current activity, `dbless` has a 60-90 day window before commoditization.

---

<details>
<summary><b>Project layout</b></summary>

```
bin/dbless              CLI entry point
src/
  daemon.ts               long-running parent of postgres + proxy
  proxy.ts                Postgres-protocol StartupMessage rewriter (~185 LOC)
  pg.ts                   embedded-postgres lifecycle + helpers
  template.ts             createTemplate / ensureBranch / dropDatabase
  worktree.ts             git rev-parse + safe-id derivation
  config.ts               dbless.json loader
  state.ts                ~/.dbless paths and pid files
  format.ts               ANSI + table helpers
  agents-snippet.ts       AGENTS.md block writer
skills/dbless/          installable agent skill
HOW-IT-WORKS.md           architecture and live-demo recipe
```

</details>

---

## License & status

[Apache-2.0](LICENSE). Inspired by [vercel-labs/portless](https://github.com/vercel-labs/portless) by Chris Tate.

`0.1.0` — first release. macOS APFS only. Linux + WSL2 in `0.2`.

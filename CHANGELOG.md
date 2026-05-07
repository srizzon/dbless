# dbless changelog

The `0.x` series is pre-stable. The on-disk format under `~/.dbless/` may change between minor versions.

## 0.1.0

Initial release.

- Per-worktree Postgres isolation via a thin proxy that rewrites the `database` field of the Postgres `StartupMessage` based on `options=-c dbless.worktree=<id>`.
- `dbless start` / `stop` / `status` / `init` / `run` / `shell` / `reset` / `prune` / `explain`.
- Embedded PostgreSQL 18 binaries via `embedded-postgres`. No system Postgres required.
- Single cluster, many databases — kilobyte-level catalog overhead per idle branch.
- Auto-generated `AGENTS.md` block on `dbless init`, idempotent via HTML comment markers.
- macOS APFS supported. Linux (XFS reflink, btrfs) and WSL2 land in `0.2`.

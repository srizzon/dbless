# Agent Rules

## Package Manager

Use `npm` for all package management commands in this repo. Yarn and pnpm have not been tested against `embedded-postgres` lifecycle hooks.

End-user install instructions in the README and `SKILL.md` use `npm install -g` and `npm link` since npm is universal.

## Dependencies

Always check for the latest npm version when adding dependencies. Use `npm view <package> version` to verify before pinning. Prefer zero new dependencies — the project's value is in being thin.

## No Emojis

Do not use emojis anywhere in this repository (code, comments, output, docs, examples).

## Dashes

Never use `--` as a dash in prose, comments, or user-facing output. Use an em dash (`—`) when a dash is needed, but prefer rephrasing to avoid dashes entirely. The only exception is CLI flags (e.g. `--name`, `--migrations`).

## Boolean Environment Variables

Document boolean env vars using only `0` and `1` in CLI help, `SKILL.md`, docs, and the README. Code may accept `true`/`false` but those alternatives are not documented.

## Composition with portless

`dbless` is a sibling to `vercel-labs/portless`, not a fork or extension. Both detect the same `git worktree` independently. Do not introduce a hard dependency on portless. Do not break the property that `dbless run -- <cmd>` works on its own with no portless installed.

## Docs Updates

When a change affects how humans or agents use dbless (new/changed/removed commands, flags, behavior, or config), update all of these:

1. `README.md` (user-facing documentation)
2. `HOW-IT-WORKS.md` (architecture / live-demo guide)
3. `skills/dbless/SKILL.md` (agent skill for using dbless)
4. `bin/dbless.ts` (`--help` output)
5. `CHANGELOG.md` under the next version

## Versioning

Follow semver. The `0.x` series is pre-stable; expect breaking changes in the on-disk format under `~/.dbless/`. Document migrations or wipes required when bumping minor versions in `0.x`.

## Releasing

Releases are manual and single-PR. The maintainer controls the changelog voice and format.

To prepare a release:

1. Create a branch (e.g. `prepare-v0.2.0`)
2. Bump the version in `package.json` and `bin/dbless.ts` (`VERSION` constant)
3. Update `README.md`, `HOW-IT-WORKS.md`, and `skills/dbless/SKILL.md` if any commands or flags changed
4. Add an entry to `CHANGELOG.md`
5. Open a PR titled `Release v0.2.0`
6. After merge, tag and push: `git tag v0.2.0 && git push --tags`

## Testing

There is no formal test suite yet. End-to-end manual verification on macOS APFS is required before any merge to `main`. Adding integration tests under `tests/` is welcome.

## Architecture Constraints

- The proxy must remain protocol-correct: rewrite the StartupMessage, then become a transparent byte pipe. Do not parse, log, or mutate query traffic.
- The daemon owns exactly one Postgres cluster. Per-worktree clusters are explicitly out of scope (RAM cost is too high).
- Routing is by custom GUC (`dbless.worktree=<id>`) carried via the `options` parameter. Do not switch to `application_name` — Prisma strips it and observability tools overwrite it.
- Branch creation goes through `CREATE DATABASE TEMPLATE` with `STRATEGY=FILE_COPY` and `file_copy_method=clone`. Do not introduce custom storage layers.

## Filesystem Assumptions

- macOS: APFS clonefile is assumed and required for sub-second clones
- Linux: XFS with reflinks (`mkfs.xfs -m reflink=1`) or btrfs are required for sub-second clones; ext4 falls back to slow byte copy and that fallback is documented, not silenced
- Windows: WSL2 only, with the cluster data dir inside the WSL filesystem (not on `/mnt/c`)

## Out of Scope

- Replication, backups, point-in-time recovery — `dbless` is dev-only
- Multi-machine sync — branches are local to one developer's machine
- Serving production traffic — the proxy is hardened for protocol correctness, not for throughput at scale
- Automatic merge of schema drift across branches — explicitly rejected (undefined semantics)

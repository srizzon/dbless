// Generates and merges the `## dbless` section into a project's AGENTS.md.
//
// The section is bracketed by HTML comment markers so re-running is
// idempotent — `writeOrUpdate` replaces the existing block instead of
// appending a duplicate.

import fs from "node:fs";
import path from "node:path";

const BEGIN = "<!-- dbless:begin -->";
const END = "<!-- dbless:end -->";

export function buildSnippet(opts: { project: string }): string {
  return `${BEGIN}

## dbless

This project uses [dbless](https://github.com/srizzon/dbless) to give every git worktree its own isolated Postgres database. The connection string is the same in every worktree — dbless routes to the right physical database based on \`git rev-parse\`.

### Contract

- Read \`DATABASE_URL\` from the env. Do not hardcode database names. The same string works in every worktree.
- Run dev / test commands through \`dbless run --\`. That is what injects \`DATABASE_URL\` and \`DBLESS_WORKTREE\` for the current worktree.
- Schema changes (\`ALTER TABLE\`, \`prisma migrate dev\`, \`drizzle-kit push\`) are local to this worktree's database. They do **not** affect other agents in other worktrees.
- Destructive operations (\`DROP TABLE\`, \`TRUNCATE\`, \`prisma migrate reset --force\`) are also local to this worktree. They do not require coordination with other agents.
- To reset the current worktree's database to the template state, run \`dbless reset\`. It is fast (sub-second) and safe.

### Do not

- Do not connect to \`localhost:15432\` directly — that is the underlying cluster, not the proxy. All app traffic goes through \`localhost:7777\` via \`DATABASE_URL\`.
- Do not modify \`DATABASE_URL\` in code or config. The \`?options=-c+dbless.worktree=...\` segment is what makes routing work.
- Do not edit migrations to work around schema drift across worktrees. Use \`dbless reset\` to regenerate from the template instead.

### Useful commands

- \`dbless explain\` — print the current worktree's context (project, branch, database, DATABASE_URL) in agent-readable Markdown
- \`dbless status\` — list all active worktrees and their databases
- \`dbless shell\` — open \`psql\` against this worktree's database
- \`dbless reset\` — drop and re-clone this worktree's database from the template

The template database is named \`template_${opts.project}\`. The current worktree's database is \`${opts.project}__<worktree-id>\`. Other worktrees of this repo are fully isolated.

${END}`;
}

export function readExisting(file: string): string {
  try { return fs.readFileSync(file, "utf-8"); } catch { return ""; }
}

export function mergeSnippet(existing: string, snippet: string): string {
  if (!existing.trim()) {
    // New file: just the snippet, plus a trailing newline.
    return snippet + "\n";
  }
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    // Replace the existing block in place.
    const before = existing.slice(0, beginIdx).replace(/\n+$/, "");
    const after = existing.slice(endIdx + END.length).replace(/^\n+/, "");
    const sep = before ? "\n\n" : "";
    const trail = after ? "\n\n" + after : "\n";
    return `${before}${sep}${snippet}${trail}`;
  }
  // Append at the end.
  const trimmed = existing.replace(/\n+$/, "");
  return `${trimmed}\n\n${snippet}\n`;
}

export function writeAgentsMd(rootDir: string, project: string): {
  path: string;
  action: "created" | "updated" | "appended";
} {
  const file = path.join(rootDir, "AGENTS.md");
  const existing = readExisting(file);
  const snippet = buildSnippet({ project });

  let action: "created" | "updated" | "appended";
  if (!existing.trim()) action = "created";
  else if (existing.includes(BEGIN) && existing.includes(END)) action = "updated";
  else action = "appended";

  const next = mergeSnippet(existing, snippet);
  fs.writeFileSync(file, next);
  return { path: file, action };
}

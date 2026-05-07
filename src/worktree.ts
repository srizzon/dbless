// Detects the current git worktree and produces a stable, filesystem-safe id.

import { execSync } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";

export type WorktreeInfo = {
  root: string;       // absolute path of the worktree root
  branch: string;     // current branch name
  id: string;         // short, lowercase, [a-z0-9_]+ id used in DB names
  isWorktree: boolean; // true if it is a linked worktree (not the main one)
};

function safeId(name: string): string {
  // Postgres database names are case-folded unless quoted; keep them lowercase
  // and restricted to a portable subset.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (slug.length > 0 && slug.length <= 32) return slug;
  // Fall back to a hash for very long or weird names.
  const hash = crypto.createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${slug.slice(0, 20)}_${hash}`;
}

export function detectWorktree(cwd: string = process.cwd()): WorktreeInfo {
  const run = (cmd: string) => execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  let root: string;
  try {
    root = run("git rev-parse --show-toplevel");
  } catch {
    throw new Error(`not inside a git repository (cwd=${cwd})`);
  }

  let branch = "detached";
  try {
    branch = run("git rev-parse --abbrev-ref HEAD");
    if (branch === "HEAD") branch = "detached";
  } catch {}

  let isWorktree = false;
  try {
    const gitDir = run("git rev-parse --git-dir");
    isWorktree = path.basename(path.dirname(gitDir)) === "worktrees";
  } catch {}

  return {
    root,
    branch,
    id: safeId(branch === "detached" ? path.basename(root) : branch),
    isWorktree,
  };
}

// Project config (dbless.json) parsing.

import path from "node:path";
import fs from "node:fs";
import { detectWorktree } from "./worktree.ts";

export type ProjectConfig = {
  name: string;
  migrations?: string;
  seed?: string;
  // Resolved at load time:
  root: string;
  worktreeId: string;
  branch: string;
};

export function loadConfig(cwd: string = process.cwd()): ProjectConfig {
  const wt = detectWorktree(cwd);
  // The dbless.json lives at the main repo root, not at each worktree —
  // worktrees are per-branch checkouts of the same project.
  // We look for it at the worktree root first; if missing, walk up the
  // shared common-dir parent.
  const candidates = [
    path.join(wt.root, "dbless.json"),
    path.join(wt.root, "..", "dbless.json"),
  ];

  let configPath: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { configPath = c; break; }
  }

  if (!configPath) {
    throw new Error(
      `no dbless.json found in ${wt.root} — run \`dbless init\` to create one`
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  if (!raw.name || typeof raw.name !== "string") {
    throw new Error(`dbless.json: missing required field "name"`);
  }

  return {
    name: raw.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
    migrations: raw.migrations,
    seed: raw.seed,
    root: wt.root,
    worktreeId: wt.id,
    branch: wt.branch,
  };
}

export function writeConfig(dir: string, cfg: { name: string; migrations?: string; seed?: string }) {
  const out: Record<string, unknown> = { name: cfg.name };
  if (cfg.migrations) out.migrations = cfg.migrations;
  if (cfg.seed) out.seed = cfg.seed;
  fs.writeFileSync(path.join(dir, "dbless.json"), JSON.stringify(out, null, 2) + "\n");
}

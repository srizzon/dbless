#!/usr/bin/env node
// dbless CLI

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ROOT, LOG_DIR, PG_PORT, PROXY_PORT, PG_USER,
  ensureDirs, readPid, clearPid, PG_PID_FILE, PROXY_PID_FILE,
} from "../src/state.ts";
import { detectWorktree } from "../src/worktree.ts";
import { loadConfig, writeConfig } from "../src/config.ts";
import { connect, exec, listDatabases, databaseSize, databaseExists } from "../src/pg.ts";
import {
  templateName, branchName, createTemplate, applySqlGlob, applySqlFile,
  lockTemplate, ensureBranch as ensureBranchFn, dropDatabase,
} from "../src/template.ts";
import { ok, fail, info, warn, dim, bold, cyan, gray, table, bytes, ago } from "../src/format.ts";
import { buildSnippet, writeAgentsMd } from "../src/agents-snippet.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.resolve(__dirname, "..", "src", "daemon.ts");
const VERSION = "0.1.0";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function isDaemonRunning(): boolean {
  return readPid(PG_PID_FILE) !== null;
}

async function waitForProxy(timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const c = connect({ database: "postgres", port: PROXY_PORT });
      await c.connect();
      await c.end();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

function buildDatabaseUrl(project: string, worktreeId: string): string {
  return `postgres://${PG_USER}:${PG_USER}@localhost:${PROXY_PORT}/${project}` +
         `?options=-c+dbless.worktree=${worktreeId}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────

async function cmdStart() {
  ensureDirs();
  if (isDaemonRunning()) {
    console.log(info(`daemon already running (pg :${PG_PORT}, proxy :${PROXY_PORT})`));
    return;
  }
  console.log(info("starting daemon …"));

  const out = fs.openSync(path.join(LOG_DIR, "daemon.out.log"), "a");
  const err = fs.openSync(path.join(LOG_DIR, "daemon.err.log"), "a");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", DAEMON_ENTRY], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();

  if (await waitForProxy()) {
    console.log(ok(`postgres ready on :${PG_PORT}`));
    console.log(ok(`proxy ready on :${PROXY_PORT}`));
    console.log(dim(`logs: ${LOG_DIR}`));
  } else {
    console.log(fail("daemon did not become healthy in time. check logs:"));
    console.log(`  tail -n 50 ${path.join(LOG_DIR, "daemon.err.log")}`);
    process.exit(1);
  }
}

async function cmdStop() {
  const pid = readPid(PG_PID_FILE);
  if (!pid) {
    console.log(info("daemon not running"));
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(ok(`signalled daemon pid=${pid}`));
  } catch {
    console.log(warn(`pid ${pid} not reachable, clearing`));
  }
  for (let i = 0; i < 30; i++) {
    if (readPid(PG_PID_FILE) === null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  clearPid(PG_PID_FILE);
  clearPid(PROXY_PID_FILE);
  console.log(ok("stopped"));
}

async function cmdStatus() {
  const running = isDaemonRunning();
  console.log(`${bold("dbless")} ${dim("· " + VERSION)}`);
  console.log("");
  console.log(`  daemon     ${running ? ok("running") : fail("stopped")}`);
  console.log(`  postgres   :${PG_PORT}`);
  console.log(`  proxy      :${PROXY_PORT}`);
  console.log(`  state      ${dim(ROOT)}`);
  console.log("");

  if (!running) {
    console.log(dim("  (run `dbless start` to bring it up)"));
    return;
  }

  // Project + branches view
  let project = "";
  try { project = loadConfig().name; } catch {}

  if (project) {
    const tmpl = templateName(project);
    const dbs = await listDatabases(`${project}__`);
    const tmplExists = await databaseExists(tmpl);

    console.log(`  project    ${cyan(project)}`);
    console.log(`  template   ${tmplExists ? ok(tmpl) : warn("missing — run `dbless init`")}`);
    console.log("");

    if (dbs.length === 0) {
      console.log(dim("  no branches yet — `dbless run -- <cmd>` will create one on first connect"));
      return;
    }

    const rows: Record<string, string>[] = [];
    for (const db of dbs) {
      const size = await databaseSize(db);
      const worktree = db.slice(`${project}__`.length);
      rows.push({
        worktree,
        database: db,
        size: bytes(size),
      });
    }
    console.log(table(rows, ["worktree", "database", "size"]));
  } else {
    console.log(dim("  not in a dbless project — run `dbless init` to set one up"));
  }
}

async function cmdInit(opts: { name?: string; migrations?: string; seed?: string }) {
  if (!isDaemonRunning()) {
    console.log(warn("daemon not running — `dbless start` first"));
    process.exit(1);
  }

  const wt = detectWorktree();
  if (wt.isWorktree) {
    console.log(fail("`dbless init` must run from the main repo, not a linked worktree"));
    process.exit(1);
  }

  const inferredName = (opts.name ?? path.basename(wt.root)).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const cfgPath = path.join(wt.root, "dbless.json");

  if (fs.existsSync(cfgPath)) {
    console.log(info("dbless.json already exists — re-running template build"));
  } else {
    writeConfig(wt.root, {
      name: inferredName,
      migrations: opts.migrations ?? "migrations/*.sql",
      seed: opts.seed,
    });
    console.log(ok(`wrote ${dim(path.relative(process.cwd(), cfgPath))}`));
  }

  const cfg = loadConfig();
  console.log(info(`building template ${cyan(templateName(cfg.name))} …`));
  await createTemplate(cfg.name);

  if (cfg.migrations) {
    try {
      const applied = await applySqlGlob(templateName(cfg.name), cfg.migrations, wt.root, cfg.seed);
      console.log(ok(`applied ${applied.length} migration(s)`));
    } catch (e) {
      console.log(warn(`migrations: ${(e as Error).message}`));
    }
  }
  if (cfg.seed) {
    try {
      await applySqlFile(templateName(cfg.name), path.resolve(wt.root, cfg.seed));
      console.log(ok(`seeded from ${cfg.seed}`));
    } catch (e) {
      console.log(warn(`seed: ${(e as Error).message}`));
    }
  }
  await lockTemplate(cfg.name);

  // Inject (or refresh) the `## dbless` block in the project's AGENTS.md so
  // any agent opening this repo immediately knows how to behave.
  try {
    const r = writeAgentsMd(wt.root, cfg.name);
    const verb = r.action === "created" ? "wrote" : r.action === "updated" ? "updated" : "appended to";
    console.log(ok(`${verb} ${dim(path.relative(process.cwd(), r.path))}`));
  } catch (e) {
    console.log(warn(`AGENTS.md: ${(e as Error).message}`));
  }

  const url = buildDatabaseUrl(cfg.name, wt.id);
  console.log("");
  console.log(ok("project ready"));
  console.log(`  ${dim("DATABASE_URL")}  ${url}`);
  console.log("");
  console.log(dim("next:"));
  console.log(dim("  git worktree add ../") + cfg.name + dim("-feat-x -b feat-x"));
  console.log(dim("  cd ../") + cfg.name + dim("-feat-x"));
  console.log(dim("  dbless run -- npm run dev"));
}

async function cmdAgents(opts: { write?: boolean }) {
  const cfg = loadConfig();
  const wt = detectWorktree();
  if (opts.write) {
    if (wt.isWorktree) {
      console.log(fail("`dbless agents --write` must run from the main repo"));
      process.exit(1);
    }
    const r = writeAgentsMd(wt.root, cfg.name);
    const verb = r.action === "created" ? "wrote" : r.action === "updated" ? "updated" : "appended to";
    console.log(ok(`${verb} ${path.relative(process.cwd(), r.path)}`));
  } else {
    process.stdout.write(buildSnippet({ project: cfg.name }) + "\n");
  }
}

async function cmdRun(args: string[]) {
  if (!isDaemonRunning()) {
    console.log(warn("daemon not running — starting it"));
    await cmdStart();
  }

  const cfg = loadConfig();
  const wt = detectWorktree();

  // Eagerly create the branch so the user sees timing in the CLI, not on
  // the first app-side connection.
  const dbName = branchName(cfg.name, wt.id);
  if (!(await databaseExists(dbName))) {
    process.stdout.write(info(`creating branch ${cyan(dbName)} from template … `));
    const r = await ensureBranchFn(cfg.name, wt.id);
    process.stdout.write(`${ok(`${r.ms}ms`)}\n`);
  }

  if (args.length === 0) {
    console.log(buildDatabaseUrl(cfg.name, wt.id));
    return;
  }

  const url = buildDatabaseUrl(cfg.name, wt.id);
  const env = { ...process.env, DATABASE_URL: url, DBLESS_WORKTREE: wt.id };
  console.log(dim(`[dbless] worktree=${wt.id} db=${dbName}`));

  const child = spawn(args[0], args.slice(1), { stdio: "inherit", env });

  // Forward signals so the spawned child dies with us — otherwise it gets
  // reparented to init and leaks (e.g. demo runs leaving stale node servers
  // bound to dev ports).
  const forward = (sig: NodeJS.Signals) => () => {
    try { child.kill(sig); } catch {}
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

async function cmdShell() {
  const cfg = loadConfig();
  const wt = detectWorktree();
  const dbName = branchName(cfg.name, wt.id);
  if (!(await databaseExists(dbName))) {
    await ensureBranchFn(cfg.name, wt.id);
  }
  // Connect via the proxy so the routing is observable in logs. Fall back to
  // direct cluster connection if psql is missing.
  const env = { ...process.env, PGPASSWORD: "dbless" };
  const child = spawnSync(
    "psql",
    [`postgres://${PG_USER}@localhost:${PROXY_PORT}/${cfg.name}?options=-c+dbless.worktree=${wt.id}`],
    { stdio: "inherit", env }
  );
  if (child.error) {
    console.log(fail("psql not found on PATH — install postgres client tools"));
    console.log(dim("alternative: `dbless run` and use your own db client"));
    process.exit(1);
  }
}

async function cmdReset() {
  const cfg = loadConfig();
  const wt = detectWorktree();
  const dbName = branchName(cfg.name, wt.id);
  console.log(info(`resetting ${cyan(dbName)} …`));
  await dropDatabase(dbName);
  const r = await ensureBranchFn(cfg.name, wt.id);
  console.log(ok(`re-cloned from template (${r.ms}ms)`));
}

async function cmdPrune() {
  const cfg = loadConfig();
  const wt = detectWorktree();
  if (wt.isWorktree) {
    console.log(fail("run `dbless prune` from the main repo"));
    process.exit(1);
  }
  // Collect known worktree ids from `git worktree list --porcelain`.
  const out = spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf-8" }).stdout;
  const known = new Set<string>();
  let curBranch: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("branch refs/heads/")) curBranch = line.slice("branch refs/heads/".length);
    else if (line === "") {
      if (curBranch) known.add(curBranch.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
      curBranch = null;
    }
  }

  const dbs = await listDatabases(`${cfg.name}__`);
  const orphans = dbs.filter((d) => !known.has(d.slice(`${cfg.name}__`.length)));
  if (orphans.length === 0) {
    console.log(ok("no orphan branches"));
    return;
  }
  for (const db of orphans) {
    await dropDatabase(db);
    console.log(ok(`dropped ${db}`));
  }
}

async function cmdExplain() {
  const cfg = loadConfig();
  const wt = detectWorktree();
  const dbName = branchName(cfg.name, wt.id);
  const tmpl = templateName(cfg.name);
  console.log(`# dbless context`);
  console.log(``);
  console.log(`- project: \`${cfg.name}\``);
  console.log(`- worktree: \`${wt.id}\` (branch \`${wt.branch}\`)`);
  console.log(`- root: \`${wt.root}\``);
  console.log(`- database: \`${dbName}\` (cloned from \`${tmpl}\`)`);
  console.log(`- DATABASE_URL: \`${buildDatabaseUrl(cfg.name, wt.id)}\``);
  console.log(``);
  console.log(`Same DATABASE_URL is used in every worktree.`);
  console.log(`Destructive ops (DELETE, TRUNCATE, DROP, prisma migrate reset)`);
  console.log(`only affect this worktree's database. Other worktrees are isolated.`);
}

function help() {
  console.log(`${bold("dbless")} ${dim("· per-worktree database isolation")}

${bold("usage")}
  dbless <command> [args]

${bold("commands")}
  ${cyan("start")}              start the daemon (postgres + proxy)
  ${cyan("stop")}               stop the daemon
  ${cyan("status")}             show daemon + project + branches
  ${cyan("init")}               create dbless.json + build template (run in main repo)
  ${cyan("run")} -- <cmd>       run a command with DATABASE_URL injected for this worktree
  ${cyan("shell")}              open psql against the current worktree's database
  ${cyan("reset")}              drop and re-clone the current worktree's database
  ${cyan("prune")}              drop databases for worktrees that no longer exist
  ${cyan("explain")}            print agent-readable context for the current worktree
  ${cyan("agents")} [--write]    print or merge the dbless section into AGENTS.md

${bold("examples")}
  dbless start
  dbless init --name myapp --migrations 'migrations/*.sql'
  git worktree add ../myapp-feat-auth -b feat-auth
  cd ../myapp-feat-auth
  dbless run -- npm run dev
`);
}

// ────────────────────────────────────────────────────────────────────────────
// Argv
// ────────────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else { flags[a.slice(2)] = argv[i + 1] ?? ""; i++; }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

(async () => {
  try {
    switch (cmd) {
      case "start":   await cmdStart(); break;
      case "stop":    await cmdStop(); break;
      case "status":  await cmdStatus(); break;
      case "init": {
        const { flags } = parseFlags(rest);
        await cmdInit({ name: flags.name, migrations: flags.migrations, seed: flags.seed });
        break;
      }
      case "run": {
        const dashIdx = rest.indexOf("--");
        const cmdArgs = dashIdx >= 0 ? rest.slice(dashIdx + 1) : rest;
        await cmdRun(cmdArgs);
        break;
      }
      case "shell":   await cmdShell(); break;
      case "reset":   await cmdReset(); break;
      case "prune":   await cmdPrune(); break;
      case "explain": await cmdExplain(); break;
      case "agents": {
        const { flags } = parseFlags(rest);
        await cmdAgents({ write: "write" in flags });
        break;
      }
      case "version":
      case "--version":
      case "-v":      console.log(VERSION); break;
      case undefined:
      case "help":
      case "--help":
      case "-h":      help(); break;
      default:
        console.log(fail(`unknown command: ${cmd}`));
        help();
        process.exit(1);
    }
  } catch (e) {
    console.error(fail((e as Error).message));
    process.exit(1);
  }
})();

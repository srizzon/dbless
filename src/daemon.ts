// Daemon entrypoint. Boots embedded Postgres + the proxy, then idles
// until SIGTERM/SIGINT. Started by `dbless start` via fork(); also
// runnable directly with `node --experimental-strip-types src/daemon.ts`
// for debugging.

import fs from "node:fs";
import path from "node:path";
import { makeEmbedded, isInitialised } from "./pg.ts";
import { startProxy, defaultEnsureBranch } from "./proxy.ts";
import {
  PG_PORT,
  PROXY_PORT,
  PG_PID_FILE,
  PROXY_PID_FILE,
  LOG_DIR,
  ensureDirs,
  writePid,
  clearPid,
} from "./state.ts";

ensureDirs();

const logPath = path.join(LOG_DIR, "daemon.log");
const logStream = fs.createWriteStream(logPath, { flags: "a" });
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  logStream.write(line);
  if (process.env.DBLESS_FOREGROUND) process.stdout.write(line);
};

const pg = makeEmbedded({ onLog: () => {} });

async function main() {
  if (!isInitialised()) {
    log("[daemon] initialising postgres data dir (first run)");
    await pg.initialise();
  }
  log(`[daemon] starting postgres on :${PG_PORT}`);
  await pg.start();
  writePid(PG_PID_FILE, process.pid);

  const proxy = startProxy({
    listenPort: PROXY_PORT,
    upstreamHost: "localhost",
    upstreamPort: PG_PORT,
    log,
    ensureBranch: defaultEnsureBranch,
  });
  proxy.on("listening", () => log(`[daemon] proxy listening on :${PROXY_PORT}`));
  writePid(PROXY_PID_FILE, process.pid);

  log("[daemon] ready");

  const shutdown = async (signal: string) => {
    log(`[daemon] ${signal} received, stopping`);
    proxy.close();
    try { await pg.stop(); } catch (e) { log(`[daemon] pg stop error: ${e}`); }
    clearPid(PG_PID_FILE);
    clearPid(PROXY_PID_FILE);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the event loop alive.
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  log(`[daemon] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});

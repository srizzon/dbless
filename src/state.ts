// Persistent state for the dbless daemon and CLI.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const ROOT = path.join(os.homedir(), ".dbless");
export const PG_DATA = path.join(ROOT, "pgdata");
export const STATE_FILE = path.join(ROOT, "state.json");
export const PG_PID_FILE = path.join(ROOT, "postgres.pid");
export const PROXY_PID_FILE = path.join(ROOT, "proxy.pid");
export const LOG_DIR = path.join(ROOT, "logs");

export const PG_PORT = Number(process.env.DBLESS_PG_PORT ?? 15432);
export const PROXY_PORT = Number(process.env.DBLESS_PROXY_PORT ?? 7777);
export const PG_USER = process.env.DBLESS_PG_USER ?? "dbless";
export const PG_PASSWORD = process.env.DBLESS_PG_PASSWORD ?? "dbless";

export type ProjectConfig = {
  name: string;
  migrations?: string;
  seed?: string;
};

export type State = {
  projects: Record<string, { name: string; templateBuiltAt?: number }>;
};

export function ensureDirs() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { projects: {} };
  }
}

export function writeState(s: State) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, "utf-8").trim());
    if (!pid) return null;
    process.kill(pid, 0); // probe
    return pid;
  } catch {
    return null;
  }
}

export function writePid(file: string, pid: number) {
  ensureDirs();
  fs.writeFileSync(file, String(pid));
}

export function clearPid(file: string) {
  try { fs.unlinkSync(file); } catch {}
}

// Lifecycle wrapper around embedded-postgres.

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { PG_DATA, PG_PORT, PG_USER, PG_PASSWORD } from "./state.ts";
import fs from "node:fs";

export function makeEmbedded(opts?: { onLog?: (s: string) => void }) {
  return new EmbeddedPostgres({
    databaseDir: PG_DATA,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    authMethod: "password",
    persistent: true,
    onLog: opts?.onLog ?? (() => {}),
    onError: (e) => process.stderr.write(`[pg] ${String(e)}\n`),
  });
}

export function isInitialised(): boolean {
  return fs.existsSync(PG_DATA) && fs.existsSync(`${PG_DATA}/PG_VERSION`);
}

export type PgConnectOpts = {
  database: string;
  host?: string;
  port?: number;
};

export function connect(opts: PgConnectOpts): pg.Client {
  return new pg.Client({
    host: opts.host ?? "localhost",
    port: opts.port ?? PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: opts.database,
  });
}

export async function exec(database: string, query: string, params?: unknown[]) {
  const client = connect({ database });
  await client.connect();
  try {
    return await client.query(query, params);
  } finally {
    await client.end();
  }
}

export async function databaseExists(name: string): Promise<boolean> {
  const r = await exec("postgres", "SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return r.rowCount === 1;
}

export async function databaseSize(name: string): Promise<number> {
  try {
    const r = await exec("postgres", "SELECT pg_database_size($1) AS size", [name]);
    return Number(r.rows[0].size);
  } catch {
    return 0;
  }
}

export async function listDatabases(prefix: string): Promise<string[]> {
  const r = await exec(
    "postgres",
    "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
    [`${prefix}%`]
  );
  return r.rows.map((row: { datname: string }) => row.datname);
}

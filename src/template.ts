// Template + branch CRUD. Branches are created via CREATE DATABASE TEMPLATE.

import path from "node:path";
import fs from "node:fs";
import { exec, databaseExists } from "./pg.ts";

export const TEMPLATE_PREFIX = "template_";

export const templateName = (project: string) => `${TEMPLATE_PREFIX}${project}`;
export const branchName = (project: string, worktreeId: string) => `${project}__${worktreeId}`;

export async function dropDatabase(name: string, force = true) {
  // PG13+ supports WITH (FORCE) which terminates active connections first.
  const sql = `DROP DATABASE IF EXISTS "${name}"${force ? " WITH (FORCE)" : ""}`;
  try {
    await exec("postgres", sql);
  } catch (e) {
    // Older Postgres: fall back to terminate + drop.
    if (force && /syntax error|FORCE/.test(String(e))) {
      await exec(
        "postgres",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
      await exec("postgres", `DROP DATABASE IF EXISTS "${name}"`);
    } else {
      throw e;
    }
  }
}

export async function createTemplate(project: string) {
  const name = templateName(project);
  await dropDatabase(name);
  await exec("postgres", `CREATE DATABASE "${name}"`);
}

export async function applySqlFile(database: string, file: string) {
  const sql = fs.readFileSync(file, "utf-8");
  await exec(database, sql);
}

export async function applySqlGlob(database: string, glob: string, cwd: string, exclude?: string) {
  // Minimal glob support: *.sql in a directory.
  const dir = path.dirname(glob);
  const pattern = path.basename(glob);
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const fullDir = path.resolve(cwd, dir);
  if (!fs.existsSync(fullDir)) {
    throw new Error(`migrations directory not found: ${fullDir}`);
  }
  const excludePath = exclude ? path.resolve(cwd, exclude) : null;
  const files = fs
    .readdirSync(fullDir)
    .filter((f) => re.test(f))
    .filter((f) => !excludePath || path.resolve(fullDir, f) !== excludePath)
    .sort();
  if (files.length === 0) {
    throw new Error(`no migrations matched ${glob} in ${fullDir}`);
  }
  for (const f of files) {
    await applySqlFile(database, path.join(fullDir, f));
  }
  return files;
}

export async function lockTemplate(project: string) {
  const name = templateName(project);
  // Quarantine: only superusers can clone from here, no app connects.
  await exec("postgres", `UPDATE pg_database SET datallowconn = false WHERE datname = '${name}'`);
}

export async function unlockTemplate(project: string) {
  const name = templateName(project);
  await exec("postgres", `UPDATE pg_database SET datallowconn = true WHERE datname = '${name}'`);
}

export async function ensureBranch(project: string, worktreeId: string): Promise<{ created: boolean; ms: number }> {
  const branch = branchName(project, worktreeId);
  if (await databaseExists(branch)) return { created: false, ms: 0 };

  const template = templateName(project);
  if (!(await databaseExists(template))) {
    throw new Error(`template ${template} does not exist — run \`dbless init\` from the project root first`);
  }

  // Allow temporary connect to template while the clone runs (then re-lock).
  await unlockTemplate(project);
  const t0 = Date.now();
  try {
    await exec("postgres", `CREATE DATABASE "${branch}" TEMPLATE "${template}"`);
  } finally {
    await lockTemplate(project);
  }
  return { created: true, ms: Date.now() - t0 };
}

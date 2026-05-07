// Postgres-protocol proxy with worktree-aware database routing.
//
// Reads the StartupMessage, extracts a custom GUC `dbless.worktree=<id>`
// from the `options` parameter, rewrites the `database` field to
// `<base>__<worktree>` and forwards. After the handshake the proxy is a
// transparent byte pipe.

import net from "node:net";
import { Buffer } from "node:buffer";
import { databaseExists } from "./pg.ts";
import { ensureBranch } from "./template.ts";

const PROTOCOL_3_0 = 196608;
const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

function parseStartupParams(body: Buffer): Map<string, string> {
  const params = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const keyEnd = body.indexOf(0, i);
    if (keyEnd === -1 || keyEnd === i) break;
    const key = body.subarray(i, keyEnd).toString("utf-8");
    i = keyEnd + 1;
    const valEnd = body.indexOf(0, i);
    if (valEnd === -1) break;
    const val = body.subarray(i, valEnd).toString("utf-8");
    params.set(key, val);
    i = valEnd + 1;
  }
  return params;
}

function buildStartupMessage(params: Map<string, string>): Buffer {
  let bodyLen = 1;
  for (const [k, v] of params) {
    bodyLen += Buffer.byteLength(k, "utf-8") + 1;
    bodyLen += Buffer.byteLength(v, "utf-8") + 1;
  }
  const totalLen = 4 + 4 + bodyLen;
  const buf = Buffer.alloc(totalLen);
  let i = 0;
  buf.writeInt32BE(totalLen, i); i += 4;
  buf.writeInt32BE(PROTOCOL_3_0, i); i += 4;
  for (const [k, v] of params) {
    i += buf.write(k, i, "utf-8");
    buf.writeUInt8(0, i++);
    i += buf.write(v, i, "utf-8");
    buf.writeUInt8(0, i++);
  }
  buf.writeUInt8(0, i);
  return buf;
}

const WORKTREE_RE = /(?:^|\s)(?:-c\s+)?dbless\.worktree=([A-Za-z0-9_-]+)/;

function extractWorktreeId(options: string | undefined): string | null {
  if (!options) return null;
  const m = WORKTREE_RE.exec(options);
  return m ? m[1] : null;
}

export type ProxyOptions = {
  listenPort: number;
  upstreamHost: string;
  upstreamPort: number;
  log?: (msg: string) => void;
  // If set, called with (project, worktree) when an unknown branch is seen,
  // and the connection is held until the branch exists.
  ensureBranch?: (project: string, worktree: string) => Promise<void>;
};

export function startProxy(opts: ProxyOptions): net.Server {
  const log = opts.log ?? ((m) => process.stdout.write(`${m}\n`));

  const server = net.createServer(async (client) => {
    const upstream = net.createConnection({ host: opts.upstreamHost, port: opts.upstreamPort });
    let upstreamReady = false;
    let startupHandled = false;
    let inbuf = Buffer.alloc(0);
    const pending: Buffer[] = [];

    const flush = () => {
      if (!upstreamReady) return;
      for (const b of pending) upstream.write(b);
      pending.length = 0;
    };

    const sendUp = (b: Buffer) => {
      if (upstreamReady) upstream.write(b);
      else pending.push(b);
    };

    upstream.on("connect", () => { upstreamReady = true; flush(); });
    upstream.on("data", (d) => client.write(d));
    upstream.on("close", () => client.end());
    upstream.on("error", (err) => {
      log(`[proxy] upstream error: ${err.message}`);
      client.destroy();
    });

    client.on("close", () => upstream.destroy());
    client.on("error", (err) => {
      log(`[proxy] client error: ${err.message}`);
      upstream.destroy();
    });

    client.on("data", async (data) => {
      if (startupHandled) {
        sendUp(data);
        return;
      }
      inbuf = Buffer.concat([inbuf, data]);

      while (inbuf.length >= 8 && !startupHandled) {
        const len = inbuf.readInt32BE(0);
        if (len < 8 || inbuf.length < len) break;

        const msg = inbuf.subarray(0, len);
        inbuf = inbuf.subarray(len);
        const code = msg.readInt32BE(4);

        if (len === 8 && (code === SSL_REQUEST || code === GSS_REQUEST)) {
          sendUp(msg);
          continue;
        }
        if (len === 16 && code === CANCEL_REQUEST) {
          sendUp(msg);
          startupHandled = true;
          if (inbuf.length > 0) { sendUp(inbuf); inbuf = Buffer.alloc(0); }
          return;
        }

        if (code === PROTOCOL_3_0) {
          const params = parseStartupParams(msg.subarray(8));
          const baseDb = params.get("database") ?? params.get("user") ?? "postgres";
          const worktree = extractWorktreeId(params.get("options"));

          if (worktree) {
            const newDb = `${baseDb}__${worktree}`;
            if (opts.ensureBranch) {
              try {
                client.pause();
                await opts.ensureBranch(baseDb, worktree);
                client.resume();
              } catch (e) {
                log(`[proxy] ensureBranch failed: ${(e as Error).message}`);
                client.destroy();
                upstream.destroy();
                return;
              }
            }
            params.set("database", newDb);
            sendUp(buildStartupMessage(params));
            log(`[proxy] route ${baseDb} → ${newDb} (worktree=${worktree})`);
          } else {
            sendUp(msg);
            log(`[proxy] passthrough ${baseDb} (no worktree)`);
          }

          startupHandled = true;
          if (inbuf.length > 0) { sendUp(inbuf); inbuf = Buffer.alloc(0); }
          return;
        }

        log(`[proxy] unknown protocol code 0x${code.toString(16)}, raw pipe`);
        sendUp(msg);
        startupHandled = true;
        if (inbuf.length > 0) { sendUp(inbuf); inbuf = Buffer.alloc(0); }
        return;
      }
    });
  });

  server.listen(opts.listenPort, "127.0.0.1");
  return server;
}

// Default ensureBranch: create the branch from `template_<project>` if missing.
export async function defaultEnsureBranch(project: string, worktree: string) {
  const dbName = `${project}__${worktree}`;
  if (await databaseExists(dbName)) return;
  await ensureBranch(project, worktree);
}

// serve.mjs — standalone node:http mount for present-share on a bare VM.
//
// Zero dependencies: a thin transport around share/core.mjs. All behavior lives
// in the core; this file only routes the three endpoints, streams the POST body
// with an early size-abort, and prints a startup banner. ~70 lines of logic.
//
//   node share/serve.mjs [--port N]
//
// Env: PRESENT_SHARE_DIR, PRESENT_SHARE_TOKEN, PRESENT_SHARE_MAX_BYTES,
//      PRESENT_SHARE_PUBLIC_URL, PORT. An optional <dir>/tokens.json adds more
//      tokens. Refuses to start with NO token configured — an open uploader is
//      a mistake.

import http from "node:http";
import { join } from "node:path";
import { createStore, createHandlers, DEFAULT_DIR } from "./core.mjs";

function parseArgs(argv) {
  const args = { port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = parseInt(argv[++i], 10);
    else if (a.startsWith("--port=")) args.port = parseInt(a.slice(7), 10);
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

const USAGE = `usage: node share/serve.mjs [--port N]

  --port N   port to listen on (default: env PORT or 8787)

env: PRESENT_SHARE_DIR (default ${DEFAULT_DIR}), PRESENT_SHARE_TOKEN (required),
     PRESENT_SHARE_MAX_BYTES, PRESENT_SHARE_PUBLIC_URL`;

// Write a core handler result ({ status, headers, body }) to the wire.
function send(res, result) {
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}

export function createServer(store) {
  const h = createHandlers(store);
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      return send(res, h.handleHealth());
    }

    if (req.method === "POST" && path === "/p") {
      let size = 0;
      let aborted = false;
      const chunks = [];
      req.on("data", (c) => {
        if (aborted) return;
        size += c.length;
        if (size > store.maxBytes) {
          // Enforce the cap WHILE receiving: answer 413 now and stop reading.
          // The request stream is destroyed only after the response flushes —
          // destroying first can discard the queued response with the socket.
          aborted = true;
          chunks.length = 0; // drop what was buffered so far
          res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({ error: `page exceeds max_upload_bytes (${store.maxBytes})` }),
            () => req.destroy(),
          );
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString("utf8");
        const query = Object.fromEntries(url.searchParams);
        send(res, h.handlePost({ headers: req.headers, query, body }));
      });
      req.on("error", () => {
        if (!aborted) {
          try {
            res.destroy();
          } catch {
            /* client already gone */
          }
        }
      });
      return;
    }

    const idMatch = path.match(/^\/p\/([^/]+)$/);
    if (req.method === "GET" && idMatch) {
      return send(res, h.handleGet({ id: decodeURIComponent(idMatch[1]) }));
    }

    send(res, {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "not found" }),
    });
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const dir = process.env.PRESENT_SHARE_DIR || DEFAULT_DIR;
  const maxBytes = process.env.PRESENT_SHARE_MAX_BYTES
    ? parseInt(process.env.PRESENT_SHARE_MAX_BYTES, 10)
    : undefined;

  const store = createStore({
    dir,
    token: process.env.PRESENT_SHARE_TOKEN || null,
    maxBytes,
    publicUrl: process.env.PRESENT_SHARE_PUBLIC_URL || null,
  });

  if (!store.hasTokens) {
    console.error(
      "error: refusing to start with no upload token configured.\n" +
        "        set PRESENT_SHARE_TOKEN, or add " +
        join(store.dir, "tokens.json") +
        " — an open uploader is a mistake.",
    );
    process.exit(1);
  }

  store.startSweepTimer();

  const port = Number.isFinite(args.port) ? args.port : parseInt(process.env.PORT, 10) || 8787;
  const server = createServer(store);
  server.listen(port, () => {
    const addr = server.address();
    const p = addr && typeof addr === "object" ? addr.port : port;
    console.log(`present-share listening on http://0.0.0.0:${p}`);
    console.log(`  dir:    ${store.dir}`);
    console.log(`  tokens: configured`);
    console.log(`  max:    ${store.maxBytes} bytes`);
    if (store.publicUrl) console.log(`  public: ${store.publicUrl}`);
    console.log(`  shares: ${store.count}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Don't wait forever on lingering keep-alive sockets.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

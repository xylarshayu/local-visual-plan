// share.mjs — give a rendered page a shareable URL.
//
// SELF-CONTAINED BY DESIGN. This file is installed into agent skill dirs
// WITHOUT the repo's share/ directory, so it uses node builtins only and
// imports NOTHING else — not even renderer siblings. Where the plan said
// "reuse share/core.mjs" to serve the tunnelled file, we instead inline a
// ~30-line single-file static server below, with the same CSP constant.
//
// Two modes, one verb:
//   Server mode (default): POST the file to a running present-share server and
//     print the durable URL it returns (VPN-scoped, the PR artifact).
//   Tunnel mode (--tunnel): serve the file locally and open an ephemeral PUBLIC
//     tunnel (pinggy over ssh by default) for "look at this now" moments.
//
// Usage:
//   node share.mjs <index.html> [--server URL] [--token-env NAME] [--ttl-days N]
//                  [--pr N] [--tunnel] [--minutes N] [--open]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";
import { spawn, spawnSync, execFile } from "node:child_process";

// The lock-down CSP served pages get — identical to share/core.mjs's constant.
// Inline everything, network nothing.
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

const USAGE = `usage: node share.mjs <index.html> [options]

  Server mode (default) — push to a present-share server, get a durable URL:
    --server URL       server base URL (default: env PRESENT_SHARE_URL)
    --token-env NAME   env var holding the bearer token (default: PRESENT_SHARE_TOKEN)
    --ttl-days N       retention in days (default 90 on the server; 0 = keep forever)
    --pr N             also post the URL as a comment on PR #N via the gh CLI
    --open             open the returned URL in a browser

  Tunnel mode — serve locally + open an ephemeral PUBLIC tunnel:
    --tunnel           enable tunnel mode
    --minutes N        auto-stop after N minutes (default: run until Ctrl-C / exit)
    --open             open the public URL in a browser

  Tunnel env: PRESENT_TUNNEL_CMD (command template, {port} substituted, run via
  sh -c), PRESENT_NO_TUNNEL_PATTERN (regex; refuse to tunnel a matching title).`;

/* -------------------------------------------------------------------------- *
 *  arg parsing (render.mjs house style)
 * -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const a = {
    input: null,
    server: null,
    tokenEnv: null,
    ttlDays: null,
    pr: null,
    tunnel: false,
    minutes: null,
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--tunnel") a.tunnel = true;
    else if (x === "--open") a.open = true;
    else if (x === "--server") a.server = argv[++i];
    else if (x.startsWith("--server=")) a.server = x.slice(9);
    else if (x === "--token-env") a.tokenEnv = argv[++i];
    else if (x.startsWith("--token-env=")) a.tokenEnv = x.slice(12);
    else if (x === "--ttl-days") a.ttlDays = argv[++i];
    else if (x.startsWith("--ttl-days=")) a.ttlDays = x.slice(11);
    else if (x === "--pr") a.pr = argv[++i];
    else if (x.startsWith("--pr=")) a.pr = x.slice(5);
    else if (x === "--minutes") a.minutes = argv[++i];
    else if (x.startsWith("--minutes=")) a.minutes = x.slice(10);
    else if (x === "-h" || x === "--help") a.help = true;
    else if (!x.startsWith("-") && !a.input) a.input = x;
  }
  return a;
}

/* -------------------------------------------------------------------------- *
 *  page metadata (self-contained; enough for the --tunnel refusal check)
 * -------------------------------------------------------------------------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&amp;/g, "&");
}

// Return every candidate title for the page: the pf-anchor-map title and the
// HTML <title>. The tunnel refusal check tests the pattern against all of them.
function pageTitles(html) {
  const titles = [];
  const m = html.match(/<script\b[^>]*id=["']pf-anchor-map["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) {
    try {
      const meta = JSON.parse(m[1]);
      if (meta && meta.title) titles.push(String(meta.title));
    } catch { /* ignore malformed anchor map */ }
  }
  const t = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) titles.push(decodeEntities(t[1].trim()));
  return titles;
}

/* -------------------------------------------------------------------------- *
 *  server mode
 * -------------------------------------------------------------------------- */

async function runServerMode(args, html) {
  const server = (args.server || process.env.PRESENT_SHARE_URL || "").replace(/\/+$/, "");
  if (!server) {
    console.error("error: no server URL — pass --server URL or set PRESENT_SHARE_URL");
    process.exit(2);
  }
  const tokenEnvName = args.tokenEnv || "PRESENT_SHARE_TOKEN";
  const token = process.env[tokenEnvName];
  if (!token) {
    console.error(`error: no upload token — set $${tokenEnvName}`);
    process.exit(2);
  }

  let url = `${server}/p`;
  if (args.ttlDays != null && args.ttlDays !== "") {
    const n = parseInt(args.ttlDays, 10);
    if (Number.isFinite(n) && n >= 0) url += `?ttl_days=${n}`;
  }

  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/html" },
      body: html,
    });
    text = await res.text();
  } catch (e) {
    console.error(`error: could not reach ${server}: ${e.message}`);
    process.exit(1);
  }

  let payload = null;
  try { payload = JSON.parse(text); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const msg = payload && payload.error ? payload.error : `HTTP ${res.status}`;
    console.error(`error: upload failed (${res.status}): ${msg}`);
    process.exit(1);
  }

  const shareUrl = payload && payload.url;
  if (!shareUrl) {
    console.error("error: server did not return a url");
    process.exit(1);
  }

  // Same "url:" reporting convention as render.mjs / open.mjs.
  if (payload.title) console.log(`title:   ${payload.title}`);
  console.log(`url:     ${shareUrl}`);
  if (payload.docId) console.log(`docId:   ${payload.docId}`);
  console.log(`expires: ${payload.expires_at || "never"}`);

  if (args.pr != null) await postPrComment(args.pr, payload.title || "shared page", shareUrl);

  if (args.open) await openUrl(shareUrl);
}

// Post the link to a PR via the gh CLI. Reports the absence of gh cleanly (a
// missing gh is not a failure of the upload — the URL is already printed).
function postPrComment(pr, title, url) {
  return new Promise((done) => {
    const n = String(pr).trim();
    if (!/^\d+$/.test(n)) {
      console.error(`warning: --pr expects a number, got "${pr}" — skipping PR comment`);
      return done();
    }
    const body = `${title}\n${url}`;
    execFile("gh", ["pr", "comment", n, "--body", body], (err, _stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") {
          console.error("note: gh CLI not found — skipped PR comment (the url above still stands)");
        } else {
          console.error(`warning: gh pr comment failed: ${(stderr || err.message || "").trim()}`);
        }
      } else {
        console.log(`posted: PR #${n} comment`);
      }
      done();
    });
  });
}

/* -------------------------------------------------------------------------- *
 *  tunnel mode
 * -------------------------------------------------------------------------- */

function hasCommand(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]);
  return r.status === 0;
}

// A minimal single-file static server: every request gets the one page under
// the same lock-down CSP. (Inlined here to keep share.mjs self-contained.)
function startStaticServer(html) {
  return new Promise((done) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP,
      });
      res.end(req.method === "HEAD" ? undefined : html);
    });
    server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port }));
  });
}

// Choose the tunnel command. Precedence: PRESENT_TUNNEL_CMD template, else ssh
// (pinggy), else cloudflared. Returns { file, args } for spawn, or null.
function tunnelCommand(port) {
  const tpl = process.env.PRESENT_TUNNEL_CMD;
  if (tpl && tpl.trim()) {
    return { file: "sh", args: ["-c", tpl.replace(/\{port\}/g, String(port))] };
  }
  if (hasCommand("ssh")) {
    return { file: "ssh", args: ["-p", "443", `-R0:localhost:${port}`, "a.pinggy.io"] };
  }
  if (hasCommand("cloudflared")) {
    return { file: "cloudflared", args: ["tunnel", "--url", `http://localhost:${port}`] };
  }
  return null;
}

const HTTPS_URL_RE = /https:\/\/[^\s"'<>()]+/;

async function runTunnelMode(args, html) {
  // Refuse to tunnel a page whose title is marked confidential.
  const patStr = process.env.PRESENT_NO_TUNNEL_PATTERN;
  if (patStr && patStr.trim()) {
    let re;
    try {
      re = new RegExp(patStr);
    } catch (e) {
      console.error(`error: PRESENT_NO_TUNNEL_PATTERN is not a valid regex: ${e.message}`);
      process.exit(2);
    }
    const titles = pageTitles(html);
    const hit = titles.find((t) => re.test(t));
    if (hit) {
      console.error(
        `refusing to tunnel: the page title matches PRESENT_NO_TUNNEL_PATTERN (/${patStr}/).\n` +
          `  offending title: ${hit}\n` +
          `  this page looks confidential; tunnel mode makes it PUBLIC. Use server mode (VPN-scoped) instead.`,
      );
      process.exit(1);
    }
  }

  // ALWAYS warn — the link is public internet for the tunnel's lifetime.
  console.error(
    "WARNING: this link is public internet for the tunnel's lifetime — anyone with\n" +
      "         the URL can view the page, with no VPN in front. Stop it (Ctrl-C) when done.",
  );

  const { server, port } = await startStaticServer(html);
  console.error(`serving locally on http://127.0.0.1:${port}`);

  const cmd = tunnelCommand(port);
  if (!cmd) {
    console.error(
      "error: no tunnel provider — install ssh or cloudflared, or set PRESENT_TUNNEL_CMD",
    );
    server.close();
    process.exit(1);
  }

  const child = spawn(cmd.file, cmd.args, { stdio: ["ignore", "pipe", "pipe"] });

  let shuttingDown = false;
  let printedUrl = false;
  let killTimer = null;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (killTimer) clearTimeout(killTimer);
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  };

  // Scrape both streams for the first https URL, then keep relaying child output
  // so the user still sees the tunnel's own logs.
  const scan = (buf) => {
    const s = buf.toString();
    process.stderr.write(s); // relay
    if (!printedUrl) {
      const m = s.match(HTTPS_URL_RE);
      if (m) {
        printedUrl = true;
        const publicUrl = m[0];
        console.log("");
        console.log("  ┌─ public link (share it, then Ctrl-C to stop) ─");
        console.log(`  url:     ${publicUrl}`);
        console.log("  └───────────────────────────────────────────────");
        if (args.open) openUrl(publicUrl);
      }
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);

  child.on("error", (e) => {
    console.error(`error: could not start tunnel (${cmd.file}): ${e.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`tunnel exited (${signal || code}); shutting down.`);
      shutdown(code || 0);
    }
  });

  process.on("SIGINT", () => {
    console.error("\nstopping…");
    shutdown(0);
  });
  process.on("SIGTERM", () => shutdown(0));

  const minutes = args.minutes != null ? parseFloat(args.minutes) : NaN;
  if (Number.isFinite(minutes) && minutes > 0) {
    console.error(`will auto-stop after ${minutes} minute(s).`);
    killTimer = setTimeout(() => {
      console.error("time limit reached; stopping.");
      shutdown(0);
    }, minutes * 60 * 1000);
  }
}

/* -------------------------------------------------------------------------- *
 *  shared: --open — a tiny URL opener. Inlined (open.mjs opens FILE paths and
 *  would resolve() an http URL into a broken filesystem path); keeps this file
 *  fully import-free so it works wherever it's installed.
 * -------------------------------------------------------------------------- */

async function openUrl(url) {
  const candidates = [];
  if (process.env.BROWSER) {
    const parts = process.env.BROWSER.trim().split(/\s+/);
    candidates.push([parts[0], [...parts.slice(1), url]]);
  }
  for (const c of ["wslview", "xdg-open"]) {
    if (hasCommand(c)) candidates.push([c, [url]]);
  }
  for (const [cmd, cargs] of candidates) {
    const r = spawnSync(cmd, cargs, { stdio: "ignore", timeout: 4000 });
    if (!r.error && !r.signal && r.status === 0) {
      console.error(`opened via ${cmd}`);
      return;
    }
  }
  console.error("note: could not auto-open — click the url above");
}

/* -------------------------------------------------------------------------- *
 *  main
 * -------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.input) {
    console.error("error: no input HTML file given\n");
    console.error(USAGE);
    process.exit(2);
  }

  let html;
  try {
    html = readFileSync(resolve(args.input), "utf8");
  } catch (e) {
    console.error(`error: cannot read ${args.input}: ${e.message}`);
    process.exit(1);
  }

  if (args.tunnel) await runTunnelMode(args, html);
  else await runServerMode(args, html);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

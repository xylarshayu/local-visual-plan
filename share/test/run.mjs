#!/usr/bin/env node
// Zero-dependency test runner for present-share: core + the node:http mount,
// end-to-end over a real ephemeral-port server, plus the share.mjs CLI's
// tunnel plumbing (no real network — a fake tunnel command stands in).
// Uses only node builtins: node:assert, node:fs, node:http, node:child_process.
//
// Run:  node share/test/run.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

import {
  CSP,
  createStore,
  createHandlers,
  parseDocMeta,
  looksLikeHtml,
  randomId,
  sha256hex,
} from "../core.mjs";
import { createServer } from "../serve.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVE_PATH = join(__dirname, "..", "serve.mjs");
const CLI_PATH = join(__dirname, "..", "..", "skills", "present", "renderer", "share.mjs");

/* -------------------------------------------------------------------------- *
 *  tiny harness (same PASS/FAIL reporting style as the renderer suite,
 *  extended with async checks)
 * -------------------------------------------------------------------------- */

let totalPass = 0;
let totalFail = 0;

function group(name) {
  console.log(`\n# ${name}`);
}

async function check(label, fn) {
  try {
    await fn();
    totalPass++;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    totalFail++;
    console.log(`  FAIL  ${label}`);
    const msg = (err && err.message ? err.message : String(err))
      .split("\n")
      .map((l) => "          " + l)
      .join("\n");
    console.log(msg);
  }
}

/* -------------------------------------------------------------------------- *
 *  fixtures + scratch space
 * -------------------------------------------------------------------------- */

const TMP = mkdtempSync(join(tmpdir(), "present-share-test-"));

const FIXTURE_DOC_ID = "pf-test12ab34cd";
const FIXTURE_TITLE = "Share Test Page: the fixture";
const FIXTURE_META = {
  version: 1,
  docId: FIXTURE_DOC_ID,
  source: "/x/plan.md",
  title: FIXTURE_TITLE,
  anchors: { "chapter:one": { kind: "chapter", label: "One", lines: [1, 2] } },
};
// A real pf-anchor-map script, embedded the way render.mjs does ("</" is
// escaped as "<\/" in the JSON so it can never close the script tag).
const FIXTURE_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Fallback &amp; Title</title></head><body>" +
  "<h1>fixture</h1>" +
  `<script type="application/json" id="pf-anchor-map">${JSON.stringify(FIXTURE_META).replace(/<\//g, "<\\/")}</script>` +
  "</body></html>";

function httpGet(port, path) {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

function httpPost(port, path, { token, body, contentType = "text/html" } = {}) {
  const headers = { "content-type": contentType };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: body ?? "" });
}

// Raw POST via http.request for the streaming 413 case: fetch can surface an
// early server-side abort as a client error, while http.request hands us the
// response that was flushed before the socket died.
function rawPost(port, path, headers, bodyBuffer) {
  return new Promise((resolveP, rejectP) => {
    let settled = false;
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          settled = true;
          resolveP({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", (e) => {
      // EPIPE/ECONNRESET after the response was read is the expected shape of
      // an early abort; only fail if we never got the response.
      if (!settled) rejectP(e);
    });
    req.end(bodyBuffer);
  });
}

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

// Async on purpose: several CLI runs talk to the HTTP server hosted in THIS
// process, so a blocking spawnSync would deadlock (child waiting on a server
// whose event loop is blocked by the wait). spawn + promise keeps us serving.
function runCli(cliArgs, env, timeout = 20000) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [CLI_PATH, ...cliArgs], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const t = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (status, signal) => {
      clearTimeout(t);
      resolveP({ status, signal, stdout, stderr });
    });
  });
}

/* -------------------------------------------------------------------------- *
 *  main
 * -------------------------------------------------------------------------- */

async function main() {
  /* ---------------- pure core: parseDocMeta / looksLikeHtml / ids -------- */
  group("core: parseDocMeta + helpers");

  await check("lifts docId and title from a real pf-anchor-map", () => {
    const m = parseDocMeta(FIXTURE_HTML);
    assert.equal(m.docId, FIXTURE_DOC_ID);
    assert.equal(m.title, FIXTURE_TITLE);
  });

  await check("no anchor map -> docId null, title falls back to <title> (entities decoded)", () => {
    const m = parseDocMeta("<html><head><title>Fallback &amp; Title</title></head><body>x</body></html>");
    assert.equal(m.docId, null);
    assert.equal(m.title, "Fallback & Title");
  });

  await check("malformed anchor-map JSON -> <title> fallback, not a throw", () => {
    const m = parseDocMeta('<title>T2</title><script type="application/json" id="pf-anchor-map">{oops</script>');
    assert.equal(m.docId, null);
    assert.equal(m.title, "T2");
  });

  await check("neither anchor map nor <title> -> \"untitled\"", () => {
    const m = parseDocMeta("<html><body><p>hello</p></body></html>");
    assert.equal(m.docId, null);
    assert.equal(m.title, "untitled");
  });

  await check("looksLikeHtml rejects empty/whitespace/plain text, accepts tags", () => {
    assert.equal(looksLikeHtml(""), false);
    assert.equal(looksLikeHtml("   \n\t "), false);
    assert.equal(looksLikeHtml("just some plain text"), false);
    assert.equal(looksLikeHtml('{"json": true}'), false);
    assert.equal(looksLikeHtml("<!doctype html><p>x</p>"), true);
    assert.equal(looksLikeHtml(FIXTURE_HTML), true);
  });

  await check("randomId: 8 chars of [a-z0-9], every time", () => {
    for (let i = 0; i < 500; i++) assert.match(randomId(), /^[a-z0-9]{8}$/);
  });

  /* ---------------- HTTP end-to-end over serve.mjs's transport ----------- */
  group("http: serve.mjs transport + core handlers (ephemeral port)");

  const DIR_HTTP = join(TMP, "http-store");
  const TOKEN = "goodtoken-abc123";
  const MAX = 65536; // small cap so the 413 test is cheap; fixture fits easily
  const store = createStore({ dir: DIR_HTTP, token: TOKEN, maxBytes: MAX });
  const server = createServer(store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  await check("401 with no Authorization header", async () => {
    const res = await httpPost(port, "/p", { body: FIXTURE_HTML });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "bad or missing upload token" });
  });

  await check("401 with a wrong token", async () => {
    const res = await httpPost(port, "/p", { token: "wrong-token", body: FIXTURE_HTML });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "bad or missing upload token" });
  });

  await check("400 empty body", async () => {
    const res = await httpPost(port, "/p", { token: TOKEN, body: "" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "empty or non-HTML body" });
  });

  await check("400 obviously-non-HTML body", async () => {
    const res = await httpPost(port, "/p", { token: TOKEN, body: "plain text, no tags at all" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "empty or non-HTML body" });
  });

  await check("413 while receiving a body over maxBytes (early abort)", async () => {
    const big = Buffer.alloc(MAX * 4, "a"); // 4x the cap
    const res = await rawPost(port, "/p", { authorization: `Bearer ${TOKEN}`, "content-type": "text/html" }, big);
    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(res.body), { error: `page exceeds max_upload_bytes (${MAX})` });
  });

  let happy; // the 201 payload — reused by the GET checks below
  await check("201 happy path lifts docId + title from the pf-anchor-map", async () => {
    const res = await httpPost(port, "/p", { token: TOKEN, body: FIXTURE_HTML });
    assert.equal(res.status, 201);
    happy = await res.json();
    assert.match(happy.id, /^[a-z0-9]{8}$/);
    assert.equal(happy.docId, FIXTURE_DOC_ID);
    assert.equal(happy.title, FIXTURE_TITLE);
    // no PRESENT_SHARE_PUBLIC_URL configured -> url built from the Host header
    assert.equal(happy.url, `http://127.0.0.1:${port}/p/${happy.id}`);
    // default ttl 90 days -> an ISO timestamp ~90 days out
    assert.ok(happy.expires_at, "expires_at set");
    const days = (Date.parse(happy.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 89 && days < 91, `~90 days out (got ${days.toFixed(2)})`);
  });

  await check("GET round-trips the exact bytes with the exact CSP header", async () => {
    const res = await httpGet(port, `/p/${happy.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("content-security-policy"), CSP);
    assert.equal(
      CSP,
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    );
    assert.equal(await res.text(), FIXTURE_HTML);
  });

  await check("GET unknown id -> 404", async () => {
    const res = await httpGet(port, "/p/zzzzzzzz");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "unknown or expired share" });
  });

  await check("ttl_days=0 -> expires_at null (keep forever)", async () => {
    const res = await httpPost(port, "/p?ttl_days=0", { token: TOKEN, body: FIXTURE_HTML });
    assert.equal(res.status, 201);
    const p = await res.json();
    assert.equal(p.expires_at, null);
    const entry = readManifest(DIR_HTTP).shares.find((s) => s.id === p.id);
    assert.equal(entry.expires_at, null);
  });

  await check("expired share on GET -> 404 AND file + manifest entry removed", async () => {
    // Plant an already-expired share via the store API (ttlDays -1 => yesterday).
    const entry = store.add({ html: FIXTURE_HTML, docId: "pf-x", title: "old", ttlDays: -1 });
    assert.ok(existsSync(join(DIR_HTTP, entry.file)), "content file exists before GET");
    const res = await httpGet(port, `/p/${entry.id}`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "unknown or expired share" });
    assert.ok(!existsSync(join(DIR_HTTP, entry.file)), "content file deleted lazily");
    assert.ok(!readManifest(DIR_HTTP).shares.some((s) => s.id === entry.id), "manifest entry removed");
  });

  await check("GET /healthz -> { ok, shares }", async () => {
    const res = await httpGet(port, "/healthz");
    assert.equal(res.status, 200);
    const h = await res.json();
    assert.equal(h.ok, true);
    assert.equal(h.shares, store.count);
    assert.equal(typeof h.shares, "number");
  });

  await check("manifest survives a store reload (fresh createStore, same dir)", async () => {
    const reloaded = createStore({ dir: DIR_HTTP, token: TOKEN });
    const hit = reloaded.get(happy.id);
    assert.ok(hit, "reloaded store still has the happy-path share");
    assert.equal(hit.html, FIXTURE_HTML);
    assert.equal(hit.entry.doc_id, FIXTURE_DOC_ID);
    assert.equal(hit.entry.title, FIXTURE_TITLE);
    assert.equal(hit.entry.token_id, "default");
    assert.equal(hit.entry.size_bytes, Buffer.byteLength(FIXTURE_HTML, "utf8"));
  });

  /* ---------------- tokens.json ----------------------------------------- */
  group("store: tokens.json (hashed secrets)");

  const DIR_TOK = join(TMP, "tok-store");
  const SECRET = "s3cret-token-xyz-42";
  mkdirSync(DIR_TOK, { recursive: true });
  writeFileSync(
    join(DIR_TOK, "tokens.json"),
    JSON.stringify([{ id: "ci", label: "github actions", secret_hash: sha256hex(SECRET) }], null, 2),
  );
  const tokStore = createStore({ dir: DIR_TOK }); // no env-style token at all
  const tokHandlers = createHandlers(tokStore);

  await check("hash in tokens.json verifies; wrong secret does not", () => {
    assert.equal(tokStore.hasTokens, true);
    assert.equal(tokStore.verifyToken(SECRET), "ci");
    assert.equal(tokStore.verifyToken("nope"), null);
    assert.equal(tokStore.verifyToken(""), null);
    assert.equal(tokStore.verifyToken(null), null);
  });

  await check("upload with a tokens.json secret records its token_id", () => {
    const r = tokHandlers.handlePost({
      headers: { authorization: `Bearer ${SECRET}` },
      query: {},
      body: FIXTURE_HTML,
    });
    assert.equal(r.status, 201);
    const id = JSON.parse(r.body).id;
    assert.equal(readManifest(DIR_TOK).shares.find((s) => s.id === id).token_id, "ci");
  });

  await check("plaintext secret is never written anywhere in the store dir", () => {
    for (const f of readdirSync(DIR_TOK)) {
      const content = readFileSync(join(DIR_TOK, f), "utf8");
      assert.ok(!content.includes(SECRET), `${f} must not contain the plaintext secret`);
    }
  });

  /* ---------------- sweep ------------------------------------------------ */
  group("store: TTL sweep");

  await check("sweep removes expired entries (file + manifest), keeps live ones", () => {
    const DIR_SWEEP = join(TMP, "sweep-store");
    const s = createStore({ dir: DIR_SWEEP, token: "t" });
    const dead = s.add({ html: FIXTURE_HTML, title: "dead", ttlDays: -2 });
    const forever = s.add({ html: FIXTURE_HTML, title: "forever", ttlDays: 0 });
    const live = s.add({ html: FIXTURE_HTML, title: "live", ttlDays: 30 });
    assert.equal(s.sweep(), 1);
    assert.equal(s.count, 2);
    assert.ok(!existsSync(join(DIR_SWEEP, dead.file)), "expired content file removed");
    const ids = readManifest(DIR_SWEEP).shares.map((x) => x.id);
    assert.deepEqual(ids.sort(), [forever.id, live.id].sort());
  });

  await check("startup sweep clears entries that expired while down", () => {
    const DIR_BOOT = join(TMP, "boot-store");
    const s1 = createStore({ dir: DIR_BOOT, token: "t" });
    const dead = s1.add({ html: FIXTURE_HTML, title: "dead", ttlDays: -1 });
    const s2 = createStore({ dir: DIR_BOOT, token: "t" }); // fresh boot
    assert.equal(s2.count, 0);
    assert.equal(s2.get(dead.id), null);
    assert.ok(!existsSync(join(DIR_BOOT, dead.file)));
  });

  /* ---------------- serve.mjs refuses to run open --------------------------- */
  group("serve.mjs: startup guard");

  await check("refuses to start with no token configured", () => {
    const r = spawnSync(process.execPath, [SERVE_PATH, "--port", "0"], {
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: process.env.PATH, PRESENT_SHARE_DIR: join(TMP, "no-token-store") },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to start/i);
    assert.match(r.stderr, /PRESENT_SHARE_TOKEN/);
  });

  /* ---------------- CLI: server mode ------------------------------------- */
  group("share.mjs CLI: server mode (against the in-process server)");

  const fixturePath = join(TMP, "fixture.html");
  writeFileSync(fixturePath, FIXTURE_HTML, "utf8");

  await check("uploads, prints url:/docId:/expires:, and warns on non-numeric --pr", async () => {
    const r = await runCli(
      [fixturePath, "--server", `http://127.0.0.1:${port}`, "--ttl-days", "0", "--pr", "abc"],
      { PRESENT_SHARE_TOKEN: TOKEN },
    );
    assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
    const m = r.stdout.match(/^url:\s+(\S+)$/m);
    assert.ok(m, `stdout has a url: line\n${r.stdout}`);
    assert.match(r.stdout, new RegExp(`docId:\\s+${FIXTURE_DOC_ID}`));
    assert.match(r.stdout, /expires:\s+never/);
    assert.match(r.stderr, /--pr expects a number/);
    // and the returned URL actually serves the exact bytes
    const res = await fetch(m[1]);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), FIXTURE_HTML);
    assert.equal(res.headers.get("content-security-policy"), CSP);
  });

  await check("clean error on a wrong token (401 surfaced, exit 1)", async () => {
    const r = await runCli([fixturePath, "--server", `http://127.0.0.1:${port}`], {
      PRESENT_SHARE_TOKEN: "wrong",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /upload failed \(401\): bad or missing upload token/);
  });

  await check("--token-env NAME reads the token from that variable", async () => {
    const r = await runCli(
      [fixturePath, "--server", `http://127.0.0.1:${port}`, "--token-env", "MY_SHARE_TOKEN"],
      { MY_SHARE_TOKEN: TOKEN },
    );
    assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
    assert.match(r.stdout, /^url:\s+http/m);
  });

  /* ---------------- CLI: tunnel plumbing (no real network) ---------------- */
  group("share.mjs CLI: tunnel mode via a fake PRESENT_TUNNEL_CMD");

  // The fake tunnel proves the whole chain: {port} substitution -> it fetches
  // the CLI's inline static server on that port (checking status/CSP/body) ->
  // prints an https URL for the CLI to scrape -> exits, which shuts the CLI down.
  const fakeTunnelPath = join(TMP, "fake-tunnel.mjs");
  writeFileSync(
    fakeTunnelPath,
    [
      "const port = process.argv[2];",
      "const res = await fetch(`http://127.0.0.1:${port}/`);",
      "const body = await res.text();",
      "console.log(`LOCAL status=${res.status} marker=${body.includes('pf-anchor-map') ? 'yes' : 'no'}`);",
      "console.log(`LOCALCSP ${res.headers.get('content-security-policy')}`);",
      "console.log('Tunnel established at https://fake-tunnel.test/abc123 for you');",
      "setTimeout(() => process.exit(0), 400);",
      "",
    ].join("\n"),
    "utf8",
  );
  const FAKE_CMD = `${process.execPath} ${fakeTunnelPath} {port}`;

  await check("surfaces the tunnel's https URL; warning printed; local server + CSP verified", async () => {
    const r = await runCli([fixturePath, "--tunnel"], { PRESENT_TUNNEL_CMD: FAKE_CMD });
    assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
    // the scraped public URL is printed prominently on stdout as a url: line
    assert.match(r.stdout, /url:\s+https:\/\/fake-tunnel\.test\/abc123/);
    // the public-link warning is ALWAYS printed (before the tunnel spawns)
    assert.match(r.stderr, /public internet for the tunnel's lifetime/);
    // the fake tunnel reached the inline static server: 200, our page, our CSP
    assert.match(r.stderr, /LOCAL status=200 marker=yes/);
    assert.ok(r.stderr.includes(`LOCALCSP ${CSP}`), "inline server serves the exact CSP");
    // child output was relayed
    assert.match(r.stderr, /Tunnel established at/);
  });

  await check("PRESENT_NO_TUNNEL_PATTERN refusal: no server, no tunnel, exit 1", async () => {
    const r = await runCli([fixturePath, "--tunnel"], {
      PRESENT_TUNNEL_CMD: FAKE_CMD,
      PRESENT_NO_TUNNEL_PATTERN: "Share Test",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to tunnel/);
    assert.match(r.stderr, /PRESENT_NO_TUNNEL_PATTERN/);
    assert.ok(!r.stderr.includes("LOCAL "), "the tunnel command must never run");
    assert.ok(!r.stdout.includes("https://fake-tunnel.test"), "no public URL printed");
  });

  await check("an invalid PRESENT_NO_TUNNEL_PATTERN regex fails closed (exit 2)", async () => {
    const r = await runCli([fixturePath, "--tunnel"], {
      PRESENT_TUNNEL_CMD: FAKE_CMD,
      PRESENT_NO_TUNNEL_PATTERN: "([unclosed",
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a valid regex/);
    assert.ok(!r.stdout.includes("https://"), "nothing served/tunnelled");
  });

  /* ---------------- teardown --------------------------------------------- */
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });

  console.log("\n" + "─".repeat(60));
  console.log(`Total: ${totalPass} passed, ${totalFail} failed`);
  if (totalFail > 0) {
    console.log("RESULT: FAIL");
    process.exit(1);
  } else {
    console.log("RESULT: PASS");
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});

// core.mjs — the portable, zero-dependency heart of present-share.
//
// Everything that decides *behavior* lives here as pure-ish functions so both
// mounts (serve.mjs on node:http, fastify-plugin.mjs on fastify) stay thin and
// the one zero-dep test suite covers them both. Node builtins only; global
// fetch is never used here (this is the server side).
//
// The pieces:
//   parseDocMeta(html)          -> { docId, title }  lifted from the page itself
//   createStore(opts)           -> flat-file store: manifest + <id>.html files,
//                                  token verification, add/get/delete, TTL sweep
//   createHandlers(store)       -> { handlePost, handleGet, handleHealth }
//                                  framework-agnostic: each returns
//                                  { status, headers, body } with body a string
//
// The HTTP contract (frozen by the approved plan) is implemented here verbatim;
// the mounts only move bytes on and off the wire.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

/* ========================================================================== *
 *  Constants — the frozen contract values
 * ========================================================================== */

// The exact lock-down CSP every served page gets. Inline everything, network
// nothing: even a hostile wireframe body can't phone home from a browser.
export const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export const DEFAULT_MAX_BYTES = 8388608; // 8 MiB
export const DEFAULT_TTL_DAYS = 90;
export const DEFAULT_DIR = "./share-data";
const MANIFEST_NAME = "manifest.json";
const TOKENS_NAME = "tokens.json";
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24h
const DAY_MS = 24 * 60 * 60 * 1000;

/* ========================================================================== *
 *  Small helpers
 * ========================================================================== */

export function sha256hex(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

// 8 chars from [a-z0-9] using crypto.randomBytes, with rejection sampling so the
// distribution over the 36-char alphabet is unbiased (256 % 36 != 0, so bytes
// >= 252 are redrawn rather than folded).
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars
export function randomId(len = 8) {
  const out = [];
  while (out.length < len) {
    const buf = randomBytes(len * 2);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      if (b >= 252) continue; // 252 = 36*7; reject the biased tail
      out.push(ID_ALPHABET[b % 36]);
    }
  }
  return out.join("");
}

// Timing-safe compare of two sha256 hex digests. Both are 64 hex chars -> 32
// bytes; unequal/short/garbage lengths fail closed before timingSafeEqual (which
// throws on length mismatch).
function timingSafeHexEqual(aHex, bHex) {
  let a, b;
  try {
    a = Buffer.from(String(aHex), "hex");
    b = Buffer.from(String(bHex), "hex");
  } catch {
    return false;
  }
  if (a.length !== 32 || b.length !== 32) return false;
  return timingSafeEqual(a, b);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/g, "&");
}

/* ========================================================================== *
 *  parseDocMeta — lift identity from the page itself
 * ========================================================================== */

// Every rendered page embeds `<script type="application/json" id="pf-anchor-map">`
// whose JSON carries { docId, title, ... }. Lift both from the upload so the
// store is content-aware for free. Absence is tolerated at every step:
//   docId -> null when there's no anchor map (or it lacks a docId)
//   title -> anchor-map title, else the HTML <title>, else "untitled"
export function parseDocMeta(html) {
  const src = typeof html === "string" ? html : String(html ?? "");
  let docId = null;
  let title = null;

  const m = src.match(
    /<script\b[^>]*id=["']pf-anchor-map["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (m) {
    try {
      // The renderer escapes "</" as "<\/" inside the JSON; JSON.parse reads
      // "\/" as "/", so no pre-unescape is needed.
      const meta = JSON.parse(m[1]);
      if (meta && typeof meta === "object") {
        if (meta.docId != null && meta.docId !== "") docId = String(meta.docId);
        if (meta.title != null && String(meta.title).trim() !== "")
          title = String(meta.title).trim();
      }
    } catch {
      /* malformed anchor map — fall through to <title> */
    }
  }

  if (title == null) {
    const t = src.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (t && t[1].trim()) title = decodeEntities(t[1].trim());
  }
  if (title == null || title === "") title = "untitled";

  return { docId, title };
}

// Heuristic gate for "obviously non-HTML" bodies: reject empty/whitespace and
// anything with no tag-shaped `<...>` at all (plain text, bare JSON, etc.).
export function looksLikeHtml(body) {
  if (body == null) return false;
  const s = typeof body === "string" ? body : String(body);
  if (s.trim() === "") return false;
  return /<[a-z!/][^>]*>/i.test(s);
}

/* ========================================================================== *
 *  createStore — flat-file manifest + <id>.html content files
 * ========================================================================== */

function freshManifest() {
  return { version: 1, shares: [] };
}

// Load the set of accepted tokens as [{ id, secret_hash }]:
//   (a) a single env token -> token_id "default"
//   (b) an optional tokens.json [{ id, label, secret_hash }] — secret_hash is
//       the sha256 hex of the bearer secret; plaintext is never stored.
function loadTokens({ token, tokensFile, dir }) {
  const tokens = [];
  if (token != null && String(token) !== "") {
    tokens.push({ id: "default", secret_hash: sha256hex(token) });
  }
  const file =
    tokensFile != null
      ? tokensFile
      : dir
        ? join(dir, TOKENS_NAME)
        : null;
  if (file && existsSync(file)) {
    try {
      const arr = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(arr)) {
        for (const t of arr) {
          if (t && t.secret_hash) {
            tokens.push({
              id: t.id != null ? String(t.id) : "token",
              label: t.label != null ? String(t.label) : undefined,
              secret_hash: String(t.secret_hash),
            });
          }
        }
      }
    } catch {
      /* a corrupt tokens.json must not silently open the uploader — but it also
         must not crash startup: env token (if any) still stands. */
    }
  }
  return tokens;
}

function isExpired(entry, nowMs) {
  return !!(entry.expires_at && Date.parse(entry.expires_at) <= nowMs);
}

/**
 * Create a store bound to a directory. Loads (or initializes) the manifest and
 * the token set immediately, then does one startup sweep.
 *
 * opts: { dir, token, tokensFile, maxBytes, publicUrl }
 */
export function createStore(opts = {}) {
  const dir = resolve(opts.dir || DEFAULT_DIR);
  const maxBytes =
    Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
      ? Math.floor(opts.maxBytes)
      : DEFAULT_MAX_BYTES;
  const publicUrl = opts.publicUrl ? String(opts.publicUrl).replace(/\/+$/, "") : null;

  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, MANIFEST_NAME);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.shares)) {
      manifest = freshManifest();
    }
  } catch {
    manifest = freshManifest();
  }

  const tokens = loadTokens({ token: opts.token, tokensFile: opts.tokensFile, dir });

  function save() {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  function contentPath(entry) {
    // Stored relative in the manifest; always read from within `dir`.
    return join(dir, entry.file);
  }

  function removeEntryAt(i) {
    const [entry] = manifest.shares.splice(i, 1);
    if (entry) {
      try {
        rmSync(contentPath(entry), { force: true });
      } catch {
        /* file already gone — manifest is still authoritative */
      }
    }
    return entry;
  }

  const store = {
    dir,
    maxBytes,
    publicUrl,

    // Whether any upload token is configured. An open uploader is a mistake —
    // serve.mjs refuses to start when this is false.
    get hasTokens() {
      return tokens.length > 0;
    },

    // Active (non-expired) share count for /healthz.
    get count() {
      return manifest.shares.length;
    },

    // Returns the matching token_id (string) or null. Computes one hash of the
    // presented secret and timing-safe-compares it against each stored hash.
    verifyToken(bearerSecret) {
      if (bearerSecret == null || bearerSecret === "") return null;
      const presented = sha256hex(bearerSecret);
      let matchedId = null;
      for (const t of tokens) {
        if (timingSafeHexEqual(presented, t.secret_hash)) matchedId = t.id;
      }
      return matchedId;
    },

    // Add a page: writes <id>.html, appends a manifest entry, persists.
    // meta: { html, docId, title, ttlDays, tokenId }
    add({ html, docId = null, title = "untitled", ttlDays = DEFAULT_TTL_DAYS, tokenId = "default" }) {
      let id = randomId();
      const existing = new Set(manifest.shares.map((s) => s.id));
      while (existing.has(id)) id = randomId();

      const nowMs = Date.now();
      const createdAt = new Date(nowMs).toISOString();
      const days = Number.isFinite(ttlDays) ? ttlDays : DEFAULT_TTL_DAYS;
      const expiresAt =
        days === 0 ? null : new Date(nowMs + days * DAY_MS).toISOString();

      const file = `${id}.html`;
      const bytes = Buffer.byteLength(html, "utf8");
      writeFileSync(join(dir, file), html, "utf8");

      const entry = {
        id,
        doc_id: docId,
        title,
        size_bytes: bytes,
        created_at: createdAt,
        expires_at: expiresAt,
        file,
        token_id: tokenId,
      };
      manifest.shares.push(entry);
      save();
      return entry;
    },

    // Fetch a page by id. Expired entries are deleted lazily and reported as
    // absent. Returns { entry, html } or null.
    get(id) {
      const i = manifest.shares.findIndex((s) => s.id === id);
      if (i === -1) return null;
      const entry = manifest.shares[i];
      if (isExpired(entry, Date.now())) {
        removeEntryAt(i);
        save();
        return null;
      }
      let html;
      try {
        html = readFileSync(contentPath(entry), "utf8");
      } catch {
        // Content vanished under us — drop the dangling manifest entry.
        removeEntryAt(i);
        save();
        return null;
      }
      return { entry, html };
    },

    delete(id) {
      const i = manifest.shares.findIndex((s) => s.id === id);
      if (i === -1) return false;
      removeEntryAt(i);
      save();
      return true;
    },

    // Remove every expired entry (content + manifest row) in one pass.
    // Returns the number removed.
    sweep(nowMs = Date.now()) {
      let removed = 0;
      for (let i = manifest.shares.length - 1; i >= 0; i--) {
        if (isExpired(manifest.shares[i], nowMs)) {
          removeEntryAt(i);
          removed++;
        }
      }
      if (removed) save();
      return removed;
    },

    // Start the 24h background sweep. unref()'d so it never keeps a process
    // alive on its own. Returns the timer (idempotent-ish; call once per mount).
    startSweepTimer() {
      const t = setInterval(() => {
        try {
          store.sweep();
        } catch {
          /* a sweep hiccup must not crash the server */
        }
      }, SWEEP_INTERVAL_MS);
      if (typeof t.unref === "function") t.unref();
      return t;
    },
  };

  // Startup sweep — clears anything that expired while we were down.
  store.sweep();
  return store;
}

/* ========================================================================== *
 *  HTTP contract helpers
 * ========================================================================== */

function json(status, obj, extraHeaders) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders || {}) },
    body: JSON.stringify(obj),
  };
}

// Extract the bearer secret from an Authorization header value.
function bearerOf(authHeader) {
  if (!authHeader) return null;
  const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Build the public URL for a share id. Prefer the configured public base; else
// fall back to the request Host header (honoring x-forwarded-proto).
function buildShareUrl(store, headers, id) {
  if (store.publicUrl) return `${store.publicUrl}/p/${id}`;
  const host = headers && (headers.host || headers.Host);
  const proto =
    (headers && (headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"])) || "http";
  const base = host ? `${proto}://${host}` : "";
  return `${base}/p/${id}`;
}

/* ========================================================================== *
 *  createHandlers — the three endpoints as pure { status, headers, body }
 * ========================================================================== */

export function createHandlers(store) {
  return {
    // POST /p — auth, size, HTML-shape, then store. Body is the already-read
    // string/Buffer (the transport enforces the streaming early-abort; this is
    // the defensive backstop and the single source of the contract responses).
    handlePost({ headers = {}, query = {}, body = "" }) {
      const tokenId = store.verifyToken(bearerOf(headers.authorization || headers.Authorization));
      if (!tokenId) return json(401, { error: "bad or missing upload token" });

      const html = typeof body === "string" ? body : body.toString("utf8");
      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > store.maxBytes) {
        return json(413, { error: `page exceeds max_upload_bytes (${store.maxBytes})` });
      }
      if (!looksLikeHtml(html)) {
        return json(400, { error: "empty or non-HTML body" });
      }

      // ttl_days: default 90, 0 = keep forever. A malformed value falls back to
      // the default rather than erroring the upload.
      let ttlDays = DEFAULT_TTL_DAYS;
      const raw = query.ttl_days;
      if (raw != null && raw !== "") {
        const n = parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
        if (Number.isFinite(n) && n >= 0) ttlDays = n;
      }

      const { docId, title } = parseDocMeta(html);
      const entry = store.add({ html, docId, title, ttlDays, tokenId });
      return json(201, {
        id: entry.id,
        url: buildShareUrl(store, headers, entry.id),
        docId: entry.doc_id,
        title: entry.title,
        expires_at: entry.expires_at,
      });
    },

    // GET /p/:id — serve the stored HTML under the lock-down CSP, or 404.
    handleGet({ id } = {}) {
      const hit = id ? store.get(id) : null;
      if (!hit) return json(404, { error: "unknown or expired share" });
      return {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": CSP,
        },
        body: hit.html,
      };
    },

    // GET /healthz
    handleHealth() {
      return json(200, { ok: true, shares: store.count });
    },
  };
}

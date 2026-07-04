// fastify-plugin.mjs — mount present-share into an existing fastify server.
//
// NOT EXERCISED BY THE ZERO-DEP TEST SUITE (this repo has no fastify — do not
// add it). It IS exercised by your VM's fastify server. Everything with real
// logic lives in share/core.mjs (which IS fully tested); this wrapper is
// deliberately thin and obviously-correct: it only translates fastify's
// request/reply shape to and from the core's { status, headers, body } handlers.
//
// Usage on the VM:
//   import sharePlugin from "./share/fastify-plugin.mjs";
//   await fastify.register(sharePlugin, {
//     dir: process.env.PRESENT_SHARE_DIR,
//     token: process.env.PRESENT_SHARE_TOKEN,
//     tokensFile,                 // optional; defaults to <dir>/tokens.json
//     maxBytes,                   // optional; defaults to 8 MiB
//     publicUrl: process.env.PRESENT_SHARE_PUBLIC_URL,
//   });

import { createStore, createHandlers, DEFAULT_MAX_BYTES } from "./core.mjs";

export default async function sharePlugin(fastify, opts = {}) {
  const store = createStore({
    dir: opts.dir,
    token: opts.token,
    tokensFile: opts.tokensFile,
    maxBytes: opts.maxBytes,
    publicUrl: opts.publicUrl,
  });
  if (!store.hasTokens) {
    throw new Error(
      "present-share: refusing to register with no upload token configured " +
        "(set opts.token or provide a tokens.json).",
    );
  }
  store.startSweepTimer();
  const h = createHandlers(store);
  const maxBytes = store.maxBytes || DEFAULT_MAX_BYTES;

  // Reply with a core handler result verbatim.
  const send = (reply, r) => reply.code(r.status).headers(r.headers).send(r.body);

  // Take the page body as a raw Buffer (no multipart, no JSON parsing). The
  // per-route bodyLimit enforces the size cap while receiving — fastify aborts
  // the stream itself; the errorHandler below reshapes that 413 to our contract.
  fastify.addContentTypeParser(
    ["text/html", "text/plain", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: maxBytes },
    (_req, body, done) => done(null, body),
  );

  fastify.setErrorHandler((err, _req, reply) => {
    if (err && (err.statusCode === 413 || err.code === "FST_ERR_CTP_BODY_TOO_LARGE")) {
      return reply
        .code(413)
        .header("content-type", "application/json; charset=utf-8")
        .send(JSON.stringify({ error: `page exceeds max_upload_bytes (${maxBytes})` }));
    }
    reply
      .code(err && err.statusCode ? err.statusCode : 500)
      .header("content-type", "application/json; charset=utf-8")
      .send(JSON.stringify({ error: (err && err.message) || "internal error" }));
  });

  fastify.post("/p", (req, reply) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
    send(reply, h.handlePost({ headers: req.headers, query: req.query || {}, body }));
  });

  fastify.get("/p/:id", (req, reply) => {
    send(reply, h.handleGet({ id: req.params.id }));
  });

  fastify.get("/healthz", (_req, reply) => {
    send(reply, h.handleHealth());
  });
}

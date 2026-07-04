// server.mjs — tiny HTTP API, plain node (no framework, no npm install needed
// to read or run it). Routes are dispatched the way an Express app would
// read: method + path -> handler. Swap this dispatch table for real Express
// later if this API grows.

import { createServer } from "node:http";
import { handleUpload, handleListUploads } from "./routes/upload.mjs";

const PORT = process.env.PORT || 3000;

const routes = [
  { method: "POST", path: "/uploads", handler: handleUpload },
  { method: "GET", path: "/uploads", handler: handleListUploads },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
  if (!route) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  try {
    await route.handler(req, res);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

server.listen(PORT, () => {
  console.log(`upload API listening on :${PORT}`);
});

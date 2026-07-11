// watch.mjs — `render.mjs --watch` support: re-render on save + live reload.
//
// Serves the rendered page over a LOOPBACK-ONLY http server and pushes an SSE
// event to connected pages after every successful rebuild. The reload snippet
// is injected at serve time — the HTML written to disk stays offline-pure, so
// the artifact the user keeps is byte-identical to a plain render.
//
// Editors that save via rename-replace (vim, VS Code atomic writes) kill an
// inotify watcher on the first save, so the watcher is re-armed after every
// event rather than trusted to stay alive.

import { createServer } from "node:http";
import { readFileSync, existsSync, watch as fsWatch } from "node:fs";

const SSE_PATH = "/__pf_events";
const RELOAD_SNIPPET =
  `<script>new EventSource("${SSE_PATH}").addEventListener("message",` +
  `function(){location.reload()});</script>`;

export async function startWatch({ inputPath, outPath, rebuild, open = false }) {
  const clients = new Set();

  const server = createServer((req, res) => {
    if (req.url === SSE_PATH) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 500\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      let html;
      try {
        html = readFileSync(outPath, "utf8");
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not rendered yet");
        return;
      }
      html = html.includes("</body>")
        ? html.replace("</body>", RELOAD_SNIPPET + "</body>")
        : html + RELOAD_SNIPPET;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    // The page is fully self-contained; nothing else is ever legitimately
    // requested, and refusing everything keeps the server's surface minimal.
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`watching ${inputPath} — Ctrl-C to stop`);
  console.log(`live:    ${url}`);

  let timer = null;
  let watcher = null;

  function armWatcher() {
    if (watcher) { try { watcher.close(); } catch { /* already dead */ } watcher = null; }
    if (!existsSync(inputPath)) return;   // transient during rename-replace; next arm catches it
    try {
      watcher = fsWatch(inputPath, onEvent);
    } catch (e) {
      console.error(`warning: cannot watch ${inputPath}: ${e.message}`);
    }
  }

  function onEvent() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        rebuild();
        for (const c of clients) c.write("data: reload\n\n");
        console.log(`rebuilt ${new Date().toLocaleTimeString()} (${clients.size} client${clients.size === 1 ? "" : "s"})`);
      } catch (e) {
        // A half-saved file mid-write can fail to parse; keep watching — the
        // next save gets another chance.
        console.error(`watch: rebuild failed: ${e.message}`);
      }
      armWatcher();
    }, 150);
  }

  armWatcher();

  if (open) {
    try {
      const { openUrl } = await import("./open.mjs");
      if (openUrl) await openUrl(url);
    } catch { /* URL printed above either way */ }
  }

  return {
    url,
    close: () => {
      if (watcher) { try { watcher.close(); } catch { /* noop */ } }
      for (const c of clients) { try { c.end(); } catch { /* noop */ } }
      server.close();
    },
  };
}

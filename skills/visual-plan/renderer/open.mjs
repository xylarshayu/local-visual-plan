// open.mjs — open a produced HTML file in the system browser.
// Fallback chain: $BROWSER -> wslview -> explorer.exe (via `wslpath -w`)
// -> xdg-open. Designed for WSL2 first, then generic Linux.
//
// Usage (programmatic):  import { openFile } from './open.mjs'; await openFile(path)
// Usage (CLI):           node open.mjs <file>

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

function hasCommand(cmd) {
  // `command -v` via the shell is the most portable existence check.
  const r = spawnSync("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]);
  return r.status === 0;
}

function toWindowsPath(p) {
  const r = spawnSync("wslpath", ["-w", p], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return null;
}

function launch(cmd, args) {
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
  return new Promise((res, rej) => {
    let settled = false;
    child.on("error", (err) => { if (!settled) { settled = true; rej(err); } });
    // If it didn't error synchronously, treat the spawn as a success.
    setTimeout(() => { if (!settled) { settled = true; res(true); } }, 120);
  });
}

/**
 * Open `filePath` using the first opener that works.
 * @returns {Promise<{ ok: boolean, via: string|null }>}
 */
export async function openFile(filePath) {
  const abs = resolve(filePath);
  const attempts = [];

  // 1) $BROWSER (on this WSL2 box it is typically `wslview`).
  if (process.env.BROWSER) {
    // $BROWSER may contain arguments; split on whitespace.
    const parts = process.env.BROWSER.trim().split(/\s+/);
    attempts.push({ via: `$BROWSER (${parts[0]})`, cmd: parts[0], args: [...parts.slice(1), abs] });
  }

  // 2) wslview
  if (hasCommand("wslview")) {
    attempts.push({ via: "wslview", cmd: "wslview", args: [abs] });
  }

  // 3) explorer.exe via Windows path
  if (hasCommand("explorer.exe")) {
    const win = toWindowsPath(abs);
    if (win) attempts.push({ via: "explorer.exe", cmd: "explorer.exe", args: [win] });
  }

  // 4) xdg-open
  if (hasCommand("xdg-open")) {
    attempts.push({ via: "xdg-open", cmd: "xdg-open", args: [abs] });
  }

  for (const a of attempts) {
    try {
      await launch(a.cmd, a.args);
      return { ok: true, via: a.via };
    } catch {
      // try next opener
    }
  }
  return { ok: false, via: null };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node open.mjs <file>");
    process.exit(2);
  }
  const res = await openFile(target);
  if (res.ok) {
    console.log(`opened via ${res.via}`);
  } else {
    console.error("could not open: no working opener found ($BROWSER, wslview, explorer.exe, xdg-open)");
    process.exit(1);
  }
}

// open.mjs — open a produced HTML file in the system browser.
// Fallback chain: $BROWSER -> wslview -> explorer.exe (via `wslpath -w`)
// -> xdg-open. Designed for WSL2 first, then generic Linux.
//
// Usage (programmatic):  import { openFile } from './open.mjs'; await openFile(path)
// Usage (CLI):           node open.mjs <file>

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function hasCommand(cmd) {
  // `command -v` via the shell is the most portable existence check.
  const r = spawnSync("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]);
  return r.status === 0;
}

// Whether launching a Windows GUI app from WSL will actually work. The
// binfmt_misc entry can read "enabled" while the Windows-side bridge is still
// unreachable, so the only reliable test is to RUN a trivial Windows no-op and
// see if it returns promptly. Cached: probed at most once per process.
let _interop = null;
function wslInteropWorks() {
  if (_interop !== null) return _interop;
  const r = spawnSync("cmd.exe", ["/c", "ver"], { stdio: "ignore", timeout: 1500 });
  _interop = !r.error && !r.signal && r.status === 0;
  return _interop;
}

// Openers that need WSL interop to do anything.
const WIN_OPENERS = new Set(["wslview", "explorer.exe", "cmd.exe", "powershell.exe"]);

function toWindowsPath(p) {
  // `wslpath` is a native WSL utility (NOT a Windows interop binary), so it works
  // even when WSL interop is disabled — which is exactly when we most need a
  // clickable Windows/UNC path to hand the user.
  const r = spawnSync("wslpath", ["-w", p], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return null;
}

// A `file://` URL the user (or a harness) can click. We don't percent-encode —
// plan slugs are kebab-case and our default out paths have no spaces.
function toFileUrl(absPath) {
  return "file://" + absPath;
}

// Launch an opener and REPORT TRUTHFULLY whether it worked. These launchers
// (wslview / xdg-open / explorer.exe) return promptly after handing off to the
// browser — they don't block until it closes — so a bounded spawnSync is safe
// and lets us detect the failure modes the old detached-spawn could not:
//   - spawn error (binary missing)            -> r.error
//   - hung then killed by timeout             -> r.signal
//   - ran but failed (e.g. interop disabled)  -> non-zero r.status
function launch(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 4000 });
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`${cmd} timed out (${r.signal})`);
  if (typeof r.status === "number" && r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
  return true;
}

/**
 * Open `filePath` using the first opener that works. The returned `targets` are
 * ALWAYS populated (even when no opener succeeds) so the caller can hand the user
 * a clickable path — important on WSL with interop disabled, where no opener can
 * launch a browser but the `\\wsl.localhost\…` UNC path still opens from Windows.
 * @returns {Promise<{ ok: boolean, via: string|null, targets: { path: string, fileUrl: string, winPath: string|null } }>}
 */
export async function openFile(filePath) {
  const abs = resolve(filePath);
  const targets = { path: abs, fileUrl: toFileUrl(abs), winPath: toWindowsPath(abs) };
  const interop = wslInteropWorks();
  const attempts = [];

  // 1) $BROWSER (on this WSL2 box it is typically `wslview`). Skip it when it is
  //    a Windows opener and interop is disabled (it would hang then fail).
  if (process.env.BROWSER) {
    // $BROWSER may contain arguments; split on whitespace.
    const parts = process.env.BROWSER.trim().split(/\s+/);
    if (interop || !WIN_OPENERS.has(parts[0])) {
      attempts.push({ via: `$BROWSER (${parts[0]})`, cmd: parts[0], args: [...parts.slice(1), abs] });
    }
  }

  // 2) wslview — only if interop is actually available.
  if (interop && hasCommand("wslview")) {
    attempts.push({ via: "wslview", cmd: "wslview", args: [abs] });
  }

  // 3) explorer.exe via Windows path — only if interop is available.
  if (interop && hasCommand("explorer.exe")) {
    const win = toWindowsPath(abs);
    if (win) attempts.push({ via: "explorer.exe", cmd: "explorer.exe", args: [win] });
  }

  // 4) xdg-open (native Linux; no interop needed).
  if (hasCommand("xdg-open")) {
    attempts.push({ via: "xdg-open", cmd: "xdg-open", args: [abs] });
  }

  for (const a of attempts) {
    try {
      await launch(a.cmd, a.args);
      return { ok: true, via: a.via, targets };
    } catch {
      // try next opener
    }
  }
  return { ok: false, via: null, targets };
}

/**
 * Open an http(s) URL (e.g. the --watch live server) with the same opener
 * chain as openFile, minus the path conversions — every opener in the chain
 * accepts a URL argument directly.
 * @returns {Promise<boolean>} whether any opener succeeded
 */
export async function openUrl(url) {
  const interop = wslInteropWorks();
  const attempts = [];
  if (process.env.BROWSER) {
    const parts = process.env.BROWSER.trim().split(/\s+/);
    if (interop || !WIN_OPENERS.has(parts[0])) {
      attempts.push({ cmd: parts[0], args: [...parts.slice(1), url] });
    }
  }
  if (interop && hasCommand("wslview")) attempts.push({ cmd: "wslview", args: [url] });
  if (interop && hasCommand("explorer.exe")) attempts.push({ cmd: "explorer.exe", args: [url] });
  if (hasCommand("xdg-open")) attempts.push({ cmd: "xdg-open", args: [url] });
  for (const a of attempts) {
    try { await launch(a.cmd, a.args); return true; } catch { /* next */ }
  }
  return false;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node open.mjs <file>");
    process.exit(2);
  }
  const res = await openFile(target);
  if (res.targets.winPath) console.log(`windows: ${res.targets.winPath}`);
  console.log(`url:     ${res.targets.fileUrl}`);
  if (res.ok) {
    console.log(`opened via ${res.via}`);
  } else {
    console.error("could not auto-open: no working opener (tried $BROWSER, wslview, explorer.exe, xdg-open) — click the path above");
    process.exit(1);
  }
}

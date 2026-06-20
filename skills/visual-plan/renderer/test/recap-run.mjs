// recap-run.mjs — tests for recap.mjs against a throwaway git repo.
// Zero deps: node:assert/fs/os/path/child_process. Run: node test/recap-run.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectDiff, buildRecapMarkdown } from "../recap.mjs";
import { renderPlan } from "../render.mjs";

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); console.log("  PASS  " + name); pass++; } catch (e) { console.log("  FAIL  " + name + "\n        " + (e.message || e)); fail++; } }

const repo = mkdtempSync(join(tmpdir(), "recap-test-"));
const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });

try {
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");

  // base commit
  writeFileSync(join(repo, "a.txt"), "alpha\nbravo\ncharlie\n");
  writeFileSync(join(repo, "gone.txt"), "delete me\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "keep.js"), "export const x = 1\n");
  g("add", "-A");
  g("commit", "-qm", "base");

  // working-tree changes: modify, delete, new untracked text, untracked binary, ignored
  writeFileSync(join(repo, "a.txt"), "alpha\nBRAVO\ncharlie\ndelta\n");
  execFileSync("git", ["rm", "-q", "gone.txt"], { cwd: repo });
  writeFileSync(join(repo, "new.md"), "# New\nhello world\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([1, 2, 0, 3, 4])); // NUL => binary
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repo, "ignored.txt"), "should not appear\n");

  const wt = collectDiff({ cwd: repo });

  ok("collectDiff finds modified / deleted / untracked", () => {
    const by = Object.fromEntries(wt.files.map((f) => [f.path, f]));
    assert.equal(by["a.txt"].status, "modified");
    assert.equal(by["gone.txt"].status, "deleted");
    assert.equal(by["new.md"].status, "added"); // untracked text, synthesized
    assert.ok(by["blob.bin"], "untracked binary should be listed");
  });
  ok("ignored files are excluded", () => {
    assert.ok(!wt.files.some((f) => f.path === "ignored.txt"));
    assert.ok(!wt.files.some((f) => f.path === ".gitignore" && false)); // .gitignore itself is untracked+added, allowed
  });
  ok("binary file is flagged, gets no hunks", () => {
    assert.equal(wt.patches.get("blob.bin").binary, true);
    assert.equal(wt.patches.get("blob.bin").hunks, "");
  });

  const md = buildRecapMarkdown(wt, { maxFiles: 8 });
  ok("recap.md has a filetree with the right flags", () => {
    assert.match(md, /```filetree/);
    assert.match(md, /\+ new\.md/);
    assert.match(md, /- gone\.txt/);
    assert.match(md, /~ a\.txt/);
  });
  ok("recap.md has a tabs block of diffs, excluding the binary", () => {
    assert.match(md, /<!-- tabs:start -->/);
    assert.match(md, /```diff file=/);
    assert.match(md, /<!-- tab: new\.md -->/);
    assert.ok(!md.includes("tab: blob.bin"), "binary file must not get a diff tab");
  });

  const { html, warnings } = renderPlan(md, { lean: true });
  ok("recap renders to the documented blocks", () => {
    assert.match(html, /data-block="filetree"/);
    assert.match(html, /data-block="diff"/);
    assert.match(html, /data-block="tabs"/);
  });
  ok("recap render is offline-pure (no external URL)", () => {
    assert.ok(!/\bhttps?:\/\//.test(html) && !/src=["']\/\//.test(html), "no external URL tokens");
  });
  ok("untracked synthesized diff shows the new file's lines as additions", () => {
    assert.match(html, /hello world/);
  });

  // range mode: commit, then HEAD~1..HEAD
  g("add", "-A");
  g("commit", "-qm", "work");
  const range = collectDiff({ range: "HEAD~1..HEAD", cwd: repo });
  ok("range mode captures the committed changes", () => {
    const paths = range.files.map((f) => f.path);
    assert.ok(paths.includes("a.txt") && paths.includes("new.md") && paths.includes("gone.txt"));
    assert.match(range.title, /HEAD~1\.\.HEAD/);
  });

  // empty
  const empty = collectDiff({ range: "HEAD..HEAD", cwd: repo });
  ok("empty diff yields a 'No changes' recap", () => {
    assert.equal(empty.files.length, 0);
    assert.match(buildRecapMarkdown(empty), /No changes/);
  });

  // --- regressions for the adversarial-review findings --------------------
  const mkrepo = () => {
    const d = mkdtempSync(join(tmpdir(), "recap-reg-"));
    const gg = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
    gg("init", "-q"); gg("config", "user.email", "t@e"); gg("config", "user.name", "t"); gg("config", "commit.gpgsign", "false");
    return { d, g: gg };
  };

  { // unborn HEAD: brand-new repo, no commits, only untracked files
    const { d } = mkrepo();
    writeFileSync(join(d, "fresh.txt"), "one\ntwo\n");
    ok("unborn HEAD (no commits) does not crash and lists untracked files", () => {
      const c = collectDiff({ cwd: d });
      assert.ok(c.files.some((f) => f.path === "fresh.txt" && f.status === "added"));
    });
    rmSync(d, { recursive: true, force: true });
  }

  { // rename + heavy edits must rank by real churn (not 0) and stay in the tabs
    const { d, g } = mkrepo();
    writeFileSync(join(d, "big.txt"), Array.from({ length: 60 }, (_, i) => "line " + i).join("\n") + "\n");
    for (let i = 0; i < 9; i++) writeFileSync(join(d, "t" + i + ".txt"), "x\n");
    g("add", "-A"); g("commit", "-qm", "base");
    execFileSync("git", ["mv", "big.txt", "big2.txt"], { cwd: d });
    writeFileSync(join(d, "big2.txt"), Array.from({ length: 60 }, (_, i) => "LINE " + i).join("\n") + "\n");
    for (let i = 0; i < 9; i++) writeFileSync(join(d, "t" + i + ".txt"), "x\ny\n");
    g("add", "-A");
    ok("rename-with-edits ranks by churn and stays in the tabs", () => {
      const c = collectDiff({ staged: true, cwd: d });
      const big = c.files.find((f) => f.path === "big2.txt");
      assert.ok(big && big.churn > 50, "expected real churn, got " + (big && big.churn));
      assert.ok(buildRecapMarkdown(c, { maxFiles: 3 }).includes("tab: big2.txt"));
    });
    rmSync(d, { recursive: true, force: true });
  }

  { // spaces + unicode in a path survive into tree + diff (quotePath=false + -z)
    const { d, g } = mkrepo();
    mkdirSync(join(d, "a b"), { recursive: true });
    writeFileSync(join(d, "a b", "café.txt"), "alpha\n");
    g("add", "-A"); g("commit", "-qm", "base");
    writeFileSync(join(d, "a b", "café.txt"), "alpha\nbeta\n");
    g("add", "-A");
    ok("spaced + unicode path renders raw in tree and diff", () => {
      const c = collectDiff({ staged: true, cwd: d });
      assert.ok(c.files.some((f) => f.path === "a b/café.txt"), "raw path; got " + c.files.map((f) => f.path).join());
      const md = buildRecapMarkdown(c);
      assert.match(md, /a b\/café\.txt/);
      assert.ok(!/caf\\\d/.test(md), "no octal-escaped path");
    });
    rmSync(d, { recursive: true, force: true });
  }

  { // empty untracked file: listed, but no phantom +1 hunk and no diff tab
    const { d, g } = mkrepo();
    writeFileSync(join(d, "seed.txt"), "x\n"); g("add", "-A"); g("commit", "-qm", "base");
    writeFileSync(join(d, "blank.txt"), "");
    ok("empty untracked file: listed, no phantom hunk, no tab", () => {
      const c = collectDiff({ cwd: d });
      assert.ok(c.files.some((f) => f.path === "blank.txt" && f.status === "added"));
      assert.equal(c.patches.get("blank.txt").hunks, "");
      assert.ok(!buildRecapMarkdown(c).includes("tab: blank.txt"));
    });
    rmSync(d, { recursive: true, force: true });
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("\n" + "─".repeat(60));
console.log(`Total: ${pass} passed, ${fail} failed`);
console.log("RESULT: " + (fail ? "FAIL" : "PASS"));
process.exit(fail ? 1 : 0);

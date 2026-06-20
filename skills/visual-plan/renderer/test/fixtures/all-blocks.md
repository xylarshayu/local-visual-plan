---
title: All Blocks & Both Diff Modes
objective: Exercise every recognized custom block type plus unified and split diffs.
status: proposed
---

This fixture exercises **every** recognized block type from `format.md`, so the
renderer's per-block HTML contract is covered end to end. It mixes standard
Markdown prose (a [link](https://example.com/docs) appears here to prove that
prose-level links survive `marked`, while the renderer must still not load any
external resource) with each custom fenced block below.

## Steps

```steps
# Add a size guard to the upload action
reuse src/lib/client.ts — uploadFile() already handles the PUT
edit src/actions/upload.ts — reject > 5MB before calling the client
new src/actions/validate-size.ts — pure size check, unit-tested
delete src/legacy/old-guard.ts — superseded by the new validator
> Reuse the existing client; only the guard + validator are genuinely new.
> Keep the behavioral change in one place for reviewability.
# Wire the validator into the action
reuse src/actions/validate-size.ts — call isTooLarge() up front
> Second step proves multiple steps render as separate <li class="step">.
```

## File tree

```filetree
. src/actions/
~   src/actions/upload.ts — guard added
+   src/actions/validate-size.ts — new
- src/legacy/old-upload.ts — removed
.   src/lib/client.ts — unchanged, reused
```

## Diff (unified, default mode)

```diff file=src/actions/upload.ts
@@ -10,6 +10,9 @@ export default defineAction({
@note: The only behavioral change — everything else is plumbing.
   run: async ({ file }) => {
+    if (file.size > MAX_BYTES) {
+      throw new ActionError('file too large')
+    }
     return uploadFile(file)
```

## Diff (split mode)

```diff file=src/actions/validate-size.ts mode=split
@@ -1,2 +1,4 @@
@note: New pure validator extracted for unit testing.
-export const MAX = 1024
+export const MAX_BYTES = 5 * 1024 * 1024
+export function isTooLarge(n) {
+  return n > MAX_BYTES
 }
```

## Code

```code lang=ts file=src/actions/validate-size.ts hl=2
@note line=2: This is the hot path — keep it allocation-free.
export const MAX_BYTES = 5 * 1024 * 1024
export function isTooLarge(n: number) { return n > MAX_BYTES }
```

## Diagram

```diagram title=Upload flow
flowchart LR
  U[User] --> A[upload action] --> S[(storage)]
```

## Wireframe

```wireframe surface=page title="Settings — after"
<div class="wf-toolbar"><span class="wf-title">Settings</span></div>
<div class="wf-row"><button class="wf-btn wf-primary">Save</button></div>
```

## Questions

```questions
# Chunk uploads above 5MB?
default: No — single PUT until real >5MB usage appears.
# Per-user or per-org tokens?
default: Per-org — matches the existing ownership model.
```

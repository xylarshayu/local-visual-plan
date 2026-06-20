---
title: Add a 5MB Upload Size Guard
objective: Reject oversized uploads before they reach storage, reusing the existing client, with a small unit-tested validator.
status: approved
---

## Context

The upload action streams straight to storage with no size check. We add a guard
that rejects files over 5MB **before** the PUT, reusing the existing
`uploadFile()` client. This is a realistic, end-to-end plan combining prose,
diagrams, steps, diffs, code, a before/after tab group, a collapsible, and a
single open-questions block at the bottom — the shape a real plan takes.

```diagram title=Where the guard sits
flowchart LR
  U[User] --> A[upload action]
  A -->|size ok| S[(storage)]
  A -->|too large| E[ActionError]
```

## Plan

```steps
# Extract a pure size validator
new src/actions/validate-size.ts — isTooLarge(n) + MAX_BYTES, unit-tested
> A pure function is trivial to test and has no I/O.
# Guard the action with the validator
reuse src/lib/client.ts — uploadFile() already does the PUT
reuse src/actions/validate-size.ts — call isTooLarge() first
edit src/actions/upload.ts — throw ActionError before the client call
> Lead with reuse: the client is untouched; only the guard is new.
# Add the unit test
new test/validate-size.test.ts — boundary cases around MAX_BYTES
> Cover exactly-at-limit, one-over, and one-under.
```

## Files touched

```filetree
. src/
+   src/actions/validate-size.ts — new validator
~   src/actions/upload.ts — guard wired in
.   src/lib/client.ts — reused, unchanged
. test/
+   test/validate-size.test.ts — new
```

## The one behavioral change

<!-- tabs:start -->
<!-- tab: Before -->

```code lang=ts file=src/actions/upload.ts
export default defineAction({
  run: async ({ file }) => uploadFile(file),
})
```

<!-- tab: After -->

```diff file=src/actions/upload.ts mode=unified
@@ -1,3 +1,6 @@ export default defineAction({
@note: The whole behavioral change is these four lines.
   run: async ({ file }) => {
+    if (isTooLarge(file.size)) {
+      throw new ActionError('file too large')
+    }
     return uploadFile(file)
```

<!-- tabs:end -->

## The validator

```code lang=ts file=src/actions/validate-size.ts hl=1
export const MAX_BYTES = 5 * 1024 * 1024
export function isTooLarge(n: number): boolean {
  return n > MAX_BYTES
}
```

<!-- collapsible: Verification details -->

1. `npm test test/validate-size.test.ts`
2. Manually upload a 6MB file and confirm a 413-style error.

```filetree
+   test/validate-size.test.ts — boundary coverage
```

<!-- collapsible:end -->

## Open questions

```questions
# Chunk uploads above 5MB instead of rejecting?
default: No — reject until real >5MB demand appears.
# Surface the limit in the client UI pre-flight?
default: Yes — cheap, avoids a wasted round-trip.
```

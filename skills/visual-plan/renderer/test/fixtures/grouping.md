---
title: Grouping Directives
objective: Exercise tabs and collapsible grouping directives wrapping prose and blocks.
status: draft
---

Grouping uses HTML-comment directives in the prose (they survive Markdown and
are invisible in a plain renderer). This fixture proves both `tabs` and
`collapsible` produce their `data-block` wrappers and that nested custom blocks
inside a group still render.

<!-- tabs:start -->
<!-- tab: Before -->

The "before" state of the upload action, with no size guard.

```code lang=ts file=src/actions/upload.ts
export default defineAction({
  run: async ({ file }) => uploadFile(file),
})
```

<!-- tab: After -->

The "after" state, with the guard wired in.

```diff file=src/actions/upload.ts
@@ -1,3 +1,6 @@
   run: async ({ file }) => {
+    if (file.size > MAX_BYTES) {
+      throw new ActionError('file too large')
+    }
     return uploadFile(file)
```

<!-- tabs:end -->

Below is a collapsible group holding verification details and a file tree.

<!-- collapsible: Verification details -->

Run the unit tests and confirm the guard rejects oversized files.

```filetree
. test/
+   test/validate-size.test.ts — new unit test
```

<!-- collapsible:end -->

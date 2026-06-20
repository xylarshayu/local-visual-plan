---
title: Unknown Block Fallback
objective: An unrecognized block type must render as a labeled pre, never dropped or executed.
status: draft
---

The block below uses an info string that is **not** one of the recognized types.
Per `format.md`, it must render as `<pre data-block="unknown" data-type="...">`
showing the raw body — never dropped, never executed.

```sequencediagram theme=dark
Alice -> Bob: hello
Bob --> Alice: hi back
<script>alert('this raw body must be escaped, not executed')</script>
```

A standard fenced code block (a plain language, not a custom block type) should
still render normally as Markdown and must NOT become `data-block="unknown"`:

```js
console.log("ordinary code fence")
```

Some trailing prose so the unknown block is not the last node.

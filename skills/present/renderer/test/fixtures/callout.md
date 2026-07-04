---
title: Callout Fixture
objective: Exercise all four callout tones plus markdown bodies.
status: draft
---

Callouts flag decisions, warnings, and risks inline with the prose.

```callout tone=info title="An informational note"
Plain **info** body with a [link](https://example.com/docs) that must not fetch.
```

```callout tone=decision
We chose option A because it is reversible — no title on this one.
```

```callout tone=warning title="Careful here"
This step is destructive and cannot be undone.
```

```callout tone=risk
Shipping this changes a public contract that other tools depend on.
```

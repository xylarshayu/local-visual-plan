---
title: Data Model Fixture
objective: Exercise the data-model block parser end to end.
status: proposed
---

Intro prose paragraph before the block.

```data-model title="Billing schema"
. user
~   plan_id uuid FK -> plan.id — was: text
+   trial_ends_at timestamptz — nullable
.   email text — unique
+ plan
+   id uuid PK
+   price_cents int
- legacy_tiers — <script>alert(1)</script> dropped
user }o--|| plan : belongs to
??? not a valid line
```

A second data-model with the SAME title to prove collision suffixing:

```data-model title="Billing schema"
+ invoice
+   id uuid PK
```

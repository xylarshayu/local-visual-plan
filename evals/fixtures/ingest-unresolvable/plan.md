---
title: Add upload size guard
objective: Reject oversized uploads before they hit storage.
status: proposed
---

## Approach

```steps
# Add a size guard to the upload action
reuse src/lib/client.ts — uploadFile() already handles the PUT
edit src/actions/upload.ts — reject > 5MB before calling the client
new src/actions/validate-size.ts — pure size check, unit-tested
> Reuse the existing client; only the guard + validator are genuinely new.
```

```questions
# Chunk uploads above 5MB?
default: No — single PUT until real >5MB usage appears.
```

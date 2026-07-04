---
title: Gate the admin routes behind a token
objective: Require a bearer token on /admin routes before anything else ships.
status: proposed
---

## Approach

```steps
# Gate the admin routes behind a bearer token
reuse lib/config.mjs — already loads values from the environment
new lib/auth.mjs — checks the Authorization header against ADMIN_TOKEN
edit routes/admin.mjs — call the new auth check before handling the request
> The token itself is a hardcoded string for now; production config work is out of scope for this pass.
```

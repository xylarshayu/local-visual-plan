---
title: API Endpoint Fixture
objective: Exercise the api-endpoint block parser end to end.
status: proposed
---

Intro prose.

```api-endpoint method=POST path=/v2/uploads title="Create upload"
. auth Bearer org token — was: user token
+ query expires_in int — optional, seconds, default 3600
~ body name string — now required
- header X-Legacy string — removed
! not a param line
request:
{ "name": "<script>alert(1)</script>", "meta": { "nested": { "deep": { "x": 1 } } } }
response 201:
{ "id": "up_9f2", "url": "up_9f2/logo.png" }
response 413:
not json at all
```

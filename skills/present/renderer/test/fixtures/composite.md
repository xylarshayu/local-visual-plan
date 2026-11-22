---
title: Composite parts and code captions
objective: A job queue whose workers box is three pools, with each part pointing at its code.
repo: https://git.example.com/shop/blob/main
---

```stepper figure=figures/job-queue.svg title="One job, end to end"
code: api src/api/jobs.ts
code: queue src/queue/
code: workers src/workers/
code: w-images src/workers/images.ts
code: w-email src/workers/email.ts
code: w-search src/workers/search.ts
code: store src/store/

# A request becomes a job
parts: api e-enqueue queue
key: The API answers at once; the work happens later.
changed: One job waits in the queue.

The API checks the request and puts a job on the queue.

# A worker claims it
parts: e-claim workers
key: Workers pull jobs; nothing pushes work at them.
changed: The job is claimed.

A free worker takes the oldest job. The stacked outline says this box is more than one thing.

# Inside the workers
parts: w-images w-email w-search
key: Workers is three pools, one per kind of job.
changed: The job runs in the pool for its kind.

Each pool scales on its own, so a burst of email does not slow image resizing.

# The result is stored
parts: e-write store
key: The store write is the commit point.
changed: The result is saved.

The worker writes the result and marks the job done.
```

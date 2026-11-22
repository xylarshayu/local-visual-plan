---
title: Composite parts and code captions
objective: A job queue whose workers box is three pools, with each part pointing at its code.
repo: https://git.example.com/shop/blob/main
---

```stepper figure=figures/job-queue.svg title="One job, end to end"
code: api src/api/jobs.ts
code: queue src/queue/
code: workers src/workers/
code: store src/store/
state: queue empty one
switch: Store

# A request becomes a job
parts: api e-enqueue queue
set: queue=one
key: The API answers at once; the work happens later.
changed: One job waits in the queue.

The API checks the request and puts a job on the queue.

# A worker claims it
parts: e-claim workers
set: queue=empty
key: Workers pull jobs; nothing pushes work at them.
changed: The job is claimed.

A free worker takes the oldest job. The stacked outline says this box is more than one thing, and its link leads to the plan below.

# The result is stored
parts: e-write store
key: The store write is the commit point.
changed: The result is saved.

The worker writes the result and marks the job done.

# The job goes back
off: The result is stored
parts: e-write store
set: queue=one
key: An unreachable store loses nothing; the job is retried.
changed: The job waits in the queue again.

The write fails, so the worker returns the job to the queue.
```

```stepper figure=figures/workers-plan.svg title="Inside the workers"
code: w-images src/workers/images.ts
code: w-email src/workers/email.ts
code: w-search src/workers/search.ts

# One queue feeds every pool
parts: queue
key: Every pool takes its jobs from the same queue.

Jobs wait in order. Each pool takes only its own kind.

# Images
parts: e-images w-images
key: Three workers side by side take a burst of uploads at once.

Images is the busiest pool, so it has the most workers.

# Email, under a rate limit
parts: e-email w-email limit
key: The limit on top keeps sends under what the mail provider accepts.

# Search
parts: e-search w-search
key: A changed record is reindexed by whichever worker is free.

# One queue in, one store out
parts: queue e-store store
key: However many pools there are, jobs come from one queue and land in one store.
```

```stepper figure=figures/layers-exploded.svg title="Four layers"
# Interface
parts: interface
key: What people see and touch.

# API
parts: api
key: The one way in.

# Services
parts: services
key: Where the rules live.
```

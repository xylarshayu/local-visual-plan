---
title: Figure and stepper
objective: A figure and a stepper over the same generic request path.
---

Some prose before the figure.

```figure src=figures/request-path.svg title="Request path"
A browser request crosses the gateway to the orders service, which writes one database row.
```

```stepper figure=figures/request-path.svg title="One request, end to end"
counter: sent | Requests sent
counter: stored | Rows written
switch: Network

# The user fills the form
parts: browser
key: Nothing leaves the browser until the user submits.
changed: The form holds the input.

The user types an order and presses submit.

# The browser sends the request
parts: browser e-gateway gateway
needs: switch
set: sent=1
key: The gateway is the only way in.
changed: One request is in flight.

The browser serialises the form and sends it to the gateway, which checks the session.

# The service writes the row
parts: e-service service e-db db
needs: switch
set: stored=1
key: The database write is the commit point.
changed: One row exists.
changed: The request is answered.

The orders service validates the order and writes it in one transaction.

# The network is down
held
parts: browser
key: The form keeps its input and retries; the user loses nothing.
changed: Requests sent stays at 0.

Without the network the browser holds the request and retries when it can.
```

Prose after.

# Diagram types — picking and authoring (on-demand)

Read this **only when you're choosing or writing a `diagram` block.** It is not
loaded by default; the `SKILL.md` just points here so the always-on context stays
small.

A `diagram` block holds raw **Mermaid** source (see `format.md` for the block
contract). The vendored bundle is **Mermaid 11.15.0** — every type below renders
**fully offline**, in the browser, from the inlined bundle.

**Look.** Diagrams render **hand-drawn by default** (sketchy shapes + the vendored
Virgil font) — that is the house style. Add `look=clean` on the info string for a
diagram that reads better as crisp/technical (dense flows, big ER models):

````
```diagram title="…" look=clean
```
````

## Pick the type

| When you want to show… | Use | keyword |
|---|---|---|
| steps, decisions, control/data flow | **Flowchart** | `flowchart` |
| messages between actors over time (API calls, protocols) | **Sequence** | `sequenceDiagram` |
| a state machine / lifecycle | **State** | `stateDiagram-v2` |
| a data model (tables, keys, cardinality) | **ER** | `erDiagram` |
| OOP structure (classes, fields, relations) | **Class** | `classDiagram` |
| a brainstom / hierarchy from one root | **Mindmap** | `mindmap` |
| branch/merge history | **Git graph** | `gitGraph` |
| a schedule with dependencies/milestones | **Gantt** | `gantt` |
| events along a timeline by period | **Timeline** | `timeline` |
| a 2×2 prioritization matrix | **Quadrant** | `quadrantChart` |
| cloud/service architecture | **Architecture** | `architecture-beta` |

For a plan/recap, **flowchart, sequence, state, and ER** carry most of the value —
reach for those first. Prefer the simplest type that makes the point.

## Syntax skeletons

**Flowchart** — `TB`/`TD`/`LR`/`RL` direction; `[box]` `("round")` `{diamond}` `[(db)]`.
```
flowchart LR
  A["start"] --> B{"ok?"}
  B -->|yes| C["do it"]
  B -->|no| D["stop"]
  subgraph group
    C --> E["next"]
  end
```

**Sequence** — `->>` call, `-->>` return; `alt`/`opt`/`loop`/`par … end`.
```
sequenceDiagram
  participant U as User
  participant S as Server
  U->>S: request
  alt ok
    S-->>U: 200
  else error
    S-->>U: 4xx
  end
```

**State**
```
stateDiagram-v2
  [*] --> Idle
  Idle --> Running: start
  Running --> [*]: done
```

**ER** — `||--o{` one-to-many; block lists attributes (`PK`/`FK`).
```
erDiagram
  USER ||--o{ ORDER : places
  ORDER {
    int id PK
    int user_id FK
  }
```

**Class**
```
classDiagram
  class Upload {
    +size: number
    +validate() bool
  }
  Upload --> Storage
```

**Mindmap** — indentation = depth; `((round))` `[square]` node shapes.
```
mindmap
  root((plan))
    Blocks
      steps
      diagram
    Render
      mermaid
```

**Git graph**
```
gitGraph
  commit
  branch feature
  commit
  checkout main
  merge feature
```

Other supported keywords (one-line each, full syntax at mermaid.js.org): `journey`
(user journey), `pie`, `requirementDiagram`, `sankey-beta`, `xychart-beta`,
`block-beta`, `packet-beta`, `kanban`, `radar`, `treemap`, `C4Context`
(`/C4Container/C4Component/…`).

## Gotchas

- **User-journey keyword is `journey`, not `userJourney`.**
- **`-beta` suffix:** `sankey-beta`, `xychart-beta`, `block-beta` need it;
  `architecture`/`packet`/`radar`/`treemap` accept both (prefer the `-beta` form).
- **ZenUML is not bundled** — `zenuml` blocks won't parse.
- **Hand-drawn shapes** are honored by `flowchart`, `stateDiagram-v2`,
  `classDiagram`, `erDiagram`, `architecture-beta`, `block-beta`, `kanban`. The
  rest (sequence, gantt, mindmap, gitGraph, journey, pie, timeline, quadrant, C4,
  sankey, xychart, packet, radar, treemap) ignore the sketchy shapes but **still
  render in the Virgil hand-drawn font**, so a document stays visually coherent.
- **`look=clean`** opts a single diagram back to crisp classic shapes (the font
  stays consistent). Use it where the sketchy look hurts readability.
- An author may set their own Mermaid frontmatter / `%%{init}%%` in the source;
  if present, the renderer leaves it untouched (you own the config).

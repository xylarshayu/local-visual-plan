# Figures, steppers and embeds: when and how

Loaded on demand. The syntax and output contract for `figure`, `stepper` and
`embed` live in `format.md`; this file is about choosing between them and
drawing well.

## Facts in markdown, geometry in the figure

A figure file holds shapes, positions and short labels. Everything a reader must
know, and everything that goes stale when the code changes, stays in the
markdown: prose, tables, the stepper's `key:` and `changed:` lines, the
figure's body. An agent keeping the page current edits markdown; it should
rarely need to open the SVG.

## The triage ladder

Give each topic the lowest rung that teaches it. Most topics stop at the second
rung.

1. **Bullets.** A short list of facts with no structure between them.
2. **Table.** The same few questions asked of several things (who owns what,
   what refuses what).
3. **Drawn diagram.** One picture of how parts relate: a Mermaid `diagram`
   when Mermaid lays it out well (sequence, state, flowchart, ER), a `figure`
   when it does not (see the house figures below).
4. **Stepper.** The idea is temporal or causal: what happens in order and what
   is true after each step. One per page is normal; it carries the page's
   central idea.
5. **Exploded or isometric figure.** Layers, containment or a physical
   object whose inside matters, when the stacking order is the point. Often
   the page's most memorable picture: spend it on the central idea.
6. **Embed.** An interaction nothing above can show: a simulation, a
   parameter the reader turns through many values. An on/off is a stepper's
   switch, not an embed. Always with a poster and a body that say what
   it shows; at most two per page.

## Pick the behaviour before the layout

Adapted from diagram-design's semantic patterns (Cathryn Lavery, MIT; see
`THIRD_PARTY_NOTICES.md`). When behaviour, enforcement or risk is the point,
name the pattern first and use its layout. One primary pattern per figure; if
two need full treatment, draw an overview and a detail.

| The reader must understand | Pattern | Layout |
|---|---|---|
| Many arrivals competing for one limited service | Fan-in queue | Data flow |
| The same questions asked at every stage | Stage framework | Process (stages x slots) |
| Loose input becoming a durable structured record | Unstructured to structured | Data flow |
| Where two policy decisions first diverge | Paired traces | Flowchart, two lanes |
| Which routes cross a trust boundary and which are blocked | Secure paved road | Architecture |
| Which controls apply at each enforcement point | Control catalog | Layer stack |
| How defences reduce risk and what risk remains | Compensating layers | Layer stack |
| What a system decomposes into, each part traceable to code | Traceable decomposition | Tree |
| How one thing moves through phases, waits and ends | Lifecycle phase map | State machine |

What each pattern must show, in one line:

- **Fan-in queue:** distinct sources, an ordered queue with a count, the
  capacity with units, one service point, admitted and deferred outcomes.
- **Stage framework:** the same slots in the same order in every stage; empty
  slots say "none".
- **Unstructured to structured:** a short source excerpt, the named
  transformation, the finished record, and at least one line from a field back
  to its source.
- **Paired traces:** both decisions on the same steps, the first divergence
  marked.
- **Secure paved road:** the boundary, the allowed route through one gate, the
  blocked routes visibly stopped.
- **Control catalog and compensating layers:** one row per layer, what each
  catches, and what still gets through.
- **Traceable decomposition:** every leaf names its code path.
- **Lifecycle phase map:** every phase, including waits, retries and each end
  state.

Budgets for any figure: at most nine primary nodes and twelve connections, at
most two accented elements, text no smaller than 12 units, everything on a
4-unit grid. Labels and outcomes must read in a still frame; a stepper adds
emphasis, never the only copy of a fact.

## Drawing a figure

- Start from a house figure (below) or a blank `viewBox`. Draw at the size it
  should appear: one user unit is one pixel, a figure grows to at most 1.25x
  its viewBox width when the column has room, and 720 units is a comfortable
  width.
- One text size: every label is 12 units (the default; set no `font-size`).
  A part's name is `font-weight="600"` in full ink, its caption regular with
  `class="muted"`. Hierarchy is weight and ink, never size. At 1.25x that
  reads at 15px, just under the prose.
- Do not reach for size to get clarity or emphasis. Try spacing, weight and
  removal first.
- One ink. Hierarchy is opacity (`data-role`), meaning is dash pattern, colour
  is only accent (look here) and add/del (this changed). The opacity roles are
  adapted from Plotter (Pasquale Vitiello, MIT).
- Name every group the prose or a stepper refers to with `data-part`.
  Connections are parts too (`e-gateway`), so a step can light the path, not
  only the boxes. Put `data-flow` on the line (drawn source to target) and a
  stepper shows movement along it while that step is current. That is the
  one moving thing a page has: one speed, one bead, accent only, three runs
  and then rest.
- In an exploded or isometric stack, `data-lift` on each layer makes the
  current one rise 20 units out of the stack as the stepper walks it, and
  ghosts the layers drawn over it. A layer carries its labels up with it, so
  keep the labels of layers on one level at least 36 units apart, or spread
  them with leaders.
- An axonometric plan (`plan.svg`) shows parts that sit side by side and
  connect, not stacked: buildings on one platform, lanes between them. Put
  `data-rise` on each building; the current one rises 12 units and nothing is
  ghosted. Keep each label inside its building's group so it rises too.
- In a plan, give each kind of part its own simple shape, still one ink: a
  channel of tiles for a queue, ridged units for workers, a gate across a lane
  for a limit, stacked disks for a store. A detail or two per shape, never
  shading or colour.
- Plan labels are plain text on clear ground (a `class="box"` backing with
  `style="stroke:none"` keeps lines from crossing them), not bordered tags.
  A label with no clear ground on its part sits beside it with a short leader.
  Leave arrowheads clear of the shapes in front of them.
- Any part a step names is a shortcut: clicking it goes to the first step
  that names it, and hovering gives it a hint of accent (a `data-rise`
  building also lifts a little). Nothing to declare.
- Arrowheads are open chevrons drawn as paths, so they follow the stroke
  colour.
- An edge label is a plain word for what it carries (`sync`, `enqueue`), or
  the method and path without the version (`POST /sync`) when the call is the
  point. The full route belongs in the code caption. A literal string such as
  a path gets `class="mono"`.
- A technology mark (the logo of a database, a queue, a framework) is a faint
  watermark tucked inside a box's top-right corner, never above it. Put the
  glyph in `<defs>` as `<symbol id="m-name" class="mark" viewBox="0 0 24 24">`
  (filled paths, no colour of its own), and place it with
  `<use href="#m-name" class="mark" x=".." y=".." width="14" height="14"/>`
  inside the part's group, 4 units in from the corner. On a plan, paint it
  flat on a roof instead: `width`/`height` the size in plan units and
  `transform="matrix(1 0.5 -1 0.5 X Y)"`, where X, Y is the roof corner it
  starts from. It draws in ink at 0.3
  opacity, accent at 0.55 while its part is current; text over it wins. A CC0
  set such as Simple Icons works; take only the paths, never brand colours.
- When a step changes what the figure looks like (a part moves, a lid opens),
  declare a `state:` in the stepper and draw each look once in a group with
  `data-show="name=value"`. The stepper fades between them. Keep it to the
  one change the story turns on.
- A part that is really several things (a pool of workers, two processes)
  is drawn as a stacked card the same size as its neighbours: one
  `class="box"` copy per extra member, at most two, each offset 4 units down
  and right, back one first, all inside the part's group. Draw a two-member
  part with one copy, not two. When the members are a topic of their own,
  draw them in their own figure lower on the page (often a plan) and put a
  small "See inside ↓" link under the card
  (`<a href="#stepper:title-slug"><text>See inside ↓</text></a>`, or
  `#figure:` for a plain figure), so the overview stays simple and the reader
  can still drill down. Sample: `renderer/test/fixtures/composite.md`.
- Run the render: every contract breach is a warning naming the file and the
  value.

## House figures

Starter files in `figures/` (next to this skill's `SKILL.md`), each a valid
figure with generic labels. Copy one next to `plan.md`, rename the parts and
labels, delete what you do not need.

| File | Use it for | Pattern |
|---|---|---|
| `layer-stack.svg` | Layers, each with what it catches or owns; an optional "gets through" row | Control catalog, compensating layers |
| `architecture.svg` | Components inside nested trust boundaries, one gate per boundary. For a before/after, mark added parts `data-change="add"` and removed ones `data-change="del"`, and put the change ledger in a table under it | Secure paved road |
| `exploded.svg` | Layers lifted apart in isometric, each with a label and what it is for; a stepper can light one layer at a time | Control catalog, traceable decomposition |
| `plan.svg` | Parts that sit side by side on one platform and connect: an intake, three services, a guard across one lane, a store; each kind its own shape, lanes carry the flow | Fan-in queue, traceable decomposition |
| `click-path.svg` | A request through a cache to an app and its database, with a bypass drawn only while a stepper's switch is off | The worked switch below |
| `swimlane.svg` | Owners as lanes, work moving between them; an optional line of visibility splits what the user sees from what the system does | Stage framework, service blueprint |

**Spectacle, selectively.** The audience runs from executives to developers,
and a page should be remembered. One striking figure per page (exploded,
isometric, a stepper over it) does that; three compete. Keep the budgets and
the one-ink rule: depth comes from drawing (faces, offsets, alignment lines),
not from colour. Shade a side face with `style="fill:var(--bg-sunken)"`.

Mermaid stays the right tool for sequence, state, flowchart, ER, timeline and
dependency graphs. Do not redraw those as figures, unless a stepper walks
through it: a stepper needs a figure.

## Writing a stepper

- Pick the one idea the stepper exists to teach and say it in the last step's
  `key:`. Every earlier step is a step toward it.
- Five to nine steps. More means two steppers or a table.
- `key:` is the idea, `changed:` is the state. If the key idea of two steps is
  the same, merge them.
- `code:` is per part and shows under every step that names it. Attach it to
  the parts only one step names (an edge, or a small part for the thing that
  step creates), so a path is not repeated down the stepper.
- Counters count the facts the idea is about (saved, accepted, delivered), not
  activity. If a counter never changes, cut it. `set:` gives a value, not an
  increment.
- A count the figure itself should show (a digit on a box) is a `state:` with
  one `data-show` group per value.
- To show a count grow, tell the same thing more than once (two clicks, two
  syncs). The first sets the stage; the second is where the idea shows.

## A switch, worked through

The switch belongs to the reader, not to the story. At any step the reader can
turn it off, and the stepper tells the same story without the thing the switch
names: steps marked `needs: switch` drop out, an `off: <title>` step stands in
for the step with that title, and one `held` step stands in for every
`needs: switch` step that has no off step. Use it only when the off state
teaches something (the network is down, a cache is disabled).

- An off step stands in for exactly one step. It may keep that step's title,
  name other parts and set its own values. When turning the thing off adds
  work (no cache means a database read), that work goes in the off steps; the
  step bar does not grow.
- Use `held` when every step that needs the switch stops the same way (nothing
  syncs offline); use off steps when each plays out differently.
- A step both stories share holds in both, `set:` included, and with the switch
  off its rail says it does not need it. Write an off step only where the text
  really differs. Set a value that differs between the stories only in the
  steps that differ.
- When the off story takes another path, draw that path as its own part inside
  a `data-show="switch=off"` group, and name it in the off steps.

A cache the reader can turn off, counted over two clicks:

````
```stepper figure=figures/click-path.svg title="Two clicks on one link"
counter: cache | Served from the cache
counter: db | Reached the database
switch: Edge cache

# A click arrives
parts: browser e-req
key: Every click is one GET for a short code.

# The cache misses
needs: switch
parts: cache e-miss app e-read db
set: db=1
key: An empty cache sends the first click on to the database.
changed: The cache now holds the link.

# The app reads the database
off: The cache misses
parts: e-bypass app e-read db
set: db=1
key: With no cache, the click goes straight to the app.

# The second click hits
needs: switch
parts: browser e-req cache e-hit
set: cache=1
key: A warm cache answers repeat clicks; the database never hears of them.

# The second click reads again
off: The second click hits
parts: browser e-bypass app e-read db
set: db=2
key: With no cache, every click is a database read.
```
````

The figure is the house figure `figures/click-path.svg`. It draws the bypass
only while the switch is off, routed around the boxes rather than through them:

```
<g data-show="switch=off">
  <g data-part="e-bypass"><path data-flow d="M72 72V40H456V72" fill="none"/><path d="M452 65L456 72L460 65"/><text class="muted" x="264" y="32" text-anchor="middle">no cache: straight to the app</text></g>
</g>
```

With the cache on, the counters end at 1 and 1; off, at 0 and 2.

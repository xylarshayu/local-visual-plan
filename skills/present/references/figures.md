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
   parameter the reader turns. Always with a poster and a body that say what
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
  should appear: one user unit is one pixel, a figure never grows past its
  viewBox width (a stepper's past 1.25x), and 720 units is a comfortable
  width.
- One text size: every label is 12 units (the default; set no `font-size`).
  A part's name is `font-weight="600"` in full ink, its caption regular with
  `class="muted"`. Hierarchy is weight and ink, never size. At a stepper's
  1.25x that reads at 15px, just under the prose.
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
  and then rest. In an
  exploded or isometric stack, `data-lift` on each layer makes the current
  one rise out of the stack as the stepper walks it.
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
  inside the part's group, 4 units in from the corner. It draws in ink at 0.3
  opacity, accent at 0.55 while its part is current; text over it wins. A CC0
  set such as Simple Icons works; take only the paths, never brand colours.
- When a step changes what the figure looks like (a part moves, a lid opens),
  declare a `state:` in the stepper and draw each look once in a group with
  `data-show="name=value"`. The stepper fades between them. Keep it to the
  one change the story turns on.
- A part that is really several things (a pool of workers, a set of services)
  is drawn as a three-layer card: the box plus two `class="box"` copies offset
  6 units up and right, back one first, all inside the part's group. When the
  story needs the members, draw them inside the box as their own parts with
  `data-future="hidden"`, and the step that names them opens the box. When the
  members are a topic of their own, give them an exploded figure elsewhere on
  the page and put a small "See inside" link in the card's corner
  (`<a href="#stepper:title-slug"><text>See inside ↓</text></a>`, or `#figure:` for a plain figure), so the
  overview stays simple and the reader can still drill down. Sample:
  `renderer/test/fixtures/composite.md`.
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
| `swimlane.svg` | Owners as lanes, work moving between them; an optional line of visibility splits what the user sees from what the system does | Stage framework, service blueprint |

**Spectacle, selectively.** The audience runs from executives to developers,
and a page should be remembered. One striking figure per page (exploded,
isometric, a stepper over it) does that; three compete. Keep the budgets and
the one-ink rule: depth comes from drawing (faces, offsets, alignment lines),
not from colour. Shade a side face with `style="fill:var(--bg-sunken)"`.

Mermaid stays the right tool for sequence, state, flowchart, ER, timeline and
dependency graphs. Do not redraw those as figures.

## Writing a stepper

- Pick the one idea the stepper exists to teach and say it in the last step's
  `key:`. Every earlier step is a step toward it.
- Five to nine steps. More means two steppers or a table.
- `key:` is the idea, `changed:` is the state. If the key idea of two steps is
  the same, merge them.
- Counters count the facts the idea is about (saved, accepted, delivered), not
  activity. If a counter never changes, cut it.
- Use the switch only when its off state teaches something (the network is
  down, a feature is disabled). When one step plays out differently, write that
  version as an `off:` step; when every step that needs the switch stops the
  same way, write one `held` step. Either gets its own key idea.

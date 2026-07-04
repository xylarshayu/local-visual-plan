# Wireframe authoring guide (`.wf-*` class catalog)

The `wireframe` block renders a UI mockup from **constrained HTML** using the
documented `.wf-*` classes below. The renderer wraps your body in the chosen
**surface** chrome (`.wf-screen.wf-<surface>`) and applies the design-system
tokens — it does **not** invent layout. You compose primitives; the stylesheet
makes them look intentional in both light and dark themes.

> Authoring syntax (see `format.md` for the full contract):
> ````
> ```wireframe surface=page title="Settings — after" style=clean
> <div class="wf-toolbar"><span class="wf-title">Settings</span></div>
> ```
> ````
> Attributes: `surface=page|panel|popover|sheet|toolbar` (default `page`),
> `title=<text>` (optional caption), `style=clean|sketchy` (default `clean`).

## Trust boundary

Wireframe bodies are passed through **as raw HTML** (everything else in a plan
is HTML-escaped). They are authored by the agent and viewed locally from
`file://`, so this is safe in the normal flow. **Do not render untrusted plan
files** — a hostile wireframe body is arbitrary HTML.

## Clean vs. sketchy

- `style=clean` (default): crisp 1.5px outlines, solid fills. Use for plans that
  communicate a near-final layout.
- `style=sketchy`: hand-drawn feel — dashed primitive borders, a roughening SVG
  displacement filter, and a marker-style font. Use to signal "low-fidelity,
  not pixel-final." Prefer clean for most plans; reach for sketchy when you want
  to keep the conversation about structure, not visual polish.

## Surfaces (the frame the renderer adds)

| `surface`  | Frame class               | Use for |
|------------|---------------------------|---------|
| `page`     | `.wf-screen.wf-page`      | Full-screen views; gets elevation. |
| `panel`    | `.wf-screen.wf-panel`     | Side panels / inspectors (max ~420px). |
| `popover`  | `.wf-screen.wf-popover`   | Menus / small floating cards (max ~300px). |
| `sheet`    | `.wf-screen.wf-sheet`     | Bottom sheets / modals (rounded top). |
| `toolbar`  | `.wf-screen.wf-toolbar-surface` | Pill-shaped control strips. |

## Primitive class catalog

### Structure
- `.wf-toolbar` — top bar; holds `.wf-title` / `.wf-subtitle` / `.wf-spacer`.
- `.wf-title`, `.wf-subtitle` — heading and secondary heading text.
- `.wf-row` — horizontal flex group (wraps), 10px gap, padded.
- `.wf-col` — vertical flex group.
- `.wf-grid` — responsive auto-fill grid of cards (min 150px columns).
- `.wf-spacer` — flex spacer that pushes following items to the right.
- `.wf-divider` — thin horizontal rule.

### Controls
- `.wf-btn` — button. Add `.wf-primary` (accent fill) or `.wf-ghost` (text-only).
- `.wf-input` — text field placeholder (style it with placeholder text inside).
- `.wf-badge` — small pill label (counts, status).

### Content
- `.wf-card` — bordered container (column layout, holds a `.wf-title` + text).
- `.wf-list` / `.wf-listitem` — a list with separated rows.
- `.wf-muted` — muted/secondary text.
- `.wf-img` — image placeholder (checkerboard, ~110px tall).
- `.wf-avatar` — round image placeholder (38px).
- `.wf-text-line` / `.wf-text-line.short` — skeleton text bars.

## One example per surface

### page
```wireframe surface=page title="Inbox"
<div class="wf-toolbar">
  <span class="wf-title">Inbox</span>
  <span class="wf-spacer"></span>
  <button class="wf-btn wf-ghost">Filter</button>
  <button class="wf-btn wf-primary">Compose</button>
</div>
<ul class="wf-list">
  <li class="wf-listitem"><span class="wf-avatar"></span><span>Ada Lovelace</span><span class="wf-spacer"></span><span class="wf-muted">2m</span></li>
  <li class="wf-listitem"><span class="wf-avatar"></span><span>Alan Turing</span><span class="wf-spacer"></span><span class="wf-badge">new</span></li>
</ul>
```

### panel
```wireframe surface=panel title="Inspector"
<div class="wf-toolbar"><span class="wf-title">Layer</span></div>
<div class="wf-col">
  <div class="wf-row"><span class="wf-muted">Opacity</span><span class="wf-spacer"></span><input class="wf-input" value="100%"></div>
  <div class="wf-row"><button class="wf-btn wf-primary">Apply</button></div>
</div>
```

### popover
```wireframe surface=popover title="Account menu"
<ul class="wf-list">
  <li class="wf-listitem">Profile</li>
  <li class="wf-listitem">Settings</li>
  <li class="wf-listitem wf-muted">Sign out</li>
</ul>
```

### sheet
```wireframe surface=sheet title="Share"
<div class="wf-toolbar"><span class="wf-title">Share file</span></div>
<div class="wf-row"><input class="wf-input" value="teammate@example.com"></div>
<div class="wf-row"><span class="wf-spacer"></span><button class="wf-btn">Cancel</button><button class="wf-btn wf-primary">Send</button></div>
```

### toolbar
```wireframe surface=toolbar title="Editor controls"
<div class="wf-row">
  <button class="wf-btn">Bold</button>
  <button class="wf-btn">Italic</button>
  <span class="wf-divider" style="width:1px;height:20px"></span>
  <button class="wf-btn wf-primary">Save</button>
</div>
```

## Quality bar

- Compose from the catalog; don't inline ad-hoc `style=` beyond minor sizing.
- Keep mockups to the structure that matters for the decision — wireframes are
  for layout and flow, not final visual design.
- Pair a `surface=*` with `style=sketchy` early in a plan, `clean` once the
  layout is settled.

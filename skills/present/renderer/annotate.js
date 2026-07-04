/* presentation annotation layer — vanilla JS, no framework, runs from file://.
   Responsibilities: click-to-annotate notes (composer + pins + viewer), a
   right-side review panel, questions-form wiring, verdict, persistence
   (localStorage keyed pf:<docId> with in-memory fallback), viewed checkboxes,
   permalinks, and the versioned feedback export.

   This file is inlined verbatim into the rendered page by the engine at the
   "INLINE:annotate.js" marker. It must stay self-contained: no imports,
   no exports, no build step.

   The pure, DOM-free logic (export serialization, excerpt normalization, state
   migration) hangs off a namespace object (window.PFAnnotate) so it can be
   unit-tested under node with a minimal shim — the DOM boot is skipped when
   document.querySelector is absent. */
(function () {
  "use strict";

  /* ======================================================================
     PURE LOGIC (DOM-free, unit-tested via window.PFAnnotate)
     ====================================================================== */

  /* Derive the kind prefix from an anchor string ("step:foo" -> "step"). */
  function anchorKind(anchor) {
    var s = String(anchor == null ? "" : anchor);
    var i = s.indexOf(":");
    return i === -1 ? s : s.slice(0, i);
  }

  /* A URL-ish slug used for the doc line + download filename. */
  function slugify(str) {
    var s = String(str == null ? "" : str)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return s || "untitled";
  }

  /* Collapse whitespace, trim, cap at max chars, append … when truncated. */
  function normalizeText(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }
  function normalizeExcerpt(text, max) {
    max = max || 140;
    var s = normalizeText(text);
    if (s.length > max) return s.slice(0, max) + "…";
    return s;
  }

  /* Map internal verdict (null | "approve" | "request-changes") to its token. */
  function verdictToken(v) {
    if (v === "approve") return "approve";
    if (v === "request-changes") return "request-changes";
    return "none";
  }

  function defaultState() {
    return { version: 1, notes: [], answers: {}, verdict: null, viewed: {} };
  }

  /* Coerce arbitrary stored JSON into the current, well-formed shape so a
     corrupt / older / partial blob never crashes the UI. */
  function migrateState(raw) {
    var s = defaultState();
    if (!raw || typeof raw !== "object") return s;
    if (Array.isArray(raw.notes)) {
      s.notes = raw.notes
        .filter(function (n) { return n && typeof n.anchor === "string"; })
        .map(function (n) {
          return {
            id: typeof n.id === "string" && n.id ? n.id : "n" + Math.random().toString(36).slice(2, 9),
            anchor: n.anchor,
            excerpt: typeof n.excerpt === "string" ? n.excerpt : "",
            text: typeof n.text === "string" ? n.text : "",
            audience: n.audience === "self" ? "self" : "agent",
            ts: typeof n.ts === "number" ? n.ts : 0
          };
        });
    }
    if (raw.answers && typeof raw.answers === "object") {
      Object.keys(raw.answers).forEach(function (k) {
        var a = raw.answers[k];
        if (!a || typeof a !== "object") return;
        s.answers[k] = {
          mode: a.mode === "custom" ? "custom" : "default",
          text: typeof a.text === "string" ? a.text : ""
        };
      });
    }
    if (raw.verdict === "approve" || raw.verdict === "request-changes") s.verdict = raw.verdict;
    if (raw.viewed && typeof raw.viewed === "object") {
      Object.keys(raw.viewed).forEach(function (k) { if (raw.viewed[k]) s.viewed[k] = true; });
    }
    return s;
  }

  /* The normative feedback export (presentation-feedback v1). See the pinned
     contract — the agent-side parser depends on this byte-for-byte. */
  function buildExportMarkdown(state, map, docOrder) {
    state = state || {};
    map = map || {};
    var anchors = map.anchors || {};
    var order = Array.isArray(docOrder) ? docOrder : [];
    var idx = {};
    order.forEach(function (a, i) { idx[a] = i; });

    function kindOf(a) { return (anchors[a] && anchors[a].kind) || anchorKind(a); }
    function labelOf(a) { return (anchors[a] && anchors[a].label) || ""; }

    var header = [
      "<!-- presentation-feedback v1 -->",
      "doc: " + slugify(map.title || "untitled") + " (" + (map.docId || "pf-unknown") + ")",
      "source: " + (map.source || "unknown"),
      "verdict: " + verdictToken(state.verdict)
    ].join("\n");

    var blocks = [];

    /* Agent-audience notes in document order; detached anchors sort last but
       are never dropped (excerpt is the re-anchor evidence). */
    var notes = (state.notes || []).filter(function (n) { return n && n.audience !== "self"; });
    notes = notes.slice().sort(function (a, b) {
      var ia = Object.prototype.hasOwnProperty.call(idx, a.anchor) ? idx[a.anchor] : Infinity;
      var ib = Object.prototype.hasOwnProperty.call(idx, b.anchor) ? idx[b.anchor] : Infinity;
      if (ia !== ib) return ia - ib;
      return (a.ts || 0) - (b.ts || 0);
    });
    notes.forEach(function (n) {
      blocks.push(
        "## note — " + kindOf(n.anchor) + " \"" + labelOf(n.anchor) + "\" [" + n.anchor + "]\n" +
        "> " + normalizeExcerpt(n.excerpt, 140) + "\n" +
        (n.text == null ? "" : String(n.text))
      );
    });

    /* Questions the user interacted with (present in state.answers), in doc
       order; untouched questions feed the trailing count. */
    var answers = state.answers || {};
    var questionAnchors = order.filter(function (a) { return kindOf(a) === "q"; });
    var unreviewed = 0;
    questionAnchors.forEach(function (a) {
      var ans = answers[a];
      if (!ans) { unreviewed++; return; }
      var head = "## answer — \"" + labelOf(a) + "\" [" + a + "]";
      var line;
      if (ans.mode === "custom") {
        line = "custom: " + (ans.text == null ? "" : String(ans.text));
      } else {
        var def = (anchors[a] && anchors[a].default != null) ? String(anchors[a].default) : "";
        line = "accepted default: " + def;
      }
      blocks.push(head + "\n" + line);
    });
    if (unreviewed > 0) blocks.push("unreviewed questions: " + unreviewed);

    var body = blocks.join("\n\n");
    return body ? header + "\n\n" + body + "\n" : header + "\n";
  }

  var PF = {
    anchorKind: anchorKind,
    slugify: slugify,
    normalizeText: normalizeText,
    normalizeExcerpt: normalizeExcerpt,
    verdictToken: verdictToken,
    defaultState: defaultState,
    migrateState: migrateState,
    buildExportMarkdown: buildExportMarkdown
  };

  var GLOBAL = (typeof window !== "undefined") ? window
    : (typeof globalThis !== "undefined") ? globalThis
    : (typeof self !== "undefined") ? self : null;
  if (GLOBAL) GLOBAL.PFAnnotate = PF;

  /* ======================================================================
     DOM BOOT — skipped entirely when there is no DOM (e.g. node tests).
     ====================================================================== */
  if (typeof document === "undefined" || !document.querySelector) return;

  /* ----- Anchor map + doc identity -------------------------------------- */
  var map = { version: 1, docId: "pf-unknown", source: null, title: document.title || "untitled", anchors: {} };
  try {
    var mapEl = document.getElementById("pf-anchor-map");
    if (mapEl && mapEl.textContent) {
      var parsed = JSON.parse(mapEl.textContent);
      if (parsed && typeof parsed === "object") map = parsed;
    }
  } catch (e) { /* keep defaults */ }
  if (!map.anchors || typeof map.anchors !== "object") map.anchors = {};
  var DOC_ID = map.docId || "pf-unknown";
  var STORAGE_KEY = "pf:" + DOC_ID;

  /* ----- Document order + question-default enrichment ------------------- */
  function computeDocOrder() {
    var els = document.querySelectorAll("[data-pf-anchor]");
    var order = [];
    var seen = {};
    Array.prototype.forEach.call(els, function (el) {
      var a = el.getAttribute("data-pf-anchor");
      if (a && !seen[a]) { seen[a] = true; order.push(a); }
    });
    return order;
  }
  var docOrder = computeDocOrder();

  Array.prototype.forEach.call(document.querySelectorAll(".question[data-pf-anchor]"), function (q) {
    var a = q.getAttribute("data-pf-anchor");
    var meta = map.anchors[a] || (map.anchors[a] = { kind: "q", label: "", lines: null });
    if (!meta.kind) meta.kind = "q";
    if (!meta.label) {
      var qt = q.querySelector(".q-text");
      meta.label = qt ? normalizeText(qt.textContent) : a;
    }
    var def = q.querySelector(".q-default");
    meta.default = def ? normalizeText(def.textContent) : "";
  });

  function metaFor(anchor) {
    return map.anchors[anchor] || { kind: anchorKind(anchor), label: "", lines: null };
  }
  function labelFor(anchor) {
    var m = metaFor(anchor);
    return m.label || anchor;
  }
  function elForAnchor(anchor) { return document.getElementById(anchor); }

  /* ----- Persistence (localStorage w/ in-memory fallback) --------------- */
  var storageOK = true;
  function readState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return migrateState(JSON.parse(raw));
      return defaultState();
    } catch (e) {
      storageOK = false;
      return defaultState();
    }
  }
  var state = readState();

  function persist() {
    if (!storageOK) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      storageOK = false;
      updateDegraded();
    }
  }

  /* ----- Small helpers -------------------------------------------------- */
  function uid() { return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function el(tag, cls, attrs) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }
  function notesByAnchor() {
    var by = {};
    state.notes.forEach(function (n) { (by[n.anchor] || (by[n.anchor] = [])).push(n); });
    return by;
  }
  function excerptFor(anchor) {
    var node = elForAnchor(anchor);
    return node ? normalizeExcerpt(node.textContent, 140) : "";
  }

  /* ----- Reveal (open tabs / details) + jump + flash -------------------- */
  function activateTabForPanel(panel) {
    var group = panel.closest("[data-block=tabs]");
    if (!group) { panel.removeAttribute("hidden"); return; }
    var panels = Array.prototype.slice.call(group.querySelectorAll(".tab-panel"));
    var i = panels.indexOf(panel);
    var btns = group.querySelectorAll(".tab-btn");
    if (i >= 0 && btns[i]) btns[i].click();     /* interactivity.js switches */
    else panel.removeAttribute("hidden");
  }
  function revealAncestors(node) {
    var n = node;
    while (n && n.nodeType === 1 && n !== document.body) {
      if (n.tagName === "DETAILS" && !n.open) n.open = true;
      n = n.parentElement;
    }
    var guard = 0;
    var hiddenPanel = node.closest(".tab-panel[hidden]");
    while (hiddenPanel && guard++ < 20) {
      activateTabForPanel(hiddenPanel);
      hiddenPanel = node.closest(".tab-panel[hidden]");
    }
  }
  function flash(node) {
    node.classList.add("pf-flash");
    setTimeout(function () { node.classList.remove("pf-flash"); }, 1200);
  }
  function jumpTo(anchor) {
    var node = elForAnchor(anchor);
    if (!node) return;
    revealAncestors(node);
    requestAnimationFrame(function () {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      flash(node);
      scheduleReposition();
    });
  }

  /* ----- Clipboard + download ------------------------------------------ */
  function fallbackCopy(text) {
    try {
      var ta = el("textarea");
      ta.value = text;
      ta.setAttribute("aria-hidden", "true");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(fallbackCopy(text)); }
      );
    } else {
      done(fallbackCopy(text));
    }
  }
  function currentExport() { return buildExportMarkdown(state, map, docOrder); }
  function downloadExport() {
    try {
      var md = currentExport();
      var blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = el("a");
      a.href = url;
      a.download = slugify(map.title || "feedback") + "-feedback.md";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    } catch (e) { toast("Download failed"); }
  }

  /* ----- Toast ---------------------------------------------------------- */
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) { toastEl = el("div", "pf-toast", { role: "status", "aria-live": "polite" }); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add("pf-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("pf-toast-show"); }, 1700);
  }

  /* ----- Overlay layer: pins + permalink ------------------------------- */
  var overlay = el("div", "pf-overlay", { "aria-hidden": "false" });
  document.body.appendChild(overlay);

  function isVisible(node) {
    if (!node) return false;
    if (node.offsetParent === null && node.getClientRects().length === 0) return false;
    var r = node.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && r.bottom > 0 && r.top < window.innerHeight;
  }

  function renderPins() {
    /* Remove old pins but keep the permalink element. */
    Array.prototype.slice.call(overlay.querySelectorAll(".pf-pin")).forEach(function (p) { p.remove(); });
    var by = notesByAnchor();
    Object.keys(by).forEach(function (anchor) {
      var node = elForAnchor(anchor);
      if (!node || !isVisible(node)) return;   /* hidden ones live in the panel */
      var r = node.getBoundingClientRect();
      var count = by[anchor].length;
      var pin = el("button", "pf-pin", { type: "button", "data-pf-anchor-pin": anchor });
      pin.setAttribute("aria-label", count + (count === 1 ? " note" : " notes") + " on " + labelFor(anchor) + " — open");
      pin.textContent = "💬" + count;
      var left = Math.min(r.right - 6, window.innerWidth - 40);
      var top = Math.max(4, r.top - 8);
      pin.style.left = left + "px";
      pin.style.top = top + "px";
      overlay.appendChild(pin);
    });
  }

  /* Permalink ¶ affordance */
  var permalink = el("button", "pf-permalink", { type: "button", "aria-label": "Copy a permalink to this element" });
  permalink.textContent = "¶";
  permalink.hidden = true;
  overlay.appendChild(permalink);
  var permalinkAnchor = null;
  function positionPermalink(node) {
    var r = node.getBoundingClientRect();
    permalink.style.top = Math.max(2, r.top + 2) + "px";
    permalink.style.left = Math.max(2, r.left - 22) + "px";
    permalink.hidden = false;
  }
  permalink.addEventListener("click", function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!permalinkAnchor) return;
    try { history.replaceState(null, "", "#" + permalinkAnchor); } catch (e) { location.hash = permalinkAnchor; }
    copyText("#" + permalinkAnchor, function (ok) { toast(ok ? "Link copied" : "Link set"); });
    jumpTo(permalinkAnchor);
  });

  /* ----- Reposition on scroll / resize --------------------------------- */
  var repositionQueued = false;
  function scheduleReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(function () {
      repositionQueued = false;
      renderPins();
      if (composerAnchor) placePopover(composer, elForAnchor(composerAnchor) || document.body);
      if (viewerAnchor) placePopover(viewer, elForAnchor(viewerAnchor) || document.body);
    });
  }
  window.addEventListener("scroll", function () { permalink.hidden = true; scheduleReposition(); }, true);
  window.addEventListener("resize", scheduleReposition);

  /* ----- Note mode ------------------------------------------------------ */
  var noteMode = false;
  var hoverTarget = null;
  function setHover(node) {
    if (hoverTarget === node) return;
    if (hoverTarget) hoverTarget.classList.remove("pf-hover-target");
    hoverTarget = node;
    if (hoverTarget) hoverTarget.classList.add("pf-hover-target");
  }
  function enterNoteMode() {
    if (noteMode) return;
    noteMode = true;
    document.body.classList.add("pf-note-mode");
    permalink.hidden = true;
    addBtn.setAttribute("aria-pressed", "true");
    toast("Note mode — click any element. Esc to exit.");
  }
  function exitNoteMode() {
    if (!noteMode) return;
    noteMode = false;
    document.body.classList.remove("pf-note-mode");
    setHover(null);
    addBtn.setAttribute("aria-pressed", "false");
  }

  function isOwnUI(target) {
    return !!(target.closest && (target.closest(".pf-pill") || target.closest(".pf-panel") ||
      target.closest(".pf-composer") || target.closest(".pf-viewer") || target.closest(".pf-overlay") ||
      target.closest(".pf-toast")));
  }

  document.addEventListener("mouseover", function (ev) {
    var t = ev.target;
    if (noteMode) {
      if (isOwnUI(t)) { setHover(null); return; }
      setHover(t.closest ? t.closest("[data-pf-anchor]") : null);
      return;
    }
    /* permalink affordance in normal reading mode */
    if (isOwnUI(t) && !(t.closest && t.closest(".pf-permalink"))) return;
    var a = t.closest ? t.closest("[data-pf-anchor]") : null;
    if (a) { permalinkAnchor = a.getAttribute("data-pf-anchor"); positionPermalink(a); }
    else if (!(t.closest && t.closest(".pf-permalink"))) { permalink.hidden = true; }
  }, true);

  document.addEventListener("click", function (ev) {
    if (!noteMode) return;
    var t = ev.target;
    if (isOwnUI(t)) return;                       /* let our controls work */
    var a = t.closest ? t.closest("[data-pf-anchor]") : null;
    if (!a) return;
    ev.preventDefault();
    ev.stopPropagation();
    openComposer(a.getAttribute("data-pf-anchor"), a);
  }, true);

  /* ----- Popover placement --------------------------------------------- */
  function placePopover(pop, node) {
    var r = node.getBoundingClientRect();
    var pw = pop.offsetWidth || 300;
    var ph = pop.offsetHeight || 170;
    var left = r.left;
    var top = r.bottom + 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    if (top < 8) top = 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  /* ----- Composer ------------------------------------------------------- */
  var composer = null;
  var composerAnchor = null;
  function closeComposer() {
    if (composer) { composer.remove(); composer = null; composerAnchor = null; }
  }
  function openComposer(anchor, node) {
    closeComposer();
    closeViewer();
    composerAnchor = anchor;
    composer = el("div", "pf-composer", { role: "dialog", "aria-label": "Add a note" });
    var kindLabel = metaFor(anchor).kind + ": " + (labelFor(anchor) || anchor);
    composer.innerHTML =
      '<div class="pf-pop-head"><span class="pf-pop-anchor"></span>' +
        '<button type="button" class="pf-x" data-pf-close aria-label="Cancel">×</button></div>' +
      '<textarea class="pf-composer-text" placeholder="Your note…" aria-label="Note text"></textarea>' +
      '<div class="pf-aud" role="radiogroup" aria-label="Audience">' +
        '<label class="pf-aud-opt"><input type="radio" name="pf-aud" value="agent" checked> for the agent</label>' +
        '<label class="pf-aud-opt"><input type="radio" name="pf-aud" value="self"> note to self</label>' +
      '</div>' +
      '<div class="pf-pop-actions">' +
        '<button type="button" class="pf-btn pf-ghost" data-pf-close>Cancel</button>' +
        '<button type="button" class="pf-btn pf-primary" data-pf-pin>Pin note</button>' +
      '</div>';
    composer.querySelector(".pf-pop-anchor").textContent = kindLabel;
    document.body.appendChild(composer);
    placePopover(composer, node || elForAnchor(anchor) || document.body);
    var ta = composer.querySelector(".pf-composer-text");
    ta.focus();

    composer.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); closeComposer(); exitNoteMode(); }
    });
    composer.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-pf-close]")) { closeComposer(); exitNoteMode(); return; }
      if (ev.target.closest("[data-pf-pin]")) {
        var text = ta.value;
        if (!normalizeText(text)) { ta.focus(); return; }
        var aud = composer.querySelector('input[name="pf-aud"]:checked');
        addNote(anchor, text, aud ? aud.value : "agent");
        closeComposer();
        exitNoteMode();
      }
    });
  }

  /* ----- Pin viewer (read / edit / delete / flip audience) -------------- */
  var viewer = null;
  var viewerAnchor = null;
  function closeViewer() {
    if (viewer) { viewer.remove(); viewer = null; viewerAnchor = null; }
  }
  function openViewer(anchor, node) {
    closeComposer();
    closeViewer();
    viewerAnchor = anchor;
    viewer = el("div", "pf-viewer", { role: "dialog", "aria-label": "Notes on " + labelFor(anchor) });
    renderViewer();
    document.body.appendChild(viewer);
    placePopover(viewer, node || elForAnchor(anchor) || document.body);
    var first = viewer.querySelector("textarea");
    if (first) first.focus();

    viewer.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); closeViewer(); }
    });
  }
  function renderViewer() {
    if (!viewer) return;
    var notes = notesByAnchor()[viewerAnchor] || [];
    if (!notes.length) { closeViewer(); return; }
    var html =
      '<div class="pf-pop-head"><span class="pf-pop-anchor">' + escapeHtml(metaFor(viewerAnchor).kind + ": " + labelFor(viewerAnchor)) + '</span>' +
      '<button type="button" class="pf-x" data-pf-vclose aria-label="Close">×</button></div>';
    notes.forEach(function (n) {
      html +=
        '<div class="pf-vnote" data-note="' + n.id + '">' +
          '<textarea class="pf-vtext" aria-label="Note text">' + escapeHtml(n.text) + '</textarea>' +
          '<div class="pf-vrow">' +
            '<span class="pf-aud" role="radiogroup" aria-label="Audience">' +
              '<label class="pf-aud-opt"><input type="radio" name="pf-vaud-' + n.id + '" value="agent"' + (n.audience !== "self" ? " checked" : "") + '> agent</label>' +
              '<label class="pf-aud-opt"><input type="radio" name="pf-vaud-' + n.id + '" value="self"' + (n.audience === "self" ? " checked" : "") + '> self</label>' +
            '</span>' +
            '<button type="button" class="pf-btn pf-danger" data-pf-vdel="' + n.id + '">Delete</button>' +
          '</div>' +
        '</div>';
    });
    html += '<div class="pf-pop-actions"><button type="button" class="pf-btn pf-ghost" data-pf-vadd>+ Add note</button></div>';
    viewer.innerHTML = html;

    viewer.querySelectorAll(".pf-vnote").forEach(function (row) {
      var id = row.getAttribute("data-note");
      var ta = row.querySelector(".pf-vtext");
      var deb;
      ta.addEventListener("input", function () {
        clearTimeout(deb);
        deb = setTimeout(function () { updateNote(id, { text: ta.value }); }, 300);
      });
      row.querySelectorAll('input[type="radio"]').forEach(function (r) {
        r.addEventListener("change", function () { if (r.checked) updateNote(id, { audience: r.value }); });
      });
    });
    viewer.addEventListener("click", viewerClick);
  }
  function viewerClick(ev) {
    if (ev.target.closest("[data-pf-vclose]")) { closeViewer(); return; }
    var del = ev.target.closest("[data-pf-vdel]");
    if (del) { deleteNote(del.getAttribute("data-pf-vdel")); return; }
    if (ev.target.closest("[data-pf-vadd]")) { var a = viewerAnchor; closeViewer(); openComposer(a, elForAnchor(a)); }
  }

  /* Pin click -> open viewer */
  overlay.addEventListener("click", function (ev) {
    var pin = ev.target.closest(".pf-pin");
    if (!pin) return;
    ev.preventDefault();
    var anchor = pin.getAttribute("data-pf-anchor-pin");
    openViewer(anchor, elForAnchor(anchor));
  });

  /* ----- Note mutations ------------------------------------------------- */
  function addNote(anchor, text, audience) {
    state.notes.push({
      id: uid(),
      anchor: anchor,
      excerpt: excerptFor(anchor),
      text: text,
      audience: audience === "self" ? "self" : "agent",
      ts: Date.now()
    });
    persist();
    renderAll();
  }
  function updateNote(id, patch) {
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === id) {
        if (patch.text != null) state.notes[i].text = patch.text;
        if (patch.audience) state.notes[i].audience = patch.audience === "self" ? "self" : "agent";
        break;
      }
    }
    persist();
    if (panelOpen()) renderPanel();
    updateCount();
  }
  function deleteNote(id) {
    var anchor = null;
    state.notes = state.notes.filter(function (n) {
      if (n.id === id) { anchor = n.anchor; return false; }
      return true;
    });
    persist();
    if (viewer && viewerAnchor === anchor) renderViewer();
    renderAll();
  }

  /* ----- Questions wiring ---------------------------------------------- */
  function recordAnswer(anchor, mode, text) {
    state.answers[anchor] = { mode: mode === "custom" ? "custom" : "default", text: mode === "custom" ? (text || "") : "" };
    persist();
    if (panelOpen()) renderPanel();
  }
  function wireQuestions() {
    Array.prototype.forEach.call(document.querySelectorAll(".question[data-pf-anchor]"), function (q) {
      var anchor = q.getAttribute("data-pf-anchor");
      var radios = q.querySelectorAll('input[type="radio"]');
      var ta = q.querySelector(".q-custom");
      var saved = state.answers[anchor];
      if (saved) {
        Array.prototype.forEach.call(radios, function (r) { r.checked = (r.value === saved.mode); });
        if (ta && saved.mode === "custom") ta.value = saved.text || "";
      }
      Array.prototype.forEach.call(radios, function (r) {
        r.addEventListener("change", function () {
          if (!r.checked) return;
          recordAnswer(anchor, r.value, ta ? ta.value : "");
          if (r.value === "custom" && ta) ta.focus();
        });
      });
      if (ta) {
        var deb;
        ta.addEventListener("input", function () {
          var custom = q.querySelector('input[value="custom"]');
          if (custom && !custom.checked) custom.checked = true;
          clearTimeout(deb);
          deb = setTimeout(function () { recordAnswer(anchor, "custom", ta.value); }, 300);
        });
      }
    });
  }

  /* ----- Viewed checkboxes (recap diffs) ------------------------------- */
  function wireViewed() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-block=tabs]"), function (group) {
      var btns = Array.prototype.slice.call(group.querySelectorAll(".tab-btn"));
      var panels = Array.prototype.slice.call(group.querySelectorAll(".tab-panel"));
      btns.forEach(function (btn, i) {
        var panel = panels[i];
        if (!panel) return;
        var diff = panel.querySelector("figure[data-block=diff][data-pf-anchor]");
        if (!diff) return;
        var anchor = diff.getAttribute("data-pf-anchor");
        var chk = el("span", "pf-viewed", { role: "checkbox", tabindex: "0" });
        chk.setAttribute("aria-label", "Mark this diff as viewed");
        function paint() {
          var on = !!state.viewed[anchor];
          chk.textContent = on ? "✓" : "";
          chk.setAttribute("aria-checked", on ? "true" : "false");
          btn.classList.toggle("pf-tab-viewed", on);
        }
        function toggle(ev) {
          ev.stopPropagation();
          ev.preventDefault();
          if (state.viewed[anchor]) delete state.viewed[anchor];
          else state.viewed[anchor] = true;
          persist();
          paint();
        }
        chk.addEventListener("click", toggle);
        chk.addEventListener("keydown", function (ev) {
          if (ev.key === " " || ev.key === "Enter" || ev.key === "Spacebar") toggle(ev);
        });
        btn.appendChild(chk);
        paint();
      });
    });
  }

  /* ----- Review panel --------------------------------------------------- */
  var pill = el("div", "pf-pill", { role: "region", "aria-label": "Annotation tools" });
  pill.innerHTML =
    '<button type="button" class="pf-pill-btn" data-pf-add aria-label="Add a note" aria-pressed="false">' +
      '<span aria-hidden="true">💬</span> Add note</button>' +
    '<button type="button" class="pf-pill-btn" data-pf-toggle-panel aria-label="Open review panel">' +
      'Notes (<span data-pf-count>0</span>)</button>' +
    '<button type="button" class="pf-pill-btn" data-pf-export aria-label="Open export">Export</button>';
  document.body.appendChild(pill);
  var addBtn = pill.querySelector("[data-pf-add]");
  var countEl = pill.querySelector("[data-pf-count]");

  var panel = el("aside", "pf-panel", { "aria-label": "Your review", "aria-hidden": "true" });
  panel.innerHTML =
    '<div class="pf-panel-head">' +
      '<span class="pf-panel-title">Your review</span>' +
      '<span class="pf-panel-badge" data-pf-panel-count>0 notes</span>' +
      '<button type="button" class="pf-x" data-pf-panel-close aria-label="Close review panel">×</button>' +
    '</div>' +
    '<div class="pf-degraded" data-pf-degraded hidden>notes won’t survive reload — export before closing</div>' +
    '<div class="pf-panel-body" data-pf-panel-body></div>';
  document.body.appendChild(panel);
  var panelBody = panel.querySelector("[data-pf-panel-body]");

  function panelOpen() { return panel.classList.contains("pf-open"); }
  function openPanel() {
    panel.classList.add("pf-open");
    panel.setAttribute("aria-hidden", "false");
    renderPanel();
  }
  function closePanel() {
    panel.classList.remove("pf-open");
    panel.setAttribute("aria-hidden", "true");
  }
  function togglePanel() { if (panelOpen()) closePanel(); else openPanel(); }

  function updateDegraded() {
    var b = panel.querySelector("[data-pf-degraded]");
    if (b) b.hidden = storageOK;
  }
  function updateCount() {
    countEl.textContent = String(state.notes.length);
    var pc = panel.querySelector("[data-pf-panel-count]");
    if (pc) pc.textContent = state.notes.length + (state.notes.length === 1 ? " note" : " notes");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderPanel() {
    updateDegraded();
    updateCount();
    var orderIndex = {};
    docOrder.forEach(function (a, i) { orderIndex[a] = i; });

    var attached = [];
    var detached = [];
    state.notes.forEach(function (n) {
      if (elForAnchor(n.anchor)) attached.push(n);
      else detached.push(n);
    });
    attached.sort(function (a, b) {
      var ia = orderIndex.hasOwnProperty(a.anchor) ? orderIndex[a.anchor] : 1e9;
      var ib = orderIndex.hasOwnProperty(b.anchor) ? orderIndex[b.anchor] : 1e9;
      if (ia !== ib) return ia - ib;
      return a.ts - b.ts;
    });

    var html = "";

    /* Notes */
    html += '<section class="pf-sec"><h3 class="pf-sec-h">Notes</h3>';
    if (!attached.length && !detached.length) {
      html += '<p class="pf-empty">No notes yet. Click <strong>Add note</strong>, then click any element.</p>';
    }
    attached.forEach(function (n) { html += noteItemHtml(n, true); });
    if (detached.length) {
      html += '<h4 class="pf-sub-h">Detached notes <span class="pf-muted">(anchor no longer in page)</span></h4>';
      detached.forEach(function (n) { html += noteItemHtml(n, false); });
    }
    html += '</section>';

    /* Questions */
    var qAnchors = docOrder.filter(function (a) { return metaFor(a).kind === "q"; });
    if (qAnchors.length) {
      html += '<section class="pf-sec"><h3 class="pf-sec-h">Questions</h3>';
      qAnchors.forEach(function (a) {
        var ans = state.answers[a];
        var st = !ans ? '<span class="pf-qstate pf-untouched">untouched</span>'
          : ans.mode === "custom" ? '<span class="pf-qstate pf-custom">custom answer</span>'
          : '<span class="pf-qstate pf-default">accepted default</span>';
        html += '<div class="pf-qitem"><a class="pf-jump" href="#' + escapeHtml(a) + '" data-pf-jump="' + escapeHtml(a) + '">' +
          escapeHtml(labelFor(a)) + '</a>' + st + '</div>';
      });
      html += '</section>';
    }

    /* Verdict */
    html += '<section class="pf-sec"><h3 class="pf-sec-h">Verdict</h3><div class="pf-verdict" role="radiogroup" aria-label="Verdict">' +
      verdictRadio("approve", "Approve", state.verdict === "approve") +
      verdictRadio("request-changes", "Request changes", state.verdict === "request-changes") +
      verdictRadio("none", "No verdict", !state.verdict) +
      '</div></section>';

    /* Export */
    html += '<section class="pf-sec pf-export"><h3 class="pf-sec-h">Export</h3>' +
      '<div class="pf-export-btns">' +
        '<button type="button" class="pf-btn pf-primary" data-pf-copy>Copy for agent</button>' +
        '<button type="button" class="pf-btn" data-pf-download>Download .md</button>' +
      '</div>' +
      '<p class="pf-export-hint">Notes marked <em>note to self</em> stay out of the export.</p>' +
      '</section>';

    panelBody.innerHTML = html;
  }

  function noteItemHtml(n, jumpable) {
    var m = metaFor(n.anchor);
    var aud = n.audience === "self"
      ? '<span class="pf-aud-mark pf-self">note to self</span>'
      : '<span class="pf-aud-mark pf-agent">for the agent</span>';
    var head = '<span class="pf-note-kind">' + escapeHtml(m.kind) + '</span> ' +
      (jumpable
        ? '<a class="pf-jump" href="#' + escapeHtml(n.anchor) + '" data-pf-jump="' + escapeHtml(n.anchor) + '">' + escapeHtml(labelFor(n.anchor)) + '</a>'
        : '<span class="pf-note-label">' + escapeHtml(labelFor(n.anchor)) + '</span>');
    var body = '<div class="pf-note-text">' + escapeHtml(n.text) + '</div>';
    var excerpt = !jumpable && n.excerpt ? '<div class="pf-note-excerpt">“' + escapeHtml(n.excerpt) + '”</div>' : '';
    return '<div class="pf-note-item">' +
      '<div class="pf-note-head">' + head + aud +
        '<button type="button" class="pf-x pf-note-del" data-pf-delnote="' + n.id + '" aria-label="Delete note">×</button>' +
      '</div>' + excerpt + body + '</div>';
  }

  function verdictRadio(value, label, checked) {
    return '<label class="pf-verdict-opt"><input type="radio" name="pf-verdict" value="' + value + '"' +
      (checked ? " checked" : "") + '> ' + escapeHtml(label) + '</label>';
  }

  /* Panel event delegation */
  panel.addEventListener("click", function (ev) {
    var jump = ev.target.closest("[data-pf-jump]");
    if (jump) { ev.preventDefault(); jumpTo(jump.getAttribute("data-pf-jump")); return; }
    var del = ev.target.closest("[data-pf-delnote]");
    if (del) { deleteNote(del.getAttribute("data-pf-delnote")); return; }
    if (ev.target.closest("[data-pf-panel-close]")) { closePanel(); return; }
    if (ev.target.closest("[data-pf-copy]")) {
      copyText(currentExport(), function (ok) { toast(ok ? "Copied for agent ✓" : "Copy failed — use Download"); });
      return;
    }
    if (ev.target.closest("[data-pf-download]")) { downloadExport(); return; }
  });
  panel.addEventListener("change", function (ev) {
    var v = ev.target.closest('input[name="pf-verdict"]');
    if (v && v.checked) {
      state.verdict = (v.value === "approve" || v.value === "request-changes") ? v.value : null;
      persist();
    }
  });

  /* ----- Pill wiring ---------------------------------------------------- */
  addBtn.addEventListener("click", function () { if (noteMode) exitNoteMode(); else enterNoteMode(); });
  pill.querySelector("[data-pf-toggle-panel]").addEventListener("click", togglePanel);
  pill.querySelector("[data-pf-export]").addEventListener("click", function () {
    if (!panelOpen()) openPanel();
    var ex = panel.querySelector(".pf-export");
    if (ex) ex.scrollIntoView({ block: "nearest" });
  });

  /* ----- Global Esc ----------------------------------------------------- */
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (composer) { closeComposer(); exitNoteMode(); return; }
    if (viewer) { closeViewer(); return; }
    if (noteMode) { exitNoteMode(); return; }
    if (panelOpen()) { closePanel(); return; }
  });

  /* ----- Render orchestration ------------------------------------------ */
  function renderAll() {
    renderPins();
    updateCount();
    if (panelOpen()) renderPanel();
  }

  /* ----- Initial hash reveal ------------------------------------------- */
  function handleInitialHash() {
    var h = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
    if (h && elForAnchor(h)) jumpTo(h);
  }
  window.addEventListener("hashchange", function () {
    var h = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
    if (h && elForAnchor(h)) jumpTo(h);
  });

  /* ----- Boot ----------------------------------------------------------- */
  function boot() {
    wireQuestions();
    wireViewed();
    updateCount();
    updateDegraded();
    renderPins();
    handleInitialHash();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

/* presentation-engine interactivity — vanilla JS, no framework, runs from file://.
   Responsibilities: theme toggle (with persistence), tab switching, chapter
   scrollspy for the side nav, and mermaid init. Guards for window.mermaid being
   undefined (--lean output). The click-to-annotate layer lives in annotate.js. */
(function () {
  "use strict";

  var root = document.documentElement;
  var STORE_KEY = "visual-plan-theme";

  /* ----- Theme ---------------------------------------------------------- */
  function preferredTheme() {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) { /* private mode / file:// restrictions */ }
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return root.getAttribute("data-theme") || "light";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem(STORE_KEY, theme); } catch (e) { /* ignore */ }
    renderMermaid(theme);
  }

  applyTheme(preferredTheme());

  document.addEventListener("click", function (ev) {
    var toggle = ev.target.closest("[data-theme-toggle]");
    if (!toggle) return;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
  });

  /* ----- Tabs ----------------------------------------------------------- */
  function initTabs() {
    var groups = document.querySelectorAll('[data-block=tabs]');
    groups.forEach(function (group) {
      var buttons = Array.prototype.slice.call(group.querySelectorAll(".tab-btn"));
      var panels = Array.prototype.slice.call(group.querySelectorAll(".tab-panel"));

      function select(index) {
        buttons.forEach(function (btn, i) {
          var on = i === index;
          btn.setAttribute("aria-selected", on ? "true" : "false");
          btn.tabIndex = on ? 0 : -1;
        });
        panels.forEach(function (panel, i) {
          if (i === index) panel.removeAttribute("hidden");
          else panel.setAttribute("hidden", "");
        });
      }

      buttons.forEach(function (btn, i) {
        btn.addEventListener("click", function () { select(i); });
        btn.addEventListener("keydown", function (ev) {
          var dir = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
          if (!dir) return;
          ev.preventDefault();
          var next = (i + dir + buttons.length) % buttons.length;
          select(next);
          buttons[next].focus();
        });
      });

      select(0);
    });
  }

  /* ----- Chapter scrollspy ---------------------------------------------- */
  // Highlight the side-nav link for the chapter currently in view. No chapters
  // in the doc -> nothing to observe, zero cost.
  function initScrollspy() {
    var sections = Array.prototype.slice.call(document.querySelectorAll("section.pf-chapter"));
    if (!sections.length) return;
    var links = {};
    Array.prototype.forEach.call(document.querySelectorAll(".pf-sidenav-link"), function (a) {
      var id = a.getAttribute("data-chapter-link") || decodeURIComponent((a.getAttribute("href") || "").replace(/^#/, ""));
      if (id) links[id] = a;
    });
    if (!Object.keys(links).length) return;

    function setActive(id) {
      for (var key in links) {
        if (!Object.prototype.hasOwnProperty.call(links, key)) continue;
        var on = key === id;
        links[key].classList.toggle("is-active", on);
        if (on) links[key].setAttribute("aria-current", "true");
        else links[key].removeAttribute("aria-current");
      }
    }

    if (typeof IntersectionObserver === "undefined") {
      setActive(sections[0].id);
      return;
    }
    // Track visibility ratios; the topmost sufficiently-visible chapter wins.
    var ratios = {};
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { ratios[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
      var best = null, bestTop = Infinity;
      sections.forEach(function (s) {
        if ((ratios[s.id] || 0) <= 0) return;
        var top = s.getBoundingClientRect().top;
        if (top < bestTop) { bestTop = top; best = s.id; }
      });
      if (best) setActive(best);
    }, { rootMargin: "-55px 0px -60% 0px", threshold: [0, 0.1, 0.5, 1] });
    sections.forEach(function (s) { obs.observe(s); });
    setActive(sections[0].id);

    // On narrow screens the nav is a disclosure; collapse it after a jump.
    Array.prototype.forEach.call(document.querySelectorAll(".pf-sidenav-link"), function (a) {
      a.addEventListener("click", function () {
        var box = document.querySelector(".pf-sidenav-box");
        if (box && box.hasAttribute("open") && window.matchMedia && window.matchMedia("(max-width: 899px)").matches) {
          box.removeAttribute("open");
        }
      });
    });
  }

  /* ----- Mermaid -------------------------------------------------------- */
  var mermaidReady = false;
  var mermaidBusy = false;

  // Kill mermaid's own DOMContentLoaded auto-start SYNCHRONOUSLY, before it can
  // fire. renderMermaid() awaits document.fonts.ready before its (full)
  // initialize; when fonts resolve late (headless runs, slow machines),
  // DOMContentLoaded lands during that await and the bundle's default
  // startOnLoad:true would render every diagram with stock config (default
  // theme, no Virgil) — after which the configured pass sees data-processed and
  // does nothing. This one early call makes our configured pass the only one.
  if (typeof window.mermaid !== "undefined") {
    try { window.mermaid.initialize({ startOnLoad: false }); } catch (e) { /* ignore */ }
  }

  async function renderMermaid(theme) {
    if (typeof window.mermaid === "undefined") return; // --lean output
    var nodes = document.querySelectorAll("pre.mermaid");
    if (!nodes.length) return;
    // SERIALIZE: the page calls this both on initial theme apply AND on boot, so
    // two passes can otherwise run concurrently — re-initializing mermaid mid-run
    // and non-deterministically dropping the per-run config (diagrams came out
    // classic instead of hand-drawn). One render at a time; skip overlaps.
    if (mermaidBusy) return;
    mermaidBusy = true;

    try {
      // On a theme change after the first render, mermaid has already replaced
      // the <pre> source with an <svg>; restore source so it can re-render.
      nodes.forEach(function (node) {
        if (node.getAttribute("data-processed") === "true" && node.dataset.src) {
          node.innerHTML = node.dataset.src;
          node.removeAttribute("data-processed");
        } else if (!node.dataset.src) {
          node.dataset.src = node.textContent;
        }
      });

      // Load the hand-drawn font BEFORE mermaid measures text. If the font is not
      // ready at measure time, node boxes are sized for the fallback metrics and
      // the wider Virgil glyphs overflow/clip. Each diagram's look (handDrawn or
      // clean) is declared in its own source frontmatter, so it is deterministic.
      if (document.fonts && document.fonts.load) {
        try {
          await document.fonts.load('16px "Virgil"');
          await document.fonts.ready;
        } catch (e) { /* fall back to default metrics */ }
      }

      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        look: "handDrawn",
        theme: theme === "dark" ? "dark" : "neutral",
        themeVariables: { fontFamily: '"Virgil", "Segoe Print", system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }
      });
      await window.mermaid.run({ querySelector: "pre.mermaid" });
    } catch (e) {
      // Leave the raw source visible rather than blanking the diagram.
      if (window.console && console.warn) console.warn("mermaid render failed:", e);
    } finally {
      mermaidReady = true;
      mermaidBusy = false;
    }
  }

  /* ----- Boot ----------------------------------------------------------- */
  function boot() {
    initTabs();
    initScrollspy();
    if (!mermaidReady) renderMermaid(root.getAttribute("data-theme") || "light");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

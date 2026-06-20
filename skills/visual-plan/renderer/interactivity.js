/* visual-plan interactivity — vanilla JS, no framework, runs from file://.
   Responsibilities: theme toggle (with persistence), tab switching, and
   mermaid init. Guards for window.mermaid being undefined (--lean output). */
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

  /* ----- Mermaid -------------------------------------------------------- */
  var mermaidReady = false;
  var mermaidRendered = false;

  function renderMermaid(theme) {
    if (typeof window.mermaid === "undefined") return; // --lean output
    var nodes = document.querySelectorAll("pre.mermaid");
    if (!nodes.length) return;

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

    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "neutral",
        themeVariables: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }
      });
      window.mermaid.run({ querySelector: "pre.mermaid" });
      mermaidRendered = true;
    } catch (e) {
      // Leave the raw source visible rather than blanking the diagram.
      if (window.console && console.warn) console.warn("mermaid render failed:", e);
    }
    mermaidReady = true;
  }

  /* ----- Boot ----------------------------------------------------------- */
  function boot() {
    initTabs();
    if (!mermaidReady) renderMermaid(root.getAttribute("data-theme") || "light");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

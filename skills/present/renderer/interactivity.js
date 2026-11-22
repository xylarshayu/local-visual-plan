/* presentation-engine interactivity — vanilla JS, no framework, runs from file://.
   Responsibilities: theme toggle (with persistence), tab switching, chapter
   scrollspy for the side nav, and mermaid init. Guards for window.mermaid being
   undefined (--lean output). The click-to-annotate layer lives in annotate.js. */
(function () {
  "use strict";

  var root = document.documentElement;
  // Renamed from "visual-plan-theme": v1 wrote the system theme on every load, so old values aren't choices.
  var STORE_KEY = "pf-theme";
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");

  /* ----- Theme: the system's until the reader clicks; only a click is stored ----- */
  function savedTheme() {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) { /* private mode / file:// restrictions */ }
    return null;
  }
  function systemTheme() { return dark && dark.matches ? "dark" : "light"; }

  // Set the theme before first paint; the first diagram render waits for boot().
  root.setAttribute("data-theme", savedTheme() || systemTheme());

  function setTheme(theme) {
    root.setAttribute("data-theme", theme);
    renderMermaid(theme);
  }
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest("[data-theme-toggle]")) return;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(STORE_KEY, next); } catch (e) { /* ignore */ }
    setTheme(next);
  });
  if (dark && dark.addEventListener) {
    dark.addEventListener("change", function () { if (!savedTheme()) setTheme(systemTheme()); });
  }

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

  /* ----- Topbar title --------------------------------------------------- */
  // Hide the topbar's copy of the title while the masthead (which shows it) is on screen.
  function initTopbarTitle() {
    var bar = document.querySelector(".plan-topbar");
    var mast = document.querySelector(".plan-masthead");
    if (!bar || !mast || typeof IntersectionObserver === "undefined") return;
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) bar.setAttribute("data-title-hidden", "");
      else bar.removeAttribute("data-title-hidden");
    }, { rootMargin: "-48px 0px 0px 0px" }).observe(mast);
  }

  /* ----- Stepper ------------------------------------------------------- */
  // Steps carry the facts (data-parts, data-counters, data-needs); this only
  // maps the current step onto the figure's [data-part] groups.
  function initSteppers() {
    document.querySelectorAll("figure[data-block=stepper]").forEach(function (fig) {
      var steps = Array.prototype.slice.call(fig.querySelectorAll(".stepper-steps > li"));
      if (!steps.length) return;
      var held = fig.querySelector(".stepper-held");
      var asides = Array.prototype.slice.call(fig.querySelectorAll(".stepper-held, .stepper-off"));
      var offs = {};
      asides.forEach(function (a) { if (a.hasAttribute("data-off-for")) offs[a.getAttribute("data-off-for")] = a; });
      var stage = fig.querySelector(".stepper-stage");
      var parts = Array.prototype.slice.call(fig.querySelectorAll(".stepper-stage [data-part]"));
      var bar = Array.prototype.slice.call(fig.querySelectorAll(".stepper-bar button"));
      var counters = Array.prototype.slice.call(fig.querySelectorAll("[data-counter]"));
      var shows = Array.prototype.slice.call(fig.querySelectorAll(".stepper-stage [data-show]"));
      var sw = fig.querySelector(".stepper-switch");
      stage.querySelectorAll("path[data-flow]").forEach(function (line) {
        var pulse = line.cloneNode(false);
        ["data-flow", "id"].forEach(function (a) { pulse.removeAttribute(a); });
        pulse.setAttribute("class", "flow-pulse");
        pulse.style.setProperty("--len", line.getTotalLength());
        pulse.setAttribute("aria-hidden", "true");
        line.after(pulse);
      });
      var words = function (el) { return (el.getAttribute("data-parts") || "").split(" ").filter(Boolean); };
      var named = {};
      steps.concat(asides).forEach(function (s) { words(s).forEach(function (w) { named[w] = 1; }); });
      var i = 0, on = true;

      function render() {
        var alt = on ? null : offs[i] || (held && steps[i].hasAttribute("data-needs") ? held : null);
        var view = alt || steps[i];
        var seen = {}, cur = {};
        // With the switch off the story leaves out needs-switch steps and swaps in off: steps.
        steps.slice(0, i).forEach(function (s, k) {
          var told = on ? s : offs[k] || (s.hasAttribute("data-needs") ? null : s);
          if (told) words(told).forEach(function (w) { seen[w] = 1; });
        });
        words(view).forEach(function (w) { cur[w] = 1; });
        parts.forEach(function (p) {
          var n = p.getAttribute("data-part");
          p.setAttribute("data-state", cur[n] ? "current" : (seen[n] || !named[n]) ? "past" : "future");
        });
        var vals = JSON.parse(steps[i].getAttribute(on ? "data-counters" : "data-off-counters") || "{}");
        if (sw) vals["switch"] = on ? "on" : "off";
        counters.forEach(function (c) {
          var b = c.querySelector("b"), v = vals[c.getAttribute("data-counter")];
          c.classList.toggle("is-changed", b.textContent !== v);
          b.textContent = v;
        });
        shows.forEach(function (g) {
          var kv = g.getAttribute("data-show"), at = kv.indexOf("=");
          g.toggleAttribute("data-on", vals[kv.slice(0, at)] === kv.slice(at + 1));
        });
        steps.concat(asides).forEach(function (s) { s.classList.toggle("is-current", s === view); });
        bar.forEach(function (b, n) {
          if (n === i) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
          b.classList.toggle("is-past", n < i);
          b.classList.toggle("is-waiting", !on && steps[n].hasAttribute("data-needs"));
        });
        var hadFocus = fig.contains(document.activeElement);
        fig.querySelector(".stepper-prev").disabled = i === 0;
        fig.querySelector(".stepper-next").disabled = i === steps.length - 1;
        // Disabling the focused button drops focus out of the stepper; keep it inside.
        if (hadFocus && (!fig.contains(document.activeElement) || document.activeElement.disabled)) bar[i].focus();
        if (sw) {
          sw.setAttribute("aria-checked", on ? "true" : "false");
          sw.querySelector(".stepper-switch-state").textContent = on ? "on" : "off";
        }
        // A narrow stage scrolls; keep the current parts in view.
        if (stage && stage.scrollWidth > stage.clientWidth) {
          var box = null;
          parts.forEach(function (p) {
            if (!cur[p.getAttribute("data-part")]) return;
            var r = p.getBoundingClientRect();
            box = box ? { l: Math.min(box.l, r.left), r: Math.max(box.r, r.right) } : { l: r.left, r: r.right };
          });
          if (box) {
            var s0 = stage.getBoundingClientRect();
            stage.scrollLeft += (box.l + box.r) / 2 - (s0.left + s0.width / 2);
          }
        }
      }
      function go(n) { i = Math.max(0, Math.min(steps.length - 1, n)); render(); }
      // Clicking a part goes to the first step that names it, unless the current step does.
      parts.forEach(function (p) {
        var name = p.getAttribute("data-part");
        var n = steps.findIndex(function (s) { return words(s).indexOf(name) >= 0; });
        if (n < 0) return;
        p.setAttribute("data-goto", "");
        p.addEventListener("click", function (ev) {
          if (!ev.target.closest("a") && words(steps[i]).indexOf(name) < 0) go(n);
        });
      });

      fig.querySelector(".stepper-prev").addEventListener("click", function () { go(i - 1); });
      fig.querySelector(".stepper-next").addEventListener("click", function () { go(i + 1); });
      bar.forEach(function (b, n) { b.addEventListener("click", function () { go(n); }); });
      if (sw) sw.addEventListener("click", function () { on = !on; render(); });
      fig.addEventListener("keydown", function (ev) {
        if (ev.target.closest("input, textarea, select")) return;
        if (ev.key === "ArrowRight") { ev.preventDefault(); go(i + 1); }
        else if (ev.key === "ArrowLeft") { ev.preventDefault(); go(i - 1); }
      });
      fig.classList.add("is-live");
      render();
    });
  }

  /* ----- Mermaid -------------------------------------------------------- */
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
    // One render at a time: re-initializing mermaid mid-run drops the run's config.
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

      // Hand-drawn diagrams need Virgil loaded BEFORE mermaid measures text, or
      // node boxes are sized for fallback metrics and the wider glyphs clip.
      // Mermaid measures with the GLOBAL font, so one hand-drawn diagram makes
      // Virgil the page-wide diagram font.
      var handDrawn = !!document.querySelector('pre.mermaid[data-look="handDrawn"]');
      if (handDrawn && document.fonts && document.fonts.load) {
        try {
          await document.fonts.load('16px "Virgil"');
          await document.fonts.ready;
        } catch (e) { /* fall back to default metrics */ }
      }

      var css = getComputedStyle(root);
      var tok = function (name) { return css.getPropertyValue(name).trim(); };
      var font = handDrawn
        ? '"Virgil", "Segoe Print", ' + tok("--sans")
        : tok("--sans");
      var config = { startOnLoad: false, securityLevel: "strict" };
      if (root.getAttribute("data-pf-theme") === "manual") {
        config.theme = theme === "dark" ? "dark" : "neutral";
        config.themeVariables = { fontFamily: font };
      } else {
        // Mermaid's base theme derives its palette from these, so diagrams follow the page tokens.
        config.theme = "base";
        config.themeVariables = {
          darkMode: theme === "dark",
          fontFamily: font,
          fontSize: "14px",
          background: tok("--bg"),
          primaryColor: tok("--bg"),
          primaryTextColor: tok("--fg"),
          primaryBorderColor: tok("--fg"),
          secondaryColor: tok("--bg-sunken"),
          tertiaryColor: tok("--bg-sunken"),
          lineColor: tok("--fg-muted"),
          textColor: tok("--fg"),
          edgeLabelBackground: tok("--bg"),
          clusterBkg: tok("--bg-sunken"),
          clusterBorder: tok("--border"),
          noteBkgColor: tok("--bg-sunken"),
          noteTextColor: tok("--fg"),
          noteBorderColor: tok("--border")
        };
      }
      window.mermaid.initialize(config);
      await window.mermaid.run({ querySelector: "pre.mermaid" });
      // Don't let a wide diagram shrink below 60% of its natural size; scroll it instead.
      document.querySelectorAll("pre.mermaid svg").forEach(function (svg) {
        var vb = svg.viewBox && svg.viewBox.baseVal;
        if (vb && vb.width) svg.style.minWidth = Math.round(vb.width * 0.6) + "px";
      });
    } catch (e) {
      // Leave the raw source visible rather than blanking the diagram.
      if (window.console && console.warn) console.warn("mermaid render failed:", e);
    } finally {
      mermaidBusy = false;
    }
  }

  /* ----- Boot ----------------------------------------------------------- */
  /* ----- Embeds: poster first, a sandboxed iframe on Run -------------- */
  var EMBED_TOKENS = ["--bg", "--bg-sunken", "--fg", "--fg-muted", "--fg-faint", "--border",
    "--accent", "--accent-fg", "--accent-soft", "--pos", "--neg", "--sans", "--mono"];

  function embedTokens() {
    var cs = getComputedStyle(root);
    var decl = EMBED_TOKENS.map(function (t) { return t + ":" + cs.getPropertyValue(t).trim(); });
    decl.push("color-scheme:" + (root.getAttribute("data-theme") === "dark" ? "dark" : "light"));
    return "<style>:root{" + decl.join(";") + "}</style>";
  }

  function runEmbed(stage) {
    var old = stage.querySelector("iframe");
    if (old) old.remove();
    var f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    var cap = stage.parentNode.querySelector("figcaption");
    f.title = cap ? cap.textContent : "Embed";
    var tokens = embedTokens();
    f.srcdoc = stage.dataset.srcdoc.replace("<!--pf-tokens-->", function () { return tokens; });
    stage.append(f);
    stage.classList.add("is-running");
  }

  function initEmbeds() {
    var stages = document.querySelectorAll(".embed-stage[data-srcdoc]");
    stages.forEach(function (stage) {
      var run = stage.querySelector(".embed-run");
      run.hidden = false;
      run.addEventListener("click", function () { runEmbed(stage); });
    });
    if (!stages.length) return;
    new MutationObserver(function () {
      document.querySelectorAll(".embed-stage.is-running").forEach(runEmbed);
    }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }

  function boot() {
    initTabs();
    initScrollspy();
    initTopbarTitle();
    initSteppers();
    initEmbeds();
    renderMermaid(root.getAttribute("data-theme") || "light");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

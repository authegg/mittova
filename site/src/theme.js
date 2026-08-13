// @ts-check

/**
 * The only script on this page.
 *
 * Everything here is an enhancement. With JavaScript off the page is already
 * correct: the stylesheet defines the light palette on bare :root and swaps it
 * under `prefers-color-scheme: dark`, and each screenshot's <source> elements
 * carry the same media query, so both the interface and the pictures follow the
 * operating system. This adds the ability to override that choice and remember
 * it.
 *
 * It runs inline in <head>, before the body exists, so that a pinned dark page
 * never flashes light. That means no element lookups at the top level: the
 * click handler is delegated from `document`, and the screenshots are corrected
 * as the parser inserts them.
 */

(function () {
  var KEY = "mittova-theme";
  var root = document.documentElement;

  /** @returns {"auto"|"light"|"dark"} */
  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch (e) {
      // Private browsing, or storage denied. Falling back to the system
      // preference is the same behaviour as having no script at all.
      return "auto";
    }
  }

  /** @param {"auto"|"light"|"dark"} setting */
  function apply(setting) {
    // `data-setting` drives the button's own appearance; `data-theme` is what
    // the palette keys off, and is absent for "auto" so the media query wins.
    root.setAttribute("data-setting", setting);
    if (setting === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", setting);

    var button = document.querySelector(".theme");
    if (button) {
      button.setAttribute(
        "aria-label",
        "Colour theme: " + { auto: "match system", light: "light", dark: "dark" }[setting],
      );
    }
  }

  /**
   * Point one screenshot `<source>` at the plate the current setting wants.
   *
   * @param {Element} source
   * @param {"auto"|"light"|"dark"} setting
   */
  function plate(source, setting) {
    var scheme = source.getAttribute("data-scheme");
    source.setAttribute(
      "media",
      setting === "auto"
        ? "(prefers-color-scheme: " + scheme + ")"
        : scheme === setting
          ? "all"
          : "not all",
    );
  }

  /** @param {"auto"|"light"|"dark"} setting */
  function syncPlates(setting) {
    var sources = document.querySelectorAll("picture source[data-scheme]");
    for (var i = 0; i < sources.length; i++) plate(sources[i], setting);
  }

  // Before first paint: pin the palette. The button is hidden until this class
  // appears, so a page without JavaScript never shows a control that does
  // nothing.
  //
  // Read once and then tracked here rather than re-read on each click:
  // `stored()` answers "auto" whenever the read throws or the write below was
  // swallowed — private browsing, or storage blocked — so deriving the cycle
  // from it made every click compute auto -> light, leaving dark and "back to
  // auto" unreachable. Storage is write-if-possible; this is the source of truth.
  var setting = stored();
  apply(setting);
  root.className += " js";

  /**
   * Correct each screenshot's `<source>` as it is parsed, not afterwards.
   *
   * Only needed when a theme is pinned: on "auto" the markup's own
   * `prefers-color-scheme` queries are already right, and rewriting them to the
   * identical value is pointless work that can itself force a re-selection.
   *
   * Syncing on DOMContentLoaded — which is what this used to do — meant that a
   * visitor whose pinned theme differed from their system watched the system's
   * plate load and paint, then get replaced: a visible dark-to-light flash on
   * the hero, which is the one image fetched eagerly. Fixing each `<source>` as
   * the parser inserts it gets ahead of the selection instead.
   */
  if (setting !== "auto") {
    var observer = new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        var added = records[r].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (!(node instanceof Element)) continue;
          if (node.matches("source[data-scheme]")) plate(node, setting);
          var nested = node.querySelectorAll("source[data-scheme]");
          for (var k = 0; k < nested.length; k++) plate(nested[k], setting);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", function () {
      observer.disconnect();
    });
  }

  // Auto -> light -> dark -> auto. Cycling back to "auto" matters: a two-state
  // toggle would leave no way to hand the choice back to the system.
  var NEXT = { auto: "light", light: "dark", dark: "auto" };

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".theme")) return;
    var next = /** @type {"auto"|"light"|"dark"} */ (NEXT[setting]);
    setting = next;
    try {
      if (next === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch (e) {
      // Nothing to do — the change still applies for this page view.
    }
    apply(next);
    // Always synced on a click, including back to "auto", which has to restore
    // the media queries the pinned states overwrote.
    syncPlates(next);
  });

  // The observer above handles the pinned case during parsing; this is the
  // catch-all for anything it missed, and a no-op on "auto".
  document.addEventListener("DOMContentLoaded", function () {
    if (setting !== "auto") syncPlates(setting);
  });
})();

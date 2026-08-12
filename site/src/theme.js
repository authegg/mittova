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
 * click handler is delegated from `document`, and the screenshots are synced on
 * DOMContentLoaded.
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

    // Repoint each screenshot at the matching plate. Without this the pictures
    // would keep following the system while the page around them did not.
    var sources = document.querySelectorAll("picture source[data-scheme]");
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
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
  }

  // Before first paint: pin the palette. The button is hidden until this class
  // appears, so a page without JavaScript never shows a control that does
  // nothing.
  root.setAttribute("data-setting", stored());
  if (stored() !== "auto") root.setAttribute("data-theme", stored());
  root.className += " js";

  // Auto -> light -> dark -> auto. Cycling back to "auto" matters: a two-state
  // toggle would leave no way to hand the choice back to the system.
  var NEXT = { auto: "light", light: "dark", dark: "auto" };

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".theme")) return;
    var next = /** @type {"auto"|"light"|"dark"} */ (NEXT[stored()]);
    try {
      if (next === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch (e) {
      // Nothing to do — the change still applies for this page view.
    }
    apply(next);
  });

  document.addEventListener("DOMContentLoaded", function () {
    apply(stored());
  });
})();

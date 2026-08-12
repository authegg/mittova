import { useState } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "mittova.theme";

/**
 * Writes data-theme on <html>, which the token overrides in styles.css key off.
 * "system" removes the attribute so prefers-color-scheme takes over again.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function initTheme() {
  applyTheme((localStorage.getItem(KEY) as Theme) ?? "system");
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme) ?? "system");

  // Applied on change rather than in an effect: an effect would re-run
  // initTheme's work on mount and persist "system" before the user picked it.
  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
    localStorage.setItem(KEY, next);
  }

  return (
    <label className="field" style={{ maxWidth: 260 }}>
      <span>Appearance</span>
      <select value={theme} onChange={(e) => choose(e.target.value as Theme)}>
        <option value="system">Match my system</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

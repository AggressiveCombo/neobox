// Applies the colour theme: `data-theme` on <html> (read by style.css) and the
// browser's theme colour, following the system setting unless the player chose one.

import { prefs, type Theme } from "./prefs";

const GROUND = { light: "#f7f7f7", dark: "#0b1510" } as const;

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(theme: Theme): "light" | "dark" {
  if (theme === "system") return systemDark.matches ? "dark" : "light";
  return theme;
}

function apply(): void {
  const theme = resolve(prefs.value.theme);
  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = GROUND[theme];
}

/** Apply the theme now and whenever the preference or the system setting changes. */
export function startTheme(): void {
  apply();
  prefs.subscribe((next, prev) => {
    if (next.theme !== prev.theme) apply();
  });
  systemDark.addEventListener("change", apply);
}

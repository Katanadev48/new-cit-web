"use strict";

try {
  const savedTheme = localStorage.getItem("dashboard-theme");
  const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme =
    savedTheme || (systemPrefersDark ? "dark" : "light");
} catch {
  document.documentElement.dataset.theme = "light";
}
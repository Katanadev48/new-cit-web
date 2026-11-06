"use strict";

const themeToggle = document.querySelector("#theme-toggle");

function updateThemeToggle() {
  const isDark = document.documentElement.dataset.theme === "dark";
  themeToggle.setAttribute("aria-pressed", String(isDark));
  themeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light theme" : "Switch to dark theme"
  );
  themeToggle.textContent = isDark ? "Light mode" : "Dark mode";
}

if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    const nextTheme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";

    document.documentElement.dataset.theme = nextTheme;
    try {
      localStorage.setItem("dashboard-theme", nextTheme);
    } catch {
      // The selected theme remains active until this page is reloaded.
    }
    updateThemeToggle();
  });

  updateThemeToggle();
}
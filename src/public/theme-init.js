(() => {
  let storedTheme = null;
  try { storedTheme = localStorage.getItem("scriverse-color-theme-v1"); } catch { /* 使用系统主题 */ }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = storedTheme === "dark" || storedTheme === "light" ? storedTheme : prefersDark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();

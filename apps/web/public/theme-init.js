// Setzt das Theme vor dem ersten Rendern, damit nichts aufblitzt.
// Eigene Datei statt Inline-Skript, weil die CSP nur script-src 'self' erlaubt (SR-34).
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("stammbuch.theme");
  } catch {
    // Speicher gesperrt: Systemeinstellung.
  }
  if (theme !== "light" && theme !== "dark") {
    theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  document.documentElement.dataset.theme = theme;
})();

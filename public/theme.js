/* Apply the saved preference before styles load, avoiding a light flash. */
(() => {
  const key = "fishdeco.theme";
  const root = document.documentElement;
  let theme = "dark";
  try {
    if (localStorage.getItem(key) === "light") theme = "light";
  } catch { /* Storage is optional. */ }

  function apply(value) {
    theme = value;
    root.dataset.theme = theme;
    for (const button of document.querySelectorAll(".theme-toggle")) {
      const label = theme === "dark" ? "Přepnout na světlý vzhled" : "Přepnout na tmavý vzhled";
      button.setAttribute("aria-label", label);
      button.title = label;
      const ns = "http://www.w3.org/2000/svg";
      const icon = document.createElementNS(ns, "svg");
      for (const [name, value] of Object.entries({
        viewBox: "0 0 24 24", width: "20", height: "20", fill: "none",
        stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round",
        "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
      })) icon.setAttribute(name, value);
      const shape = document.createElementNS(ns, "path");
      shape.setAttribute("d", theme === "dark"
        ? "M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42M5.64 18.36l1.42-1.42m9.88-9.88 1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
        : "M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z");
      icon.appendChild(shape);
      button.replaceChildren(icon);
    }
  }

  apply(theme);
  document.addEventListener("DOMContentLoaded", () => {
    apply(theme);
    for (const button of document.querySelectorAll(".theme-toggle")) {
      button.addEventListener("click", () => {
        apply(theme === "dark" ? "light" : "dark");
        try { localStorage.setItem(key, theme); } catch { /* Keep this visit's choice. */ }
      });
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) apply(event.newValue === "light" ? "light" : "dark");
  });
})();

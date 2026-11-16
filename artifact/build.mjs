// Složí artifact/studovna.html (jedna stránka pro Claude Artifacts) z public/ a artifact/backend.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, "..", p), "utf8");

let css = read("public/styles.css");
// Motiv řídí prohlížeč artifactu: systémové nastavení, nebo data-theme na kořeni.
const dark = css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
css = css.replace(dark[0],
  `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {${dark[1]}\n    color-scheme: dark;\n  }\n}\n:root[data-theme="dark"] {${dark[1]}\n  color-scheme: dark;\n}`);

const overrides = `
/* ---------- úpravy pro artifact ---------- */
:root { --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --display: "Space Grotesk", "Inter", system-ui, sans-serif; }
html, body { height: 100%; }
h1, h2, h3, .logo { font-family: var(--display); }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 30; background: var(--bg); }
.topbar { top: env(safe-area-inset-top, 0px); }
.topbar, .page, .topic-layout { padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.fab { right: calc(18px + env(safe-area-inset-right, 0px)); }
.center-screen { min-height: 70vh; }
.chat { top: calc(76px + env(safe-area-inset-top, 0px)); }
math { font-size: 1.12em; }
math[display="block"] { margin: .8em 0; overflow-x: auto; max-width: 100%; }
@media (max-width: 1020px) {
  .chat { top: 0; padding-top: env(safe-area-inset-top, 0px); padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const cdn = "https://cdn.jsdelivr.net/npm/";
const libs = ["marked@12.0.2/marked.min.js", "dompurify@3.1.6/dist/purify.min.js", "katex@0.16.11/dist/katex.min.js",
  "pdfjs-dist@3.11.174/build/pdf.min.js", "pdfjs-dist@3.11.174/build/pdf.worker.min.js", "mammoth@1.6.0/mammoth.browser.min.js"];

const scripts = [read("artifact/backend.js"), read("public/app.js")];
for (const s of scripts) if (/<\/script/i.test(s)) throw new Error("Skript obsahuje </script>.");

const html = `<title>Studovna</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@600;700&display=swap">
<style>
${css}${overrides}</style>
<div id="app"><div class="center-screen"><div class="center-card"><div class="spinner" style="margin:0 auto 16px"></div><p class="muted">Načítám Studovnu…</p></div></div></div>
<div id="modals"></div>
<div id="toasts"></div>
${libs.map((l) => `<script src="${cdn}${l}"></script>`).join("\n")}
<script>
${scripts[0]}
</script>
<script>
${scripts[1]}
</script>
`;
fs.writeFileSync(path.join(here, "studovna.html"), html);
console.log("artifact/studovna.html", (html.length / 1024).toFixed(0) + " kB");

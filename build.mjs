import * as esbuild from "esbuild";
import { mkdirSync, cpSync, rmSync, existsSync } from "node:fs";

const outdir = "dist";
if (existsSync(outdir)) rmSync(outdir, { recursive: true });
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: { background: "src/background/index.ts" },
  bundle: true,
  outdir,
  format: "esm",
  target: "chrome110",
  sourcemap: true,
});

await esbuild.build({
  entryPoints: {
    content: "src/content/panel.ts",
    options: "src/options/options.ts",
  },
  bundle: true,
  outdir,
  format: "iife",
  target: "chrome110",
  sourcemap: true,
  loader: { ".css": "text" },
});

cpSync("manifest.json", `${outdir}/manifest.json`);
cpSync("src/options/options.html", `${outdir}/options.html`);
// Branding: toolbar/extension-card icons (manifest.json "icons"/"action.default_icon") and the options-page logo.
mkdirSync(`${outdir}/icons`, { recursive: true });
for (const s of [16, 32, 48, 128]) cpSync(`assets/cleavr-icon-${s}.png`, `${outdir}/icons/icon-${s}.png`);
cpSync("assets/cleavr-logo.png", `${outdir}/logo.png`);

console.log("built to dist/");

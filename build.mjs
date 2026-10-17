import * as esbuild from "esbuild";
import { mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { gitDescribe, stampVersionName } from "./scripts/release.mjs";

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
// FACTORY-495: every build gets a version_name stamp (version+githash,
// "-dirty" if the tree has uncommitted changes), not just tagged CI
// releases — so a stale "Load unpacked" build from an earlier checkout
// shows a different string on the extension card instead of looking
// identical to the current one.
const versionName = stampVersionName(`${outdir}/manifest.json`, gitDescribe());
cpSync("src/options/options.html", `${outdir}/options.html`);
// Branding: toolbar/extension-card icons (manifest.json "icons"/"action.default_icon") and the options-page logo.
mkdirSync(`${outdir}/icons`, { recursive: true });
for (const s of [16, 32, 48, 128]) cpSync(`assets/cleavr-icon-${s}.png`, `${outdir}/icons/icon-${s}.png`);
cpSync("assets/cleavr-logo.png", `${outdir}/logo.png`);

console.log(`built to dist/ (version_name ${versionName})`);

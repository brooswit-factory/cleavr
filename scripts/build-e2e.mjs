// Builds a throwaway copy of dist/ with one extra static content_scripts
// entry matching only http://127.0.0.1/* (the smoke test's own local
// server). This exists ONLY so headless Puppeteer — which cannot dispatch a
// genuine click on the (non-existent, in headless) toolbar icon, so it can
// never obtain a real activeTab grant — has some way to get content.js
// injected into the test page at all. The shipped manifest.json has no
// content_scripts entry and relies solely on activeTab + the action click,
// exactly as the ticket asks for.
//
// dist-e2e/background.js is otherwise an unmodified copy of dist/background.js
// (FACTORY-466 removed the bearer-token auth path, so there is no longer a
// separate authenticated/unauthenticated opener to swap between here — see
// src/lib/pty/opener.ts).
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";

const src = "dist";
const out = "dist-e2e";
if (existsSync(out)) rmSync(out, { recursive: true });
cpSync(src, out, { recursive: true });

const manifest = JSON.parse(readFileSync(`${out}/manifest.json`, "utf8"));
manifest.content_scripts = [
  {
    matches: ["http://127.0.0.1/*"],
    js: ["content.js"],
    run_at: "document_idle",
  },
];
// The shipped manifest.json already declares http://127.0.0.1/* as a
// required host_permissions entry (Cleavr only ever talks to loopback), so
// nothing needs widening here anymore — this script only adds the
// content_scripts entry above, for headless Puppeteer's lack of a real
// toolbar click.
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));

console.log("built test-only extension copy to dist-e2e/ (adds a 127.0.0.1-only content_script; not shipped)");

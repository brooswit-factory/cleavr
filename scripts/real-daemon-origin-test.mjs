// FACTORY-478/FACTORY-480/FACTORY-504 real-browser regression test.
//
// WHY THIS EXISTS: FACTORY-464 was accepted on curl + unit tests alone —
// curl lets you hand-set an `Origin` header, which a real browser never
// lets a caller do. That hid a real bug: a real MV3 extension service
// worker's GET to /resources/for-url carries NO `Origin` header at all
// (measured on headless Chrome for Testing 148 against a real built cleavr
// dist/ — see FACTORY-478's Jira comments for the full measurement and
// the original probe script this test is adapted from), so
// butchr's strict "absent Origin is 403" guard rejected the extension on
// every real install. This test drives a REAL headless Chrome, with the
// REAL BUILT extension (dist-e2e/, an unmodified copy of dist/'s
// background.js — see build-e2e.mjs) loaded, against a REAL HTTP server
// running butchr's actual, unmodified guard/route code
// (../butchr/scripts/real-guard-server.ts — see that file's own header for
// exactly what is real and what is stubbed, and why). No hand-set Origin
// header anywhere in this file.
//
// FACTORY-504 extended this from covering ONE request (the service worker's
// POST /resources/for-url) to the FULL PANEL FLOW — every network request
// the extension makes, enumerated from the source (not guessed at):
//   grep -rn "fetch(\|new WebSocket" src/background src/options src/content src/lib
// finds exactly four call sites, three distinct daemon routes:
//   1. POST /resources/for-url  — src/background/wire.ts's fetchResources,
//      called by the panel's content script over chrome.runtime.sendMessage
//      (exercised below via that same message, from a page context).
//   2. POST /resources/for-url  — src/options/options.ts's "Test connection"
//      button — same route, same forUrlRequestInit shape, but a DIFFERENT
//      call site (options.html's own page context, not the service worker),
//      so it needs its own real-browser evidence: nothing already proven for
//      #1 tells you whether Chrome stamps Origin the same way for a fetch
//      made from an ordinary extension page as opposed to the extension's
//      service worker.
//   3. GET /agents/:agentKey/pty (WebSocket upgrade) — src/lib/pty/opener.ts's
//      createRealOpener, driven end-to-end through the REAL background
//      wiring (src/background/wire.ts's wirePtyConnections /
//      src/background/pty-manager.ts) via a real chrome.runtime.connect
//      port, exactly as the panel's content script (src/content/terminal.ts)
//      does — not a hand-rolled `new WebSocket()` bypassing that code.
//   4. GET/POST http://.../agents/:agentKey/pty (probeHttp's plain-HTTP
//      side-channel, src/background/wire.ts) — fired automatically by the
//      same real attach flow once the WS upgrade in #3 fails to open (see
//      probeHttp's own header for why this can never carry Origin, and why
//      that's fine: it no longer claims an origin diagnosis it can't earn).
// Content scripts make ZERO network calls of their own — confirmed by
// `grep -rn "fetch(\|WebSocket" src/content` returning nothing; they reach
// the service worker over a chrome.runtime.Port instead (src/content/panel.ts,
// terminal.ts). Every network call in the extension lives in src/background/
// and src/options/ — this file drives all of them.
//
// FAILURE CONTRACT: `checkOrigin(name, ...)` below is the single place that
// decides whether a given request's Origin was acceptable, and its failure
// message always NAMES the specific request (the `name` argument) — see
// that helper. The whole run fails (non-zero exit) if ANY covered request
// reached the daemon without an Origin.
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "..", "dist-e2e");
const butchrDir = process.env.BUTCHR_DIR ?? path.resolve(__dirname, "..", "..", "butchr");

if (!fs.existsSync(distPath)) {
  console.error(`FAIL: ${distPath} does not exist — run \`npm run build:e2e\` first.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(butchrDir, "scripts", "real-guard-server.ts"))) {
  console.error(
    `FAIL: no butchr checkout with scripts/real-guard-server.ts found at ${butchrDir}. ` +
      `Set BUTCHR_DIR to point at a butchr checkout (with \`bun install\` already run there) ` +
      `— this test drives butchr's own real Origin guard, in-process reimplementation is not acceptable here.`,
  );
  process.exit(1);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function startRealGuardServer(port, allowedOrigins, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", "scripts/real-guard-server.ts"], {
      cwd: butchrDir,
      env: { ...process.env, REAL_GUARD_PORT: String(port), REAL_GUARD_ALLOWED_ORIGINS: allowedOrigins, ...extraEnv },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let resolved = false;
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      if (!resolved && buf.includes("REAL_GUARD_READY")) {
        resolved = true;
        resolve(child);
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`real-guard-server.ts exited early (code ${code})`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error("real-guard-server.ts did not report ready within 10s"));
    }, 10000);
  });
}

// FACTORY-532: a minimal local HTTP server serving two trivial pages on
// 127.0.0.1 — the ONE host `manifest.json`'s `host_permissions` grants
// `chrome.scripting.executeScript` for, which is what makes it possible to
// inject the REAL content.js panel into a REAL navigated page at all (an
// arbitrary external host, e.g. a real Jira site, is neither reachable nor
// permitted here — see this test's own header for why request-interception
// tricks aren't used instead: the point is a genuine `location.href` the
// extension's own manifest actually allows it to run on, not a spoofed one).
// The page bodies are content-free; only the PATH (hence `location.href`)
// matters, since that's the one thing `real-guard-server.ts`'s
// `REAL_GUARD_JIRA_HOST` is pointed at `127.0.0.1` to make resolvable.
function startLocalPageServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>fixture</title>");
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

let failed = false;
const coveredRequests = [];
function check(condition, passMsg, failMsg) {
  if (condition) {
    console.log(`PASS: ${passMsg}`);
  } else {
    console.error(`FAIL: ${failMsg}`);
    failed = true;
  }
}

// The one place that decides "did this request carry an Origin", and the
// one place a failure here names which specific request it was — the
// ticket's own DoD ("the test's failure output must name the specific
// request that failed"). `name` should read like "<method> <path> (<who
// sent it>)" so a failing line is unambiguous on its own.
function checkOrigin(name, originPresent, detail = "") {
  coveredRequests.push(name);
  check(
    originPresent,
    `${name}: reached the daemon WITH an Origin header${detail ? ` (${detail})` : ""}`,
    `${name}: reached the daemon with NO Origin header${detail ? ` (${detail})` : ""} — this request must always carry Origin`,
  );
}

const browser = await puppeteer.launch({
  headless: "new",
  args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, "--no-sandbox"],
});

let guardServer;
let localPageServer;
try {
  let sw;
  for (let attempt = 0; attempt < 20 && !sw; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
    sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"));
  }
  if (!sw) throw new Error("FAIL: extension service worker did not start (background.js)");
  const extensionId = new URL(sw.url()).host;
  console.log("PASS: extension loaded, service worker running. real id =", extensionId);

  // A second, distinct extension id — well-formed (32 a-p chars) but never
  // loaded into this browser — used as the NOT-allowlisted case below. It
  // must never equal `extensionId`.
  const wrongId = extensionId
    .split("")
    .map((c) => (c === "a" ? "b" : "a"))
    .join("");

  const worker = await sw.worker();

  // An extension page (options.html) — chrome.runtime is only reachable
  // from pages inside the extension's own origin (an ordinary http:// page
  // has no chrome.runtime at all unless a content script injects it, and
  // content scripts inject nothing network-related — see this file's own
  // header). This is also the ACTUAL context request #2 (the "Test
  // connection" button) runs in, and it doubles as the page context for
  // requests #1/#3/#4 below: chrome.runtime.sendMessage/connect work
  // identically from any page inside the extension, and using ONE page
  // throughout keeps this script from needing a second, pointless plain
  // HTTP host server just to hold a page open.
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  async function setPort(port) {
    await worker.evaluate((p) => chrome.storage.local.set({ "cleavr:options": { port: p } }), port);
  }

  async function realFetchResources() {
    return page.evaluate(() => chrome.runtime.sendMessage({ type: "cleavr:fetch-resources", pageUrl: "https://example.com/" }));
  }

  // Drives the REAL attach flow: chrome.runtime.connect({name:"cleavr:pty"})
  // then an "attach" message — the exact port protocol src/content/terminal.ts
  // uses, reaching src/background/wire.ts's wirePtyConnections and
  // src/background/pty-manager.ts's real opener (src/lib/pty/opener.ts),
  // never a WebSocket this test script opens directly. Resolves with every
  // "state" message observed within the window, or once a terminal-looking
  // state (anything other than "connecting"/"idle") is seen.
  async function realPtyAttach(agentKey) {
    return page.evaluate(
      (key) =>
        new Promise((resolve) => {
          const states = [];
          const port = chrome.runtime.connect({ name: "cleavr:pty" });
          port.onMessage.addListener((message) => {
            if (message.type !== "state") return;
            states.push(message.state);
            if (message.state.kind !== "connecting" && message.state.kind !== "idle") {
              clearTimeout(timer);
              resolve(states);
            }
          });
          port.postMessage({ type: "attach", agentKey: key });
          const timer = setTimeout(() => resolve(states), 6000);
        }),
      agentKey,
    );
  }

  // --- Request #1: service-worker POST /resources/for-url -----------------
  const acceptPort = await freePort();
  guardServer = await startRealGuardServer(acceptPort, `chrome-extension://${extensionId}`);
  await setPort(acceptPort);

  const acceptResult = await realFetchResources();
  check(
    acceptResult?.kind === "success",
    "real service-worker POST /resources/for-url, real allowlisted id: fetchResources succeeded (200) — this assertion FAILS against the old GET-only client, which a real MV3 service worker's missing Origin header 403s",
    `expected fetchResources to succeed with the real id allowlisted, got ${JSON.stringify(acceptResult)}`,
  );
  checkOrigin("#1 POST /resources/for-url (service worker, real fetchResources)", acceptResult?.kind === "success");

  // Also prove GET is still reachable-but-403 from this exact context, as
  // docs/resources-for-url.md now documents (a raw GET, unlike the client's
  // own POST, still carries no Origin from a real service worker — this is
  // NOT the client's own code path, just a direct probe of the still-kept
  // GET route).
  const rawGetStatus = await worker.evaluate(
    (p) => fetch(`http://127.0.0.1:${p}/resources/for-url?url=${encodeURIComponent("https://example.com/")}`).then((r) => r.status),
    acceptPort,
  );
  check(
    rawGetStatus === 403,
    "a raw GET from the real service worker still 403s even with the real id allowlisted (no Origin header reaches the server on a GET from this context)",
    `expected a raw GET to 403 regardless of allowlist, got HTTP ${rawGetStatus}`,
  );

  const rejectPort = await freePort();
  guardServer.kill();
  guardServer = await startRealGuardServer(rejectPort, `chrome-extension://${wrongId}`);
  await setPort(rejectPort);

  const rejectResult = await realFetchResources();
  check(
    rejectResult?.kind === "failure" && rejectResult.failure?.kind === "unauthorized" && rejectResult.failure?.status === 403,
    "real service-worker POST /resources/for-url, WRONG allowlisted id: fetchResources reported unauthorized (403) — the real id's Origin was present but didn't match, proving Origin DID reach the server (a MISSING Origin 403s with a different guard reason, 'origin required', never surfaced to the client, but distinguishable server-side — see the WRONG-origin scenario immediately below, which forges no header, just points the allowlist elsewhere)",
    `expected an unauthorized 403 failure with a non-matching allowlist, got ${JSON.stringify(rejectResult)}`,
  );

  // --- Request #2: options-page POST /resources/for-url ("Test connection") ---
  guardServer.kill();
  guardServer = await startRealGuardServer(rejectPort, `chrome-extension://${extensionId}`);
  await page.evaluate((p) => {
    document.querySelector("#port").value = String(p);
  }, rejectPort);
  await page.click("#test-connection");
  await new Promise((r) => setTimeout(r, 500));
  const testConnAccept = await page.evaluate(() => document.querySelector("#test-result").textContent);
  console.log("options page Test Connection button, real allowlisted id:", testConnAccept);
  check(
    /accepted the request/i.test(testConnAccept ?? ""),
    "real options-page POST /resources/for-url, real allowlisted id: Test Connection reported success",
    `expected the Test Connection button to report success with the real id allowlisted, got ${JSON.stringify(testConnAccept)}`,
  );
  checkOrigin("#2 POST /resources/for-url (options page, 'Test connection' button)", /accepted the request/i.test(testConnAccept ?? ""));

  guardServer.kill();
  guardServer = await startRealGuardServer(rejectPort, `chrome-extension://${wrongId}`);
  await page.click("#test-connection");
  await new Promise((r) => setTimeout(r, 500));
  const testConnReject = await page.evaluate(() => document.querySelector("#test-result").textContent);
  console.log("options page Test Connection button, WRONG allowlisted id:", testConnReject);
  check(
    /rejected \(403\)/.test(testConnReject ?? ""),
    "real options-page POST /resources/for-url, WRONG allowlisted id: Test Connection reported a 403 rejection (proving its Origin reached the server, and didn't match)",
    `expected the Test Connection button to report a 403 rejection with a non-matching allowlist, got ${JSON.stringify(testConnReject)}`,
  );

  // --- Requests #3 & #4: the real PTY attach flow (WS upgrade + probeHttp) ---
  // Re-point at an ACCEPT server (real id allowlisted) so a present Origin
  // clears the guard and the only thing left to observe is Origin itself.
  // No pane will ever actually resolve (real-guard-server.ts's ptyAttach is
  // deliberately unconfigured — see that file's own header), so the attach
  // is expected to fail AFTER the Origin gate, not to succeed — this test
  // is about what the daemon SAW on the wire, not about a working terminal.
  const wsPort = await freePort();
  guardServer.kill();
  guardServer = await startRealGuardServer(wsPort, `chrome-extension://${extensionId}`);
  await setPort(wsPort);

  const attachStates = await realPtyAttach("nonexistent-agent");
  console.log("real PTY attach, states observed over the real chrome.runtime port:", JSON.stringify(attachStates));

  // real-guard-server.ts's `onRequest` hook (its own header explains why)
  // logs EVERY request matching /agents/*/pty here, not just genuine
  // upgrade attempts — that includes request #4's own plain-fetch probes,
  // each logged with origin=null (see that function's header: a plain
  // fetch can never carry Origin to this route). A flaky upgrade can also
  // fire both `error` and `close` browser events for one failed attempt,
  // each triggering its own redundant probe — so this log can contain
  // several null-origin probe entries alongside the one real upgrade
  // entry, in no guaranteed order. The two request KINDS are
  // indistinguishable in the log's shape (no method/upgrade-header field),
  // so `.at(-1)` is the wrong tool here — it can land on a probe entry and
  // misreport a real Origin-carrying upgrade as absent. Instead: a genuine
  // browser-native WebSocket upgrade is the ONLY thing that can EVER
  // produce a non-null origin against this route (established fact, see
  // probeHttp's own header) — so finding even one such entry is sufficient
  // proof the upgrade itself carried Origin, regardless of how many
  // null-origin probe entries sit alongside it.
  const wsLog = await fetch(`http://127.0.0.1:${wsPort}/__test__/ws-log`).then((r) => r.json());
  console.log("all /agents/*/pty requests seen server-side by the real guard:", JSON.stringify(wsLog));
  const wsUpgradeEntry = wsLog.find((e) => e.origin !== null);
  check(
    wsLog.some((e) => e.path === "/agents/nonexistent-agent/pty"),
    "the real guard server recorded at least one request for the PTY route (#3's upgrade and/or #4's probes)",
    "no request reached the real guard server's /agents/:agentKey/pty route at all — cannot confirm the WS upgrade happened",
  );
  checkOrigin(
    "#3 GET /agents/:agentKey/pty (WebSocket upgrade, real chrome.runtime.connect attach flow)",
    wsUpgradeEntry !== undefined,
    wsUpgradeEntry ? `observed origin=${wsUpgradeEntry.origin}` : `${wsLog.length} request(s) logged, none with a non-null origin`,
  );

  // Request #4 (probeHttp): the WS upgrade above clears the Origin gate but
  // then hits `!deps.ptyAttach` (503, "endpoint disabled") — from the
  // client's perspective that's an abnormal close (1006) while
  // "connecting", which triggers the "probe-http" effect
  // (src/lib/pty/state.ts) and fires probeHttp's own plain fetch against
  // the SAME URL. Per probeHttp's own header (src/background/wire.ts), that
  // plain fetch can NEVER reach the guard OR the pane-resolution logic at
  // all (no Upgrade header) — it 404s unconditionally, whether or not the
  // agent is real — so THIS request is not, and structurally cannot be,
  // Origin-checked; it is excluded from checkOrigin's "every request must
  // carry Origin" contract for exactly that reason, spelled out here
  // rather than silently skipped. What IS asserted: FACTORY-504 removed
  // the "rejected" and probe-derived "not-found" ConnState kinds entirely
  // (src/lib/pty/state.ts) — probeHttp's classification of this 404 must
  // land the connection in the same honest "we don't know why, keep
  // retrying" states every other inconclusive probe result does, never in
  // a state that claims a cause (an origin problem, or an unknown agent)
  // it never earned.
  const finalState = attachStates.at(-1);
  console.log("final connection state after the real attach flow:", JSON.stringify(finalState));
  const honestFallbackKinds = ["connecting", "reconnecting", "daemon-unreachable", "retry-exhausted"];
  check(
    honestFallbackKinds.includes(finalState?.kind),
    `request #4 (probeHttp's plain-HTTP classification of the failed WS) resolves into an honest state ("${finalState?.kind}") rather than the removed "rejected"/"not-found"`,
    `expected one of ${JSON.stringify(honestFallbackKinds)}, got ${JSON.stringify(finalState)} — probeHttp must never claim a diagnosis (Origin, or "unknown agent") it can't earn (see src/background/wire.ts's probeHttp header)`,
  );
  coveredRequests.push(
    "#4 GET http://.../agents/:agentKey/pty (probeHttp's plain-fetch classification, real chrome.runtime.connect attach flow — EXCLUDED from the Origin check: structurally can never carry one, see above)",
  );

  // --- FACTORY-532 (implementing FACTORY-531): the real PANEL renders a
  // jira-project board URL as "no agent running", never "not a butchr
  // resource" -------------------------------------------------------------
  // Unlike requests #1-#4 above (which only assert on the Origin header and
  // the raw fetchResources() return value), this drives the ACTUAL
  // content.js panel — real DOM, real shadow root, real chrome.scripting
  // injection into a REAL navigated page — and reads what it rendered. The
  // page's own `location.href` is what `fetchResources` sends as `pageUrl`
  // (see src/content/panel.ts's `loadResources`), so it has to be a URL the
  // real, unmodified `resolveUrlToResource` (butchr) can actually recognise
  // as a Jira project — which means `real-guard-server.ts`'s configured
  // Jira host has to match whatever host this test can really navigate to.
  // `manifest.json`'s `host_permissions` only ever grants script injection
  // on `http://127.0.0.1/*` (see this file's own header on why content
  // scripts are never declaratively matched by URL in this extension at
  // all — every injection here is the same `chrome.scripting.executeScript`
  // the real `chrome.action.onClicked` handler uses), so the fixture page
  // below is served locally and `real-guard-server.ts` is started with
  // `REAL_GUARD_JIRA_HOST=127.0.0.1` (FACTORY-532's own addition to that
  // script) to match it.
  localPageServer = await startLocalPageServer();
  const localPort = localPageServer.address().port;

  async function waitForPanelText(timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
      const text = await page.evaluate(() => {
        const host = document.getElementById("cleavr-panel-host");
        const el = host?.shadowRoot?.querySelector(".agent-picker");
        return el ? el.textContent : null;
      });
      if (text && text !== "Loading…") return text;
      if (Date.now() - start > timeoutMs) throw new Error(`panel text did not stabilize within ${timeoutMs}ms (last seen: ${JSON.stringify(text)})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Injects content.js into whichever tab is currently navigated to `url`
  // and opens the panel — the same `chrome.scripting.executeScript` +
  // `chrome.tabs.sendMessage(..., {type:"cleavr:toggle"})` pair the real
  // `chrome.action.onClicked` handler runs (src/background/wire.ts's
  // `toggleOnTab`); only the "user clicked the toolbar icon" trigger itself
  // is skipped, since headless Chrome has no clickable toolbar icon to
  // drive and `chrome.action.onClicked` is a browser-native event this
  // extension's own code does not implement.
  async function openPanelOn(url) {
    await page.goto(url, { waitUntil: "load" });
    await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({ url: targetUrl });
      const tabId = tabs[0]?.id;
      if (tabId === undefined) throw new Error(`no tab found for ${targetUrl}`);
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, { type: "cleavr:toggle" });
    }, url);
  }

  const projectGuardPort = await freePort();
  guardServer.kill();
  guardServer = await startRealGuardServer(projectGuardPort, `chrome-extension://${extensionId}`, { REAL_GUARD_JIRA_HOST: "127.0.0.1" });
  await setPort(projectGuardPort);

  const projectUrl = `http://127.0.0.1:${localPort}/jira/software/c/projects/FACTORY/boards/119?issueType=10010`;
  await openPanelOn(projectUrl);
  const projectPanelText = await waitForPanelText();
  console.log(`panel text for a jira-project board URL (${projectUrl}):`, JSON.stringify(projectPanelText));
  check(
    projectPanelText === "Butchr knows this resource but has no agent running on it.",
    'FACTORY-532: the real panel renders a jira-project board URL as "no agent running" (resource resolved, no agent staffed in this stub — never "not a butchr resource")',
    `expected the panel's exact "no agent running" text, got ${JSON.stringify(projectPanelText)}`,
  );
  coveredRequests.push("#5 POST /resources/for-url (content-script panel, real chrome.scripting-injected panel rendering a jira-project board URL)");

  // Control: an unrelated local path must still render "not a Butchr
  // resource" — proves this test's harness (and the real recogniser) can
  // tell the two cases apart, rather than the panel always rendering
  // "no agent running" regardless of the URL.
  const unrelatedUrl = `http://127.0.0.1:${localPort}/unrelated`;
  await openPanelOn(unrelatedUrl);
  const unrelatedPanelText = await waitForPanelText();
  console.log(`panel text for an unrelated local URL (${unrelatedUrl}):`, JSON.stringify(unrelatedPanelText));
  check(
    unrelatedPanelText === "This page isn't a Butchr resource.",
    "control: the real panel still renders an unrelated URL as not-a-resource (proves the jira-project assertion above isn't a fixed/stuck render)",
    `expected the panel's exact not-a-resource text, got ${JSON.stringify(unrelatedPanelText)}`,
  );

  console.log("\nRequests this test covers:");
  for (const r of coveredRequests) console.log(`  - ${r}`);
} finally {
  if (guardServer) guardServer.kill();
  if (localPageServer) localPageServer.close();
  await browser.close();
}

if (failed) {
  console.error("\nREAL-BROWSER ORIGIN REGRESSION TEST: FAILED");
  process.exit(1);
}
console.log("\nREAL-BROWSER ORIGIN REGRESSION TEST: ALL CHECKS PASSED");

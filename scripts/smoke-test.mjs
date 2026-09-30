// Headless-Chrome evidence for the PR: loads the (test-only, see
// build-e2e.mjs) unpacked extension, opens a real local page, and drives the
// actual content-script panel through the real chrome.runtime messaging
// path used in production.
//
// Two phases:
//   1. Panel shell checks (unchanged in spirit from FACTORY-336): toggle
//      open, the unset-options message, drag-resize, the close-button /
//      Escape decision, host-page isolation, keyboard non-leak.
//   2. PTY connection checks (FACTORY-456, new): points the extension at
//      scripts/fake-pty-server.mjs — a small local server that mimics
//      docs/pty-attach.md's documented wire shapes over a REAL WebSocket,
//      run against Chrome for Testing with dist-e2e's (unmodified copy of
//      dist/'s) background.js — and checks the panel actually renders a
//      snapshot, that two successive snapshots do not accumulate, and that
//      a pane-gone close (4000) surfaces as that specific state.
//
// LIMITATION, stated plainly (per the ticket): this is NOT a live daemon —
// scripts/fake-pty-server.mjs is a hand-written stand-in for the documented
// wire shapes, not butchr itself. It proves the transport-independent code
// paths work over a real socket. See README's "End-to-end evidence" and
// "Real-daemon end-to-end evidence" sections — the latter is where this was
// actually driven against a real daemon.
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "..", "dist-e2e");

const hostServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><h1>Host page</h1><p>some text</p></body></html>");
});
await new Promise((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
const hostPort = hostServer.address().port;
const pageUrl = `http://127.0.0.1:${hostPort}/`;

function startFakePtyServer(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "fake-pty-server.mjs")], {
      env: { ...process.env, FAKE_PTY_SCENARIO: scenario },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let resolved = false;
    child.stdout.on("data", (chunk) => {
      const match = /FAKE_PTY_PORT=(\d+)/.exec(chunk.toString());
      if (match && !resolved) {
        resolved = true;
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`fake-pty-server exited early (code ${code})`));
    });
  });
}

const browser = await puppeteer.launch({
  headless: "new",
  args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, "--no-sandbox"],
});

let failed = false;
let fakeServers = [];
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((resolve) => setTimeout(resolve, 300));

  let sw;
  for (let attempt = 0; attempt < 20 && !sw; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background.js"));
  }
  if (!sw) throw new Error("FAIL: extension service worker did not start (background.js)");
  const extensionId = new URL(sw.url()).host;
  console.log("PASS: extension loaded, service worker running. id =", extensionId);

  const worker = await sw.worker();

  function sendToggle() {
    return worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.reduce((latest, t) => (t.id > (latest?.id ?? -1) ? t : latest), null);
      if (!tab) return { ok: false, reason: "no tabs found" };
      await chrome.tabs.sendMessage(tab.id, { type: "cleavr:toggle" });
      return { ok: true };
    });
  }

  // --- Phase 1: panel shell -------------------------------------------------

  const toggleOpenResult = await sendToggle();
  if (!toggleOpenResult.ok) throw new Error(`FAIL: toggle-open message failed: ${toggleOpenResult.reason}`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const openState = await page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    if (!host || !host.shadowRoot) return { present: false };
    const panel = host.shadowRoot.querySelector(".panel");
    const status = host.shadowRoot.querySelector(".status");
    return {
      present: true,
      open: panel ? panel.classList.contains("open") : false,
      statusText: status ? status.textContent : null,
      hasTermContainer: !!host.shadowRoot.querySelector(".term-container"),
      width: panel ? panel.getBoundingClientRect().width : null,
      hostLayoutUnaffected: document.body.getBoundingClientRect().width > 0,
    };
  });
  console.log("panel state after action-click-equivalent toggle:", openState);
  if (!openState.present) throw new Error("FAIL: panel host / shadow root not found in page");
  if (!openState.open) throw new Error("FAIL: panel did not open");
  if (!openState.hasTermContainer) throw new Error("FAIL: terminal container missing from panel body");
  // FACTORY-469: options are never "unset" anymore (port defaults to 7717
  // with nothing configured), so with no daemon actually listening yet this
  // now surfaces as an "unreachable" failure rather than a base-url-unset
  // one. The exact network-error detail varies by environment, so only the
  // fixed prefix is asserted.
  if (!openState.statusText?.startsWith("Couldn't reach the Butchr daemon")) {
    throw new Error(`FAIL: unexpected status text before any daemon is configured: "${openState.statusText}"`);
  }
  console.log("PASS: panel opened in shadow root, showed the daemon-unreachable message (zero-config default port, no daemon yet), terminal container present.");

  // Drag-resize the panel via its left-edge handle.
  const handleBox = await page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    const rect = host.shadowRoot.querySelector(".resize-handle").getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 50 };
  });
  await page.mouse.move(handleBox.x, handleBox.y);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 120, handleBox.y, { steps: 10 });
  await page.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const widthAfterDrag = await page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    return host.shadowRoot.querySelector(".panel").getBoundingClientRect().width;
  });
  console.log(`panel width before drag: ${openState.width}, after dragging handle 120px left: ${widthAfterDrag}`);
  if (!(widthAfterDrag > openState.width)) {
    throw new Error("FAIL: dragging the left edge did not widen the panel");
  }
  console.log("PASS: left-edge drag resize widened the panel.");

  // FACTORY-456 decision: Escape now reaches the terminal (the agent may
  // bind it) and must NOT also close the panel — only the "×" button (and
  // the toolbar toggle) close it. See README's Keyboard section.
  await page.keyboard.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterEscape = await page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    return { open: host.shadowRoot.querySelector(".panel").classList.contains("open") };
  });
  console.log("panel state after Escape:", afterEscape);
  if (!afterEscape.open) throw new Error("FAIL: Escape closed the panel — it must reach the terminal instead now");
  console.log("PASS: Escape did NOT close the panel (it now reaches the terminal instead).");

  const closedByButton = await page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    host.shadowRoot.querySelector(".close").click();
    return { open: host.shadowRoot.querySelector(".panel").classList.contains("open") };
  });
  if (closedByButton.open) throw new Error("FAIL: the × button did not close the panel");
  console.log("PASS: the × button closed the panel.");

  const layoutAfterClose = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  console.log("host layout after close:", layoutAfterClose);
  if (layoutAfterClose.scrollWidth > layoutAfterClose.clientWidth + 1) {
    throw new Error("FAIL: closing the panel left the host page layout altered (horizontal overflow)");
  }
  console.log("PASS: host page layout unchanged after closing the panel.");

  await sendToggle();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const leakTest = await page.evaluate(() => {
    let leaked = false;
    document.addEventListener("keydown", () => {
      leaked = true;
    });
    const host = document.getElementById("cleavr-panel-host");
    const panel = host.shadowRoot.querySelector(".panel");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true, composed: true }));
    return leaked;
  });
  console.log("did a keydown inside the panel leak to document?", leakTest);
  if (leakTest) throw new Error("FAIL: a keydown inside the panel reached the host document listener");
  console.log("PASS: keystrokes inside the panel do not reach the host page's own handlers.");

  // --- Phase 2: PTY connection over a real socket ---------------------------

  const normal = await startFakePtyServer("normal");
  fakeServers.push(normal.child);
  console.log(`fake PTY server (normal) listening on 127.0.0.1:${normal.port}`);

  await worker.evaluate(async (port) => {
    await chrome.storage.local.set({ "cleavr:options": { port } });
  }, normal.port);

  // A fresh navigation gives a fresh content-script module instance (the
  // __cleavrInjected guard resets), so the panel re-fetches resources against
  // the fake server's port instead of the cached daemon-unreachable result.
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await sendToggle();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const agentLabelState = await page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    const label = host.shadowRoot.querySelector(".agent-label");
    return { labelText: label ? label.textContent : null };
  });
  console.log("agent picker after pointing at the fake daemon:", agentLabelState);
  if (agentLabelState.labelText !== "Fake Agent") {
    throw new Error(`FAIL: expected the single fake agent to render, got "${agentLabelState.labelText}"`);
  }
  console.log("PASS: /resources/for-url (fake) resolved to the single fake agent and the panel attached to it.");

  await new Promise((resolve) => setTimeout(resolve, 500));
  const rendered1 = await readTerminalText(page);
  console.log("terminal text after first settle:", JSON.stringify(rendered1));
  if (!/tick \d+/.test(rendered1)) {
    throw new Error(`FAIL: terminal did not render the fake server's snapshot; got: ${JSON.stringify(rendered1)}`);
  }
  console.log("PASS: the panel's real xterm.js instance rendered a snapshot from a real socket.");

  await new Promise((resolve) => setTimeout(resolve, 500));
  const rendered2 = await readTerminalText(page);
  const tick1 = Number(/tick (\d+)/.exec(rendered1)?.[1] ?? -1);
  const tick2 = Number(/tick (\d+)/.exec(rendered2)?.[1] ?? -1);
  console.log(`tick numbers across two settles: ${tick1} -> ${tick2}`);
  if (!(tick2 > tick1)) throw new Error("FAIL: the terminal never advanced past the first snapshot");
  // The redraw-not-accumulate property: an EARLIER tick's line must not
  // still be sitting in the buffer next to the latest one once the latest
  // tick has advanced past it — mirrors tests/pty/redraw.test.ts's unit
  // coverage, but observed here through a real xterm.js instance, a real
  // socket, and a real (fake) server.
  if (rendered2.includes(`tick ${tick1}`) && tick1 !== tick2) {
    throw new Error(`FAIL: an earlier snapshot (tick ${tick1}) is still visible alongside the latest — frames accumulated`);
  }
  console.log("PASS: successive snapshots did not accumulate in the real terminal.");

  // --- pane-gone -------------------------------------------------------------

  const paneGone = await startFakePtyServer("pane-gone");
  fakeServers.push(paneGone.child);
  await worker.evaluate(async (port) => {
    await chrome.storage.local.set({ "cleavr:options": { port } });
  }, paneGone.port);
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await sendToggle();
  await new Promise((resolve) => setTimeout(resolve, 1200)); // 2 ticks @ 200ms + margin, then the fake server closes 4000

  const bannerAfterPaneGone = await page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    const banner = host.shadowRoot.querySelector(".conn-banner");
    return { hidden: banner.hidden, text: banner.textContent };
  });
  console.log("connection banner after the fake pane goes away:", bannerAfterPaneGone);
  if (bannerAfterPaneGone.hidden || !/no longer live/.test(bannerAfterPaneGone.text)) {
    throw new Error(`FAIL: expected a pane-gone-specific banner, got: ${JSON.stringify(bannerAfterPaneGone)}`);
  }
  console.log('PASS: a real 4000 close surfaced as the pane-gone-specific state, not a generic "disconnected".');

  if (consoleErrors.length > 0) {
    throw new Error(`FAIL: console/page errors observed: ${consoleErrors.join(" | ")}`);
  }
  console.log("PASS: no console or page errors observed.");

  console.log("\nSMOKE TEST: ALL CHECKS PASSED");
  console.log(
    "\nNOT exercised by this test (stated per the ticket): a real butchr daemon or real herdr panes — " +
      "scripts/fake-pty-server.mjs is a hand-written stand-in for the documented wire shapes, purely to " +
      "exercise the transport-independent code. See README's 'Real-daemon end-to-end evidence' section " +
      "for where this was actually driven against a real daemon.",
  );
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  hostServer.close();
  for (const child of fakeServers) child.kill();
}

async function readTerminalText(page) {
  return page.evaluate(() => {
    const host = document.getElementById("cleavr-panel-host");
    // xterm.js's DOM renderer paints rows into `.xterm-rows` — reading that
    // specifically (rather than the whole `.term-container`, which also
    // holds the injected xterm.css <style> tag's text) keeps this to actual
    // rendered terminal content.
    const rows = host.shadowRoot.querySelector(".xterm-rows");
    return rows ? rows.textContent : "";
  });
}

process.exit(failed ? 1 : 0);

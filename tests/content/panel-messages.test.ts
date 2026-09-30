// @vitest-environment jsdom
// FACTORY-504: the panel must never blame a "check the Origin allowlist"
// setting — butchr's Origin allowlist is gone (FACTORY-475/FACTORY-497
// hardcoded the single extension origin). The `failureMessage` tests below
// (the real, legitimately-reachable 401/403 from POST /resources/for-url)
// run against the PRE-FIX text ("Check its Origin allowlist.") and fail.
// The `connectionBannerInfo` sweep below covers a DIFFERENT fix: that PTY
// path's own "rejected" state was removed outright (see
// src/lib/pty/state.ts's header) rather than just reworded, since
// probeHttp structurally cannot earn an origin diagnosis for the endpoint
// it probes — so there is no single pre-fix case to replay here; the sweep
// is a standing invariant instead.
import { describe, expect, it, vi, afterEach } from "vitest";
import "./skip-panel-init-stub";
import { failureMessage, connectionBannerInfo, sendMessage } from "../../src/content/panel";
import type { ConnState } from "../../src/lib/pty/state";

describe("failureMessage (resource-lookup failures)", () => {
  it("a 403 unauthorized failure never mentions an allowlist", () => {
    const message = failureMessage({ kind: "unauthorized", status: 403 });
    expect(message).not.toMatch(/allowlist/i);
  });

  it("a 401 unauthorized failure never mentions an allowlist", () => {
    const message = failureMessage({ kind: "unauthorized", status: 401 });
    expect(message).not.toMatch(/allowlist/i);
  });

  // FACTORY-530 item 1: a storage read failure (e.g. getOptions' port
  // lookup rejecting) must render its own honest message, distinct from
  // "unreachable" — the daemon was never even contacted.
  it("a storage-unreadable failure names the settings read, not the daemon", () => {
    const message = failureMessage({ kind: "storage-unreadable", detail: "storage unavailable" });
    expect(message).toMatch(/settings/i);
    expect(message).not.toMatch(/daemon/i);
  });

  // FACTORY-530 item 3: sendMessage's own generic-channel-failure case must
  // also render distinctly from both of the above.
  it("an extension-error failure names neither the daemon nor storage settings", () => {
    const message = failureMessage({ kind: "extension-error", detail: "Receiving end does not exist" });
    expect(message).not.toMatch(/daemon/i);
    expect(message).not.toMatch(/settings/i);
  });
});

// FACTORY-530 item 3: run against the pre-fix code (a bare
// `return chrome.runtime.sendMessage(message)`, no try/catch), the test
// below fails — sendMessage rejects instead of resolving to a typed
// failure, which is exactly what let loadResources hang on "Loading…"
// forever whenever the background channel itself (not fetchResources'
// own logic) was the thing that failed.
describe("sendMessage — degrades a rejected chrome.runtime.sendMessage to a typed failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves to an extension-error failure instead of rejecting", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist.")),
      },
    });
    await expect(sendMessage({ type: "cleavr:fetch-resources", pageUrl: "https://example.com" })).resolves.toEqual({
      kind: "failure",
      failure: { kind: "extension-error", detail: "Could not establish connection. Receiving end does not exist." },
    });
  });
});

// FACTORY-504 removed the "rejected" and probe-derived "not-found" states
// entirely (src/lib/pty/state.ts's own header explains why: probeHttp
// structurally cannot earn either diagnosis against /agents/:agentKey/pty's
// real routing) — so there is no longer a ConnState that can claim an
// origin/allowlist problem at all. This is now an exhaustive sweep: every
// remaining ConnState's banner message must never mention "allowlist".
describe("connectionBannerInfo (PTY connection failures) — no state may blame a nonexistent allowlist", () => {
  const states: ConnState[] = [
    { kind: "idle" },
    { kind: "connecting", agentKey: "agent-a", attempt: 0 },
    { kind: "attached", agentKey: "agent-a", attempt: 0 },
    { kind: "pane-gone", agentKey: "agent-a" },
    { kind: "daemon-unreachable", agentKey: "agent-a", attempt: 0 },
    { kind: "unexpected-drop", agentKey: "agent-a", attempt: 0 },
    { kind: "reconnecting", agentKey: "agent-a", attempt: 1, retryAtMs: Date.now() },
    { kind: "retry-exhausted", agentKey: "agent-a" },
  ];

  for (const state of states) {
    it(`"${state.kind}" never mentions an allowlist`, () => {
      const info = connectionBannerInfo(state);
      expect(info?.message ?? "").not.toMatch(/allowlist/i);
    });
  }
});

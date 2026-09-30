// FACTORY-504: probeHttp must never claim a diagnosis it hasn't earned for
// its target (/agents/:agentKey/pty converted from ws:// to http://) — see
// probeHttp's own header in src/background/wire.ts for the full
// investigation. Two false diagnoses were removed, not just one:
//   - "rejected-401"/"rejected-403" (the ticket's original finding): a
//     plain fetch() can never carry the Upgrade header a real WS upgrade
//     needs, so it can never reach butchr's origin guard at all on this
//     WebSocket-only route.
//   - "not-found" (found DURING this ticket, once "make the probe
//     Origin-stamped instead" turned out to be impossible for this route,
//     see FACTORY-504's Jira comments): the SAME routing fact means a
//     plain fetch 404s unconditionally, whether or not the agent key names
//     a real pane — so a 404 from THIS probe is not evidence the agent is
//     unknown either.
// Run against the PRE-FIX code (the version that did
// `if (status===403) return "rejected-403"` and
// `if (status===404) return "not-found"`), the tests below fail: a bare
// 403 classifies as "rejected-403", a bare 404 as "not-found". Against the
// fixed code they always pass — only "unreachable" (a network-level
// failure) is treated as a legitimate signal; every actual HTTP response
// collapses to "inconclusive".
import { describe, expect, it, vi, afterEach } from "vitest";
import "./chrome-global-stub";
import { probeHttp } from "../src/background/wire";

function fakeResponse(status: number): Response {
  return { status } as Response;
}

describe("probeHttp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never classifies a 403 as a rejected-origin failure — it has no way to know that's why", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(403)));
    const result = await probeHttp("http://127.0.0.1:7717/agents/agent-a/pty");
    expect(result).not.toBe("rejected-403");
    expect(result).toBe("inconclusive");
  });

  it("never classifies a 401 as a rejected-origin failure either (butchr's guard never even emits 401, but the probe must not invent one)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(401)));
    const result = await probeHttp("http://127.0.0.1:7717/agents/agent-a/pty");
    expect(result).not.toBe("rejected-401");
    expect(result).toBe("inconclusive");
  });

  it("never classifies a 404 as not-found either — this route 404s unconditionally, regardless of whether the agent is real", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(404)));
    const result = await probeHttp("http://127.0.0.1:7717/agents/agent-a/pty");
    expect(result).not.toBe("not-found");
    expect(result).toBe("inconclusive");
  });

  it("classifies a network failure as unreachable — the one signal this probe CAN legitimately observe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await probeHttp("http://127.0.0.1:7717/agents/agent-a/pty");
    expect(result).toBe("unreachable");
  });

  it("classifies any other status as inconclusive too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(500)));
    const result = await probeHttp("http://127.0.0.1:7717/agents/agent-a/pty");
    expect(result).toBe("inconclusive");
  });
});

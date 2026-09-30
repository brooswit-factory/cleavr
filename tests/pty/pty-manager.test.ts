import { describe, it, expect } from "vitest";
import { PtyConnectionManager, type PtyManagerDeps } from "../../src/background/pty-manager";
import { createFakeOpener } from "./fake-opener";
import type { BackgroundToPanelMessage } from "../../src/lib/pty/messages";
import type { ConnState } from "../../src/lib/pty/state";
import { MAX_ATTEMPTS, PANE_GONE_CLOSE_CODE } from "../../src/lib/pty/state";

function makeDeps(overrides: Partial<PtyManagerDeps> = {}) {
  const { opener, sockets } = createFakeOpener();
  const posted: BackgroundToPanelMessage[] = [];
  const alarms: { name: string; delayMs: number }[] = [];
  const cleared: string[] = [];
  const deps: PtyManagerDeps = {
    opener,
    getOptions: async () => ({ port: 1234 }),
    post: (message) => posted.push(message),
    scheduleAlarm: (name, delayMs) => alarms.push({ name, delayMs }),
    clearAlarm: (name) => cleared.push(name),
    probeHttp: async () => "unreachable",
    ...overrides,
  };
  return { deps, sockets, posted, alarms, cleared };
}

function states(posted: BackgroundToPanelMessage[]): ConnState[] {
  return posted.filter((m): m is { type: "state"; state: ConnState } => m.type === "state").map((m) => m.state);
}

describe("PtyConnectionManager", () => {
  it("attaching opens exactly one socket for the requested agent", async () => {
    const { deps, sockets } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.opts.agentKey).toBe("agent-a");
  });

  it("attach goes straight to connecting, never a config-missing detour (the daemon address is always defined now)", async () => {
    const { deps, posted } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    expect(states(posted)).toEqual([{ kind: "connecting", agentKey: "agent-a", attempt: 0 }]);
  });

  it("opens the socket against the port getOptions returns", async () => {
    const { deps, sockets } = makeDeps({ getOptions: async () => ({ port: 9999 }) });
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    expect(sockets[0]?.opts.port).toBe(9999);
  });

  it("a message from the socket is forwarded as a full-redraw frame", async () => {
    const { deps, sockets, posted } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    sockets[0]!.simulateOpen();
    sockets[0]!.simulateMessage("hello pane");
    const frame = posted.find((m) => m.type === "frame");
    expect(frame?.type).toBe("frame");
    if (frame?.type === "frame") {
      expect(frame.text.endsWith("hello pane")).toBe(true);
      expect(frame.text).not.toBe("hello pane"); // wrapped with the redraw prefix
    }
  });

  it("switching agents tears down exactly the old socket and opens exactly one new one", async () => {
    const { deps, sockets } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    sockets[0]!.simulateOpen();

    await manager.handle({ type: "attach", agentKey: "agent-b" });
    await flush();

    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[1]!.closed).toBe(false);
    expect(sockets[1]!.opts.agentKey).toBe("agent-b");
  });

  it("pane-gone (code 4000) is terminal: no retry alarm scheduled", async () => {
    const { deps, sockets, posted, alarms } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    sockets[0]!.simulateOpen();
    sockets[0]!.simulateClose(PANE_GONE_CLOSE_CODE, "agent gone: pane no longer live");

    expect(lastOf(states(posted))).toEqual({ kind: "pane-gone", agentKey: "agent-a" });
    expect(alarms).toHaveLength(0);
  });

  it("an unexpected drop schedules bounded retries and eventually exhausts", async () => {
    const { deps, sockets, posted, alarms } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    sockets[0]!.simulateOpen();

    let currentSocket = sockets[0]!;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      currentSocket.simulateClose(1006, "");
      expect(alarms).toHaveLength(i + 1);
      manager.onAlarmFired();
      await flush();
      currentSocket = lastOf(sockets)!;
      currentSocket.simulateOpen();
    }
    // One more drop should exhaust retries.
    currentSocket.simulateClose(1006, "");
    expect(lastOf(states(posted))).toEqual({ kind: "retry-exhausted", agentKey: "agent-a" });
    expect(alarms).toHaveLength(MAX_ATTEMPTS); // no additional alarm scheduled past the cap
  });

  it("manual reconnect after exhaustion opens a fresh socket", async () => {
    const { deps, sockets, posted } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    sockets[0]!.simulateOpen();
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      lastOf(sockets)!.simulateClose(1006, "");
      if (lastOf(states(posted))?.kind === "reconnecting") {
        manager.onAlarmFired();
        await flush();
        lastOf(sockets)!.simulateOpen();
      } else {
        break;
      }
    }
    expect(lastOf(states(posted))?.kind).toBe("retry-exhausted");

    await manager.handle({ type: "manual-reconnect" });
    await flush();
    expect(lastOf(sockets)!.opts.agentKey).toBe("agent-a");
    expect(lastOf(states(posted))?.kind).toBe("connecting");
  });

  it("a resize control frame is sent but nothing asserts it reached the agent, and the connection is unaffected", async () => {
    const { deps, sockets } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    sockets[0]!.simulateOpen();
    await manager.handle({ type: "resize", cols: 80, rows: 24 });
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
  });

  it("detach closes the socket and cancels any pending retry alarm", async () => {
    const { deps, sockets, cleared } = makeDeps();
    const manager = new PtyConnectionManager(deps, 1);
    await manager.handle({ type: "attach", agentKey: "agent-a" });
    await flush();
    sockets[0]!.simulateOpen();
    await manager.handle({ type: "detach" });
    expect(sockets[0]!.closed).toBe(true);
    expect(cleared.length).toBeGreaterThan(0);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function lastOf<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

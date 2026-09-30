// FACTORY-458/466/469: the real opener's own contract, checked against a fake
// WebSocket constructor rather than a real socket — no network I/O, just
// asserting exactly what createRealOpener hands to `new WebSocket(...)`.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRealOpener, ptyWebSocketUrl } from "../../src/lib/pty/opener";

class FakeWebSocketCtor {
  static instances: FakeWebSocketCtor[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  protocol = "";

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocketCtor.instances.push(this);
  }

  send(): void {}
  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocketCtor.instances = [];
});

describe("createRealOpener", () => {
  it("opens with no subprotocol at all (FACTORY-466 dropped the bearer-token channel)", () => {
    vi.stubGlobal("WebSocket", FakeWebSocketCtor);
    const opener = createRealOpener();
    opener({ port: 1234, agentKey: "agent-a" });

    expect(FakeWebSocketCtor.instances).toHaveLength(1);
    const instance = FakeWebSocketCtor.instances[0]!;
    expect(instance.protocols).toBeUndefined();
  });

  it("builds the same ws:// URL ptyWebSocketUrl would", () => {
    vi.stubGlobal("WebSocket", FakeWebSocketCtor);
    const opener = createRealOpener();
    opener({ port: 1234, agentKey: "agent-a" });

    const instance = FakeWebSocketCtor.instances[0]!;
    expect(instance.url).toBe(ptyWebSocketUrl(1234, "agent-a"));
  });

  it("always builds a ws:// URL against 127.0.0.1 (the daemon host is fixed, not user-editable)", () => {
    vi.stubGlobal("WebSocket", FakeWebSocketCtor);
    const opener = createRealOpener();
    opener({ port: 7717, agentKey: "prov:rule:res" });

    const instance = FakeWebSocketCtor.instances[0]!;
    expect(instance.url).toBe("ws://127.0.0.1:7717/agents/prov%3Arule%3Ares/pty");
  });
});

import { describe, it, expect } from "vitest";
import {
  reduce,
  isTerminal,
  delayForAttempt,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_ATTEMPTS,
  PANE_GONE_CLOSE_CODE,
  type ConnState,
} from "../../src/lib/pty/state";

function attach(agentKey = "provider:rule:1"): ConnState {
  return reduce({ kind: "idle" }, { type: "attach", agentKey }).state;
}

describe("pty connection state machine", () => {
  it("idle -> attach -> connecting, opens a socket", () => {
    const { state, effects } = reduce({ kind: "idle" }, { type: "attach", agentKey: "a" });
    expect(state).toEqual({ kind: "connecting", agentKey: "a", attempt: 0 });
    expect(effects).toEqual([{ type: "clear-terminal" }, { type: "open-socket", agentKey: "a" }]);
  });

  it("connecting -> socket-open -> attached", () => {
    const connecting = attach("a");
    const { state } = reduce(connecting, { type: "socket-open" });
    expect(state).toEqual({ kind: "attached", agentKey: "a", attempt: 0 });
  });

  it("attached -> socket-close(4000, pane gone) -> pane-gone, terminal, no retry scheduled", () => {
    const attached: ConnState = { kind: "attached", agentKey: "a", attempt: 0 };
    const { state, effects } = reduce(attached, {
      type: "socket-close",
      code: PANE_GONE_CLOSE_CODE,
      reason: "agent gone: pane no longer live",
    });
    expect(state).toEqual({ kind: "pane-gone", agentKey: "a" });
    expect(isTerminal(state)).toBe(true);
    expect(effects).not.toContainEqual(expect.objectContaining({ type: "schedule-retry" }));
  });

  it("connecting -> socket-close(other) -> probes HTTP rather than guessing", () => {
    const connecting = attach("a");
    const { effects } = reduce(connecting, { type: "socket-close", code: 1006, reason: "" });
    expect(effects).toEqual([{ type: "probe-http", agentKey: "a" }]);
  });

  // FACTORY-504: probeHttp's plain-HTTP classification of a failed WS
  // upgrade against /agents/:agentKey/pty cannot legitimately distinguish
  // an origin rejection or an unknown agent from anything else — the route
  // is WebSocket-only, so a plain fetch() 404s unconditionally regardless
  // of Origin or agent key (see probeHttp's own header in
  // src/background/wire.ts). The "rejected"/probe-derived "not-found"
  // states this test used to cover here are gone — every classification
  // probeHttp can produce now folds into the same daemon-unreachable
  // retry/backoff path, covered by the test immediately below.
  it("probe-result unreachable -> daemon-unreachable, schedules a bounded retry", () => {
    const connecting = attach("a");
    const { state, effects } = reduce(connecting, { type: "probe-result", classification: "unreachable" });
    expect(state.kind).toBe("reconnecting");
    expect(effects[0]).toEqual({ type: "schedule-retry", delayMs: delayForAttempt(0) });
  });

  // FACTORY-504's own DoD: a probe against a route that returns some
  // response (404, in practice — see probeHttp's header) regardless of
  // Origin or agent key must NOT yield "rejected" or "not-found" — it must
  // behave exactly like "we got no useful signal", i.e. identically to
  // "unreachable" above.
  it("probe-result inconclusive -> ALSO daemon-unreachable (never 'rejected' or 'not-found') — same as unreachable", () => {
    const connecting = attach("a");
    const { state, effects } = reduce(connecting, { type: "probe-result", classification: "inconclusive" });
    expect(state.kind).toBe("reconnecting");
    expect(state.kind).not.toBe("rejected");
    expect(state.kind).not.toBe("not-found");
    expect(effects[0]).toEqual({ type: "schedule-retry", delayMs: delayForAttempt(0) });
  });


  it("an unexpected drop from 'attached' reconnects with backoff, not immediately", () => {
    const attached: ConnState = { kind: "attached", agentKey: "a", attempt: 0 };
    const { state, effects } = reduce(attached, { type: "socket-close", code: 1006, reason: "" });
    expect(state).toEqual({ kind: "reconnecting", agentKey: "a", attempt: 1, retryAtMs: expect.any(Number) });
    expect(effects).toEqual([{ type: "schedule-retry", delayMs: BASE_DELAY_MS }]);
  });

  it("back-pressure close (also code 1006, see src/lib/pty/state.ts header) is indistinguishable from any other unexpected drop", () => {
    const attached: ConnState = { kind: "attached", agentKey: "a", attempt: 0 };
    const backpressureLike = reduce(attached, { type: "socket-close", code: 1006, reason: "" });
    const genericDrop = reduce(attached, { type: "socket-close", code: 1006, reason: "" });
    expect(backpressureLike).toEqual(genericDrop);
  });

  it("retry-timer-fired resumes connecting with the same attempt count and re-opens the socket", () => {
    const reconnecting: ConnState = { kind: "reconnecting", agentKey: "a", attempt: 2, retryAtMs: 123 };
    const { state, effects } = reduce(reconnecting, { type: "retry-timer-fired" });
    expect(state).toEqual({ kind: "connecting", agentKey: "a", attempt: 2 });
    expect(effects).toEqual([{ type: "open-socket", agentKey: "a" }]);
  });

  it("backoff is bounded: delay grows exponentially then caps at MAX_DELAY_MS", () => {
    expect(delayForAttempt(0)).toBe(BASE_DELAY_MS);
    expect(delayForAttempt(1)).toBe(BASE_DELAY_MS * 2);
    expect(delayForAttempt(2)).toBe(BASE_DELAY_MS * 4);
    const big = delayForAttempt(20);
    expect(big).toBe(MAX_DELAY_MS);
  });

  it("gives up after MAX_ATTEMPTS and requires a manual reconnect (no more auto-retry)", () => {
    let state: ConnState = { kind: "attached", agentKey: "a", attempt: 0 };
    let lastEffects: ReturnType<typeof reduce>["effects"] = [];
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      const result = reduce(state, { type: "socket-close", code: 1006, reason: "" });
      state = result.state;
      lastEffects = result.effects;
      if (state.kind === "reconnecting") {
        state = reduce(state, { type: "retry-timer-fired" }).state;
        // Simulate the retried socket actually opening, so the NEXT drop is
        // once again a drop from "attached" (the unexpected-drop path),
        // exactly like a real flaky connection — not a repeated
        // still-connecting failure, which is a different, already-covered
        // branch (probe-http).
        state = reduce(state, { type: "socket-open" }).state;
      }
    }
    expect(state).toEqual({ kind: "retry-exhausted", agentKey: "a" });
    expect(isTerminal(state)).toBe(true);
    expect(lastEffects).toEqual([]);
  });

  it("manual-reconnect restarts attempt count from 0, even from retry-exhausted", () => {
    const exhausted: ConnState = { kind: "retry-exhausted", agentKey: "a" };
    const { state, effects } = reduce(exhausted, { type: "manual-reconnect" });
    expect(state).toEqual({ kind: "connecting", agentKey: "a", attempt: 0 });
    expect(effects).toEqual([{ type: "clear-terminal" }, { type: "open-socket", agentKey: "a" }]);
  });

  it("manual-reconnect also works from other terminal states (pane-gone)", () => {
    for (const terminal of [{ kind: "pane-gone", agentKey: "a" }] as ConnState[]) {
      const { state } = reduce(terminal, { type: "manual-reconnect" });
      expect(state).toEqual({ kind: "connecting", agentKey: "a", attempt: 0 });
    }
  });

  it("detach from any active state closes the socket and cancels retry, returning to idle", () => {
    const reconnecting: ConnState = { kind: "reconnecting", agentKey: "a", attempt: 1, retryAtMs: 1 };
    const { state, effects } = reduce(reconnecting, { type: "detach" });
    expect(state).toEqual({ kind: "idle" });
    expect(effects).toEqual(expect.arrayContaining([{ type: "cancel-retry" }, { type: "close-socket" }]));
  });

  it("switching agents (attach while already attached) closes exactly the old socket and opens exactly one new one", () => {
    const attached: ConnState = { kind: "attached", agentKey: "a", attempt: 0 };
    const { state, effects } = reduce(attached, { type: "attach", agentKey: "b" });
    expect(state).toEqual({ kind: "connecting", agentKey: "b", attempt: 0 });
    const closeEffects = effects.filter((e) => e.type === "close-socket");
    const openEffects = effects.filter((e) => e.type === "open-socket");
    expect(closeEffects).toHaveLength(1);
    expect(openEffects).toEqual([{ type: "open-socket", agentKey: "b" }]);
    expect(effects).toContainEqual({ type: "clear-terminal" });
  });
});

// Pure connection state machine for the PTY attach socket (FACTORY-338/456).
// No DOM, no chrome.* API, no real timer or socket — see docs/pty-attach.md
// (butchr repo) for the wire contract this reacts to. The imperative shell
// that drives real sockets/alarms lives in src/background/pty-manager.ts.
//
// Three states this machine deliberately does NOT have, and why:
//   - A distinct "back-pressure dropped" state. Measured empirically against
//     a local Bun server configured exactly like butchr's route
//     (backpressureLimit + closeOnBackpressureLimit): the resulting close is
//     code 1006 with an empty reason, byte-for-byte the same as an ordinary
//     abnormal network drop. There is nothing on the wire to distinguish the
//     two, so this machine folds both into "unexpected-drop" rather than
//     claiming a precision it cannot deliver (the ticket's own "do not fake
//     precision" rule, applied here as much as to the rejected/not-found
//     case immediately below).
//   - A "resize acknowledged" state. Resize is fire-and-forget; nothing may
//     ever depend on the daemon having honoured it (it currently cannot).
//   - FACTORY-504 REMOVED a "rejected" (401/403) state and a probe-derived
//     "not-found" state that used to exist here, along with the
//     `RejectStatus` type. Both were fed exclusively by probeHttp's
//     plain-HTTP classification of a failed WS upgrade
//     (src/background/wire.ts) — and that probe, targeting
//     `/agents/:agentKey/pty`, structurally CANNOT observe either: the
//     route is WebSocket-only (no plain GET/POST handler), so a plain
//     `fetch()` (which can never carry the `Upgrade` header a real upgrade
//     needs) never reaches the origin guard OR the pane-resolution logic —
//     it 404s unconditionally, regardless of Origin, and regardless of
//     whether the agent key is real. Keeping "rejected"/probe-derived
//     "not-found" around claimed a diagnosis (an origin problem, or an
//     unknown agent) the probe had no way to have earned — exactly the
//     "do not fake precision" failure this file's own header already
//     warned about for the back-pressure case. There is currently no OTHER
//     path by which the client can legitimately observe why a WS upgrade
//     failed either: browsers give JS no status/headers on a failed
//     upgrade (see docs/pty-attach.md in the butchr repo, "Origin gate at
//     upgrade, never after"). So every probe result now folds into the
//     same honest "daemon-unreachable" retry/backoff path below — see
//     "probe-result" in `reduce()`.

export type ConnState =
  | { kind: "idle" }
  | { kind: "connecting"; agentKey: string; attempt: number }
  | { kind: "attached"; agentKey: string; attempt: number }
  | { kind: "pane-gone"; agentKey: string }
  | { kind: "daemon-unreachable"; agentKey: string; attempt: number }
  | { kind: "unexpected-drop"; agentKey: string; attempt: number }
  | { kind: "reconnecting"; agentKey: string; attempt: number; retryAtMs: number }
  | { kind: "retry-exhausted"; agentKey: string };

export type ConnEvent =
  | { type: "attach"; agentKey: string }
  | { type: "detach" }
  | { type: "socket-open" }
  | { type: "socket-close"; code: number; reason: string }
  | { type: "socket-error" }
  | {
      type: "probe-result";
      classification: "unreachable" | "inconclusive";
    }
  | { type: "retry-timer-fired" }
  | { type: "manual-reconnect" };

export type Effect =
  | { type: "open-socket"; agentKey: string }
  | { type: "close-socket" }
  | { type: "clear-terminal" }
  | { type: "probe-http"; agentKey: string }
  | { type: "schedule-retry"; delayMs: number }
  | { type: "cancel-retry" };

export const PANE_GONE_CLOSE_CODE = 4000;

// Bounded exponential backoff: 500ms, 1s, 2s, 4s, 8s, capped at 15s, and no
// more than MAX_ATTEMPTS scheduled retries before requiring the user to
// press "Reconnect" — an unbounded auto-retry is exactly the "looks like a
// working terminal" failure mode the ticket forbids.
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 15_000;
export const MAX_ATTEMPTS = 6;

export function delayForAttempt(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

export interface ReduceResult {
  state: ConnState;
  effects: Effect[];
}

const currentAgentKey = (state: ConnState): string | null => {
  switch (state.kind) {
    case "idle":
      return null;
    default:
      return state.agentKey;
  }
};

export function reduce(state: ConnState, event: ConnEvent): ReduceResult {
  switch (event.type) {
    case "attach": {
      // Switching agents while one is already attached/connecting must tear
      // down exactly the one old socket before opening exactly one new one
      // (the ticket's own agent-switching requirement) — never two sockets
      // briefly alive, never zero.
      const effects: Effect[] = [];
      if (currentAgentKey(state) !== null) effects.push({ type: "cancel-retry" }, { type: "close-socket" });
      effects.push({ type: "clear-terminal" }, { type: "open-socket", agentKey: event.agentKey });
      return { state: { kind: "connecting", agentKey: event.agentKey, attempt: 0 }, effects };
    }

    case "detach": {
      const effects: Effect[] = [{ type: "cancel-retry" }];
      if (currentAgentKey(state) !== null) effects.push({ type: "close-socket" });
      return { state: { kind: "idle" }, effects };
    }

    case "socket-open": {
      if (state.kind !== "connecting") return { state, effects: [] };
      // Deliberately carries the attempt count forward rather than resetting
      // it to 0: a socket that opens and then drops again immediately (a
      // flapping connection) must still count towards MAX_ATTEMPTS, or a
      // daemon that's actually unhealthy could retry forever while
      // fleetingly looking attached each time — exactly the "looks like a
      // working terminal" failure mode the ticket forbids. Only a fresh
      // "attach" (a different agent, or the same one re-picked) or an
      // explicit "manual-reconnect" resets the count.
      return { state: { kind: "attached", agentKey: state.agentKey, attempt: state.attempt }, effects: [] };
    }

    case "socket-close": {
      const agentKey = currentAgentKey(state);
      if (agentKey === null) return { state, effects: [] };

      if (event.code === PANE_GONE_CLOSE_CODE) {
        return { state: { kind: "pane-gone", agentKey }, effects: [{ type: "cancel-retry" }] };
      }

      // A close while still trying to attach carries no distinguishing
      // information over the WS itself (browsers only expose a generic
      // 1006 for a refused upgrade) — probe over plain HTTP to classify it
      // per the ticket's own suggested fallback.
      if (state.kind === "connecting") {
        return { state, effects: [{ type: "probe-http", agentKey }] };
      }

      // Was live, then dropped unexpectedly (network flake or back-pressure
      // — see this file's header for why those are not distinguished).
      // state.attempt always exists here: every non-"connecting", non-idle,
      // non-terminal ConnState still tracks it.
      const attempt = "attempt" in state ? state.attempt : 0;
      return scheduleOrExhaust({ kind: "unexpected-drop", agentKey, attempt }, agentKey);
    }

    case "socket-error": {
      const agentKey = currentAgentKey(state);
      if (agentKey === null) return { state, effects: [] };
      if (state.kind === "connecting") {
        return { state, effects: [{ type: "probe-http", agentKey }] };
      }
      return { state, effects: [] };
    }

    case "probe-result": {
      const agentKey = currentAgentKey(state);
      if (agentKey === null || state.kind !== "connecting") return { state, effects: [] };
      // FACTORY-504: every classification probeHttp can produce here means
      // the same thing — "we don't know why the WS upgrade failed" (see
      // this file's own header) — so both fold into the identical honest
      // retry/backoff path, rather than the removed "rejected"/"not-found"
      // states that used to claim a cause the probe never actually earned.
      return scheduleOrExhaust({ kind: "daemon-unreachable", agentKey, attempt: state.attempt }, agentKey);
    }

    case "retry-timer-fired": {
      if (state.kind !== "reconnecting") return { state, effects: [] };
      return {
        state: { kind: "connecting", agentKey: state.agentKey, attempt: state.attempt },
        effects: [{ type: "open-socket", agentKey: state.agentKey }],
      };
    }

    case "manual-reconnect": {
      const agentKey = currentAgentKey(state);
      if (agentKey === null) return { state, effects: [] };
      // Terminal states (pane-gone, not-found, rejected) never auto-retry,
      // but a manual reconnect press starts a fresh attempt sequence
      // (attempt 0) for all of them, including retry-exhausted.
      return {
        state: { kind: "connecting", agentKey, attempt: 0 },
        effects: [{ type: "clear-terminal" }, { type: "open-socket", agentKey }],
      };
    }

    default:
      return { state, effects: [] };
  }
}

function scheduleOrExhaust(
  next: { kind: "unexpected-drop" | "daemon-unreachable"; agentKey: string; attempt: number },
  agentKey: string,
): ReduceResult {
  if (next.attempt >= MAX_ATTEMPTS) {
    return { state: { kind: "retry-exhausted", agentKey }, effects: [] };
  }
  const delayMs = delayForAttempt(next.attempt);
  return {
    state: { kind: "reconnecting", agentKey, attempt: next.attempt + 1, retryAtMs: Date.now() + delayMs },
    effects: [{ type: "schedule-retry", delayMs }],
  };
}

// Terminal = no automatic retry will ever move this state forward on its
// own; only a fresh "attach" or a "manual-reconnect" can.
export function isTerminal(state: ConnState): boolean {
  return state.kind === "pane-gone" || state.kind === "retry-exhausted";
}

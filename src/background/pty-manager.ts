// The imperative shell around src/lib/pty/state.ts's pure reducer: one
// PtyConnectionManager per tab (a tab's panel owns at most one live PTY
// attach at a time — agent switching tears the old one down first, per the
// ticket's "exactly one socket closed, one opened" requirement). This is the
// only place that touches a real socket, chrome.alarms, or chrome.storage.
//
// Reconnect state survives the service worker being evicted and restarted
// by MV3 (see README's "Where the socket lives" section for why this
// matters even though an active socket is expected to keep the worker
// alive most of the time): the retry timer is a chrome.alarm, not
// setTimeout (alarms wake a killed service worker; timers do not), and the
// in-flight agentKey/attempt count are persisted to chrome.storage.session
// (in-memory, per-browser-session, never synced) so a restarted worker
// resumes the same backoff sequence instead of silently forgetting it and
// retrying from attempt 0 forever.
import { reduce, type ConnEvent, type ConnState, type Effect, PANE_GONE_CLOSE_CODE } from "../lib/pty/state";
import { toRedrawSequence } from "../lib/pty/redraw";
import { ptyWebSocketUrl, buildResizeControlFrame, type PtyOpener, type PtySocketLike } from "../lib/pty/opener";
import type { PanelToBackgroundMessage, BackgroundToPanelMessage } from "../lib/pty/messages";

export interface PtyManagerDeps {
  opener: PtyOpener;
  getOptions: () => Promise<{ port: number }>;
  post: (message: BackgroundToPanelMessage) => void;
  scheduleAlarm: (name: string, delayMs: number) => void;
  clearAlarm: (name: string) => void;
  probeHttp: (url: string) => Promise<"unreachable" | "inconclusive">;
}

export class PtyConnectionManager {
  private state: ConnState = { kind: "idle" };
  private socket: PtySocketLike | null = null;
  private readonly alarmName: string;

  constructor(private readonly deps: PtyManagerDeps, tabId: number) {
    this.alarmName = `cleavr:pty-retry:${tabId}`;
  }

  getState(): ConnState {
    return this.state;
  }

  // Used ONLY when a chrome.alarm wakes a freshly-restarted service worker
  // that has no in-memory manager for this tab (the previous one, and its
  // in-progress backoff, died with the evicted worker). Reconstructs just
  // enough state — agentKey and attempt count, read back from
  // chrome.storage.session by the caller — so the alarm firing resumes the
  // SAME backoff sequence instead of silently restarting it from attempt 0.
  // See this file's header for why this is necessary even though an active
  // socket is expected to keep the worker alive most of the time.
  rehydrateForRetry(agentKey: string, attempt: number): void {
    this.state = { kind: "reconnecting", agentKey, attempt, retryAtMs: Date.now() };
  }

  async handle(message: PanelToBackgroundMessage): Promise<void> {
    if (message.type === "attach") {
      // The daemon's address is always defined now (fixed host, defaulted
      // port), so attaching never needs to check for missing config first.
      return this.dispatch({ type: "attach", agentKey: message.agentKey });
    }
    if (message.type === "detach") {
      return this.dispatch({ type: "detach" });
    }
    if (message.type === "manual-reconnect") {
      return this.dispatch({ type: "manual-reconnect" });
    }
    if (message.type === "input") {
      this.socket?.send(message.text);
      return;
    }
    if (message.type === "resize") {
      // Best-effort only — see src/lib/pty/state.ts's header: nothing may
      // ever depend on this reaching the pane, because it currently cannot
      // (no herdr call sets a PTY's size; docs/pty-attach.md's Resize
      // section). Sending it is harmless.
      this.socket?.send(buildResizeControlFrame(message.cols, message.rows));
      return;
    }
  }

  onAlarmFired(): void {
    this.dispatch({ type: "retry-timer-fired" });
  }

  dispose(): void {
    this.deps.clearAlarm(this.alarmName);
    this.socket?.close();
    this.socket = null;
  }

  private dispatch(event: ConnEvent): void {
    const { state, effects } = reduce(this.state, event);
    this.state = state;
    this.deps.post({ type: "state", state });
    for (const effect of effects) this.runEffect(effect);
  }

  private runEffect(effect: Effect): void {
    switch (effect.type) {
      case "clear-terminal":
        // Nothing to do here — the panel clears its own xterm buffer on
        // seeing the "connecting" state transition that always accompanies
        // this effect (see src/content/panel.ts).
        return;
      case "close-socket":
        this.socket?.close();
        this.socket = null;
        return;
      case "cancel-retry":
        this.deps.clearAlarm(this.alarmName);
        return;
      case "schedule-retry":
        this.deps.scheduleAlarm(this.alarmName, effect.delayMs);
        return;
      case "open-socket":
        void this.openSocket(effect.agentKey);
        return;
      case "probe-http":
        void this.probe(effect.agentKey);
        return;
    }
  }

  private async openSocket(agentKey: string): Promise<void> {
    const options = await this.deps.getOptions();
    const socket = this.deps.opener({ port: options.port, agentKey });
    this.socket = socket;
    socket.onopen = () => {
      this.dispatch({ type: "socket-open" });
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.deps.post({ type: "frame", text: toRedrawSequence(event.data) });
      }
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.dispatch({ type: "socket-close", code: event.code, reason: event.reason });
    };
    socket.onerror = () => this.dispatch({ type: "socket-error" });
  }

  private async probe(agentKey: string): Promise<void> {
    const options = await this.deps.getOptions();
    const httpUrl = ptyWebSocketUrl(options.port, agentKey).replace(/^ws/, "http");
    const classification = await this.deps.probeHttp(httpUrl);
    this.dispatch({ type: "probe-result", classification });
  }
}

export { PANE_GONE_CLOSE_CODE };

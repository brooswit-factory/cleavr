// Messages carried over the chrome.runtime.connect port between the panel
// (content script) and the background connection manager. One port per tab,
// named "cleavr:pty" (see src/content/panel.ts / src/background/pty-manager.ts).
import type { ConnState } from "./state";

export type PanelToBackgroundMessage =
  | { type: "attach"; agentKey: string }
  | { type: "detach" }
  | { type: "input"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "manual-reconnect" };

export type BackgroundToPanelMessage = { type: "state"; state: ConnState } | { type: "frame"; text: string };

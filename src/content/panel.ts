import type { RuntimeMessage, FetchResourcesResult } from "../lib/messages";
import type { ButchrResource, ResourceState, Failure, ButchrAgent } from "../lib/adapter";
import { getPanelWidth, setPanelWidth, getAgentChoice, setAgentChoice } from "../lib/storage";
import type { BackgroundToPanelMessage } from "../lib/pty/messages";
import type { ConnState } from "../lib/pty/state";
import { PanelTerminal } from "./terminal";
import { installKeyboardIsolation } from "./keyboard-isolation";

const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;

function init(): void {
  const host = document.createElement("div");
  host.id = "cleavr-panel-host";
  // Reset any inherited styles the host page might cascade onto our host
  // element itself (the shadow root below is already fully isolated).
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.right = "0";
  host.style.height = "100vh";
  host.style.zIndex = "2147483647";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${panelCss()}</style>
    <div class="panel" tabindex="-1">
      <div class="resize-handle"></div>
      <div class="header">
        <div class="agent-picker"><span class="status">Loading…</span></div>
        <button class="close" aria-label="Close Cleavr panel">×</button>
      </div>
      <div class="conn-banner" hidden></div>
      <div class="body">
        <div class="term-container"></div>
      </div>
    </div>
  `;

  const panel = shadow.querySelector<HTMLDivElement>(".panel")!;
  const closeButton = shadow.querySelector<HTMLButtonElement>(".close")!;
  const resizeHandle = shadow.querySelector<HTMLDivElement>(".resize-handle")!;
  const agentPicker = shadow.querySelector<HTMLDivElement>(".agent-picker")!;
  const connBanner = shadow.querySelector<HTMLDivElement>(".conn-banner")!;
  const termContainer = shadow.querySelector<HTMLDivElement>(".term-container")!;

  let isOpen = false;
  let currentResource: ButchrResource | null = null;
  let hasFetched = false;
  let currentAgentKey: string | null = null;
  let connState: ConnState = { kind: "idle" };

  const terminal = new PanelTerminal(termContainer, (text) => {
    port.postMessage({ type: "input", text });
  });

  let port = chrome.runtime.connect({ name: "cleavr:pty" });
  wirePort(port);

  function wirePort(p: chrome.runtime.Port): void {
    p.onMessage.addListener((message: BackgroundToPanelMessage) => {
      if (message.type === "frame") {
        terminal.writeFrame(message.text);
        return;
      }
      if (message.type === "state") {
        connState = message.state;
        renderConnBanner();
      }
    });
    p.onDisconnect.addListener(() => {
      // The service worker most likely went idle and was evicted — MV3's
      // ports do not auto-reconnect. Re-establish a fresh one; the
      // background's own reconnect/backoff state survives this (see
      // src/background/pty-manager.ts and src/background/index.ts), so this
      // is just re-attaching the UI's own pipe, not restarting a session.
      port = chrome.runtime.connect({ name: "cleavr:pty" });
      wirePort(port);
      if (currentAgentKey) port.postMessage({ type: "attach", agentKey: currentAgentKey });
    });
  }

  function renderConnBanner(): void {
    const info = connectionBannerInfo(connState);
    if (!info) {
      connBanner.hidden = true;
      connBanner.innerHTML = "";
      return;
    }
    connBanner.hidden = false;
    connBanner.innerHTML = "";
    connBanner.className = `conn-banner conn-${info.tone}`;
    const text = document.createElement("span");
    text.textContent = info.message;
    connBanner.appendChild(text);
    if (info.showReconnect) {
      const button = document.createElement("button");
      button.className = "reconnect";
      button.textContent = "Reconnect";
      button.addEventListener("click", () => port.postMessage({ type: "manual-reconnect" }));
      connBanner.appendChild(button);
    }
  }

  void getPanelWidth(DEFAULT_WIDTH).then((width) => {
    panel.style.width = `${clampWidth(width)}px`;
  });

  function open(): void {
    isOpen = true;
    panel.classList.add("open");
    panel.focus();
    fitAndSend();
    if (!hasFetched) {
      hasFetched = true;
      void loadResources();
    }
  }

  function close(): void {
    isOpen = false;
    panel.classList.remove("open");
  }

  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  function attachAgent(agentKey: string): void {
    if (currentAgentKey === agentKey) return;
    currentAgentKey = agentKey;
    terminal.clear();
    port.postMessage({ type: "attach", agentKey });
  }

  function detachAgent(): void {
    if (currentAgentKey === null) return;
    currentAgentKey = null;
    port.postMessage({ type: "detach" });
    connState = { kind: "idle" };
    renderConnBanner();
  }

  async function loadResources(): Promise<void> {
    renderLoading();
    const result = await sendMessage({ type: "cleavr:fetch-resources", pageUrl: location.href });
    if (result.kind === "failure") {
      renderFailure(result.failure);
      return;
    }
    await renderResourceState(result.state);
  }

  function renderLoading(): void {
    agentPicker.innerHTML = `<span class="status">Loading…</span>`;
  }

  function renderFailure(failure: Failure): void {
    detachAgent();
    const message = failureMessage(failure);
    agentPicker.innerHTML = `<span class="status status-error">${escapeHtml(message)}</span>`;
  }

  async function renderResourceState(state: ResourceState): Promise<void> {
    if (state.kind === "no-resource") {
      currentResource = null;
      detachAgent();
      agentPicker.innerHTML = `<span class="status">This page isn't a Butchr resource.</span>`;
      return;
    }

    currentResource = state.resource;

    if (state.kind === "no-agents") {
      detachAgent();
      agentPicker.innerHTML = `<span class="status">Butchr knows this resource but has no agent running on it.</span>`;
      return;
    }

    if (state.kind === "single-agent") {
      agentPicker.innerHTML = `<span class="agent-label">${escapeHtml(state.agent.label)}</span>`;
      attachAgent(state.agent.agentKey);
      return;
    }

    // multi-agent: dropdown in returned order, remembering the last choice.
    const lastChoice = await getAgentChoice(state.resource);
    const selected = state.agents.find((a) => a.agentKey === lastChoice) ?? (state.agents[0] as ButchrAgent);
    agentPicker.innerHTML = "";
    const select = document.createElement("select");
    select.className = "agent-select";
    for (const agent of state.agents) {
      // Built with the DOM API rather than an HTML template string: agentKey
      // is attacker-influenceable (it originates from the daemon, which the
      // adapter accepts as an arbitrary string), and a template string
      // interpolated into a quoted attribute is an injection sink even with
      // an escaper, since escaping text-node content does not escape quotes.
      // Setting properties directly has no such sink.
      const option = document.createElement("option");
      option.value = agent.agentKey;
      option.textContent = agent.label;
      option.selected = agent.agentKey === selected.agentKey;
      select.appendChild(option);
    }
    agentPicker.appendChild(select);
    attachAgent(selected.agentKey);
    select.addEventListener("change", () => {
      if (currentResource) void setAgentChoice(currentResource, select.value);
      attachAgent(select.value);
    });
  }

  closeButton.addEventListener("click", close);

  // Keystrokes inside the panel must never reach the host page's own
  // shortcut handlers (Jira/GitHub bind single letters on keydown, keypress,
  // AND keyup) — see src/content/keyboard-isolation.ts for the full
  // reasoning and its own unit tests. Escape is included: it now reaches the
  // terminal (an agent may bind it) and can no longer close the panel — the
  // "×" button (and the toolbar icon, which toggles the panel) are the only
  // ways to close it now. See README's "Keyboard" section.
  installKeyboardIsolation(host);

  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragging = false;

  resizeHandle.addEventListener("mousedown", (event) => {
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = panel.getBoundingClientRect().width;
    event.preventDefault();
  });

  document.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    const delta = dragStartX - event.clientX;
    const width = clampWidth(dragStartWidth + delta);
    panel.style.width = `${width}px`;
    fitAndSend();
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    const width = clampWidth(panel.getBoundingClientRect().width);
    void setPanelWidth(width);
  });

  // Fit the terminal to the panel on any size change, including a page
  // resize (the panel's own height tracks 100vh). May send a resize control
  // frame (harmless — see docs/pty-attach.md) but nothing may ever depend on
  // it reaching the agent, because it currently cannot.
  const resizeObserver = new ResizeObserver(() => fitAndSend());
  resizeObserver.observe(panel);

  function fitAndSend(): void {
    if (!isOpen) return;
    const { cols, rows } = terminal.fit();
    port.postMessage({ type: "resize", cols, rows });
  }

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === "cleavr:ping") {
      sendResponse(true);
      return;
    }
    if (message.type === "cleavr:toggle") {
      toggle();
      sendResponse(true);
    }
    return undefined;
  });
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

export function failureMessage(failure: Failure): string {
  switch (failure.kind) {
    case "unauthorized":
      // Butchr no longer has a configurable Origin allowlist (FACTORY-475/
      // FACTORY-497 hardcoded the single extension origin) — a rejection
      // here almost always means this extension's id doesn't match what the
      // daemon expects (a stale build reloaded under a new id), not a
      // setting to go tweak.
      return `Butchr rejected the request (${failure.status}). This extension's id may not match what the daemon expects — try reloading the extension.`;
    case "storage-unreadable":
      return `Couldn't read this extension's own settings (${failure.detail}). Try reloading the extension.`;
    case "extension-error":
      return `Couldn't complete the request (${failure.detail}). Try reloading the page or the extension.`;
    case "unreachable":
    default:
      return `Couldn't reach the Butchr daemon (${failure.detail ?? "unknown error"}). Check the port on the options page.`;
  }
}

interface BannerInfo {
  message: string;
  tone: "info" | "error" | "warn";
  showReconnect: boolean;
}

// The only place that turns a ConnState into user-facing copy — kept as a
// pure function of the state so it's easy to audit that every state in
// src/lib/pty/state.ts has a distinct, honest message (the ticket's core
// ask for item 2). FACTORY-504 REMOVED the "not-found" and "rejected" cases
// that used to live here (see src/lib/pty/state.ts's own header for why —
// both were fed only by probeHttp's plain-HTTP classification of a failed
// WS upgrade, which cannot legitimately earn either diagnosis against
// `/agents/:agentKey/pty`'s actual routing) — a failed connection now
// always surfaces as "daemon-unreachable"/"reconnecting"/"retry-exhausted"
// below, honest about what the client can actually tell.
export function connectionBannerInfo(state: ConnState): BannerInfo | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "connecting":
      return { message: "Connecting…", tone: "info", showReconnect: false };
    case "attached":
      return null;
    case "pane-gone":
      return {
        message: "This agent's pane is no longer live (it stopped, or was restarted under this agent key).",
        tone: "warn",
        showReconnect: false,
      };
    case "daemon-unreachable":
      return { message: "Can't reach the Butchr daemon — retrying…", tone: "warn", showReconnect: false };
    case "unexpected-drop":
      return { message: "Connection dropped unexpectedly — reconnecting…", tone: "warn", showReconnect: false };
    case "reconnecting":
      return { message: `Reconnecting (attempt ${state.attempt})…`, tone: "warn", showReconnect: false };
    case "retry-exhausted":
      return { message: "Gave up reconnecting after repeated failures.", tone: "error", showReconnect: true };
  }
}

// FACTORY-530: chrome.runtime.sendMessage itself can reject (the background
// service worker went idle/was evicted mid-request, the extension context
// was invalidated by a reload, "Receiving end does not exist", etc.) —
// a generic version of the bug this ticket fixes, one level up from
// fetchResources' own storage-read failure. Without this catch, loadResources
// would still hang on "Loading…" forever on a bare sendMessage rejection even
// after fetchResources itself is made to always resolve, so this is a
// deliberate defense-in-depth choice: degrade to a typed failure here too,
// rather than leaving the panel to assume the channel always answers.
// Exported (alongside failureMessage/connectionBannerInfo above) so
// tests/content/panel-messages.test.ts can exercise the rejection path
// directly, without standing up the full init()/PanelTerminal machinery.
export async function sendMessage(message: RuntimeMessage): Promise<FetchResourcesResult> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return {
      kind: "failure",
      failure: { kind: "extension-error", detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function panelCss(): string {
  return `
    :host { all: initial; }
    .panel {
      box-sizing: border-box;
      position: fixed;
      top: 0;
      right: 0;
      height: 100vh;
      background: #1e1f24;
      color: #f2f2f3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      display: flex;
      flex-direction: column;
      box-shadow: -2px 0 12px rgba(0, 0, 0, 0.35);
      transform: translateX(100%);
      transition: transform 0.22s ease;
      outline: none;
    }
    .panel.open { transform: translateX(0); }
    .resize-handle {
      position: absolute;
      left: -3px;
      top: 0;
      width: 6px;
      height: 100%;
      cursor: ew-resize;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      flex: 0 0 auto;
    }
    .agent-picker { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-error { color: #ff8a8a; }
    .agent-select { width: 100%; }
    .close {
      background: transparent;
      border: none;
      color: inherit;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
      margin-left: 8px;
    }
    .close:hover { opacity: 0.7; }
    .conn-banner {
      flex: 0 0 auto;
      padding: 6px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .conn-info { background: rgba(255, 255, 255, 0.06); color: rgba(242, 242, 243, 0.85); }
    .conn-warn { background: rgba(255, 196, 0, 0.15); color: #ffdb70; }
    .conn-error { background: rgba(255, 80, 80, 0.15); color: #ff8a8a; }
    .reconnect {
      background: transparent;
      border: 1px solid currentColor;
      color: inherit;
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .body { flex: 1 1 auto; overflow: hidden; display: flex; }
    .term-container { flex: 1 1 auto; overflow: hidden; padding: 4px; }
  `;
}

// Guard against double injection (e.g. a stale ping racing a fresh
// executeScript on the same tab).
if (!(window as unknown as { __cleavrInjected?: boolean }).__cleavrInjected) {
  (window as unknown as { __cleavrInjected?: boolean }).__cleavrInjected = true;
  init();
}

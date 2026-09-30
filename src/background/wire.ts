// The actual background wiring, factored out of index.ts. scripts/build-e2e.mjs
// reuses the same compiled background.js unmodified for headless smoke
// evidence against scripts/fake-pty-server.mjs (see that script's header).
import { getOptions } from "../lib/storage";
import { forUrlEndpoint, forUrlRequestInit } from "../lib/url";
import { parseForUrlResponse, MalformedResponseError } from "../lib/adapter";
import type { Failure } from "../lib/adapter";
import type { RuntimeMessage, FetchResourcesResult } from "../lib/messages";
import { PtyConnectionManager } from "./pty-manager";
import type { PtyOpener } from "../lib/pty/opener";
import type { PanelToBackgroundMessage } from "../lib/pty/messages";

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void toggleOnTab(tab.id);
});

async function toggleOnTab(tabId: number): Promise<void> {
  const alreadyInjected = await ping(tabId);
  if (!alreadyInjected) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
  await chrome.tabs.sendMessage(tabId, { type: "cleavr:toggle" });
}

async function ping(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "cleavr:ping" });
    return true;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "cleavr:fetch-resources") {
    // fetchResources itself never rejects (every failure mode it can reach
    // is caught below and turned into a typed FetchResourcesResult), but
    // this .catch is a second, independent backstop: whatever handles this
    // message must call sendResponse exactly once no matter what, including
    // a future failure mode neither of us has thought of yet — otherwise the
    // channel stays open and the panel hangs on "Loading…" again, which is
    // the exact defect this ticket exists to close off.
    fetchResources(message.pageUrl)
      .catch(
        (err): FetchResourcesResult => ({
          kind: "failure",
          failure: extensionErrorFailure(err),
        }),
      )
      .then(sendResponse);
    return true;
  }
  return undefined;
});

function storageUnreadableFailure(err: unknown): Failure {
  return { kind: "storage-unreadable", detail: err instanceof Error ? err.message : String(err) };
}

function extensionErrorFailure(err: unknown): Failure {
  return { kind: "extension-error", detail: err instanceof Error ? err.message : String(err) };
}

export async function fetchResources(pageUrl: string): Promise<FetchResourcesResult> {
  let options: Awaited<ReturnType<typeof getOptions>>;
  try {
    options = await getOptions();
  } catch (err) {
    // getOptions reads chrome.storage.local (via ensureMigrated and its own
    // lookup) and can reject — unlike every failure below, this means the
    // daemon was never even contacted, so it gets its own honest Failure
    // kind rather than being folded into "unreachable".
    return { kind: "failure", failure: storageUnreadableFailure(err) };
  }
  const requestUrl = forUrlEndpoint(options.port);

  let response: Response;
  try {
    response = await fetch(requestUrl, forUrlRequestInit(pageUrl));
  } catch (err) {
    return {
      kind: "failure",
      failure: { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) },
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "failure", failure: { kind: "unauthorized", status: response.status } };
  }
  if (!response.ok) {
    return { kind: "failure", failure: { kind: "unreachable", detail: `HTTP ${response.status}` } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: "failure", failure: { kind: "unreachable", detail: "response was not valid JSON" } };
  }

  try {
    const state = parseForUrlResponse(json);
    return { kind: "success", state };
  } catch (err) {
    const detail = err instanceof MalformedResponseError ? err.message : "malformed response";
    return { kind: "failure", failure: { kind: "unreachable", detail } };
  }
}

// ---------------------------------------------------------------------------
// PTY connection wiring (FACTORY-456). One PtyConnectionManager per tab, kept
// alive in this map only as long as the worker itself is alive — see
// src/background/pty-manager.ts's header on why the reconnect backoff itself
// does not depend on this map surviving a worker restart.
// ---------------------------------------------------------------------------

// FACTORY-504: `url` is the PTY WebSocket endpoint
// (ptyWebSocketUrl(...).replace(/^ws/, "http")), and this deliberately stays
// a bare `fetch(url)` GET, not an Origin-stamped POST like
// `forUrlRequestInit` — unlike `/resources/for-url`, `/agents/:agentKey/pty`
// has no plain-HTTP handler at all (see src/web/view.ts in the butchr repo:
// it's a `.ws(...)` route with no sibling `.get`/`.post`), and butchr's
// router only matches a `.ws()` route when the request carries
// `Upgrade: websocket` — a header no `fetch()` call can ever send, from any
// method or context (forbidden header name, enforced by the Fetch spec
// everywhere, not just extensions; measured directly against butchr's own
// real, unmodified guard/route code, both GET and POST, with and without a
// forged Origin header — see FACTORY-504's Jira comments for the full
// measurement). So a plain fetch here can NEVER reach `checkExtensionOrigin`
// OR the pane-resolution logic behind it — it 404s UNCONDITIONALLY,
// regardless of Origin, method, or whether the agent key names a real pane.
// That means this probe can never legitimately observe EITHER an origin
// rejection (401/403) OR a genuine "no such agent" (404): it has nothing to
// earn either diagnosis from, and its own request getting 404 is not
// evidence about the daemon's real state at all. The previous code
// (`if (status===403) return "rejected-403"`, `if (status===404) return
// "not-found"`) claimed both anyway — the false "rejected-403" this ticket
// exists to remove, PLUS an equally false "not-found" the same investigation
// (FACTORY-504's Jira comments) surfaced once "make it Origin-stamped
// instead" turned out to be impossible for this route. Every response this
// probe can observe now falls into "inconclusive": honest about what a
// plain-HTTP probe of a WebSocket-only route can and cannot tell you.
// `unreachable` still means what it always did — a network-level failure
// (the daemon isn't listening at all), which IS something this probe can
// legitimately tell apart from "got SOME response". Exported so it can be
// exercised directly against a mocked `fetch` (tests/wire.test.ts) without
// standing up the whole chrome.runtime.onConnect wiring below.
export async function probeHttp(url: string): Promise<"unreachable" | "inconclusive"> {
  try {
    await fetch(url);
    return "inconclusive";
  } catch {
    return "unreachable";
  }
}

export function wirePtyConnections(opener: PtyOpener): void {
  const managers = new Map<number, PtyConnectionManager>();

  function retryStorageKey(tabId: number): string {
    return `cleavr:pty-retry-state:${tabId}`;
  }

  async function persistRetrySnapshot(
    tabId: number,
    state: { kind: string; agentKey?: string; attempt?: number },
  ): Promise<void> {
    const key = retryStorageKey(tabId);
    if (state.kind === "reconnecting" && typeof state.agentKey === "string" && typeof state.attempt === "number") {
      await chrome.storage.session.set({ [key]: { agentKey: state.agentKey, attempt: state.attempt } });
    } else {
      await chrome.storage.session.remove(key);
    }
  }

  // One port per tab (the panel opens it on attach); looked up by tabId
  // rather than closed over directly, since multiple tabs can each have
  // their own panel/manager live at once and each manager's `post` callback
  // must reach only its OWN tab's port.
  const ports = new Map<number, chrome.runtime.Port>();

  function getOrCreateManager(tabId: number): PtyConnectionManager {
    let manager = managers.get(tabId);
    if (!manager) {
      manager = new PtyConnectionManager(
        {
          opener,
          getOptions,
          post: (message) => {
            void persistRetrySnapshot(tabId, message.type === "state" ? message.state : { kind: "" });
            try {
              ports.get(tabId)?.postMessage(message);
            } catch {
              // Port's tab navigated away or closed between dispatch and
              // post; nothing to deliver to.
            }
          },
          scheduleAlarm: (name, delayMs) => {
            chrome.alarms.create(name, { when: Date.now() + delayMs });
          },
          clearAlarm: (name) => {
            void chrome.alarms.clear(name);
          },
          probeHttp,
        },
        tabId,
      );
      managers.set(tabId, manager);
    }
    return manager;
  }

  chrome.runtime.onConnect.addListener((connectedPort) => {
    if (connectedPort.name !== "cleavr:pty") return;
    const tabId = connectedPort.sender?.tab?.id;
    if (tabId === undefined) return;
    ports.set(tabId, connectedPort);
    const manager = getOrCreateManager(tabId);
    connectedPort.postMessage({ type: "state", state: manager.getState() });

    connectedPort.onMessage.addListener((message: PanelToBackgroundMessage) => {
      void manager.handle(message);
    });
    connectedPort.onDisconnect.addListener(() => {
      void manager.handle({ type: "detach" });
      managers.delete(tabId);
      ports.delete(tabId);
    });
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    const match = /^cleavr:pty-retry:(\d+)$/.exec(alarm.name);
    if (!match) return;
    const tabId = Number(match[1]);
    let manager = managers.get(tabId);
    if (!manager) {
      // The worker was evicted and restarted between scheduling this alarm
      // and it firing — rehydrate just enough state from
      // chrome.storage.session to resume the same backoff sequence (see
      // PtyConnectionManager.rehydrateForRetry).
      void (async () => {
        const key = retryStorageKey(tabId);
        const stored = (await chrome.storage.session.get(key))[key] as
          | { agentKey: string; attempt: number }
          | undefined;
        if (!stored) return;
        manager = getOrCreateManager(tabId);
        manager.rehydrateForRetry(stored.agentKey, stored.attempt);
        manager.onAlarmFired();
      })();
      return;
    }
    manager.onAlarmFired();
  });
}

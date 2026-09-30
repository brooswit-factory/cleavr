// FACTORY-530: THE DEFECT. fetchResources began with
// `const options = await getOptions();` outside any try, so a rejecting
// chrome.storage.local read (getOptions reads it via ensureMigrated) meant
// fetchResources itself rejected, sendResponse was never called, and the
// onMessage channel stayed open — the panel's loadResources has no .catch,
// so it stayed on renderLoading()'s "Loading…" forever. Run against the
// pre-fix code, both tests below fail: the first because fetchResources
// rejects instead of resolving to a typed failure, the second because
// sendResponse is never invoked at all.
//
// This file (not tests/wire.test.ts) sets up its own module-scope chrome
// stub — one whose runtime.onMessage.addListener actually CAPTURES the
// listener wire.ts registers at import time, and whose storage.local.get
// rejects unconditionally — so it must run in its own module registry, not
// share wire.ts's already-imported instance from another test file. Vitest
// isolates test files into separate module registries by default, so a
// fresh top-level `chrome` assigned before importing "../src/background/wire"
// here is safe and does not leak into/from tests/wire.test.ts.
import { describe, expect, it, vi } from "vitest";

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

let capturedListener: Listener | undefined;

(globalThis as unknown as { chrome: unknown }).chrome = {
  action: { onClicked: { addListener: () => {} } },
  runtime: {
    onMessage: {
      addListener: (fn: Listener) => {
        capturedListener = fn;
      },
    },
  },
  storage: {
    local: {
      get: () => Promise.reject(new Error("storage unavailable")),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  },
};

const { fetchResources } = await import("../src/background/wire");

describe("fetchResources — storage read failure (FACTORY-530 item 1)", () => {
  it("resolves to a typed storage-unreadable failure instead of rejecting, when getOptions rejects", async () => {
    await expect(fetchResources("https://example.com")).resolves.toEqual({
      kind: "failure",
      failure: { kind: "storage-unreadable", detail: "storage unavailable" },
    });
  });
});

describe("onMessage listener — always calls sendResponse (FACTORY-530 item 1)", () => {
  it("calls sendResponse exactly once with a failure result, never leaving the channel open", async () => {
    expect(capturedListener).toBeDefined();
    const sendResponse = vi.fn();
    const keepChannelOpen = capturedListener!(
      { type: "cleavr:fetch-resources", pageUrl: "https://example.com" },
      {},
      sendResponse,
    );
    // Returning true is what tells chrome.runtime this listener will call
    // sendResponse asynchronously — losing this return would reopen the
    // exact hang this ticket fixes, even with every failure path handled.
    expect(keepChannelOpen).toBe(true);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({
      kind: "failure",
      failure: { kind: "storage-unreadable", detail: "storage unavailable" },
    });
  });
});

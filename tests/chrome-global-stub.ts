// A minimal chrome global, just enough for src/background/wire.ts's
// MODULE-SCOPE side effects (chrome.action.onClicked.addListener,
// chrome.runtime.onMessage.addListener) not to throw on import. Must be
// imported BEFORE wire.ts — ES module imports evaluate in declaration
// order for a non-circular graph, so `import "./chrome-global-stub"` ahead
// of `import ... from "../src/background/wire"` runs this file's top-level
// assignment first, unlike a `beforeEach` (which would run too late: wire.ts's
// own top-level code already ran once, at import time, before any test hook).
(globalThis as unknown as { chrome: unknown }).chrome = {
  action: { onClicked: { addListener: () => {} } },
  runtime: { onMessage: { addListener: () => {} } },
};

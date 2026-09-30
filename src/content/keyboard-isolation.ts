// Stops keystrokes typed inside the panel from bubbling out to the host
// page's own shortcut handlers (Jira/GitHub bind bare letters on
// document/window). Extracted from panel.ts so it's unit-testable with a
// plain DOM fixture, independent of chrome.* APIs — see
// tests/content/keyboard-isolation.test.ts.
//
// ALL THREE key event types, not just keydown: a host page can bind its
// shortcut on keydown, keypress, OR keyup (Jira/GitHub use different ones in
// different places), so stopping only one still lets a shortcut fire on
// another. This was FACTORY-456's original mistake — caught in review — and
// is exactly why this module exists as its own tested unit rather than an
// inline listener easy to under-cover again.
//
// stopPropagation() runs on the HOST element during the BUBBLE phase, after
// any shadow-internal handling (including xterm.js's own) has already run —
// so the terminal still receives every key; only the host page's listeners
// (attached further up the real DOM, outside the shadow tree) are cut off.
//
// INHERENT LIMITATION (documented, not fixed here): a host page that
// registers its shortcut handler in the CAPTURE phase on `document` still
// sees the key, because capture runs ancestor-first and nothing at the
// shadow host can prevent it — this is how the DOM's capture phase works,
// not a defect here (the same fact is documented from the transport side in
// docs/pty-attach.md, butchr repo).
export const ISOLATED_KEY_EVENT_TYPES = ["keydown", "keypress", "keyup"] as const;

export function installKeyboardIsolation(host: EventTarget): void {
  for (const type of ISOLATED_KEY_EVENT_TYPES) {
    host.addEventListener(type, (event) => {
      event.stopPropagation();
    });
  }
}

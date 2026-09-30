// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { installKeyboardIsolation, ISOLATED_KEY_EVENT_TYPES } from "../../src/content/keyboard-isolation";

// Mirrors the panel's real DOM shape closely enough to test the isolation
// boundary itself: a host element (installKeyboardIsolation attaches here,
// exactly as panel.ts does), a shadow root, and an inner focusable element
// standing in for xterm.js's own input-receiving element (its hidden
// textarea, in the real panel).
function buildFixture() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const innerInput = document.createElement("input");
  shadow.appendChild(innerInput);
  installKeyboardIsolation(host);
  return { host, innerInput };
}

// The exact keys the ticket calls out by name.
const CASES: { label: string; init: KeyboardEventInit }[] = [
  { label: "Ctrl-C", init: { key: "c", code: "KeyC", ctrlKey: true } },
  { label: "Ctrl-D", init: { key: "d", code: "KeyD", ctrlKey: true } },
  { label: "Tab", init: { key: "Tab", code: "Tab" } },
  { label: "ArrowUp", init: { key: "ArrowUp", code: "ArrowUp" } },
  { label: "ArrowDown", init: { key: "ArrowDown", code: "ArrowDown" } },
  { label: "ArrowLeft", init: { key: "ArrowLeft", code: "ArrowLeft" } },
  { label: "ArrowRight", init: { key: "ArrowRight", code: "ArrowRight" } },
  { label: "Escape", init: { key: "Escape", code: "Escape" } },
];

describe("installKeyboardIsolation", () => {
  let documentLeakListener: (event: Event) => void;
  let leaked: string[];

  beforeEach(() => {
    document.body.innerHTML = "";
    leaked = [];
    documentLeakListener = (event) => leaked.push(event.type);
    for (const type of ISOLATED_KEY_EVENT_TYPES) {
      document.addEventListener(type, documentLeakListener);
    }
  });

  for (const type of ISOLATED_KEY_EVENT_TYPES) {
    describe(`event type: ${type}`, () => {
      for (const { label, init } of CASES) {
        it(`${label}: reaches the terminal's input element but never bubbles past the panel host`, () => {
          const { innerInput } = buildFixture();
          let reachedInner = false;
          innerInput.addEventListener(type, () => {
            reachedInner = true;
          });

          const event = new KeyboardEvent(type, { ...init, bubbles: true, composed: true, cancelable: true });
          innerInput.dispatchEvent(event);

          expect(reachedInner).toBe(true);
          expect(leaked).toEqual([]);
        });
      }
    });
  }

  it("does not stop propagation for non-key events (sanity check the isolation is scoped to keyboard input)", () => {
    const { host } = buildFixture();
    let documentSawClick = false;
    document.addEventListener("click", () => {
      documentSawClick = true;
    });
    host.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(documentSawClick).toBe(true);
  });
});

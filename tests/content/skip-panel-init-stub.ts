// Sets the same double-injection guard panel.ts checks at its own module
// scope (`if (!window.__cleavrInjected) init()`), so importing panel.ts in a
// test — just to reach its exported pure helpers, failureMessage and
// connectionBannerInfo — doesn't also run init() and build a real
// PanelTerminal/xterm instance, which needs more of a real browser than
// jsdom provides (matchMedia, canvas). Must be imported BEFORE panel.ts —
// see tests/chrome-global-stub.ts's own header for why import order (not
// textual statement order within one file) is what guarantees this runs
// first.
(window as unknown as { __cleavrInjected?: boolean }).__cleavrInjected = true;

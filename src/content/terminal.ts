// Thin wrapper around xterm.js + the fit addon, scoped to the panel's shadow
// root (FACTORY-456). Bundled into the extension (esbuild) — MV3 forbids
// remote script, so there is no CDN reference anywhere, here or in
// manifest.json.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
// esbuild's text loader (see build.mjs) turns this into the stylesheet's
// text content, so it ships inside the bundle and is injected as a <style>
// tag inside the shadow root below — xterm's CSS never leaks out of, and
// the host page's CSS never leaks into, the panel (same isolation the rest
// of the panel already relies on).
import xtermCss from "@xterm/xterm/css/xterm.css";

export class PanelTerminal {
  private readonly term: Terminal;
  private readonly fitAddon: FitAddon;

  constructor(
    private readonly container: HTMLElement,
    private readonly onData: (text: string) => void,
  ) {
    const style = document.createElement("style");
    style.textContent = xtermCss;
    container.appendChild(style);

    this.term = new Terminal({
      convertEol: false,
      scrollback: 1000,
      // Panel width does not change the AGENT's terminal size (see
      // src/lib/pty/state.ts / README — resize cannot be wired through to
      // the daemon). What xterm fits to is only how much of the snapshot the
      // panel can show at once; a snapshot wider than the fitted terminal is
      // left for xterm's own scrollback/clip behaviour, never re-flowed.
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.term.onData((text) => this.onData(text));
  }

  /** Full-screen redraw write — see src/lib/pty/redraw.ts for why every frame is written this way, never appended. */
  writeFrame(text: string): void {
    this.term.write(text);
  }

  clear(): void {
    this.term.reset();
  }

  fit(): { cols: number; rows: number } {
    this.fitAddon.fit();
    return { cols: this.term.cols, rows: this.term.rows };
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    this.term.dispose();
  }
}

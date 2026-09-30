import { describe, it, expect, afterEach } from "vitest";
import { Terminal } from "@xterm/headless";
import { toRedrawSequence } from "../../src/lib/pty/redraw";

// Renders through a REAL (headless) xterm.js terminal, not a string
// comparison of our own escape sequence — the thing that actually matters is
// what ends up in the terminal's buffer after writing two successive
// snapshots, since that's the failure mode the ticket calls out explicitly:
// "two successive snapshots must not accumulate".
function bufferLines(term: Terminal): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines;
}

describe("toRedrawSequence + xterm.js (headless)", () => {
  let term: Terminal | undefined;

  afterEach(() => {
    term?.dispose();
    term = undefined;
  });

  it("writing a naive (non-redraw) frame twice accumulates — the bug this exists to prevent", async () => {
    term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await writeAndSettle(term, "first snapshot");
    await writeAndSettle(term, "second snapshot");
    // Joined with no separator: a 20-col terminal wraps mid-word, so this
    // checks for accumulated CONTENT, not a literal unwrapped phrase.
    const lines = bufferLines(term).join("");
    // Naive appending leaves BOTH snapshots' distinguishing words visible.
    expect(lines).toContain("first");
    expect(lines).toContain("second");
  });

  it("writing each frame through toRedrawSequence does not accumulate: only the latest snapshot is visible", async () => {
    term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await writeAndSettle(term, toRedrawSequence("first snapshot"));
    await writeAndSettle(term, toRedrawSequence("second snapshot"));
    const lines = bufferLines(term).join("\n");
    expect(lines).not.toContain("first snapshot");
    expect(lines).toContain("second snapshot");
  });

  it("an identical repeated snapshot still renders correctly (idempotent redraw)", async () => {
    term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await writeAndSettle(term, toRedrawSequence("same"));
    await writeAndSettle(term, toRedrawSequence("same"));
    const lines = bufferLines(term).join("\n");
    expect(lines).toContain("same");
  });

  it("preserves ANSI (e.g. a color escape) through the redraw wrapper", async () => {
    term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    const colored = "\x1b[31mred-text\x1b[0m";
    await writeAndSettle(term, toRedrawSequence(colored));
    const buf = term.buffer.active;
    const line = buf.getLine(0);
    const cell = line?.getCell(0);
    // Red (SGR 31) is ANSI color index 1.
    expect(cell?.getFgColor()).toBe(1);
  });
});

function writeAndSettle(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

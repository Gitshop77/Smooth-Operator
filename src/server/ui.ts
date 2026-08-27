/** Zero-dependency terminal styling for the installer. Every helper degrades
 * to plain text on non-TTY streams, NO_COLOR, or dumb terminals so piped and
 * CI output stays machine-readable. */

type Writable = NodeJS.WritableStream & { isTTY?: boolean };

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAX_TERMINAL_TEXT_CHARS = 4_096;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u001B]/g;

export type Ui = ReturnType<typeof createUi>;

function colorEnabled(stdout: Writable | undefined): boolean {
  if (!stdout?.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  const term = process.env.TERM ?? "";
  return term !== "dumb";
}

/** Keep installer output single-line and terminal-safe even when it contains
 * paths, detected executable labels, or other values that came from a user or
 * the local filesystem. */
function sanitizeTerminalText(value: string): string {
  return value
    .replace(TERMINAL_CONTROL_PATTERN, "")
    .replace(/[\r\n]/g, " ")
    .slice(0, MAX_TERMINAL_TEXT_CHARS);
}

export function createUi(stdout?: Writable) {
  const enabled = colorEnabled(stdout);
  const write = typeof stdout?.write === "function"
    ? stdout.write.bind(stdout)
    : (() => true);
  const paint = (code: string, text: string): string => {
    const safeText = sanitizeTerminalText(text);
    return enabled ? `${code}${safeText}${RESET}` : safeText;
  };

  return {
    colors: enabled,
    bold: (text: string): string => paint(BOLD, text),
    dim: (text: string): string => paint(DIM, text),
    cyan: (text: string): string => paint(CYAN, text),
    green: (text: string): string => paint(GREEN, text),
    yellow: (text: string): string => paint(YELLOW, text),
    red: (text: string): string => paint(RED, text),

    /** Application banner shown once at the top of the wizard. */
    banner(name: string, tagline: string, version = ""): void {
      const safeName = sanitizeTerminalText(name);
      const safeTagline = sanitizeTerminalText(tagline);
      const safeVersion = sanitizeTerminalText(version);
      const line = "─".repeat(Math.max(safeName.length + safeTagline.length + 8, 44));
      write(`\n${paint(CYAN, line)}\n`);
      write(`  ${paint(BOLD, safeName)}${safeVersion ? ` ${paint(DIM, `v${safeVersion}`)}` : ""}\n`);
      write(`  ${paint(CYAN, safeTagline)}\n`);
      write(`${paint(CYAN, line)}\n\n`);
    },

    /** Numbered step header, e.g. "── [2/6] Headless mode ──". */
    step(current: number, total: number, title: string): void {
      write(`\n${paint(BOLD, `[${current}/${total}] ${sanitizeTerminalText(title)}`)}\n`);
    },

    /** Indented explanatory paragraph under a question. */
    explain(lines: readonly string[]): void {
      for (const line of lines) {
        write(`  ${paint(DIM, sanitizeTerminalText(line))}\n`);
      }
    },

    /** One option row in a numbered choice list. */
    option(index: number, label: string, description: string, recommended = false): void {
      const badge = recommended ? paint(GREEN, " (recommended)") : "";
      write(`  ${paint(CYAN, `${index})`)} ${paint(BOLD, sanitizeTerminalText(label))}${badge}\n`);
      write(`     ${paint(DIM, sanitizeTerminalText(description))}\n`);
    },

    keyValues(rows: ReadonlyArray<readonly [string, string]>): void {
      const safeRows = rows.map(([key, value]) => [sanitizeTerminalText(key), sanitizeTerminalText(value)] as const);
      const width = Math.max(...safeRows.map(([key]) => key.length));
      for (const [key, value] of safeRows) {
        write(`  ${paint(DIM, key.padEnd(width))}  ${value}\n`);
      }
    },

    success(text: string): void {
      write(`${paint(GREEN, "✔")} ${sanitizeTerminalText(text)}\n`);
    },

    failure(text: string): void {
      write(`${paint(RED, "✖")} ${sanitizeTerminalText(text)}\n`);
    },

    note(text: string): void {
      write(`  ${paint(YELLOW, "›")} ${paint(DIM, sanitizeTerminalText(text))}\n`);
    },
  };
}

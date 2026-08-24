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

export type Ui = ReturnType<typeof createUi>;

function colorEnabled(stdout: Writable | undefined): boolean {
  if (!stdout?.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  const term = process.env.TERM ?? "";
  return term !== "dumb";
}

export function createUi(stdout?: Writable) {
  const enabled = colorEnabled(stdout);
  const write = typeof stdout?.write === "function"
    ? stdout.write.bind(stdout)
    : (() => true);
  const paint = (code: string, text: string): string => (enabled ? `${code}${text}${RESET}` : text);

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
      const line = "─".repeat(Math.max(name.length + tagline.length + 8, 44));
      write(`\n${paint(CYAN, line)}\n`);
      write(`  ${paint(BOLD, name)}${version ? ` ${paint(DIM, `v${version}`)}` : ""}\n`);
      write(`  ${paint(CYAN, tagline)}\n`);
      write(`${paint(CYAN, line)}\n\n`);
    },

    /** Numbered step header, e.g. "── [2/6] Headless mode ──". */
    step(current: number, total: number, title: string): void {
      write(`\n${paint(BOLD, `[${current}/${total}] ${title}`)}\n`);
    },

    /** Indented explanatory paragraph under a question. */
    explain(lines: readonly string[]): void {
      for (const line of lines) {
        write(`  ${paint(DIM, line)}\n`);
      }
    },

    /** One option row in a numbered choice list. */
    option(index: number, label: string, description: string, recommended = false): void {
      const badge = recommended ? paint(GREEN, " (recommended)") : "";
      write(`  ${paint(CYAN, `${index})`)} ${paint(BOLD, label)}${badge}\n`);
      write(`     ${paint(DIM, description)}\n`);
    },

    keyValues(rows: ReadonlyArray<readonly [string, string]>): void {
      const width = Math.max(...rows.map(([key]) => key.length));
      for (const [key, value] of rows) {
        write(`  ${paint(DIM, key.padEnd(width))}  ${value}\n`);
      }
    },

    success(text: string): void {
      write(`${paint(GREEN, "✔")} ${text}\n`);
    },

    failure(text: string): void {
      write(`${paint(RED, "✖")} ${text}\n`);
    },

    note(text: string): void {
      write(`  ${paint(YELLOW, "›")} ${paint(DIM, text)}\n`);
    },
  };
}

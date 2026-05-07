// Tiny ANSI helpers and table formatter. No deps.

const isTTY = process.stdout.isTTY === true && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const cyan = wrap("36");
export const gray = wrap("90");

export const ok = (msg: string) => `${green("✓")} ${msg}`;
export const fail = (msg: string) => `${red("✗")} ${msg}`;
export const info = (msg: string) => `${cyan("›")} ${msg}`;
export const warn = (msg: string) => `${yellow("!")} ${msg}`;

export function table(rows: Array<Record<string, string>>, columns: string[]): string {
  if (rows.length === 0) return dim("(empty)");
  const widths: Record<string, number> = {};
  for (const c of columns) widths[c] = c.length;
  for (const r of rows) {
    for (const c of columns) {
      widths[c] = Math.max(widths[c], (r[c] ?? "").length);
    }
  }

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = (l: string, m: string, r: string, fill: string) =>
    l + columns.map((c) => fill.repeat(widths[c] + 2)).join(m) + r;

  const lines: string[] = [];
  lines.push(gray(sep("┌", "┬", "┐", "─")));
  lines.push(gray("│ ") + columns.map((c) => bold(pad(c, widths[c]))).join(gray(" │ ")) + gray(" │"));
  lines.push(gray(sep("├", "┼", "┤", "─")));
  for (const r of rows) {
    lines.push(gray("│ ") + columns.map((c) => pad(r[c] ?? "", widths[c])).join(gray(" │ ")) + gray(" │"));
  }
  lines.push(gray(sep("└", "┴", "┘", "─")));
  return lines.join("\n");
}

export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function ago(ms: number): string {
  if (ms < 1500) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

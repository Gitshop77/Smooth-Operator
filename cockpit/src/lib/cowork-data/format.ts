/** Format a timestamp as a short relative string ("3s", "12m", "4h", "2d"). */
export function timeAgo(ts: number | string | Date | null | undefined): string {
 // `0` (and `""`) is a sentinel for "no value" — without this
 // check, `timeAgo(0)` computes `Date.now() - 0` ≈ 1.7 trillion ms ≈
 // ~20000 days, rendering "20000d" in the UI. Treat 0 / "" like null.
  if (ts == null || ts === 0) return "—";
  const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms === 0) return "—";
  const diff = Date.now() - ms;
  if (diff < 1000) return "now";
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** Format a number of bytes as a human-readable size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log2(n) / 10)));
  return `${(n / (1024 ** i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Extract the hostname from a URL. Falls back to the raw string. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Defense-in-depth: return the URL only if it uses an http(s) scheme,
 * otherwise return `"#"`. The cockpit's POST endpoints (`/tabs`, `/bookmarks`)
 * validate URL scheme at insert time, but rows seeded directly into the DB
 * (e.g. by the extension's history sync, which has no POST endpoint) skip
 * validation. A `javascript:` URL rendered as `<a href>` would execute on
 * click. Pass every dynamic URL through this helper before binding to `href`.
 */
export function safeHref(url: string | null | undefined): string {
  if (!url || typeof url !== "string") return "#";
  const trimmed = url.trim();
  if (!trimmed) return "#";
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return "#";
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return trimmed;
    return "#";
  } catch {
    return "#";
  }
}

/** Truncate a long string in the middle. */
export function truncateMiddle(s: string, max = 64): string {
  if (max <= 2) return s.slice(0, Math.max(0, max));
  if (s.length <= max) return s;
  const keep = max - 1;
  const half = Math.max(1, Math.floor(keep / 2));
  return `${s.slice(0, half)}…${s.slice(-(keep - half))}`;
}

/**
 * Defensive parse of a Prisma JSON-encoded string column (or an already-decoded
 * array) into `T[]`. A malformed/empty row must never crash the view, so any
 * parse error, non-array, or empty/missing input yields `[]`. Shared by the
 * runs/session views so the defensive contract lives in exactly one place.
 */
export function safeParseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

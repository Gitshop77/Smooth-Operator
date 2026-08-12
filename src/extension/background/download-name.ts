/** Truncate without splitting a short trailing extension. */
export function truncateFilename(name: string, maxLen = 120): string {
  if (name.length <= maxLen) return name;
  const extMatch = name.match(/\.([a-z0-9]{1,5})$/i);
  if (!extMatch) return name.slice(0, maxLen);
  const ext = extMatch[0];
  const baseMax = maxLen - ext.length;
  if (baseMax <= 0) return ext.slice(0, maxLen);
  return name.slice(0, baseMax) + ext;
}

/** NTFS-reserved device names — `chrome.downloads` rejects these verbatim. */
const NTFS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Sanitize a resolved filename before passing it to chrome.downloads.
 *
 * The downloads API rejects names that are empty, all-dots, NTFS-reserved, or
 * that carry C0 control characters (`Invalid filename`), and leading dots are
 * interpreted as hidden-file markers on every platform. A total, graceful
 * sanitizer keeps the scheduled-task download path deterministic across
 * platforms: strip leading dots, trim trailing dots/spaces, drop C0 control
 * characters entirely, prefix NTFS-reserved names, and fall back to `"file"`
 * when nothing survives.
 */
export function sanitizeDownloadName(rawName: string): string {
  const cleaned = String(rawName)
    // Drop C0 control characters (NUL, DEL, …) entirely — the downloads API
    // rejects them and they corrupt shell/UI display.
    .replace(/[\x00-\x1f\x7f]/g, "")
    // Whitespace first, so a space-only name collapses to empty and interior
    // whitespace is never turned into a separator underscore later.
    .trim()
    // Leading dots (hidden files) come off before separator replacement so an
    // all-dot name collapses to empty and falls back to "file".
    .replace(/^\.+/, "")
    // Path separators and any other non-word/non-dot char → `_`.
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/\.{2,}/g, "_")
    // Trailing dots are stripped.
    .replace(/[.\s]+$/, "");
  if (cleaned === "") return "file";
  const base = NTFS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
  return truncateFilename(base, 120);
}

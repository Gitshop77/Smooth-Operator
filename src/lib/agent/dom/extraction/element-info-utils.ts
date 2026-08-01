// ─── Boolean attribute set ──────────────────────────────────────────────────

export const BOOLEAN_ATTRS: ReadonlySet<string> = new Set([
  "required", "checked", "selected", "disabled", "readonly",
  "multiple", "hidden", "autofocus", "formnovalidate",
]);

// ─── URL token redaction ─────────────────────────────────────────────────────

export function looksLikeSecretSegment(seg: string): boolean {
  if (seg.length < 12) return false;
  if (/[\s"'<>]/.test(seg)) return false;
  if (/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$/.test(seg) && /[0-9]/.test(seg) && seg.length <= 48) {
    return false;
  }
  const hasLower = /[a-z]/.test(seg);
  const hasUpper = /[A-Z]/.test(seg);
  const hasDigit = /[0-9]/.test(seg);
  const hasSpecial = /[^A-Za-z0-9]/.test(seg);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  if (classes === 1 && hasDigit && seg.length >= 24) return true;
  if (classes >= 2 && !hasSpecial && seg.length >= 12) return true;
  if (classes >= 3 && seg.length >= 12) return true;
  return false;
}

export function redactPathSecrets(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (looksLikeSecretSegment(seg) ? "[redacted]" : seg))
    .join("/");
}

// Hostname labels are rarely enough on their own to trip the character-class
// classifier: `secret-token` (lowercase + hyphen, 2 classes) looks identical
// to an ordinary hyphenated hostname by entropy, so a global rule would
// redact every `my-shop.example.com`. Only when the URL already carried
// userinfo (credentials are the stronger signal) is a hyphenated/underscored
// label treated as a token — the label then gets replaced, not leaked.
function isSecretHostLabel(lab: string, hadUserInfo: boolean): boolean {
  if (looksLikeSecretSegment(lab)) return true;
  return hadUserInfo && lab.length >= 12 && /[-_]/.test(lab);
}

export function redactUrlTokens(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "[non-http url redacted]";
    }
    const hadUserInfo = u.username !== "" || u.password !== "";
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    const labels = u.hostname.split(".");
    // The redacted marker must be a valid host label: "[" and "]" are
    // forbidden host code points, so assigning "[redacted]…" to `.hostname`
    // fails silently in the WHATWG parser and the raw secret label survives.
    const redactedHost = labels
      .map((lab) => (isSecretHostLabel(lab, hadUserInfo) ? "redacted" : lab))
      .join(".");
    u.hostname = redactedHost;
    u.pathname = redactPathSecrets(u.pathname);
    return u.toString();
  } catch {
    // Unparseable URL (relative/protocol-relative): strip any `user:pass@`
    // userinfo before path-segment redaction so credentials never survive.
    const hadUserInfo = /\/\/[^/]*@/.test(url);
    const stripped = url.replace(/\/\/[^/]*@/, "//").replace(/[?#].*$/, "");
    if (hadUserInfo) {
      return redactPathSecrets(
        stripped.replace(/^\/\/([^/]+)/, (_m, auth: string) =>
          "//" + auth
            .split(".")
            .map((lab) => (isSecretHostLabel(lab, true) ? "redacted" : lab))
            .join("."),
        ),
      );
    }
    return redactPathSecrets(stripped);
  }
}

// ─── Attribute helpers ───────────────────────────────────────────────────────

const MAX_ATTR_VALUE_LENGTH = 200;

export function capAttrValue(v: string): string {
  return v.length > MAX_ATTR_VALUE_LENGTH
    ? v.slice(0, MAX_ATTR_VALUE_LENGTH) + "..."
    : v;
}

export function implicitRole(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset") return "button";
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  return null;
}

// ─── Element hashing ─────────────────────────────────────────────────────────

export function fnv1aHash(s: string, offsetBasis: number, prime: number): string {
  let h: number = offsetBasis;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, prime);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

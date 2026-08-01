/**
 * IPv4 / IPv6 literal classification for the SSRF guard.
 */

// ─── IPv4 helpers ────────────────────────────────────────────────────────────

/** Parse a dotted-quad IPv4 string into 4 octets, or null if not a valid v4 literal. */
function parseIPv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** True iff `(a, b)` octets are in a genuine SSRF-sink IPv4 range. */
function isSsrfSinkIpv4(a: number, b: number): boolean {
  if (a === 0) return true;                              // 0.0.0.0/8 unspecified
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 CGNAT
  return false;
}

/** True iff `(a, b)` octets are in an RFC1918 private IPv4 range. */
function isRfc1918Ipv4(a: number, b: number): boolean {
  if (a === 10) return true;                             // RFC1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;      // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true;               // RFC1918 192.168.0.0/16
  return false;
}

export function isDangerousIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  return isSsrfSinkIpv4(a, b);
}

function isLocalIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 127) return true;
  return isRfc1918Ipv4(a, b);
}

// ─── IPv6 helpers ────────────────────────────────────────────────────────────

/**
 * Render the last two 16-bit IPv6 groups as a dotted-quad IPv4 string
 * (e.g. `0xa9fe`, `0xa9fe` → "169.254.169.254"), or return null if either
 * group is out of the 16-bit range.
 */
export function groupsToIpv4(g6: number, g7: number): string | null {
  if (g6 < 0 || g6 > 0xffff || g7 < 0 || g7 > 0xffff) return null;
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 literal
 * (`::ffff:<ipv4>` in either dotted or canonical-hex form). Returns the
 * dotted-quad IPv4 string, or `null` when the host is not a mapped form.
 */
function parseMappedIpv4(host: string): string | null {
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const g5 = parseInt(mappedHex[1], 16);
    const g6 = parseInt(mappedHex[2], 16);
    return `${(g5 >> 8) & 0xff}.${g5 & 0xff}.${(g6 >> 8) & 0xff}.${g6 & 0xff}`;
  }
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mappedDotted) return mappedDotted[1];
  return null;
}

/**
 * Expand an IPv6 literal into 8 unsigned-16-bit groups, handling `:`
 * compression. Returns null if the string is not a valid IPv6 literal.
 */
export function expandIPv6(host: string): number[] | null {
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
  if (!/^[0-9a-fA-F:]+$/.test(host)) return null;
  const doubleColon = host.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = host.split(":");
    tail = [];
    if (head.length !== 8) return null;
  } else {
    head = host.slice(0, doubleColon).split(":").filter((x) => x.length > 0);
    tail = host.slice(doubleColon + 2).split(":").filter((x) => x.length > 0);
    if (head.length + tail.length > 8) return null;
  }
  const groups: number[] = [];
  for (const g of head) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n > 0xffff) return null;
    groups.push(n);
  }
  if (doubleColon !== -1) {
    const missing = 8 - head.length - tail.length;
    for (let i = 0; i < missing; i++) groups.push(0);
  }
  for (const g of tail) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n > 0xffff) return null;
    groups.push(n);
  }
  if (groups.length !== 8) return null;
  return groups;
}

// ─── Composite classification ────────────────────────────────────────────────

/**
 * Returns true if `host` is an IP literal in a DANGEROUS SSRF-sink range.
 * Hostname-based URLs return false (no DNS resolution).
 */
export function isDangerousSinkIp(host: string): boolean {
  if (!host) return false;
  if (host.includes(":")) {
    return isDangerousIpv6(host);
  }
  return isDangerousIpv4(host);
}

function isLocalIpv6(host: string): boolean {
  const emb = parseMappedIpv4(host);
  if (emb !== null) return isLocalIpv4(emb);
  const groups = expandIPv6(host);
  if (!groups) return false;
  if (groups[4] === 0xffff && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
      groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    // RFC 4380 Teredo: the embedded IPv4 client address is XOR'd with
    // 0xFFFFFFFF (ones' complement). De-obfuscate before classification.
    const teredo = groupsToIpv4(groups[6] ^ 0xffff, groups[7] ^ 0xffff);
    if (teredo && isLocalIpv4(teredo)) return true;
  }
  if (groups[0] === 0x2002) {
    const embedded = groupsToIpv4(groups[1], groups[2]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  return false;
}

/**
 * IPv6-literal SSRF classification. Handles mapped / NAT64 / Teredo /
 * 6to4 / IPv4-compatible forms. Returns false for non-IPv6-literal hosts.
 */
export function isDangerousIpv6(host: string): boolean {
  const emb = parseMappedIpv4(host);
  if (emb !== null) return isDangerousIpv4(emb);
  const groups = expandIPv6(host);
  if (!groups) return false;
  if (groups[4] === 0xffff && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  if (groups.every((g) => g === 0)) return true;
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return false;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
      groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    // RFC 4380 Teredo: the embedded IPv4 client address is XOR'd with
    // 0xFFFFFFFF (ones' complement). De-obfuscate before classification.
    const teredo = groupsToIpv4(groups[6] ^ 0xffff, groups[7] ^ 0xffff);
    if (teredo && isDangerousIpv4(teredo)) return true;
  }
  if (groups[0] === 0x2002) {
    const embedded = groupsToIpv4(groups[1], groups[2]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  return false;
}

/**
 * True if `host` is an IP literal in a user-local range that the DEFAULT
 * policy ALLOWS (loopback, RFC1918, IPv6 ULA).
 */
export function isUserLocalIp(host: string): boolean {
  if (!host) return false;
  if (host.includes(":")) return isLocalIpv6(host);
  return isLocalIpv4(host);
}

/**
 * True if `host` is a hostname that always refers to the local machine
 * (`localhost` / `*.localhost`).
 */
export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

// ─── Webhook-specific classification ─────────────────────────────────────────

/** True if `host` is an IP literal (or hostname) that a webhook must NOT reach. */
export function isBlockedWebhookHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.endsWith(".lan") ||
    h.endsWith(".home") ||
    (!h.includes(".") && !h.includes(":"))
  ) {
    return true;
  }
  if (h.includes(":")) return isBlockedWebhookIpv6(host);
  return isBlockedWebhookIpv4(host);
}

function isBlockedWebhookIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  return isSsrfSinkIpv4(a, b) || isRfc1918Ipv4(a, b);
}

function isBlockedWebhookIpv6(host: string): boolean {
  const emb = parseMappedIpv4(host);
  if (emb !== null) return isBlockedWebhookIpv4(emb);
  const groups = expandIPv6(host);
  if (!groups) return false;
  if (groups[4] === 0xffff && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  if (groups.every((g) => g === 0)) return true;
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return false;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
      groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    // RFC 4380 Teredo: the embedded IPv4 client address is XOR'd with
    // 0xFFFFFFFF (ones' complement). De-obfuscate before classification.
    const teredo = groupsToIpv4(groups[6] ^ 0xffff, groups[7] ^ 0xffff);
    if (teredo && isBlockedWebhookIpv4(teredo)) return true;
  }
  if (groups[0] === 0x2002) {
    const embedded = groupsToIpv4(groups[1], groups[2]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  return false;
}

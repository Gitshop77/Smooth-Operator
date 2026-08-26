import { lstatSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { domainToASCII } from "node:url";

import type { ServerConfig } from "./config";
import { AppError } from "./errors";

function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/^\[|\]$/g, "").replace(/^\.+|\.+$/g, "");
  if (!trimmed) {
    return "";
  }
  // Canonicalize Unicode patterns to IDNA before suffix matching.
  if (isIP(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    const ascii = domainToASCII(trimmed);
    return ascii ? ascii.toLowerCase() : "";
  } catch {
    return "";
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "localhost" || normalized === "localhost.localdomain" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4(host);
  if (!parts) {
    return false;
  }
  const [first, second, third] = parts;
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = normalizeHost(host);
  const parsed = parseIpv6(normalized);
  if (!parsed) {
    return false;
  }
  const { parts, embeddedIpv4 } = parsed;
  const first = parts[0];
  // NAT64 (`64:ff9b::/96`) and Teredo (`2001:0000::/32`) embed an IPv4 host in
  // their low bits. Best-effort preflight hardening, not a firewall: route the
  // embedded host through the same private-IPv4 decision as mapped addresses.
  const nat64 = first === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every((part) => part === 0);
  const sixToFour = first === 0x2002;
  const sixToFourIpv4 = sixToFour
    ? [parts[1] >> 8, parts[1] & 255, parts[2] >> 8, parts[2] & 255].join(".")
    : undefined;
  const teredo = first === 0x2001 && parts[1] === 0x0000;
  const teredoIpv4 = teredo
    ? [
      ((parts[6] >> 8) ^ 0xff),
      ((parts[6] & 255) ^ 0xff),
      ((parts[7] >> 8) ^ 0xff),
      ((parts[7] & 255) ^ 0xff),
    ].join(".")
    : undefined;
  const mappedIpv4 = embeddedIpv4
    ?? (teredoIpv4
      ?? (sixToFourIpv4
        ?? (((parts.slice(0, 5).every((part) => part === 0) && (parts[5] === 0 || parts[5] === 0xffff)) || nat64)
      ? [parts[6] >> 8, parts[6] & 255, parts[7] >> 8, parts[7] & 255].join(".")
          : undefined)));
  return (mappedIpv4 !== undefined && isPrivateIpv4(mappedIpv4))
    || parts.every((part) => part === 0)
    || (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1)
    || (first >= 0xfc00 && first <= 0xfdff)
    || (first >= 0xfe80 && first <= 0xfeff)
    || (first >= 0xff00 && first <= 0xffff)
    || (first === 0x2001 && parts[1] === 0x0db8);
}

function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }
  const parsed = parts.map(Number);
  return parsed.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parsed as [number, number, number, number]
    : undefined;
}

function parseIpv6(host: string): { parts: number[]; embeddedIpv4?: string } | undefined {
  const sections = host.split("::");
  if (sections.length > 2) {
    return undefined;
  }
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections.length === 2 && sections[1] ? sections[1].split(":") : [];
  const parsedLeft = parseIpv6Side(left);
  const parsedRight = parseIpv6Side(right);
  if (!parsedLeft || !parsedRight || (parsedLeft.embeddedIpv4 && sections.length === 2) || (parsedLeft.embeddedIpv4 && parsedRight.embeddedIpv4)) {
    return undefined;
  }
  const embeddedIpv4 = parsedLeft.embeddedIpv4 ?? parsedRight.embeddedIpv4;
  const parts = [...parsedLeft.parts, ...parsedRight.parts];
  if (sections.length === 1) {
    return parts.length === 8 ? { parts, embeddedIpv4 } : undefined;
  }
  const missing = 8 - parts.length;
  return missing > 0 ? { parts: [...parsedLeft.parts, ...Array.from({ length: missing }, () => 0), ...parsedRight.parts], embeddedIpv4 } : undefined;
}

function parseIpv6Side(rawParts: string[]): { parts: number[]; embeddedIpv4?: string } | undefined {
  let embeddedIpv4: string | undefined;
  const parts: number[] = [];
  for (let index = 0; index < rawParts.length; index += 1) {
    const part = rawParts[index];
    if (part.includes(".")) {
      const ipv4 = parseIpv4(part);
      if (index !== rawParts.length - 1 || !ipv4) {
        return undefined;
      }
      embeddedIpv4 = part;
      parts.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) {
      return undefined;
    }
    parts.push(Number.parseInt(part, 16));
  }
  return { parts, embeddedIpv4 };
}

function isPrivateHost(host: string): boolean {
  const normalized = normalizeHost(host);
  const ipVersion = isIP(normalized);
  return isLoopbackHost(normalized) || (ipVersion === 4 && isPrivateIpv4(normalized)) || (ipVersion === 6 && isPrivateIpv6(normalized));
}

function matchesDomain(host: string, pattern: string): boolean {
  if (typeof pattern !== "string") {
    return false;
  }
  const normalized = normalizeHost(host);
  const rawPattern = pattern.trim().replace(/^\[|\]$/g, "").replace(/^\.+|\.+$/g, "");
  const wildcard = rawPattern.startsWith("*.");
  const normalizedPattern = normalizeHost(wildcard ? rawPattern.slice(2) : rawPattern);
  if (!normalized || !normalizedPattern || rawPattern.includes("*") && !wildcard) {
    return false;
  }
  if (wildcard) {
    // A wildcard represents one or more complete labels.  Reject malformed
    // forms such as `*.*.example` rather than turning them into a broad
    // substring match.
    if (rawPattern.slice(2).includes("*") || normalizedPattern.includes("." + ".")) {
      return false;
    }
    return normalized.endsWith(`.${normalizedPattern}`) && normalized !== normalizedPattern;
  }
  return normalized === normalizedPattern;
}

function isValidDomainPattern(pattern: string): boolean {
  if (typeof pattern !== "string") {
    return false;
  }
  try {
    const rawPattern = pattern.trim().replace(/^\.+|\.+$/g, "");
    const wildcard = rawPattern.startsWith("*.");
    const base = wildcard ? rawPattern.slice(2) : rawPattern;
    if (!base || (rawPattern.includes("*") && !wildcard) || base.includes("..")) {
      return false;
    }
    const bracketless = base.replace(/^\[|\]$/g, "");
    if (isIP(bracketless) !== 0) {
      return true;
    }
    const ascii = domainToASCII(base);
    return Boolean(ascii) && ascii.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  } catch {
    return false;
  }
}

function requireString(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("INVALID_ARGUMENT", `The '${name}' field is required.`);
  }
  const normalized = value.trim();
  if (normalized.includes("\0")) {
    throw new AppError("INVALID_ARGUMENT", `The '${name}' field must not contain null bytes.`);
  }
  return normalized;
}

function canonicalPath(path: string): string | undefined {
  const missingSegments: string[] = [];
  let current = path;
  while (true) {
    try {
      // Use the OS-native resolver consistently. On Windows the regular
      // synchronous and asynchronous helpers can return different short/long
      // spellings for the same temp path, which makes an otherwise valid root
      // fail containment checks when compared with a missing child.
      const canonical = realpathSync.native(current);
      return missingSegments.reduceRight((parent, segment) => join(parent, segment), canonical);
    } catch {
      // A failed realpath is only recoverable for a genuinely missing leaf.
      // If the current path exists but cannot be resolved (including a
      // dangling symlink, a permission failure, or a non-directory segment),
      // fail closed instead of falling back to a lexical path.
      try {
        lstatSync(current);
        return undefined;
      } catch (error) {
        if (!isMissingPathError(error)) {
          return undefined;
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

function hasSymlinkSegment(path: string): boolean {
  let current = path;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        // An uninspectable path must not be treated as safe merely because
        // its lexical spelling happens to be under an allowed root.
        return true;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function hasNoSymlinkSegments(path: string): boolean {
  return !hasSymlinkSegment(path);
}

export class SecurityPolicy {
  private static readonly DNS_LOOKUP_TIMEOUT_MS = 10_000;
  private readonly dnsCache = new Map<string, { expiresAt: number; private: boolean }>();
  private readonly dnsInFlight = new Map<string, Promise<Array<{ address: string }>>>();

  constructor(private readonly config: ServerConfig) {}

  assertNavigationAllowed(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new AppError("URL_INVALID", "The URL is not valid.", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new AppError("URL_BLOCKED", "Only HTTP and HTTPS URLs are allowed.");
    }
    if (url.username || url.password) {
      throw new AppError("URL_BLOCKED", "URLs containing credentials are not allowed.");
    }

    const host = normalizeHost(url.hostname);
    if (!host) {
      throw new AppError("URL_INVALID", "The URL host is invalid.");
    }
    if (this.config.security.blockedDomains.some((pattern) => !isValidDomainPattern(pattern))) {
      throw new AppError("CONFIG_INVALID", "Configured blocked-domain patterns are invalid.");
    }
    if (this.config.security.blockedDomains.some((pattern) => matchesDomain(host, pattern))) {
      throw new AppError("DOMAIN_BLOCKED", `Navigation to '${host}' is blocked by policy.`);
    }
    if (isPrivateHost(host) && !this.config.security.allowPrivateNetwork && !isLoopbackHost(host)) {
      throw new AppError("PRIVATE_NETWORK_BLOCKED", "Private-network navigation is disabled by policy.");
    }
    if (this.config.security.allowedDomains.length > 0 && !this.config.security.allowedDomains.some((pattern) => matchesDomain(host, pattern))) {
      throw new AppError("DOMAIN_NOT_ALLOWED", `Navigation to '${host}' is outside the configured allowlist.`);
    }
    return url;
  }

  async assertNavigationAllowedAsync(rawUrl: string): Promise<URL> {
    const url = this.assertNavigationAllowed(rawUrl);
    const host = normalizeHost(url.hostname);
    if (this.config.security.allowPrivateNetwork || isLoopbackHost(host) || isIP(host)) {
      return url;
    }
    const cached = this.dnsCache.get(host);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.private) {
        throw new AppError("PRIVATE_NETWORK_BLOCKED", "The target hostname resolves to a private network address.");
      }
    }
    let addresses: Array<{ address: string }>;
    const inFlight = this.dnsInFlight.get(host);
    if (inFlight) {
      addresses = await inFlight;
    } else {
      const resolution = Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })).catch((error: unknown) => {
        throw new AppError("DNS_RESOLUTION_FAILED", `The target hostname '${host}' could not be resolved.`, { retryable: true, cause: error });
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const boundedResolution = Promise.race([
        resolution,
        new Promise<Array<{ address: string }>>((_, reject) => {
          timeout = setTimeout(() => reject(new AppError("DNS_RESOLUTION_FAILED", `The target hostname '${host}' did not resolve before the DNS deadline.`, { retryable: true })), SecurityPolicy.DNS_LOOKUP_TIMEOUT_MS);
        }),
      ]);
      this.dnsInFlight.set(host, boundedResolution);
      try {
        addresses = await boundedResolution;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (this.dnsInFlight.get(host) === boundedResolution) {
          this.dnsInFlight.delete(host);
        }
      }
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new AppError("DNS_RESOLUTION_FAILED", `The target hostname '${host}' returned no addresses.`, { retryable: true });
    }
    // DNS answers are untrusted.  Require every result to be a valid IP and
    // deny if any one result is loopback, private, link-local, multicast, or
    // otherwise reserved.  Checking only the first answer would allow a
    // resolver to hide a private address behind a public one.
    const normalizedAddresses = addresses.map((entry) => {
      if (!entry || typeof entry !== "object" || typeof (entry as { address?: unknown }).address !== "string") {
        return "";
      }
      return (entry as { address: string }).address.trim();
    });
    if (normalizedAddresses.some((address) => isIP(address) === 0)) {
      throw new AppError("DNS_RESOLUTION_FAILED", "The target hostname returned an invalid address.", { retryable: true });
    }
    const privateAddress = normalizedAddresses.some((address) => isPrivateHost(address));
    if (privateAddress) {
      // Cache only deny decisions. Caching a public answer would allow a DNS
      // rebinding to a private address during the cache window.
      this.dnsCache.set(host, { expiresAt: Date.now() + 30_000, private: true });
      if (this.dnsCache.size > 256) {
        const oldest = this.dnsCache.keys().next().value;
        if (oldest) {
          this.dnsCache.delete(oldest);
        }
      }
      throw new AppError("PRIVATE_NETWORK_BLOCKED", "The target hostname resolves to a private network address.");
    }
    return url;
  }

  assertFilePath(rawPath: string, options: { mustExist?: boolean } = {}): string {
    const path = resolve(requireString(rawPath, "filePath"));
    const canonicalCandidate = canonicalPath(path);
    if (options.mustExist) {
      try {
        lstatSync(path);
      } catch {
        throw new AppError("FILE_PATH_BLOCKED", "The file path does not exist or cannot be resolved safely.");
      }
    }
    if (canonicalCandidate === undefined && hasSymlinkSegment(path)) {
      throw new AppError("FILE_PATH_BLOCKED", "The file path contains a symbolic link that cannot be resolved safely.");
    }
    const root = this.config.security.allowedFileRoots.find((candidate) => {
      const lexicalRoot = resolve(candidate);
      const canonicalRoot = canonicalPath(lexicalRoot) ?? lexicalRoot;

      // Compare the resolved path when it exists (or has an existing parent).
      // This both accepts macOS /var -> /private/var canonicalization and
      // prevents a child symlink from escaping an explicitly allowed root.
      if (canonicalCandidate !== undefined && isWithinRoot(canonicalRoot, canonicalCandidate)) {
        return true;
      }
      if (canonicalCandidate === undefined && isWithinRoot(lexicalRoot, path)) {
        return true;
      }
      // Windows can return a short/long-name spelling mismatch between two
      // otherwise identical real paths. A lexical fallback is safe only when
      // both paths are free of symlink or uninspectable components; symlinked
      // roots and children must continue through the canonical comparison.
      return canonicalCandidate !== undefined
        && hasNoSymlinkSegments(lexicalRoot)
        && hasNoSymlinkSegments(path)
        && isWithinRoot(lexicalRoot, path);
    });
    if (!root) {
      throw new AppError("FILE_PATH_BLOCKED", "The file path is outside the configured file roots.");
    }
    return path;
  }
}

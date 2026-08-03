/**
 * Read-only, vendor-precise detection of documented browser challenge
 * integrations (Cloudflare Turnstile, reCAPTCHA, hCaptcha, Friendly Captcha,
 * Altcha, AWS WAF, Arkose, Geetest).
 *
 * The detector mirrors the challenge-detector contract of the upstream
 * stealthy-browser project (ported, not copied): a bounded page snapshot is
 * collected with five signal classes —
 *   M1  known DOM widget markers (`.cf-turnstile`, `.g-recaptcha` /
 *       `[name='g-recaptcha-response']`, `.h-captcha`, `.frc-captcha`,
 *       `altcha-widget`);
 *   M2  generic visibility-gated markers (captcha/challenge titled iframes,
 *       captcha/verification dialogs, `[data-captcha]` / `[data-challenge]`);
 *   M3  documented resource hosts/paths (cloudflare turnstile +
 *       challenge-platform, google/recaptcha, hcaptcha api.js, arkoselabs —
 *       site-key path redacted to `/redacted` — and `@friendlycaptcha/`
 *       script paths);
 *   M4  window globals probed via `hasOwnProperty` (`AwsWafCaptcha`,
 *       `initGeetest4`);
 *   M5  nothing found.
 *
 * Output is bounded (20 matches / 8 evidence strings / 8 frames / 8 elements
 * per match / 100 snapshot items / 256-char resource paths) and never echoes
 * page-controlled text: query strings, fragments, and arkose site keys are
 * stripped before a match is formed.
 *
 * The classifier is read-only by construction: it never mutates the DOM,
 * never requests vendor hosts, skips hidden generic markers, excludes
 * zero-size elements, and ignores `srcdoc` iframes. A snapshot-collection
 * failure is reported distinctly (`status: "unknown"`) from a clean miss
 * (`status: "absent"` with `matches: []`).
 */

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Max matches returned. */
const MAX_MATCHES = 20;
/** Max evidence strings / locations retained per match. */
const MAX_EVIDENCE = 8;
/** Max iframe frames retained per match. */
const MAX_FRAMES = 8;
/** Max element boxes retained per match. */
const MAX_ELEMENTS = 8;
/** Max collected snapshot items per resource/element group. */
export const MAX_SNAPSHOT_ITEMS = 100;
/** Max resource path length retained (query/fragment stripped first). */
const MAX_RESOURCE_PATH_LENGTH = 256;
/** Arkose site keys are replaced with this literal in resource paths. */
const REDACTED_RESOURCE_PATH = "/redacted";

/** Confidence ladder — a match's confidence only ever moves upward. */
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

/** Generic (non-vendor-specific) challenge marker. */
const GENERIC_ELEMENT_MARKER = "generic-challenge";

// ─── Types ──────────────────────────────────────────────────────────────────

type Confidence = "low" | "medium" | "high";

/** A sanitised resource origin+path (host lower-cased, path bounded). */
export interface ChallengeResource {
  host: string;
  path: string;
}

/** Geometry of a detected widget/frame in CSS viewport pixels. */
export interface ChallengeBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A collected element marker (+ visibility + raw geometry). */
interface ChallengeElement {
  marker: string;
  visible: boolean;
  bounding_box: ChallengeBoundingBox;
}

/** A collected iframe resource (+ geometry + visibility). */
interface ChallengeFrameEntry {
  resource: ChallengeResource | null;
  bounding_box: ChallengeBoundingBox;
  visible: boolean;
}

/** A collected script resource. */
interface ChallengeScriptEntry {
  resource: ChallengeResource | null;
}

/** The raw page snapshot handed to the classifier. */
interface ChallengeSnapshot {
  iframes: ChallengeFrameEntry[];
  scripts: ChallengeScriptEntry[];
  elements: ChallengeElement[];
  globals: { aws_waf: boolean; geetest: boolean };
}

/** One classified vendor match. */
export interface ChallengeMatch {
  vendor: string;
  confidence: Confidence;
  locations: string[];
  evidence: string[];
  frames?: Array<ChallengeResource & { bounding_box?: ChallengeBoundingBox }>;
  elements?: Array<{ bounding_box: ChallengeBoundingBox }>;
}

/** Result of classification / detection. */
export interface ChallengeDetectionResult {
  detected: boolean;
  status: "present" | "absent" | "unknown";
  matches: ChallengeMatch[];
  /** Present only when the caller requested a scroll. */
  scrolled_into_view?: boolean;
}

/** Known widget DOM markers → vendor identity. */
const KNOWN_ELEMENT_VENDORS: Record<string, [string, Confidence, string]> = {
  altcha: ["altcha", "high", "widget-container"],
  friendlycaptcha: ["friendlycaptcha", "high", "widget-container"],
  hcaptcha: ["hcaptcha", "high", "widget-container"],
  recaptcha: ["recaptcha", "high", "widget-container"],
  turnstile: ["turnstile", "high", "widget-container"],
};

/** Known page-global probes → vendor identity. */
const KNOWN_GLOBAL_VENDORS: Record<string, [string, Confidence, string]> = {
  aws_waf: ["aws_waf", "high", "published-api"],
  geetest: ["geetest", "medium", "published-api"],
};

// ─── Pure sanitisation helpers ──────────────────────────────────────────────

/**
 * Sanitise a raw `{host, path}` resource: rebuild the URL, reject embedded
 * credentials, lower-case the host, strip query/fragment via `pathname`,
 * bound the path length, and redact arkose site-key paths.
 */
export function sanitiseResource(resource: unknown): ChallengeResource | null {
  if (typeof resource !== "object" || resource === null) return null;
  const { host, path } = resource as Record<string, unknown>;
  if (typeof host !== "string" || typeof path !== "string") return null;
  let parsed: URL;
  try {
    // Rebuilding with a fixed scheme means a `host` that smuggles credentials
    // or a `path` that shifts the authority is caught by the parsed values
    // below (and `URL` normalises dot segments, so `/turnstile/../x` cannot
    // sneak past the prefix rules via traversal).
    parsed = new URL(`https://${host}${path}`);
  } catch {
    return null;
  }
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  const sanitisedHost = parsed.hostname.toLowerCase();
  let sanitisedPath = parsed.pathname.slice(0, MAX_RESOURCE_PATH_LENGTH);
  if (
    sanitisedHost === "iframe.arkoselabs.com" ||
    sanitisedHost.endsWith("-api.arkoselabs.com")
  ) {
    sanitisedPath = REDACTED_RESOURCE_PATH;
  }
  return { host: sanitisedHost, path: sanitisedPath };
}

/** Sanitise raw geometry: numeric (non-boolean), finite, rounded to 2dp. */
export function sanitiseBoundingBox(value: unknown): ChallengeBoundingBox | null {
  if (typeof value !== "object" || value === null) return null;
  const box: ChallengeBoundingBox = { x: 0, y: 0, width: 0, height: 0 };
  for (const key of ["x", "y", "width", "height"] as const) {
    const coordinate = (value as Record<string, unknown>)[key];
    // `typeof` alone would accept booleans and NaN; both must be rejected so
    // page-controlled geometry can never poison downstream math.
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) return null;
    box[key] = Math.round(coordinate * 100) / 100;
  }
  return box;
}

/** Map a sanitised resource to a vendor when it matches a documented host/path. */
function vendorForResource(resource: ChallengeResource): [string, Confidence, string] | null {
  const { host, path } = resource;
  if (
    host === "challenges.cloudflare.com" &&
    (path.startsWith("/turnstile/") || path.startsWith("/cdn-cgi/challenge-platform/"))
  ) {
    return ["turnstile", "high", "documented-host-path"];
  }
  if (
    (host === "www.google.com" || host === "www.recaptcha.net") &&
    path.startsWith("/recaptcha/")
  ) {
    return ["recaptcha", "high", "documented-host-path"];
  }
  if (host === "js.hcaptcha.com" && path.startsWith("/1/api.js")) {
    return ["hcaptcha", "high", "documented-host-path"];
  }
  if (host === "iframe.arkoselabs.com" || host.endsWith("-api.arkoselabs.com")) {
    return ["arkose", "high", "documented-host-path"];
  }
  if (path.includes("@friendlycaptcha/")) {
    return ["friendlycaptcha", "medium", "documented-script-path"];
  }
  return null;
}

/** Deduplicate + bound a string list (first occurrence wins). */
function boundedStrings(values: readonly string[], limit: number): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || output.includes(value)) continue;
    output.push(value);
    if (output.length === limit) break;
  }
  return output;
}

/** Structural key for frame deduplication (resource + optional geometry). */
function frameKey(frame: ChallengeResource & { bounding_box?: ChallengeBoundingBox }): string {
  const box = frame.bounding_box;
  return `${frame.host}|${frame.path}|${box ? `${box.x},${box.y},${box.width},${box.height}` : ""}`;
}

/** Structural key for element-box deduplication. */
function elementKey(element: { bounding_box: ChallengeBoundingBox }): string {
  const box = element.bounding_box;
  return `${box.x},${box.y},${box.width},${box.height}`;
}

/** Accumulator state for one vendor while classifying. */
interface ChallengeMatchState extends ChallengeMatch {
  frames: Array<ChallengeResource & { bounding_box?: ChallengeBoundingBox }>;
  elements: Array<{ bounding_box: ChallengeBoundingBox }>;
}

/** Merge one piece of evidence into a vendor match, bounding + deduping. */
function addMatch(
  matches: Record<string, ChallengeMatchState>,
  vendor: string,
  confidence: Confidence,
  location: string,
  evidence: string,
  resource?: ChallengeResource | null,
  boundingBox?: ChallengeBoundingBox | null,
): void {
  const match: ChallengeMatchState =
    matches[vendor] ?? {
      vendor,
      confidence,
      locations: [],
      evidence: [],
      frames: [],
      elements: [],
    };
  matches[vendor] = match;
  if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[match.confidence]) {
    match.confidence = confidence;
  }
  match.locations = boundedStrings([...match.locations, location], MAX_EVIDENCE);
  match.evidence = boundedStrings([...match.evidence, evidence], MAX_EVIDENCE);
  if (location === "iframe" && resource && match.frames.length < MAX_FRAMES) {
    const frame: ChallengeResource & { bounding_box?: ChallengeBoundingBox } = {
      host: resource.host,
      path: resource.path,
    };
    if (boundingBox) frame.bounding_box = boundingBox;
    if (!match.frames.some((f) => frameKey(f) === frameKey(frame))) match.frames.push(frame);
  }
  if (location === "element" && boundingBox && match.elements.length < MAX_ELEMENTS) {
    const element = { bounding_box: boundingBox };
    if (!match.elements.some((e) => elementKey(e) === elementKey(element))) {
      match.elements.push(element);
    }
  }
}

// ─── Classification (pure — no DOM access) ─────────────────────────────────

/**
 * Classify a pre-collected snapshot without returning page-controlled text.
 * Emits `status: "present"` when anything matched, `"absent"` otherwise.
 */
export function classifyChallengeSnapshot(snapshot: unknown): ChallengeDetectionResult {
  if (typeof snapshot !== "object" || snapshot === null) {
    return { detected: false, status: "absent", matches: [] };
  }
  const snap = snapshot as Record<string, unknown>;
  const matches: Record<string, ChallengeMatchState> = {};

  for (const [locationKey, location] of [
    ["iframes", "iframe"],
    ["scripts", "script"],
  ] as const) {
    const candidates = snap[locationKey];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates.slice(0, MAX_SNAPSHOT_ITEMS)) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const resource = sanitiseResource((candidate as Record<string, unknown>).resource);
      if (!resource) continue;
      const vendor = vendorForResource(resource);
      if (!vendor) continue;
      const [name, confidence, evidence] = vendor;
      addMatch(
        matches,
        name,
        confidence,
        location,
        evidence,
        resource,
        sanitiseBoundingBox((candidate as Record<string, unknown>).bounding_box),
      );
    }
  }

  const elements = snap.elements;
  if (Array.isArray(elements)) {
    for (const candidate of elements.slice(0, MAX_SNAPSHOT_ITEMS)) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const el = candidate as Record<string, unknown>;
      const marker = el.marker;
      // Generic markers are visibility-gated: a hidden generic element is a
      // false positive (any page can hide an unrelated dialog). Known vendor
      // markers match regardless (widgets are legitimately hidden until used).
      if (marker === GENERIC_ELEMENT_MARKER && el.visible !== true) continue;
      if (typeof marker === "string" && marker in KNOWN_ELEMENT_VENDORS) {
        const [name, confidence, evidence] = KNOWN_ELEMENT_VENDORS[marker];
        addMatch(
          matches,
          name,
          confidence,
          "element",
          evidence,
          undefined,
          sanitiseBoundingBox(el.bounding_box),
        );
      } else if (marker === GENERIC_ELEMENT_MARKER) {
        addMatch(
          matches,
          "unknown",
          "low",
          "element",
          "generic-visible-marker",
          undefined,
          sanitiseBoundingBox(el.bounding_box),
        );
      }
    }
  }

  const globals = snap.globals;
  if (typeof globals === "object" && globals !== null) {
    for (const [marker, vendor] of Object.entries(KNOWN_GLOBAL_VENDORS)) {
      if ((globals as Record<string, unknown>)[marker] !== true) continue;
      const [name, confidence, evidence] = vendor;
      addMatch(matches, name, confidence, "page", evidence);
    }
  }

  const output = Object.values(matches)
    .slice(0, MAX_MATCHES)
    .map((m) => {
      const out: ChallengeMatch = {
        vendor: m.vendor,
        confidence: m.confidence,
        locations: m.locations,
        evidence: m.evidence,
      };
      if (m.frames.length > 0) out.frames = m.frames;
      if (m.elements.length > 0) out.elements = m.elements;
      return out;
    });
  return {
    detected: output.length > 0,
    status: output.length > 0 ? "present" : "absent",
    matches: output,
  };
}

// ─── Scroll targeting (pure target selection) ───────────────────────────────

/**
 * Pick the first visible detected iframe/widget with geometry — the widget a
 * human would see first and therefore the one to reveal.
 */
export function firstVisibleScrollTarget(snapshot: unknown): ChallengeBoundingBox | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const snap = snapshot as Record<string, unknown>;

  const iframes = snap.iframes;
  if (Array.isArray(iframes)) {
    for (const candidate of iframes.slice(0, MAX_SNAPSHOT_ITEMS)) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const frame = candidate as Record<string, unknown>;
      if (frame.visible !== true) continue;
      const resource = sanitiseResource(frame.resource);
      if (!resource || !vendorForResource(resource)) continue;
      const boundingBox = sanitiseBoundingBox(frame.bounding_box);
      if (boundingBox) return boundingBox;
    }
  }

  const elements = snap.elements;
  if (!Array.isArray(elements)) return null;
  for (const candidate of elements.slice(0, MAX_SNAPSHOT_ITEMS)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const el = candidate as Record<string, unknown>;
    if (el.visible !== true) continue;
    const marker = el.marker;
    if (typeof marker !== "string") continue;
    if (!(marker in KNOWN_ELEMENT_VENDORS) && marker !== GENERIC_ELEMENT_MARKER) continue;
    const boundingBox = sanitiseBoundingBox(el.bounding_box);
    if (boundingBox) return boundingBox;
  }
  return null;
}

// ─── Snapshot collection (in-page) ──────────────────────────────────────────

/** Resolve an attribute value to a sanitised resource against the base URI. */
function sanitiseResourceInPage(value: string | null): ChallengeResource | null {
  if (!value) return null;
  try {
    const parsed = new URL(value, document.baseURI);
    return {
      host: parsed.hostname.toLowerCase(),
      path: parsed.pathname.slice(0, MAX_RESOURCE_PATH_LENGTH),
    };
  } catch {
    return null;
  }
}

/** True when the node has non-zero layout and is not hidden via style. */
function isVisibleNode(node: Element): boolean {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return Boolean(
    rect.width && rect.height && style.display !== "none" && style.visibility !== "hidden",
  );
}

/** Raw viewport geometry of a node. */
function geometryOf(node: Element): ChallengeBoundingBox {
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Collect the bounded page snapshot (mirrors the upstream `_SNAPSHOT_SCRIPT`
 * shape: `{iframes, scripts, elements, globals}`). Pure read of the live DOM —
 * never mutates the page and never fetches anything.
 */
export function collectChallengeSnapshot(): ChallengeSnapshot {
  const elements: ChallengeElement[] = [];
  const addElements = (selector: string, marker: string, requiresVisible: boolean): void => {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      if (elements.length >= MAX_SNAPSHOT_ITEMS) break;
      const isVisible = isVisibleNode(node);
      if (requiresVisible && !isVisible) continue;
      elements.push({ marker, visible: isVisible, bounding_box: geometryOf(node) });
    }
  };
  // Known vendor markers are collected regardless of visibility (a widget can
  // legitimately be hidden until triggered); generic markers require a
  // visible, non-zero-size element to avoid false positives.
  addElements(".cf-turnstile", "turnstile", false);
  addElements(".g-recaptcha, [name='g-recaptcha-response']", "recaptcha", false);
  addElements(".h-captcha", "hcaptcha", false);
  addElements(".frc-captcha", "friendlycaptcha", false);
  addElements("altcha-widget", "altcha", false);
  addElements(
    "iframe[title*='captcha' i], iframe[title*='challenge' i]",
    GENERIC_ELEMENT_MARKER,
    true,
  );
  addElements(
    "[role='dialog'][aria-label*='captcha' i], [role='dialog'][aria-label*='verification' i]",
    GENERIC_ELEMENT_MARKER,
    true,
  );
  addElements("[data-captcha], [data-challenge]", GENERIC_ELEMENT_MARKER, true);

  return {
    iframes: Array.from(document.querySelectorAll("iframe"))
      .slice(0, MAX_SNAPSHOT_ITEMS)
      .map((node) => ({
        resource: sanitiseResourceInPage(node.getAttribute("src")),
        bounding_box: geometryOf(node),
        visible: isVisibleNode(node),
      })),
    scripts: Array.from(document.scripts)
      .slice(0, MAX_SNAPSHOT_ITEMS)
      .map((node) => ({ resource: sanitiseResourceInPage(node.getAttribute("src")) })),
    elements,
    globals: {
      aws_waf: Object.prototype.hasOwnProperty.call(window, "AwsWafCaptcha"),
      geetest: Object.prototype.hasOwnProperty.call(window, "initGeetest4"),
    },
  };
}

// ─── In-page scroll ─────────────────────────────────────────────────────────

/**
 * Center the first visible detected widget via `window.scrollTo` with a
 * clamped offset. Returns `false` when there is nothing valid to reveal.
 * Only meaningful in a real page context (content script).
 */
export function scrollIntoViewFromSnapshot(snapshot: unknown): boolean {
  const target = firstVisibleScrollTarget(snapshot);
  if (!target) return false;
  const { x, y, width, height } = target;
  // Validate the boundary between the pure layer and the page: a degenerate
  // box (zero/negative size, non-finite) must not feed `scrollTo`.
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return false;
  }
  const isInViewport = (top: number): boolean =>
    x < window.innerWidth && x + width > 0 && top < window.innerHeight && top + height > 0;
  if (isInViewport(y)) return true;
  const documentY = window.scrollY + y;
  const maximumScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const desiredScrollY = Math.max(
    0,
    Math.min(maximumScrollY, documentY - (window.innerHeight - height) / 2),
  );
  window.scrollTo(0, desiredScrollY);
  return isInViewport(documentY - window.scrollY);
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Detect challenges on the current page. A collection failure is reported as
 * `status: "unknown"` (distinct from a clean `"absent"` miss) so callers can
 * choose to retry instead of assuming the page is challenge-free.
 */
export function detectChallenges(
  opts: { scrollIntoView?: boolean } = {},
): ChallengeDetectionResult {
  const scroll = opts.scrollIntoView === true;
  let snapshot: ChallengeSnapshot;
  try {
    snapshot = collectChallengeSnapshot();
  } catch {
    const result: ChallengeDetectionResult = {
      detected: false,
      status: "unknown",
      matches: [],
    };
    if (scroll) result.scrolled_into_view = false;
    return result;
  }
  const result = classifyChallengeSnapshot(snapshot);
  if (scroll) {
    result.scrolled_into_view = scrollIntoViewFromSnapshot(snapshot);
  }
  return result;
}

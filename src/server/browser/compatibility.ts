/**
 * Stable launch defaults for the one native browser profile.
 *
 * These switches reduce background work and startup noise that is unrelated to
 * browser tasks. They deliberately do not alter browser identity, web
 * security, certificate validation, sandboxing, or page JavaScript globals.
 * Keeping this list centralized makes the native profile auditable and avoids
 * transport- or tool-specific launch behavior.
 */
export const NATIVE_BROWSER_LAUNCH_ARGS = [
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-hang-monitor",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-sync",
  "--no-default-browser-check",
  "--no-first-run",
  "--no-pings",
] as const;

export function nativeBrowserLaunchArgs(): string[] {
  return [...NATIVE_BROWSER_LAUNCH_ARGS];
}

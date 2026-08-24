/** Stable launch defaults for the native profile. Reduces background work without altering identity or security. */
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

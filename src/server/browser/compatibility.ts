/**
 * Stable launch defaults for the native profile. Reduces background work;
 * optional explicit viewport flags append here when configured. Identity,
 * language, and automation signals are never changed by this module.
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

// GPU rendering flags are explicit performance/compatibility controls, not
// identity controls. They remain opt-in because Vulkan availability varies.
const STEALTH_GPU_ARGS: readonly string[] = ["--use-angle=vulkan", "--enable-vulkan"];

/** Options controlling optional native launch flags. */
export interface StealthLaunchOptions {
  /** Compatibility flag; window size and GPU are never gated on it. */
  enabled?: boolean;
  gpu?: boolean;
  /** An explicit viewport is the only dimension claim the caller may share. */
  viewport?: { width: number; height: number };
}

export function nativeBrowserLaunchArgs(options: StealthLaunchOptions = {}): string[] {
  const args: string[] = [...NATIVE_BROWSER_LAUNCH_ARGS];
  if (options.viewport
    && Number.isInteger(options.viewport.width)
    && Number.isInteger(options.viewport.height)
    && options.viewport.width > 0
    && options.viewport.height > 0) {
    args.push(`--window-size=${options.viewport.width},${options.viewport.height}`);
  }
  if (options.gpu) {
    for (const flag of STEALTH_GPU_ARGS) {
      if (!args.includes(flag)) args.push(flag);
    }
  }
  return args;
}

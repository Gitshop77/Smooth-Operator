import { safeLog } from "./state-store";

type StartupListener = () => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

export interface ProviderLifecycleService {
  start(): void;
  stop(): void;
  warm(): void;
}

export interface ProviderLifecycleDependencies {
  onStartup: {
    addListener(listener: StartupListener): void;
    removeListener(listener: StartupListener): void;
  };
  onStorageChanged: {
    addListener(listener: StorageListener): void;
    removeListener(listener: StorageListener): void;
  };
  refreshPricing(): Promise<void>;
  catalogFetchSucceeded(): Promise<boolean>;
  scheduleCatalogRefresh(): Promise<void>;
  now(): number;
  logWarning(error: unknown): void;
}

const SETTINGS_KEY = /^(?:provider|model|apiKey|api_key|baseUrl|base_url|endpoint)/i;
const PRICING_REFRESH_THROTTLE_MS = 2_000;

function createDefaultDependencies(): ProviderLifecycleDependencies {
  return {
    onStartup: chrome.runtime.onStartup,
    onStorageChanged: chrome.storage.onChanged,
    async refreshPricing() {
      const pricing = await import("../../lib/agent/llm/pricing");
      await pricing.refreshPricingFromCatalog();
    },
    async catalogFetchSucceeded() {
      const catalog = await import("../../lib/agent/llm/catalog");
      return catalog.catalogFetchSucceeded();
    },
    async scheduleCatalogRefresh() {
      const catalog = await import("../../lib/agent/llm/catalog");
      catalog.scheduleRefresh();
    },
    now: Date.now,
    logWarning(error) {
      void safeLog("warn", "[pricing] live catalog refresh failed:", error);
    },
  };
}

/** Owns provider-catalog startup, settings-change refresh, and teardown. */
export function createProviderLifecycleService(
  dependencies: ProviderLifecycleDependencies = createDefaultDependencies(),
): ProviderLifecycleService {
  let started = false;
  let generation = 0;
  let lastPricingRefreshAt = 0;

  const warm = (): void => {
    if (!started) return;
    // Apply the same cooldown inside `warm()` so a direct startup call can't
    // bypass the storage-listener throttle, and a flaky network backs off
    // (lastPricingRefreshAt is stamped at attempt time) instead of retrying on
    // every wake.
    const now = dependencies.now();
    if (lastPricingRefreshAt !== 0 && now - lastPricingRefreshAt < PRICING_REFRESH_THROTTLE_MS) return;
    lastPricingRefreshAt = now;
    const activeGeneration = generation;
    void dependencies.refreshPricing()
      .then(async () => {
        if (!started || generation !== activeGeneration) return;
        if (!(await dependencies.catalogFetchSucceeded())) return;
        if (!started || generation !== activeGeneration) return;
        await dependencies.scheduleCatalogRefresh();
      })
      .catch((error) => dependencies.logWarning(error));
  };

  const onStartup: StartupListener = () => warm();
  const onStorageChanged: StorageListener = (changes, areaName) => {
    if (areaName !== "local" && areaName !== "sync") return;
    if (!Object.keys(changes).some((key) => SETTINGS_KEY.test(key))) return;
    warm();
  };

  return {
    start() {
      if (started) return;
      started = true;
      generation += 1;
      dependencies.onStartup.addListener(onStartup);
      dependencies.onStorageChanged.addListener(onStorageChanged);
    },
    stop() {
      if (!started) return;
      started = false;
      generation += 1;
      dependencies.onStartup.removeListener(onStartup);
      dependencies.onStorageChanged.removeListener(onStorageChanged);
    },
    warm,
  };
}

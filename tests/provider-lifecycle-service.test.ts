import { describe, expect, it, vi } from "vitest";
import {
  createProviderLifecycleService,
  type ProviderLifecycleDependencies,
} from "../src/extension/background/provider-lifecycle-service";

function listenerPort<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => listeners.add(listener)),
    removeListener: vi.fn((listener: T) => listeners.delete(listener)),
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ProviderLifecycleService", () => {
  it("registers once and refreshes on startup and relevant, throttled settings changes", async () => {
    const startup = listenerPort<() => void>();
    const storage = listenerPort<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
    const refreshPricing = vi.fn(async () => undefined);
    const scheduleCatalogRefresh = vi.fn(async () => undefined);
    let now = 10_000;
    const dependencies: ProviderLifecycleDependencies = {
      onStartup: startup,
      onStorageChanged: storage,
      refreshPricing,
      catalogFetchSucceeded: vi.fn(async () => true),
      scheduleCatalogRefresh,
      now: () => now,
      logWarning: vi.fn(),
    };
    const service = createProviderLifecycleService(dependencies);

    service.start();
    service.start();
    startup.emit();
    await vi.waitFor(() => expect(scheduleCatalogRefresh).toHaveBeenCalledTimes(1));
    // The startup warm-up stamps the refresh throttle too; settings changes
    // within the cooldown are dropped, later ones refresh.
    now += 2_000;

    storage.emit({ theme: {} }, "local");
    storage.emit({ provider: {} }, "session");
    expect(refreshPricing).toHaveBeenCalledTimes(1);

    storage.emit({ provider: {} }, "local");
    await vi.waitFor(() => expect(refreshPricing).toHaveBeenCalledTimes(2));
    storage.emit({ model: {} }, "sync");
    expect(refreshPricing).toHaveBeenCalledTimes(2);
    now += 2_000;
    storage.emit({ apiKey: {} }, "local");
    await vi.waitFor(() => expect(refreshPricing).toHaveBeenCalledTimes(3));
    expect(startup.addListener).toHaveBeenCalledTimes(1);
    expect(storage.addListener).toHaveBeenCalledTimes(1);
  });

  it("removes listeners and suppresses catalog scheduling from a late refresh", async () => {
    const startup = listenerPort<() => void>();
    const storage = listenerPort<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
    const pending = deferred();
    const scheduleCatalogRefresh = vi.fn(async () => undefined);
    const service = createProviderLifecycleService({
      onStartup: startup,
      onStorageChanged: storage,
      refreshPricing: vi.fn(() => pending.promise),
      catalogFetchSucceeded: vi.fn(async () => true),
      scheduleCatalogRefresh,
      now: () => 10_000,
      logWarning: vi.fn(),
    });

    service.start();
    service.warm();
    service.stop();
    service.stop();
    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduleCatalogRefresh).not.toHaveBeenCalled();
    expect(startup.removeListener).toHaveBeenCalledTimes(1);
    expect(storage.removeListener).toHaveBeenCalledTimes(1);
  });
});

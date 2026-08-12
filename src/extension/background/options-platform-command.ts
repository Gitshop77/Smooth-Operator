import type {
  OptionsPlatformCommandMessageV1,
  OptionsPlatformCommandResponseV1,
} from "../options-platform-contract";
import type { ProviderConnectionService } from "./provider-connection-service";
import { createProviderConnectionService } from "./provider-connection-service";
import { resolveCredential } from "../credential-service";
import { getCredentialStatus } from "../credential-service";
import { ensureApiKeyInSession } from "../api-key-storage";
import { isExactOptionsSender } from "./options-sender";

type SendResponse = (response: OptionsPlatformCommandResponseV1) => void;

export { isExactOptionsSender };

export interface OptionsPlatformServices {
  connection: ProviderConnectionService;
  getCredentialStatus: typeof getCredentialStatus;
}

export function createOptionsPlatformCommandHandler(services: OptionsPlatformServices) {
  return function handleOptionsPlatformCommand(
    message: OptionsPlatformCommandMessageV1,
    sender: chrome.runtime.MessageSender,
    sendResponse: SendResponse,
  ): boolean {
    if (!isExactOptionsSender(sender)) {
      sendResponse({ ok: false, error: "Unauthorized Options platform sender." });
      return false;
    }
    if (message?.version !== 1 ||
        (message.command?.kind !== "connection_test" && message.command?.kind !== "credential_status")) {
      sendResponse({ ok: false, error: "Unsupported Options platform command." });
      return false;
    }
    if (message.command.kind === "credential_status") {
      void services.getCredentialStatus().then(
        (status) => sendResponse({ ok: true, kind: "credential_status", status }),
        () => sendResponse({ ok: false, error: "Credential status unavailable." }),
      );
      return true;
    }
    void services.connection.test(message.command.config).then(
      (result) => sendResponse({ ok: true, kind: "connection_test", result }),
      () => sendResponse({ ok: false, error: "Connection service unavailable." }),
    );
    return true;
  };
}

let installedHandler: ReturnType<typeof createOptionsPlatformCommandHandler> | null = null;

export function installOptionsPlatformConnectionService(services: OptionsPlatformServices): void {
  installedHandler = createOptionsPlatformCommandHandler(services);
}

export function installDefaultOptionsPlatformConnectionService(): void {
  installOptionsPlatformConnectionService({
    connection: createProviderConnectionService(async (reference) => {
      try {
        const value = reference ? await resolveCredential(reference) : await ensureApiKeyInSession();
        return value ? { ok: true, value } : { ok: false, reason: "missing" };
      } catch {
        return { ok: false, reason: "stale" };
      }
    }),
    getCredentialStatus,
  });
}

export function handleOptionsPlatformCommand(
  message: OptionsPlatformCommandMessageV1,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse,
): boolean {
  if (!installedHandler) {
    sendResponse({ ok: false, error: "Connection service unavailable." });
    return false;
  }
  return installedHandler(message, sender, sendResponse);
}

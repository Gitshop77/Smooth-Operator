import type {
  OptionsPlatformCommandMessageV1,
  OptionsPlatformCommandResponseV1,
  CredentialStatusSnapshotV1,
  ProviderConnectionConfigV1,
  ProviderConnectionResultV1,
} from "../options-platform-contract";

export async function sendOptionsPlatformCommand(
  message: OptionsPlatformCommandMessageV1,
): Promise<OptionsPlatformCommandResponseV1> {
  const response = await chrome.runtime.sendMessage(message) as OptionsPlatformCommandResponseV1;
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
    return { ok: false, error: "Invalid response from the background connection service." };
  }
  return response;
}

export async function testSelectedProviderConnection(
  config: ProviderConnectionConfigV1,
): Promise<ProviderConnectionResultV1> {
  const response = await sendOptionsPlatformCommand({
    type: "OPTIONS_PLATFORM_COMMAND",
    version: 1,
    command: { kind: "connection_test", config },
  });
  if (!response.ok) {
    return {
      version: 1,
      ok: false,
      code: "internal_error",
      latencyMs: 0,
      provider: config.provider,
      model: config.model,
      message: response.error.slice(0, 240),
    };
  }
  if (response.kind !== "connection_test") {
    return {
      version: 1,
      ok: false,
      code: "internal_error",
      latencyMs: 0,
      provider: config.provider,
      model: config.model,
      message: "Unexpected response from the background connection service.",
    };
  }
  return response.result;
}

export async function getProviderCredentialStatus(): Promise<CredentialStatusSnapshotV1> {
  const response = await sendOptionsPlatformCommand({
    type: "OPTIONS_PLATFORM_COMMAND",
    version: 1,
    command: { kind: "credential_status" },
  });
  return response.ok && response.kind === "credential_status"
    ? response.status
    : { status: "corrupt" };
}

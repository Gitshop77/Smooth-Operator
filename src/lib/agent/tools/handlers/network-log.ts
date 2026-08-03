/**
 * Network-log actions — enable / disable / get / clear / getclear the
 * SW-side ring (rate-limit-tracker.ts). The ring lives in the service worker
 * because `chrome.webRequest` events only fire there; these handlers delegate
 * via the `NETWORK_LOG` runtime message. The handlers are thin re-exports of
 * the parameterized ring-log core in `./sw-rpc`.
 */

import { makeRingLogHandler } from "./sw-rpc";

export const handleEnableNetworkLog = makeRingLogHandler({
  messageType: "NETWORK_LOG",
  noun: "network log",
  actionType: "enable_network_log",
  verb: "enable",
});

export const handleDisableNetworkLog = makeRingLogHandler({
  messageType: "NETWORK_LOG",
  noun: "network log",
  actionType: "disable_network_log",
  verb: "disable",
});

export const handleGetNetworkLog = makeRingLogHandler({
  messageType: "NETWORK_LOG",
  noun: "network log",
  actionType: "get_network_log",
  verb: "get",
});

export const handleClearNetworkLog = makeRingLogHandler({
  messageType: "NETWORK_LOG",
  noun: "network log",
  actionType: "clear_network_log",
  verb: "clear",
});

export const handleGetclearNetworkLog = makeRingLogHandler({
  messageType: "NETWORK_LOG",
  noun: "network log",
  actionType: "getclear_network_log",
  verb: "getclear",
});

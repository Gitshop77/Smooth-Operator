import type { ChatMessage } from "../llm/provider";
import type { ImagePartV1 } from "../llm/image-part";
import { buildNavigatorUserMessage, buildPlannerUserMessage } from "../loop/messages";
import type { buildNavigatorPrompt } from "./navigator-prompt";
import { buildJudgeUserMessage, JUDGE_SYSTEM_PROMPT, type JudgePromptInputV1 } from "./judge-prompt";
import {
  memoizedCacheDescriptorV1,
  memoizedNavigatorSystem,
  memoizedPlannerSystem,
} from "./prompt-memo";
import {
  PROMPT_CONTRACT_VERSION,
  type CompiledPromptV1,
  type PromptKindV1,
  type PromptSectionV1,
} from "./prompt-contract";

type NavigatorUserArgs = Parameters<typeof buildNavigatorUserMessage>[0];
type PlannerUserArgs = Parameters<typeof buildPlannerUserMessage>[0];

interface CompileLegacyPairV1 {
  kind: PromptKindV1;
  system: string;
  user: string;
  cacheEligible: boolean;
  systemProvenance: PromptSectionV1["provenance"];
  userTrust: PromptSectionV1["trust"];
  invalidationKeys: string[];
  /** Extra user-message parts appended AFTER the sections-derived text.
   * NEVER rendered into a section: the cache descriptor hashes `section.text`
   * (prompt-cache-descriptor.ts), so a structured image part — which is
   * volatile per step and must not shape the stable cache key — stays a
   * separate content part in `messages` only. */
  extraUserParts?: Array<string | ImagePartV1>;
}

async function compileLegacyPairV1(input: CompileLegacyPairV1): Promise<CompiledPromptV1> {
  const sections: PromptSectionV1[] = [
    {
      version: PROMPT_CONTRACT_VERSION,
      id: `${input.kind}.system`,
      role: "system",
      text: input.system,
      trust: "system",
      provenance: input.systemProvenance,
      volatility: input.cacheEligible ? "configuration" : "request",
      required: true,
      cache: input.cacheEligible ? "stable" : "ineligible",
    },
    {
      version: PROMPT_CONTRACT_VERSION,
      id: `${input.kind}.user`,
      role: "user",
      text: input.user,
      trust: input.userTrust,
      provenance: "runtime",
      volatility: input.kind === "navigator" ? "page" : "request",
      required: true,
      cache: input.cacheEligible ? "volatile" : "ineligible",
    },
  ];
  const messages: ChatMessage[] = sections.map(({ role, text: content }) => ({ role, content }));
  if (input.extraUserParts && input.extraUserParts.length > 0) {
    // The user message becomes a parts array: the sections-derived text first,
    // then the appended parts. `sections` stay text-only (see the interface
    // contract above), so the cache descriptor never hashes the screenshot.
    messages[1] = {
      role: "user",
      content: [
        ...(typeof messages[1].content === "string" ? [messages[1].content] : messages[1].content),
        ...input.extraUserParts,
      ],
    };
  }
  return {
    version: PROMPT_CONTRACT_VERSION,
    kind: input.kind,
    sections,
    messages,
    cache: await memoizedCacheDescriptorV1(sections, {
      cacheEligible: input.cacheEligible,
      invalidationKeys: input.invalidationKeys,
    }),
  };
}

export interface CompileNavigatorPromptV1Input {
  maxActions: number;
  customPrompt?: string;
  visionMode?: Parameters<typeof buildNavigatorPrompt>[2];
  mode?: string;
  user: NavigatorUserArgs;
  /** Exact suffixes applied by the provider-facing adapter. */
  systemSuffix?: string;
  userSuffix?: string;
  /** Structured screenshot part appended to the user message as a content
   * part (never rendered as text — see `CompileLegacyPairV1.extraUserParts`).
   * The base64 lives only in this part, so forged `<screenshot>` markers in
   * page text can never be promoted into an image block. */
  screenshot?: ImagePartV1;
  /** When true, use the COMPACT navigator system prompt for low-context
   * (<128k) models — every security/schema/behavior block is preserved, only
   * prose is compressed (see `buildNavigatorPrompt(..., compact)`). */
  compact?: boolean;
  /** Capability-gated action names — when present the system prompt's action
   * listing shows only the core actions + this set (executor schema unchanged;
   * see `buildNavigatorPrompt(..., enabledActions)`). */
  enabledActions?: ReadonlySet<string>;
}

export async function compileNavigatorPromptV1(
  input: CompileNavigatorPromptV1Input,
): Promise<CompiledPromptV1> {
  const system = memoizedNavigatorSystem(
    input.maxActions,
    input.customPrompt,
    input.visionMode,
    input.mode,
    input.compact,
    input.systemSuffix,
    input.enabledActions,
  );
  const user = await buildNavigatorUserMessage(input.user) + (input.userSuffix ?? "");
  return compileLegacyPairV1({
    kind: "navigator",
    system,
    user,
    cacheEligible: true,
    systemProvenance: input.customPrompt?.trim() ? "settings" : "application",
    userTrust: "untrusted-page",
    invalidationKeys: [
      "prompt-contract-version",
      "customNavigatorPrompt",
      "visionMode",
      "agentMode",
      "structured-output-support",
    ],
    ...(input.screenshot ? { extraUserParts: [input.screenshot] } : {}),
  });
}

export interface CompilePlannerPromptV1Input {
  customPrompt?: string;
  user: PlannerUserArgs;
  systemSuffix?: string;
}

export async function compilePlannerPromptV1(
  input: CompilePlannerPromptV1Input,
): Promise<CompiledPromptV1> {
  return compileLegacyPairV1({
    kind: "planner",
    system: memoizedPlannerSystem(input.customPrompt, input.systemSuffix),
    user: await buildPlannerUserMessage(input.user),
    // A planner call is two messages, but it is not one-use in an agent run:
    // the identical ~9.5KB system prefix is revisited every planner interval.
    // Mark only that stable prefix cacheable; the per-step user payload stays
    // volatile. This enables explicit Anthropic caching and is harmless for
    // providers with automatic/no prompt caching.
    cacheEligible: true,
    systemProvenance: input.customPrompt?.trim() ? "settings" : "application",
    userTrust: "untrusted-model",
    invalidationKeys: ["prompt-contract-version", "customPlannerPrompt", "structured-output-support"],
  });
}

export async function compileJudgePromptV1(input: JudgePromptInputV1): Promise<CompiledPromptV1> {
  return compileLegacyPairV1({
    kind: "judge",
    system: JUDGE_SYSTEM_PROMPT,
    user: buildJudgeUserMessage(input),
    cacheEligible: false,
    systemProvenance: "application",
    userTrust: "untrusted-model",
    invalidationKeys: ["prompt-contract-version"],
  });
}

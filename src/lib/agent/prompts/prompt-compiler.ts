import type { ChatMessage } from "../llm/provider";
import { buildNavigatorUserMessage, buildPlannerUserMessage } from "../loop/messages";
import { buildNavigatorPrompt } from "./navigator-prompt";
import { buildPlannerPrompt } from "./planner-prompt";
import { buildJudgeUserMessage, JUDGE_SYSTEM_PROMPT, type JudgePromptInputV1 } from "./judge-prompt";
import {
  PROMPT_CONTRACT_VERSION,
  type CompiledPromptV1,
  type PromptKindV1,
  type PromptSectionV1,
} from "./prompt-contract";
import { createPromptCacheDescriptorV1 } from "./prompt-cache-descriptor";

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
  return {
    version: PROMPT_CONTRACT_VERSION,
    kind: input.kind,
    sections,
    messages,
    cache: await createPromptCacheDescriptorV1(sections, {
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
  /** When true, use the COMPACT navigator system prompt for low-context
   * (<128k) models — every security/schema/behavior block is preserved, only
   * prose is compressed (see `buildNavigatorPrompt(..., compact)`). */
  compact?: boolean;
}

export async function compileNavigatorPromptV1(
  input: CompileNavigatorPromptV1Input,
): Promise<CompiledPromptV1> {
  const system = buildNavigatorPrompt(input.maxActions, input.customPrompt, input.visionMode, input.mode, input.compact) +
    (input.systemSuffix ?? "");
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
    system: buildPlannerPrompt(input.customPrompt) + (input.systemSuffix ?? ""),
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

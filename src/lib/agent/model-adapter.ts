/**
 * Model adapter for the agent runtime (#329, epic #325).
 *
 * The agent needs a tool-calling model, and `src/lib/llm` has no tool-calling
 * surface — its provider contract is text streaming plus config validation. So
 * the agent drives the ratified AI SDK provider packages instead, and this
 * module is where the repository's own settings resolution meets them: it
 * resolves and validates a configuration through `src/lib/llm`, hands it to the
 * kind's adapter in `provider-registry.ts`, and translates SDK failures back into
 * this repository's error vocabulary.
 *
 * Which environment variables may be read, and why each provider package's own
 * fallbacks stay unread, is the registry's concern and is documented there.
 */

import { AISDKError, APICallError, type CallWarning, LoadAPIKeyError } from "ai";
import {
  type LLMConfig,
  type LLMModelEffort,
  type LLMProviderType,
  LLMAuthError,
  LLMConfigError,
  LLMError,
  LLMRateLimitError,
  LLMStreamError,
} from "@/lib/llm/types";
import { resolveConfig, validateConfig, validModelEffort } from "@/lib/llm/utils/config";
import { type AgentFetch, type AgentLanguageModel, resolveAgentProviderAdapter } from "./provider-registry";

/** A model plus the resolved identity it was built from, for audit and logging. */
export interface AgentModel {
  readonly provider: LLMProviderType;
  readonly modelId: string;
  readonly model: AgentLanguageModel;
  /**
   * `LLM_MODEL_EFFORT`, validated, which `validateConfig` allows on the `openai` kind only.
   * Carried here so every call can send it without reading the environment outside `src/lib/llm`.
   */
  readonly effort?: LLMModelEffort;
}

export interface AgentModelOptions {
  /** Overrides handed to `resolveConfig`, the same shape `createLLMProvider` takes. */
  readonly config?: Partial<LLMConfig>;
  /**
   * The SDK providers document `fetch` as the interception point for tests and
   * proxies; injecting it keeps the suite off a global stub, which would leak
   * into every other test in the same process and has to be restored by hand.
   */
  readonly fetch?: AgentFetch;
}

/**
 * Build a model instance from the repository's resolved LLM configuration.
 *
 * @throws LLMConfigError if the configuration is one the chat surface would also
 *         refuse, if the kind has no adapter, or if the SDK refuses the settings
 *         when the provider is constructed.
 */
export async function createAgentModel(options: AgentModelOptions = {}): Promise<AgentModel> {
  const config = resolveConfig(options.config);
  validateConfig(config);
  const adapter = resolveAgentProviderAdapter(config.provider);
  const effort = validModelEffort(config);

  try {
    return {
      provider: config.provider,
      modelId: config.model,
      model: await adapter.createModel(config, options.fetch),
      ...(effort === undefined ? {} : { effort }),
    };
  } catch (error) {
    if (error instanceof LLMError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new LLMConfigError(`Cannot build the ${config.provider} model: ${detail}`, config.provider);
  }
}

/**
 * What a turn asks for when this model's thinking is the thing that loses the cell: a profile's
 * quiet switch (`suppressPlanReasoning`, `suppressAgentReasoning` in `models/profile.ts`).
 *
 * A REQUEST FIELD and not a word in the prompt, which is the whole reason it is acceptable:
 * every planning rule in `investigation.ts` is wording a measured cell depends on, and nothing
 * here touches it. The in-prompt `/no_think` marker was tried first and abandoned - see the
 * model's entry.
 */
export const PLAN_NO_REASONING_EFFORT = "none";

/** Provider options in the shape the SDK takes them: one object per provider package's own key. */
export type AgentProviderOptions = Record<string, Record<string, string | boolean | null>>;

/**
 * The provider options every agent call to a model sends, built in one place so the capability
 * probe asks the model exactly what a run will ask it.
 *
 * Keyed `openai` whatever the kind is called, because the three OpenAI-compatible kinds are all
 * `@ai-sdk/openai` models and that package reads its options under its OWN key. Keying them by
 * the provider's name once passed every test and sent nothing at all on a real Ollama run.
 *
 * For the `openai` kind, which is OpenAI's Responses API:
 *
 *  - `store: false`, always: a run sends database schemas and rows, and OpenAI must not retain
 *    them. Stateless mode is also why each turn's reasoning comes back encrypted and is replayed
 *    with the next one; the SDK asks for that content itself once `store` is false.
 *  - `reasoningSummary: null`, always: the SDK otherwise asks for a detailed summary whenever an
 *    effort is set. Nothing in a run reads it, and OpenAI may require organization verification
 *    before it serves one, which would turn a setting nobody asked for into a refused request.
 *  - `reasoningEffort`: `LLM_MODEL_EFFORT` when the operator set it, which wins over a profile's
 *    quiet switch; otherwise the quiet switch's `none`; otherwise nothing, the model's default.
 *
 * For `ollama` and `custom` only the quiet switch, as before this options object existed, so the
 * bytes those endpoints receive do not move. `gemini` reads its own key, so the `openai` object a
 * quiet switch builds reaches nothing there.
 *
 * @param quiet - whether the model's profile asks this turn for no reasoning
 */
export function agentProviderOptions(
  agentModel: Pick<AgentModel, "provider" | "effort">,
  quiet = false,
): AgentProviderOptions | undefined {
  const effort = agentModel.effort ?? (quiet ? PLAN_NO_REASONING_EFFORT : undefined);
  if (agentModel.provider === "openai") {
    return {
      openai: { store: false, reasoningSummary: null, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    };
  }
  return effort === undefined ? undefined : { openai: { reasoningEffort: effort } };
}

/**
 * The SDK's refusal of a reasoning effort, as the error it has to be.
 *
 * `@ai-sdk/openai` keeps its own table of which efforts a model takes (GPT-6.1 Sol has no `none`)
 * and treats a non-reasoning model as taking none. An effort outside it is not sent and not
 * refused by the API either: the SDK drops it, warns, and sends the request at the model's
 * default effort. A run on an effort the operator did not ask for is the silent fallback this
 * repository refuses, so every caller reads the call's warnings and raises this instead.
 *
 * @returns the error to raise, or undefined when no effort was dropped
 */
export function refusedEffortError(
  warnings: readonly CallWarning[] | undefined,
  agentModel: Pick<AgentModel, "provider" | "modelId" | "effort">,
): LLMConfigError | undefined {
  const dropped = warnings?.find(
    (warning): warning is UnsupportedWarning => warning.type === "unsupported" && warning.feature === "reasoningEffort",
  );
  if (dropped === undefined) return undefined;
  return new LLMConfigError(effortRefusalMessage(agentModel, dropped.details), agentModel.provider);
}

type UnsupportedWarning = Extract<CallWarning, { type: "unsupported" }>;

// The sentence is one template from parts built a statement each: bun's line coverage under-counts
// the continuation lines of multi-line string concatenation.
const effortRefusalMessage = (
  agentModel: Pick<AgentModel, "provider" | "modelId" | "effort">,
  details: string | undefined,
): string => {
  const subject =
    agentModel.effort === undefined
      ? "The reasoning effort this model's profile asks for"
      : `LLM_MODEL_EFFORT "${agentModel.effort}"`;
  const reason = details === undefined ? "." : `: ${details.replace(/\.$/, "")}.`;
  const advice = agentModel.effort === undefined ? "" : " Change LLM_MODEL_EFFORT or unset it.";
  return `${subject} was refused for the model "${agentModel.modelId}" (${agentModel.provider})${reason}${advice}`;
};

/**
 * An `APICallError`'s message, plus the transport's own words when only its `cause` carries them.
 *
 * Since `@ai-sdk/provider-utils` 5.0.33 a body that breaks mid-stream (a dropped socket, an Ollama
 * server killed while answering) surfaces as "Failed to process successful response" with the
 * socket's message on `cause` alone, so the user would be told nothing about what broke. Only a
 * cause the SDK did not raise itself is appended: an SDK cause such as a JSON parse failure can
 * quote the response body, and a cause the message already quotes ("Cannot connect to API: ...")
 * is not repeated.
 */
function withTransportCause(error: APICallError): string {
  const { cause } = error;
  if (!(cause instanceof Error) || AISDKError.isInstance(cause)) return error.message;
  if (error.message.includes(cause.message)) return error.message;
  return `${error.message}: ${cause.message}`;
}

/**
 * Translate an SDK failure into this repository's error vocabulary, so the agent
 * run loop catches the same classes every other LLM caller does. Errors already
 * in that vocabulary pass through unchanged.
 */
export function mapAgentModelError(error: unknown, provider: LLMProviderType): LLMError {
  if (error instanceof LLMError) return error;

  // Marker-based checks, not instanceof: they hold across duplicate copies of
  // the SDK in a dependency tree, which instanceof does not.
  if (LoadAPIKeyError.isInstance(error)) return new LLMConfigError(error.message, provider);

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) return new LLMAuthError(error.message, provider);
    if (error.statusCode === 429) return new LLMRateLimitError(error.message, provider);
    return new LLMStreamError(withTransportCause(error), provider);
  }

  return new LLMStreamError(error instanceof Error ? error.message : String(error), provider);
}

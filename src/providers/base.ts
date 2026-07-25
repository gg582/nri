import { z } from "zod";

/** A single chat message handed to a provider strategy. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options every provider strategy must honor. */
export interface InvokeOptions {
  /** Sampling temperature. Deterministic pipeline nodes should use 0. */
  temperature?: number;
  /** Hard cap on output tokens for this call. */
  maxTokens?: number;
}

/**
 * Strategy interface: one concrete implementation per LLM provider.
 *
 * The harness only ever talks to this interface; adding a new provider
 * means adding one class and registering it in the factory.
 */
export interface LLMProviderStrategy {
  /** Stable identifier, e.g. "openai", "claude", "kimi". */
  readonly name: string;
  /** The concrete model id in use, for logging/tracing. */
  readonly model: string;

  /** Free-form chat completion. */
  invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string>;

  /**
   * Structured JSON completion. The strategy must steer the model toward
   * schema-conformant JSON; the harness validates with zod and retries
   * through `invokeJsonWithRetry` on parse/validation failure.
   */
  invokeJson<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    opts?: InvokeOptions,
  ): Promise<T>;
}

/** Extract the first JSON object/array from a model response. */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error("No JSON found in model response");
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  if (end <= start) throw new Error("Unbalanced JSON in model response");
  return candidate.slice(start, end + 1);
}

/**
 * Shared JSON-enforcement loop: invoke -> extract -> zod-validate.
 * On failure, feed the error back to the model and retry (self-correction).
 * When retries are exhausted, run one salvage pass: the content is usually
 * fine and only the JSON wrapping failed, so ask the model to reformat its
 * own last answer instead of regenerating from scratch.
 */
export async function invokeJsonWithRetry<T>(
  provider: LLMProviderStrategy,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  opts?: InvokeOptions & { retries?: number },
): Promise<T> {
  const retries = opts?.retries ?? 2;
  const history: ChatMessage[] = [...messages];
  let lastError = "";
  let lastRaw = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      history.push({
        role: "user",
        content:
          `Your previous response failed validation: ${lastError}\n` +
          "Respond again with ONLY a valid JSON value matching the required schema. No prose, no markdown fences.",
      });
    }
    const raw = await provider.invoke(history, opts);
    lastRaw = raw;
    history.push({ role: "assistant", content: raw });
    try {
      return schema.parse(JSON.parse(extractJson(raw)));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (lastRaw) {
    try {
      const salvaged = await provider.invoke(
        [
          ...messages,
          { role: "assistant", content: lastRaw },
          {
            role: "user",
            content:
              "Your response above could not be parsed as JSON. Reformat the SAME content into " +
              "ONLY a valid JSON value matching the requested schema — no prose, no markdown " +
              "fences, and do not drop any file content.",
          },
        ],
        opts,
      );
      return schema.parse(JSON.parse(extractJson(salvaged)));
    } catch (err) {
      lastError += `; salvage reformat also failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`Structured output failed after ${retries + 1} attempts: ${lastError}`);
}

/** Convenience base class implementing invokeJson on top of invoke. */
export abstract class BaseProviderStrategy implements LLMProviderStrategy {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string>;

  invokeJson<T>(messages: ChatMessage[], schema: z.ZodType<T>, opts?: InvokeOptions): Promise<T> {
    return invokeJsonWithRetry(this, messages, schema, opts);
  }
}

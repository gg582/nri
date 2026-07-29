import { z } from "zod";
import { repairJson } from "../tools/jsonRepair.js";

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
  /**
   * invokeJson only: schema-validation retries after the first attempt
   * (default 2). Lower it for large structured calls where a retry
   * re-sends a big prompt.
   */
  retries?: number;
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
   * Optional vision call: critique/describe an image (screenshot). Present
   * only on multimodal strategies; the visual-check node skips otherwise.
   */
  invokeVision?(prompt: string, imagePath: string): Promise<string>;

  /**
   * Optional token streaming: yield raw text deltas as the model produces
   * them. Consumers that only need the final string may concatenate the
   * deltas; consumers like the implementation nodes parse file blocks out of
   * the stream incrementally. Strategies that cannot stream simply omit it.
   */
  stream?(messages: ChatMessage[], opts?: InvokeOptions): AsyncIterable<string>;

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
 * Shared JSON-enforcement loop, in escalating stages:
 *   1. deterministic repair of the response (free: close cut-off strings and
 *      brackets — the usual output-limit truncation),
 *   2. feed the error (with a snippet around the failure position) back to
 *      the model and retry,
 *   3. one salvage pass asking the model to reformat its own last answer.
 * Failed responses are kept in the retry history only as bounded snippets —
 * re-sending a full large structured output on every attempt would inflate
 * each retry's prompt and latency. Model *switching* is handled one level
 * up by TrialStrategy.invokeJson.
 */
export async function invokeJsonWithRetry<T>(
  provider: LLMProviderStrategy,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  opts?: InvokeOptions,
): Promise<T> {
  const retries = opts?.retries ?? 2;
  const history: ChatMessage[] = [...messages];
  let lastError = "";
  let lastRaw = "";

  const tryParse = (raw: string): { ok: boolean; value?: T; error: string } => {
    const candidates: string[] = [];
    try {
      candidates.push(extractJson(raw));
    } catch (err) {
      candidates.push(raw);
      lastError = err instanceof Error ? err.message : String(err);
    }
    const repaired = repairJson(candidates[0]);
    if (repaired !== candidates[0]) candidates.push(repaired);
    for (const candidate of candidates) {
      try {
        return { ok: true, value: schema.parse(JSON.parse(candidate)), error: "" };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return { ok: false, error: lastError };
  };

  const feedback = (error: string, raw: string): string => {
    const pos = error.match(/position (\d+)/)?.[1];
    const snippet = pos
      ? `\nNear the failure point: ...${raw.slice(Math.max(0, Number(pos) - 80), Number(pos) + 80)}...`
      : "";
    return (
      `Your previous response failed validation: ${error}${snippet}\n` +
      "Respond again with ONLY a valid JSON value matching the required schema. No prose, no markdown fences."
    );
  };

  /** Bounded stand-in for a failed response kept in the retry history. */
  const snippetForHistory = (raw: string, limit = 2000): string => {
    if (raw.length <= limit) return raw;
    const half = Math.floor(limit / 2);
    return `${raw.slice(0, half)}\n...[${raw.length - limit} chars omitted]...\n${raw.slice(-half)}`;
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) history.push({ role: "user", content: feedback(lastError, lastRaw) });
    const started = Date.now();
    const raw = await provider.invoke(history, opts);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    lastRaw = raw;
    history.push({ role: "assistant", content: snippetForHistory(raw) });
    const { ok, value, error } = tryParse(raw);
    if (ok) return value as T;
    console.error(
      `nri: structured output attempt ${attempt + 1}/${retries + 1} failed validation after ${elapsed}s ` +
        `(${error.split("\n")[0].slice(0, 160)})`,
    );
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
      const { ok, value } = tryParse(salvaged);
      if (ok) return value as T;
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

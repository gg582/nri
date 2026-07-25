import { loadConfig } from "../config.js";
import { z } from "zod";
import {
  BaseProviderStrategy,
  type ChatMessage,
  type InvokeOptions,
  type LLMProviderStrategy,
} from "./base.js";
import { createProvider, parseModelSpec } from "./factory.js";

/**
 * Ordered trial pool: invoke tries each strategy in turn; one that errors is
 * benched for the rest of the process and the next spec takes over. `name`
 * and `model` always reflect the model currently serving (for logs/headers).
 */
export class TrialStrategy extends BaseProviderStrategy {
  private readonly strategies: LLMProviderStrategy[];
  private readonly benched = new Set<number>();
  private readonly onFallback?: (message: string) => void;

  constructor(strategies: LLMProviderStrategy[], opts?: { onFallback?: (message: string) => void }) {
    super();
    if (strategies.length === 0) throw new Error("TrialStrategy needs at least one strategy");
    this.strategies = strategies;
    this.onFallback = opts?.onFallback;
  }

  private get active(): LLMProviderStrategy {
    return this.strategies.find((_, i) => !this.benched.has(i)) ?? this.strategies[0];
  }

  get name(): string {
    try {
      return this.active.name;
    } catch {
      return "pool";
    }
  }

  get model(): string {
    try {
      return this.active.model;
    } catch {
      return "?";
    }
  }

  /** Notify a member failure (guarded: the member may not even construct). */
  private notifyFailure(index: number, err: unknown): void {
    let label = `pool member #${index + 1}`;
    try {
      label = `${this.strategies[index].name}/${this.strategies[index].model}`;
    } catch {
      /* keep generic label */
    }
    const message =
      `nri: ${label} failed (${err instanceof Error ? err.message : String(err)}) ` +
      "— trying next model in pool";
    if (this.onFallback) this.onFallback(message);
    else console.error(message);
  }

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    let lastError: unknown = new Error("all models in the trial pool failed");
    for (let i = 0; i < this.strategies.length; i++) {
      if (this.benched.has(i)) continue;
      try {
        return await this.strategies[i].invoke(messages, opts);
      } catch (err) {
        this.benched.add(i);
        lastError = err;
        this.notifyFailure(i, err);
      }
    }
    throw lastError;
  }

  /**
   * Structured output with model escalation: when a member's own
   * retry/repair loop is exhausted, the next pool model takes over the same
   * request instead of failing the whole call.
   */
  override async invokeJson<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    opts?: InvokeOptions,
  ): Promise<T> {
    let lastError: unknown = new Error("all models in the trial pool failed");
    for (let i = 0; i < this.strategies.length; i++) {
      if (this.benched.has(i)) continue;
      try {
        return await this.strategies[i].invokeJson(messages, schema, opts);
      } catch (err) {
        this.benched.add(i);
        lastError = err;
        this.notifyFailure(i, err);
      }
    }
    throw lastError;
  }

  /** Vision critique with pool escalation (multimodal members only). */
  async invokeVision(prompt: string, imagePath: string): Promise<string> {
    let lastError: unknown = new Error("no multimodal model in the trial pool");
    for (let i = 0; i < this.strategies.length; i++) {
      if (this.benched.has(i)) continue;
      const member = this.strategies[i];
      if (!member.invokeVision) continue;
      try {
        return await member.invokeVision(prompt, imagePath);
      } catch (err) {
        this.benched.add(i);
        lastError = err;
        this.notifyFailure(i, err);
      }
    }
    throw lastError;
  }

  async *stream(messages: ChatMessage[], opts?: InvokeOptions): AsyncIterable<string> {
    let lastError: unknown = new Error("all models in the trial pool failed");
    for (let i = 0; i < this.strategies.length; i++) {
      if (this.benched.has(i)) continue;
      const member = this.strategies[i];
      if (!member.stream) continue;
      let yielded = false;
      try {
        for await (const delta of member.stream(messages, opts)) {
          yielded = true;
          yield delta;
        }
        return;
      } catch (err) {
        // Mid-stream failure leaves partial content downstream — no clean
        // failover, so propagate. Pre-yield failures fall through to the
        // next pool member as usual.
        if (yielded) throw err;
        this.benched.add(i);
        lastError = err;
        this.notifyFailure(i, err);
      }
    }
    throw lastError;
  }
}

/**
 * Build the per-node provider resolver.
 *
 * Resolution for a node (e.g. "triage", "implement"):
 *   1. config routing.nodes[node]   (spec or ordered trial pool)
 *   2. config routing.default       (spec or ordered trial pool)
 *   3. CLI --provider/--model
 *   4. NRI_PROVIDER env / "openai"
 *
 * Strategies are constructed lazily per call so a run only touches the
 * providers its nodes actually use.
 */
export function makeProviderResolver(cli?: {
  provider?: string;
  model?: string;
}, hooks?: { onFallback?: (message: string) => void }): (node: string) => LLMProviderStrategy {
  const config = loadConfig();
  const cache = new Map<string, LLMProviderStrategy>();
  const build = (spec: string): LLMProviderStrategy => {
    const { provider, model } = parseModelSpec(spec);
    return createProvider(provider, { model });
  };
  return (node: string) => {
    const raw = config.routing?.nodes?.[node] ?? config.routing?.default;
    const pool = (raw ? (Array.isArray(raw) ? raw : [raw]) : []).filter(Boolean);
    const key = pool.length > 0 ? pool.join(">") : `cli:${cli?.provider ?? ""}:${cli?.model ?? ""}`;
    let strategy = cache.get(key);
    if (!strategy) {
      if (pool.length === 0) {
        strategy = createProvider(cli?.provider, { model: cli?.model });
      } else {
        // Lazy pool members: only the first spec is built up front; the rest
        // are constructed on first fallback so unused providers never throw
        // (e.g. missing credentials for a backup model).
        strategy =
          pool.length === 1
            ? build(pool[0])
            : new TrialStrategy(lazyAll(pool, build), hooks);
      }
      cache.set(key, strategy);
    }
    return strategy;
  };
}

/** Build strategies lazily: first eagerly, the rest on first access. */
function lazyAll(
  specs: string[],
  build: (spec: string) => LLMProviderStrategy,
): LLMProviderStrategy[] {
  const built = new Map<number, LLMProviderStrategy>();
  return specs.map(
    (spec, i) =>
      new Proxy({} as LLMProviderStrategy, {
        get(_target, prop) {
          let s = built.get(i);
          if (!s) {
            s = build(spec);
            built.set(i, s);
          }
          const value = (s as unknown as Record<PropertyKey, unknown>)[prop];
          return typeof value === "function" ? (value as Function).bind(s) : value;
        },
      }),
  );
}

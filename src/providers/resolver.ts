import { loadConfig } from "../config.js";
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

  constructor(strategies: LLMProviderStrategy[]) {
    super();
    if (strategies.length === 0) throw new Error("TrialStrategy needs at least one strategy");
    this.strategies = strategies;
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

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    let lastError: unknown = new Error("all models in the trial pool failed");
    for (let i = 0; i < this.strategies.length; i++) {
      if (this.benched.has(i)) continue;
      try {
        return await this.strategies[i].invoke(messages, opts);
      } catch (err) {
        this.benched.add(i);
        lastError = err;
        // The failing member may not even construct (e.g. missing credentials),
        // so reading its name/model can itself throw — guard the label.
        let label = `pool member #${i + 1}`;
        try {
          label = `${this.strategies[i].name}/${this.strategies[i].model}`;
        } catch {
          /* keep generic label */
        }
        // console.error (not stderr.write) so the ink UI can render the notice.
        console.error(
          `nri: ${label} failed (${err instanceof Error ? err.message : String(err)}) ` +
            "— trying next model in pool",
        );
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
}): (node: string) => LLMProviderStrategy {
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
            : new TrialStrategy(lazyAll(pool, build));
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

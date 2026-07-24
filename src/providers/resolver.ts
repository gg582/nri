import { loadConfig } from "../config.js";
import type { LLMProviderStrategy } from "./base.js";
import { createProvider, parseModelSpec } from "./factory.js";

/**
 * Build the per-node provider resolver.
 *
 * Resolution for a node (e.g. "triage", "implement"):
 *   1. config routing.nodes[node]   ("provider:model" or "provider")
 *   2. config routing.default
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
  return (node: string) => {
    const spec = config.routing?.nodes?.[node] ?? config.routing?.default;
    const key = spec ?? `cli:${cli?.provider ?? ""}:${cli?.model ?? ""}`;
    let strategy = cache.get(key);
    if (!strategy) {
      if (spec) {
        const { provider, model } = parseModelSpec(spec);
        strategy = createProvider(provider, { model });
      } else {
        strategy = createProvider(cli?.provider, { model: cli?.model });
      }
      cache.set(key, strategy);
    }
    return strategy;
  };
}

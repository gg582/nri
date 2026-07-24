import { loadConfig } from "../config.js";
import type { LLMProviderStrategy } from "./base.js";
import {
  ClaudeStrategy,
  DeepSeekStrategy,
  GeminiStrategy,
  GrokStrategy,
  KimiStrategy,
  OpenAIStrategy,
  type StrategyOptions,
} from "./strategies.js";

export const PROVIDER_NAMES = ["openai", "gemini", "kimi", "deepseek", "grok", "claude"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Built-in default model per provider (used when config/env specify none). */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o",
  gemini: "gemini-2.5-flash",
  kimi: "kimi-k2-0905-preview",
  deepseek: "deepseek-chat",
  grok: "grok-4",
  claude: "claude-sonnet-4-20250514",
};

const ENV_KEYS: Record<ProviderName, string[]> = {
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
};

/** Registry mapping provider name -> strategy constructor (Strategy pattern). */
const registry: Record<ProviderName, (opts: StrategyOptions) => LLMProviderStrategy> = {
  openai: (o) => new OpenAIStrategy(o),
  gemini: (o) => new GeminiStrategy(o),
  kimi: (o) => new KimiStrategy(o),
  deepseek: (o) => new DeepSeekStrategy(o),
  grok: (o) => new GrokStrategy(o),
  claude: (o) => new ClaudeStrategy(o),
};

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Resolve the active provider strategy.
 * Precedence: explicit options > stored config credentials > env vars.
 * Name precedence: argument > NRI_PROVIDER env > first available provider > "openai".
 */
export function createProvider(name?: string, options: StrategyOptions = {}): LLMProviderStrategy {
  const resolved = (name ?? process.env.NRI_PROVIDER ?? availableProviders()[0] ?? "openai").toLowerCase();
  if (!isProviderName(resolved)) {
    throw new Error(`Unknown provider "${resolved}". Supported: ${PROVIDER_NAMES.join(", ")}`);
  }
  const stored = loadConfig().providers?.[resolved] ?? {};
  return registry[resolved]({
    model: options.model ?? stored.defaultModel,
    apiKey: options.apiKey ?? stored.apiKey,
    baseURL: options.baseURL ?? stored.baseURL,
  });
}

/** Providers usable right now: env key present OR credentials stored in config. */
export function availableProviders(): ProviderName[] {
  const stored = loadConfig().providers ?? {};
  return PROVIDER_NAMES.filter(
    (name) => ENV_KEYS[name].some((k) => process.env[k]) || stored[name]?.apiKey,
  );
}

/** Default model for a provider: stored config default > built-in default. */
export function defaultModelFor(name: ProviderName): string {
  return loadConfig().providers?.[name]?.defaultModel ?? DEFAULT_MODELS[name];
}

/** All model ids known for a provider (imported model list > default). */
export function modelsForProvider(name: ProviderName): string[] {
  const stored = loadConfig().providers?.[name];
  if (stored?.models?.length) return stored.models;
  return [defaultModelFor(name)];
}

/** Parse a "provider:model" spec; bare "provider" selects its default model. */
export function parseModelSpec(spec: string): { provider: ProviderName; model?: string } {
  const idx = spec.indexOf(":");
  const provider = (idx === -1 ? spec : spec.slice(0, idx)).toLowerCase();
  if (!isProviderName(provider)) {
    throw new Error(`Unknown provider "${provider}" in model spec "${spec}".`);
  }
  return { provider, model: idx === -1 ? undefined : spec.slice(idx + 1) };
}

import { loadConfig } from "../config.js";
import type { LLMProviderStrategy } from "./base.js";
import { AntigravityStrategy, antigravityAvailable } from "./antigravity.js";
import { CodexStrategy, codexAuthAvailable } from "./codex.js";
import { KimiCodeStrategy, kimiCodeCredAvailable } from "./kimiCode.js";
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
  // OpenAI credential precedence: explicit/stored API key > codex oauth
  // (imported) > OPENAI_API_KEY env. codex oauth serves ChatGPT-plan models
  // (gpt-5.6-*) that API keys without credit cannot call.
  openai: (o) =>
    o.apiKey || o.auth !== "codex-oauth" || !codexAuthAvailable()
      ? new OpenAIStrategy(o)
      : new CodexStrategy(o),
  // Gemini via antigravity oauth (imported): uses the agy CLI's Code Assist
  // quota, not the Gemini API-key quota.
  gemini: (o) =>
    o.auth === "antigravity-oauth" && antigravityAvailable()
      ? new AntigravityStrategy(o)
      : new GeminiStrategy(o),
  // Kimi via kimi-code oauth: re-reads the CLI's credential file per call
  // and refreshes on 401, instead of a stale import-time snapshot.
  kimi: (o) =>
    o.auth === "kimi-code-oauth" && kimiCodeCredAvailable()
      ? new KimiCodeStrategy(o)
      : new KimiStrategy(o),
  deepseek: (o) => new DeepSeekStrategy(o),
  grok: (o) => new GrokStrategy(o),
  claude: (o) => new ClaudeStrategy(o),
};

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Providers blocked via `blockedProviders` in config (case-insensitive). */
function blockedSet(): Set<string> {
  return new Set((loadConfig().blockedProviders ?? []).map((b) => b.toLowerCase()));
}

/**
 * Resolve the active provider strategy.
 * Precedence: explicit options > stored config credentials > env vars.
 * Name precedence: argument > NRI_PROVIDER env > first available provider > "openai".
 * A provider listed in `blockedProviders` never resolves, even on explicit request.
 */
export function createProvider(name?: string, options: StrategyOptions = {}): LLMProviderStrategy {
  const resolved = (name ?? process.env.NRI_PROVIDER ?? availableProviders()[0] ?? "openai").toLowerCase();
  if (!isProviderName(resolved)) {
    throw new Error(`Unknown provider "${resolved}". Supported: ${PROVIDER_NAMES.join(", ")}`);
  }
  if (blockedSet().has(resolved)) {
    throw new Error(`Provider "${resolved}" is blocked (blockedProviders in nri config).`);
  }
  const stored = loadConfig().providers?.[resolved] ?? {};
  return registry[resolved]({
    model: options.model ?? stored.defaultModel,
    apiKey: options.apiKey ?? stored.apiKey,
    baseURL: options.baseURL ?? stored.baseURL,
    auth: stored.auth,
  });
}

/** Providers usable right now: not blocked, and env key present OR credentials stored in config. */
export function availableProviders(): ProviderName[] {
  const stored = loadConfig().providers ?? {};
  const blocked = blockedSet();
  return PROVIDER_NAMES.filter(
    (name) =>
      !blocked.has(name) &&
      (ENV_KEYS[name].some((k) => process.env[k]) ||
        stored[name]?.apiKey ||
        (stored[name]?.auth === "codex-oauth" && codexAuthAvailable()) ||
        (stored[name]?.auth === "kimi-code-oauth" && kimiCodeCredAvailable()) ||
        (stored[name]?.auth === "antigravity-oauth" && antigravityAvailable())),
  );
}

/** Credentials for direct provider API calls (e.g. model listing): stored config > env. */
export function providerCredentials(name: ProviderName): { apiKey?: string; baseURL?: string } {
  const stored = loadConfig().providers?.[name];
  return {
    apiKey: stored?.apiKey ?? ENV_KEYS[name].map((k) => process.env[k]).find(Boolean),
    baseURL: stored?.baseURL,
  };
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

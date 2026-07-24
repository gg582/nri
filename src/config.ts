import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storePaths } from "./store/paths.js";

/** Credentials/settings for one provider, stored in nri config. */
export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  /** Credential mechanism: "codex-oauth" = tokens from ~/.codex/auth.json. */
  auth?: string;
  /** Extra model ids offered by this provider (e.g. imported from kimi-code). */
  models?: string[];
  /** Free-form provenance note, e.g. "imported from kimi-code (oauth token, expires ...)". */
  note?: string;
}

/**
 * Per-node model routing. Values are "provider:model" (or bare "provider")
 * specs — a single spec, or an ordered trial pool: on invoke failure the
 * resolver falls back to the next spec in the pool.
 */
export interface RoutingConfig {
  default?: string | string[];
  nodes?: Record<string, string | string[]>;
}

export interface NriConfig {
  locale?: string;
  providers?: Record<string, ProviderConfig>;
  routing?: RoutingConfig;
  permissions?: {
    mode?: "plan" | "auto" | "yolo";
    allow?: string[];
    deny?: string[];
  };
  /** Memory persistence: gen-1 JSONL store or gen-2 DB-backed RAG. */
  memory?: {
    backend?: "jsonl" | "rag";
  };
}

export const GLOBAL_CONFIG_PATH = storePaths().configFile;
export const CWD_CONFIG_PATH = join(process.cwd(), "nri.config.json");

function readJson(path: string): NriConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as NriConfig;
  } catch {
    return {};
  }
}

function merge(base: NriConfig, over: NriConfig): NriConfig {
  return {
    locale: over.locale ?? base.locale,
    providers: { ...base.providers, ...over.providers },
    routing: {
      default: over.routing?.default ?? base.routing?.default,
      nodes: { ...base.routing?.nodes, ...over.routing?.nodes },
    },
    permissions: {
      mode: over.permissions?.mode ?? base.permissions?.mode,
      allow: over.permissions?.allow ?? base.permissions?.allow,
      deny: over.permissions?.deny ?? base.permissions?.deny,
    },
    memory: {
      backend: over.memory?.backend ?? base.memory?.backend,
    },
  };
}

/** Load config: global (~/.config/nri/config.json) merged with cwd (nri.config.json). */
export function loadConfig(): NriConfig {
  return merge(readJson(GLOBAL_CONFIG_PATH), readJson(CWD_CONFIG_PATH));
}

/** Persist a partial config to the global config file (deep-merged). */
export function saveGlobalConfig(patch: NriConfig, opts?: { replaceProviders?: boolean }): void {
  const base = readJson(GLOBAL_CONFIG_PATH);
  const next = opts?.replaceProviders
    ? { ...merge(base, patch), providers: patch.providers }
    : merge(base, patch);
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

/** Mask a secret for display: keep first 4 / last 2 chars. */
export function maskKey(key?: string): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

/** Resolve the output locale: CLI flag > NRI_LOCALE env > config.locale > en-US. */
export function resolveLocale(cliLocale?: string): string {
  return cliLocale ?? process.env.NRI_LOCALE ?? loadConfig().locale ?? "en-US";
}

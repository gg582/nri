import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, maskKey, saveGlobalConfig, type ProviderConfig } from "../config.js";
import {
  availableProviders,
  isProviderName,
  providerCredentials,
  PROVIDER_NAMES,
  type ProviderName,
} from "../providers/factory.js";
import { fetchProviderModels } from "../providers/models.js";
import { codexCliDefaults } from "../providers/codex.js";

interface ImportResult {
  provider: string;
  config: ProviderConfig;
  source: string;
}

/* ---------------- importers: existing AI clients -> nri config ---------------- */

/** kimi-code: ~/.kimi-code/config.toml (provider base_url + models) + oauth credentials. */
function importKimiCode(): ImportResult[] {
  const tomlPath = join(homedir(), ".kimi-code", "config.toml");
  const credPath = join(homedir(), ".kimi-code", "credentials", "kimi-code.json");
  if (!existsSync(tomlPath) || !existsSync(credPath)) return [];

  const toml = readFileSync(tomlPath, "utf8");
  // Parse the [providers.*] section specifically — the first base_url in the
  // file belongs to unrelated [services.*] sections.
  const providerSection = toml.match(/\[providers\."[^"]+"\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
  const baseURL = providerSection.match(/base_url\s*=\s*"([^"]+)"/)?.[1];
  const models = [...toml.matchAll(/\[models\."[^"]+"\]\s*\n(?:[^\[]*\n)*?model\s*=\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );

  // No apiKey is stored: oauth tokens live in ~/.kimi-code and are re-read
  // per call (and refreshed on 401) by KimiCodeStrategy.
  return [
    {
      provider: "kimi",
      source: "kimi-code",
      config: {
        auth: "kimi-code-oauth",
        baseURL,
        defaultModel: models[0],
        models,
        note: "imported from kimi-code (oauth; tokens re-read from ~/.kimi-code per call)",
      },
    },
  ];
}

/** antigravity: token file presence only — calls mimic the agy CLI (separate quota). */
function importAntigravity(): ImportResult[] {
  const tokenPath = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  if (!existsSync(tokenPath)) return [];
  const existing = loadConfig().providers?.gemini ?? {};
  return [
    {
      provider: "gemini",
      source: "antigravity",
      config: {
        auth: "antigravity-oauth",
        defaultModel: existing.defaultModel ?? "gemini-3-flash",
        note: "imported from antigravity (oauth; agy CLI mimicry — separate from API-key quota)",
      },
    },
  ];
}

/** codex: ~/.codex/auth.json — oauth tokens (ChatGPT plan) preferred, else a plain OPENAI_API_KEY. */
function importCodex(): ImportResult[] {
  const authPath = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) return [];
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
      OPENAI_API_KEY?: string;
      tokens?: { access_token?: string };
    };
    if (auth.tokens?.access_token) {
      const defaults = codexCliDefaults();
      return [
        {
          provider: "openai",
          source: "codex",
          config: {
            auth: "codex-oauth",
            ...(defaults.model ? { defaultModel: defaults.model } : {}),
            note: "imported from codex auth.json (oauth; tokens re-read from ~/.codex/auth.json per call)",
          },
        },
      ];
    }
    if (!auth.OPENAI_API_KEY) return [];
    return [
      {
        provider: "openai",
        source: "codex",
        config: { apiKey: auth.OPENAI_API_KEY, note: "imported from codex auth.json" },
      },
    ];
  } catch {
    return [];
  }
}

const IMPORTERS: Record<string, () => ImportResult[]> = {
  "kimi-code": importKimiCode,
  codex: importCodex,
  antigravity: importAntigravity,
  // claude-code and gemini-cli store oauth tokens in OS-specific vaults with
  // no plain API key — importing them is out of scope; use env keys instead.
};

/* ---------------- subcommands ---------------- */

export function providerList(): void {
  const config = loadConfig();
  const active = new Set(availableProviders());
  stdout.write("providers (* = credentials available):\n");
  for (const name of PROVIDER_NAMES) {
    const stored = config.providers?.[name];
    const mark = active.has(name) ? "*" : " ";
    const model = stored?.defaultModel ? ` default=${stored.defaultModel}` : "";
    const key = stored?.apiKey ? ` key=${maskKey(stored.apiKey)}` : "";
    const note = stored?.note ? ` — ${stored.note}` : "";
    stdout.write(` ${mark} ${name}${model}${key}${note}\n`);
  }
}

export function providerImport(client?: string): void {
  const names = client ? [client] : Object.keys(IMPORTERS);
  let imported = 0;
  for (const name of names) {
    const importer = IMPORTERS[name];
    if (!importer) {
      stdout.write(`no importer for "${name}" (supported: ${Object.keys(IMPORTERS).join(", ")})\n`);
      continue;
    }
    const results = importer();
    if (results.length === 0) {
      stdout.write(`skipped ${name}: no importable plain API key found (oauth-only or missing config).\n`);
      continue;
    }
    for (const result of results) {
      if (!isProviderName(result.provider)) continue;
      const existing = loadConfig().providers ?? {};
      saveGlobalConfig({
        providers: { ...existing, [result.provider]: { ...existing[result.provider], ...result.config } },
      });
      stdout.write(
        `imported ${result.provider} from ${result.source}: key=${maskKey(result.config.apiKey)}` +
          (result.config.baseURL ? ` base=${result.config.baseURL}` : "") +
          (result.config.models?.length ? ` models=[${result.config.models.join(", ")}]` : "") +
          "\n",
      );
      imported++;
    }
  }
  if (imported === 0) {
    stdout.write("nothing imported (no supported client configs found, or no plain API keys).\n");
    stdout.write("note: claude-code / gemini-cli use oauth vaults — set ANTHROPIC_API_KEY / GEMINI_API_KEY instead.\n");
  }
}

export async function providerAdd(
  name?: string,
  opts?: { apiKey?: string; baseURL?: string; defaultModel?: string },
): Promise<void> {
  // Non-interactive path (TUI wizard / scripted use): all fields supplied.
  if (name && opts) {
    if (!isProviderName(name)) throw new Error(`unknown provider "${name}"`);
    const entry: ProviderConfig = {
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
      note: "manual entry",
    };
    const existing = loadConfig().providers ?? {};
    saveGlobalConfig({ providers: { ...existing, [name]: { ...existing[name], ...entry } } });
    stdout.write(`saved provider "${name}" (key=${maskKey(entry.apiKey)})\n`);
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const provider = (name ?? (await rl.question(`provider name (${PROVIDER_NAMES.join("/")}): `)))
      .trim()
      .toLowerCase();
    if (!isProviderName(provider)) throw new Error(`unknown provider "${provider}"`);
    const apiKey = (await rl.question("api key (leave empty to use env var): ")).trim();
    const baseURL = (await rl.question("base url (optional): ")).trim();
    const defaultModel = (await rl.question("default model (optional): ")).trim();
    const entry: ProviderConfig = {
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      note: "manual entry",
    };
    const existing = loadConfig().providers ?? {};
    saveGlobalConfig({ providers: { ...existing, [provider]: { ...existing[provider], ...entry } } });
    stdout.write(`saved provider "${provider}" (key=${maskKey(entry.apiKey)})\n`);
  } finally {
    rl.close();
  }
}

export function providerRemove(name?: string): void {
  if (!name) throw new Error("usage: nri provider remove <name>");
  const existing = loadConfig().providers ?? {};
  if (!(name in existing)) {
    stdout.write(`provider "${name}" not in config\n`);
    return;
  }
  delete existing[name];
  // replaceProviders: a delete must not be resurrected by base-merge.
  saveGlobalConfig({ providers: existing }, { replaceProviders: true });
  stdout.write(`removed provider "${name}"\n`);
}

/**
 * Fetch the live model list from each provider's API and store it in config.
 * Refreshed models become candidates for `nri model assign` / `candidates`.
 */
export async function providerRefresh(name?: string): Promise<void> {
  let targets: ProviderName[];
  if (name) {
    if (!isProviderName(name)) throw new Error(`unknown provider "${name}"`);
    targets = [name];
  } else {
    targets = availableProviders();
  }
  if (targets.length === 0) {
    stdout.write("no providers available — run `nri provider import` or `nri provider add` first.\n");
    return;
  }
  for (const target of targets) {
    const creds = providerCredentials(target);
    if (!creds.apiKey) {
      stdout.write(`${target}: no credentials — skipped.\n`);
      continue;
    }
    try {
      const models = await fetchProviderModels(target, { apiKey: creds.apiKey, baseURL: creds.baseURL });
      const existing = loadConfig().providers ?? {};
      saveGlobalConfig({ providers: { ...existing, [target]: { ...existing[target], models } } });
      const sample = models.slice(0, 3).join(", ") + (models.length > 3 ? ", …" : "");
      stdout.write(`${target}: ${models.length} models saved (${sample})\n`);
    } catch (err) {
      stdout.write(`${target}: refresh failed — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

/** Entry point for `nri provider ...` / `nri /provider ...`. */
export async function providerCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case undefined:
      providerList();
      return;
    case "import":
      providerImport(rest[0]);
      return;
    case "add":
      await providerAdd(rest[0]);
      return;
    case "remove":
      providerRemove(rest[0]);
      return;
    case "refresh":
      await providerRefresh(rest[0]);
      return;
    default:
      throw new Error(`unknown provider subcommand "${sub}" (list|import|add|remove|refresh)`);
  }
}

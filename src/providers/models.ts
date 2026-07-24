import type { ProviderName } from "./factory.js";

/** Default base URLs for each provider's model-list endpoint. */
const LIST_BASE: Record<ProviderName, string> = {
  openai: "https://api.openai.com/v1",
  kimi: "https://api.moonshot.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  grok: "https://api.x.ai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  claude: "https://api.anthropic.com/v1",
};

/** Ids that are not chat models (OpenAI also returns embeddings, audio, image, ...). */
const NON_CHAT = /embed|whisper|dall-?e|tts|moderation|transcribe|realtime|audio|image|babbage|davinci/i;

/** OpenAI-compatible `GET {base}/models` (openai, kimi, deepseek, grok). */
async function fetchOpenAICompatible(baseURL: string, apiKey: string): Promise<string[]> {
  const base = baseURL.replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/models`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

/** Gemini `GET /v1beta/models?key=...` — names arrive as "models/<id>". */
async function fetchGeminiModels(baseURL: string, apiKey: string): Promise<string[]> {
  const base = baseURL.replace(/\/+$/, "");
  const res = await fetch(`${base}/models?key=${apiKey}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/models`);
  const body = (await res.json()) as {
    models?: { name?: string; supportedGenerationMethods?: string[] }[];
  };
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => (m.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
}

/** Anthropic `GET /v1/models` (x-api-key + anthropic-version headers). */
async function fetchClaudeModels(baseURL: string, apiKey: string): Promise<string[]> {
  const base = baseURL.replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/models`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

/**
 * Query the provider's live model-list API and return chat-model ids,
 * de-duplicated and sorted. Throws on HTTP/network errors.
 */
export async function fetchProviderModels(
  name: ProviderName,
  creds: { apiKey: string; baseURL?: string },
): Promise<string[]> {
  const baseURL =
    creds.baseURL ?? (name === "kimi" ? process.env.KIMI_BASE_URL : undefined) ?? LIST_BASE[name];
  const models =
    name === "gemini"
      ? await fetchGeminiModels(baseURL, creds.apiKey)
      : name === "claude"
        ? await fetchClaudeModels(baseURL, creds.apiKey)
        : await fetchOpenAICompatible(baseURL, creds.apiKey);
  return [...new Set(models.filter((id) => !NON_CHAT.test(id)))].sort();
}

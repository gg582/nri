import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseProviderStrategy, type ChatMessage, type InvokeOptions } from "./base.js";
import type { StrategyOptions } from "./strategies.js";

/**
 * OpenAI via codex CLI OAuth (ChatGPT account) instead of an API key.
 *
 * codex CLI stores oauth tokens in ~/.codex/auth.json and talks to the
 * ChatGPT backend's Responses endpoint — this is where account-level models
 * (gpt-5.6-terra/luna/sol, ...) are served with ChatGPT-plan quota, even
 * when the api.openai.com key has no credit. Tokens are re-read from disk
 * per call (codex CLI refreshes the file itself); on 401 we run the same
 * refresh grant codex uses and write the new tokens back.
 */

const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Public client id of the official codex CLI (from its source). */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
    refresh_token?: string;
  };
  [key: string]: unknown;
}

function readCodexAuth(): CodexAuth | null {
  if (!existsSync(CODEX_AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8")) as CodexAuth;
  } catch {
    return null;
  }
}

/** True when a usable codex oauth token is present on disk. */
export function codexAuthAvailable(): boolean {
  return Boolean(readCodexAuth()?.tokens?.access_token);
}

/** Defaults discovered from the codex CLI config (model, reasoning effort). */
export function codexCliDefaults(): { model?: string; reasoningEffort?: string } {
  if (!existsSync(CODEX_CONFIG_PATH)) return {};
  try {
    const toml = readFileSync(CODEX_CONFIG_PATH, "utf8");
    return {
      model: toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1],
      reasoningEffort: toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1],
    };
  } catch {
    return {};
  }
}

/** Run the oauth refresh grant and persist new tokens back to auth.json. */
async function refreshCodexToken(): Promise<void> {
  const auth = readCodexAuth();
  const refreshToken = auth?.tokens?.refresh_token;
  if (!auth || !refreshToken) throw new Error("codex oauth refresh_token missing — run `codex login`");
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`codex oauth refresh failed (HTTP ${res.status}) — run \`codex login\``);
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!body.access_token) throw new Error("codex oauth refresh returned no access_token");
  auth.tokens = {
    ...auth.tokens,
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
  };
  writeFileSync(CODEX_AUTH_PATH, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
}

interface SseEvent {
  type?: string;
  delta?: string;
  response?: {
    error?: { message?: string };
    output?: { content?: { type?: string; text?: string }[] }[];
  };
}

/** Accumulate assistant text from a buffered SSE stream of Responses events. */
function parseSseText(body: string): string {
  let text = "";
  let completed: SseEvent["response"] | null = null;
  for (const chunk of body.split("\n\n")) {
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    const payload = dataLine.slice(6);
    if (payload === "[DONE]") continue;
    let evt: SseEvent;
    try {
      evt = JSON.parse(payload) as SseEvent;
    } catch {
      continue;
    }
    if (evt.type === "response.output_text.delta") text += evt.delta ?? "";
    else if (evt.type === "response.completed") completed = evt.response ?? null;
    else if (evt.type === "response.failed")
      throw new Error(evt.response?.error?.message ?? "codex response failed");
  }
  if (!text && completed) {
    for (const item of completed.output ?? []) {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") text += part.text ?? "";
      }
    }
  }
  if (!text) throw new Error("empty response from codex backend");
  return text;
}

export class CodexStrategy extends BaseProviderStrategy {
  readonly name = "openai";
  readonly model: string;
  private readonly reasoningEffort: string;

  constructor(opts: StrategyOptions = {}) {
    super();
    if (!codexAuthAvailable()) throw new Error("codex oauth tokens not found — run `codex login`");
    const defaults = codexCliDefaults();
    this.model = opts.model ?? process.env.NRI_MODEL ?? defaults.model ?? "gpt-5.6-terra";
    this.reasoningEffort = defaults.reasoningEffort ?? "medium";
  }

  private buildPayload(messages: ChatMessage[], opts?: InvokeOptions): string {
    const instructions = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const input = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        type: "message",
        role: m.role,
        content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
      }));
    return JSON.stringify({
      model: this.model,
      instructions: instructions || "You are a helpful assistant.",
      input,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: this.reasoningEffort, summary: "auto" },
      store: false,
      stream: true,
      include: [],
      // note: the codex backend rejects max_output_tokens — opts.maxTokens is
      // intentionally not forwarded.
    });
  }

  private post(payload: string): Promise<Response> {
    const tokens = readCodexAuth()?.tokens ?? {};
    return fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "chatgpt-account-id": tokens.account_id ?? "",
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: payload,
    });
  }

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    const payload = this.buildPayload(messages, opts);
    let res = await this.post(payload);
    if (res.status === 401) {
      await refreshCodexToken();
      res = await this.post(payload);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`codex backend HTTP ${res.status}: ${detail}`);
    }
    return parseSseText(await res.text());
  }
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseProviderStrategy, type ChatMessage, type InvokeOptions } from "./base.js";
import type { StrategyOptions } from "./strategies.js";

/**
 * Gemini via the Antigravity CLI's Google oauth (antigravity CLI mimicry).
 *
 * The agy CLI stores a Google 3LO token in
 * ~/.gemini/antigravity-cli/antigravity-oauth-token and calls the Code
 * Assist internal API (cloudcode-pa v1internal) with it — quota there is
 * separate from a Gemini API-key quota, so this path does not consume the
 * latter. We reuse the CLI's embedded oauth client credentials for the
 * standard refresh grant, and mirror its request shape and headers.
 */

const TOKEN_PATH = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
const STATE_PATH = join(homedir(), ".gemini", "antigravity-cli", "jetski_state.pbtxt");
const AGY_PATH = join(homedir(), ".local", "bin", "agy");
const CLOUD_CODE = process.env.CLOUD_CODE_URL ?? "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = "antigravity/1.1.6 linux/x64";

interface OauthClient {
  id: string;
  secret: string;
}

let cachedClients: OauthClient[] | null = null;

/**
 * Extract the oauth client id/secret pairs embedded in the agy CLI binary
 * (local state, not hardcoded credentials). Ids and secrets sit in the same
 * order in the string table; pairing is validated at refresh time — a pair
 * rejected with invalid_client is skipped for the next one.
 */
function agyOauthClients(): OauthClient[] {
  if (cachedClients) return cachedClients;
  const path = process.env.AGY_PATH ?? AGY_PATH;
  cachedClients = [];
  if (existsSync(path)) {
    const bin = readFileSync(path, "latin1");
    const ids = [...bin.matchAll(/\d{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g)].map((m) => m[0]);
    const secrets = [...bin.matchAll(/GOCSPX-[A-Za-z0-9_-]{20,}/g)].map((m) => m[0]);
    cachedClients = ids.slice(0, secrets.length).map((id, i) => ({ id, secret: secrets[i] }));
  }
  return cachedClients;
}

interface TokenFile {
  token?: {
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    expiry?: string; // RFC3339
  };
  [key: string]: unknown;
}

function readTokenFile(): TokenFile | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as TokenFile;
  } catch {
    return null;
  }
}

/** True when an antigravity oauth token file with a refresh token exists. */
export function antigravityAvailable(): boolean {
  return Boolean(readTokenFile()?.token?.refresh_token);
}

/** Standard Google 3LO refresh; persists the rotated token back to disk. */
async function refreshToken(): Promise<string> {
  const file = readTokenFile();
  const refresh = file?.token?.refresh_token;
  if (!file || !refresh) throw new Error("antigravity refresh_token missing — run `agy` to log in again");
  const clients = agyOauthClients();
  if (clients.length === 0) {
    throw new Error("agy CLI binary not found — install antigravity and run `agy` to log in");
  }
  let lastError = "no oauth client pairs";
  for (const client of clients) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
      if (!body.access_token) throw new Error("antigravity oauth refresh returned no access_token");
      file.token = {
        ...file.token,
        access_token: body.access_token,
        ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
        expiry: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      };
      writeFileSync(TOKEN_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
      return body.access_token;
    }
    lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status !== 400 && res.status !== 401) break; // server-side — rotating clients won't help
  }
  throw new Error(`antigravity oauth refresh failed (${lastError}) — run \`agy\` to log in again`);
}

/** Access token, refreshing when missing or within 60s of expiry. */
async function ensureToken(): Promise<string> {
  const token = readTokenFile()?.token;
  if (token?.access_token && token.expiry) {
    const msLeft = Date.parse(token.expiry) - Date.now();
    if (msLeft > 60_000) return token.access_token;
  }
  return refreshToken();
}

/** installation_uuid from the CLI state file, else a per-process uuid. */
function deviceId(): string {
  try {
    const state = readFileSync(STATE_PATH, "utf8");
    const m = state.match(/installation_uuid:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return randomUUID();
}

interface CloudCodeSse {
  /** v1internal wraps the GenerateContentResponse in a "response" envelope. */
  response?: {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string };
}

export class AntigravityStrategy extends BaseProviderStrategy {
  readonly name = "gemini";
  model: string;
  private project?: string;
  private models?: Record<string, { recommended?: boolean }>;
  private readonly sessionId = randomUUID();

  constructor(opts: StrategyOptions = {}) {
    super();
    if (!antigravityAvailable()) throw new Error("antigravity token not found — run `agy` to log in");
    this.model = opts.model ?? process.env.NRI_MODEL ?? "gemini-3-flash";
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "user-agent": USER_AGENT,
      "x-goog-api-client": "google-cloud-sdk vscode/1.86.0",
      "client-metadata": JSON.stringify({
        ideType: "INTELLIJ",
        platform: "LINUX",
        pluginType: "GEMINI",
        arch: "x64",
        sqmId: `{${randomUUID().toUpperCase()}}`,
      }),
      "x-client-device-id": deviceId(),
    };
  }

  /** Resolve the Cloud Code project once per process (loadCodeAssist). */
  private async resolveProject(token: string): Promise<string> {
    if (this.project) return this.project;
    try {
      const res = await fetch(`${CLOUD_CODE}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({
          metadata: { ideType: "INTELLIJ", platform: "LINUX", pluginType: "GEMINI" },
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { cloudaicompanionProject?: string };
        if (body.cloudaicompanionProject) {
          this.project = body.cloudaicompanionProject;
          return this.project;
        }
      }
    } catch {
      /* fall through to default */
    }
    this.project = "default";
    return this.project;
  }

  /** Discover available models once; ordered candidates: configured model
   * first (if served), then recommended gemini models, then the rest. */
  private async modelCandidates(token: string): Promise<string[]> {
    if (this.models === undefined) {
      try {
        const res = await fetch(`${CLOUD_CODE}/v1internal:fetchAvailableModels`, {
          method: "POST",
          headers: this.headers(token),
          body: "{}",
        });
        this.models = res.ok
          ? (((await res.json()) as { models?: Record<string, { recommended?: boolean }> }).models ?? {})
          : {};
      } catch {
        this.models = {};
      }
    }
    const names = Object.keys(this.models);
    if (names.length === 0) return [this.model];
    const recommended = names.filter((n) => this.models![n].recommended);
    const ordered = [
      ...(names.includes(this.model) ? [this.model] : []),
      ...recommended.filter((n) => n.startsWith("gemini") && n !== this.model),
      ...recommended.filter((n) => !n.startsWith("gemini") && n !== this.model),
    ];
    if (!names.includes(this.model) && ordered.length > 0 && ordered[0] !== this.model) {
      console.error(`nri: gemini/${this.model} not available on antigravity — falling back within the account's models`);
    }
    return ordered;
  }

  private async post(messages: ChatMessage[], opts: InvokeOptions | undefined, model: string): Promise<Response> {
    const token = await ensureToken();
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    return fetch(`${CLOUD_CODE}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({
        project: await this.resolveProject(token),
        model,
        request: {
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          ...(opts?.maxTokens ? { generationConfig: { maxOutputTokens: opts.maxTokens } } : {}),
        },
        requestType: "agent",
        userAgent: "antigravity",
        requestId: `agent-${randomUUID()}`,
      }),
    });
  }

  /** Consume an SSE body, yielding text deltas. */
  private async *consume(res: Response): AsyncIterable<string> {
    if (!res.body) throw new Error("cloudcode: empty response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let evt: CloudCodeSse;
        try {
          evt = JSON.parse(line.slice(6)) as CloudCodeSse;
        } catch {
          continue;
        }
        const inner = evt.response ?? evt;
        if (inner.error?.message) throw new Error(`cloudcode: ${inner.error.message}`);
        for (const candidate of inner.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (part.text) yield part.text;
          }
        }
      }
    }
  }

  async *stream(messages: ChatMessage[], opts?: InvokeOptions): AsyncIterable<string> {
    const candidates = await this.modelCandidates(await ensureToken());
    let lastError: unknown = new Error("cloudcode: no model candidates available");
    for (const model of candidates) {
      let res = await this.post(messages, opts, model);
      if (res.status === 401 || res.status === 403) {
        await refreshToken();
        res = await this.post(messages, opts, model);
      }
      if (res.status === 503) {
        const detail = (await res.text()).slice(0, 200);
        console.error(`nri: gemini/${model} unavailable (capacity) — trying next model`);
        lastError = new Error(`cloudcode HTTP 503: ${detail}`);
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`cloudcode HTTP ${res.status}: ${detail}`);
      }
      this.model = model;
      yield* this.consume(res);
      return;
    }
    throw lastError;
  }

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    let text = "";
    for await (const delta of this.stream(messages, opts)) text += delta;
    if (!text) throw new Error("empty response from cloudcode");
    return text;
  }
}

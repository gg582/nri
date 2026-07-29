import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseProviderStrategy, type ChatMessage, type InvokeOptions } from "./base.js";
import type { StrategyOptions } from "./strategies.js";
import {
  oauthClients,
  readTokenFile,
  writeTokenFile,
  type OauthClient,
} from "./antigravityAuth.js";

/**
 * Gemini via the Antigravity CLI's Google oauth (antigravity CLI mimicry).
 *
 * The agy CLI stores a Google 3LO token in
 * ~/.gemini/antigravity-cli/antigravity-oauth-token and calls the Code
 * Assist internal API (cloudcode-pa v1internal) with it — quota there is
 * separate from a Gemini API-key quota, so this path does not consume the
 * latter. Login and the embedded oauth client pairs live in
 * antigravityAuth.ts (`nri provider login antigravity`); here we only run
 * the standard refresh grant and mirror the request shape and headers.
 */

const STATE_PATH = join(homedir(), ".gemini", "antigravity-cli", "jetski_state.pbtxt");
const CLOUD_CODE = process.env.CLOUD_CODE_URL ?? "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = "antigravity/1.1.6 linux/x64";

/**
 * Client pair matching the token's auth_method first (as stored at login),
 * then the other — a pair rejected with invalid_client is skipped.
 */
function clientPairs(): OauthClient[] {
  const clients = oauthClients();
  const method = readTokenFile()?.auth_method === "gcp" ? "gcp" : "consumer";
  const first = clients[method];
  const second = clients[method === "gcp" ? "consumer" : "gcp"];
  return [first, second];
}

/** True when an antigravity oauth token file with a refresh token exists. */
export function antigravityAvailable(): boolean {
  return Boolean(readTokenFile()?.token?.refresh_token);
}

/** Standard Google 3LO refresh; persists the rotated token back to disk. */
async function refreshToken(): Promise<string> {
  const file = readTokenFile();
  const refresh = file?.token?.refresh_token;
  if (!file || !refresh) {
    throw new Error("antigravity refresh_token missing — run `nri provider login antigravity` (or `agy`) to log in again");
  }
  let lastError = "no oauth client pairs";
  for (const client of clientPairs()) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Go-http-client/1.1", // agy refreshes via Go's default http client
      },
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
      writeTokenFile({
        token: {
          ...file.token,
          access_token: body.access_token,
          ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
          expiry: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
        },
      });
      return body.access_token;
    }
    lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status !== 400 && res.status !== 401) break; // server-side — rotating clients won't help
  }
  throw new Error(`antigravity oauth refresh failed (${lastError}) — run \`nri provider login antigravity\` (or \`agy\`) to log in again`);
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
    if (!antigravityAvailable()) throw new Error("antigravity token not found — run `nri provider login antigravity` (or `agy`) to log in");
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

  async invokeVision(prompt: string, imagePath: string): Promise<string> {
    const data = readFileSync(imagePath).toString("base64");
    const token = await ensureToken();
    const res = await fetch(`${CLOUD_CODE}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({
        project: await this.resolveProject(token),
        model: await this.modelCandidates(token).then((c) => c[0]),
        request: {
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data } }],
            },
          ],
        },
        requestType: "agent",
        userAgent: "antigravity",
        requestId: `agent-${randomUUID()}`,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`cloudcode vision HTTP ${res.status}: ${detail}`);
    }
    let text = "";
    for await (const delta of this.consume(res)) text += delta;
    if (!text) throw new Error("empty vision response from cloudcode");
    return text;
  }

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    let text = "";
    for await (const delta of this.stream(messages, opts)) text += delta;
    if (!text) throw new Error("empty response from cloudcode");
    return text;
  }
}

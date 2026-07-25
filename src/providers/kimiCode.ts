import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, InvokeOptions } from "./base.js";
import { OpenAICompatibleStrategy, type StrategyOptions } from "./strategies.js";

/**
 * Kimi via kimi-code CLI oauth (like CodexStrategy for codex CLI).
 *
 * kimi-code stores oauth credentials in ~/.kimi-code/credentials/kimi-code.json
 * and refreshes them itself — but access tokens live only ~15 minutes
 * (expires_in=900), so nri re-reads the file before every call instead of
 * holding an import-time snapshot. On 401 we run the same refresh grant the
 * CLI uses (form POST to the auth host) and persist the rotated tokens back
 * so the CLI keeps working.
 */

const CRED_PATH = join(homedir(), ".kimi-code", "credentials", "kimi-code.json");
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
/** Public oauth client id embedded in the kimi-code CLI binary. */
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

interface KimiCodeCreds {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  [key: string]: unknown;
}

function readCreds(): KimiCodeCreds | null {
  if (!existsSync(CRED_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CRED_PATH, "utf8")) as KimiCodeCreds;
  } catch {
    return null;
  }
}

/** True when a usable kimi-code oauth credential file is present. */
export function kimiCodeCredAvailable(): boolean {
  return Boolean(readCreds()?.access_token);
}

/** Run the oauth refresh grant and persist rotated tokens back to disk. */
async function refreshKimiCodeToken(): Promise<void> {
  const creds = readCreds();
  if (!creds?.refresh_token) throw new Error("kimi-code refresh_token missing — run `kimi` to log in again");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`kimi-code oauth refresh failed (HTTP ${res.status}) — run \`kimi\` to log in again`);
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("kimi-code oauth refresh returned no access_token");
  const next: KimiCodeCreds = {
    ...creds,
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    ...(body.expires_in ? { expires_in: body.expires_in } : {}),
    expires_at: Math.floor(Date.now() / 1000) + (body.expires_in ?? 900),
  };
  writeFileSync(CRED_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function isAuthError(err: unknown): boolean {
  return /401|invalid or may have expired|authentication/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

export class KimiCodeStrategy extends OpenAICompatibleStrategy {
  constructor(opts: StrategyOptions = {}) {
    if (!kimiCodeCredAvailable()) throw new Error("kimi-code credentials not found — run `kimi` to log in");
    super({
      name: "kimi",
      model: opts.model ?? process.env.NRI_MODEL ?? "kimi-for-coding",
      apiKey: "resolved-per-call",
      baseURL: opts.baseURL ?? process.env.KIMI_BASE_URL ?? "https://api.kimi.com/coding/v1",
    });
    this.syncKey();
  }

  /** Pick up the freshest access_token (kimi-code CLI refreshes it often). */
  private syncKey(): void {
    const token = readCreds()?.access_token;
    if (token) this.args.apiKey = token;
  }

  /**
   * Proactive refresh grant: tokens live ~15 min, so renew when under 2 min
   * remain instead of burning a doomed call and waiting for the 401. If the
   * proactive refresh fails, fall through — the reactive 401 path below is
   * the backstop.
   */
  private async ensureFresh(): Promise<void> {
    const exp = readCreds()?.expires_at;
    if (exp && Date.now() / 1000 > exp - 120) {
      try {
        await refreshKimiCodeToken();
      } catch {
        /* backstop is the 401-reactive refresh */
      }
    }
  }

  async invoke(messages: ChatMessage[], opts?: InvokeOptions): Promise<string> {
    await this.ensureFresh();
    this.syncKey();
    try {
      return await super.invoke(messages, opts);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      await refreshKimiCodeToken();
      this.syncKey();
      return await super.invoke(messages, opts);
    }
  }

  async *stream(messages: ChatMessage[], opts?: InvokeOptions): AsyncIterable<string> {
    await this.ensureFresh();
    this.syncKey();
    let yielded = false;
    try {
      for await (const delta of super.stream(messages, opts)) {
        yielded = true;
        yield delta;
      }
      return;
    } catch (err) {
      // Failover is only clean before the first delta (see base stream).
      if (yielded || !isAuthError(err)) throw err;
    }
    await refreshKimiCodeToken();
    this.syncKey();
    yield* super.stream(messages, opts);
  }
}

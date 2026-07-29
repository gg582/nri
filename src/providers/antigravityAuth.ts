import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * 1:1 re-implementation of the Antigravity CLI (`agy`) Google OAuth login
 * flow, recovered by static disassembly of the agy binary
 * (google3/third_party/jetski/cli/backend/auth/auth).
 *
 * Verified behavior mirrored here:
 *  - consumer/gcp embedded client id+secret pairs (auth.getOauthParams)
 *  - scope list order, `openid` appended last (auth.getScopesByAuthMethod)
 *  - auth URL https://accounts.google.com/o/oauth2/auth with PKCE S256,
 *    access_type=offline, prompt=consent, and the hosted redirect
 *    https://antigravity.google/oauth-callback (auth.oauthMethod.StartInteractive)
 *  - state: 16 random bytes, verifier: 32 random bytes, both base64url
 *    without padding (auth.generateState / oauth2.GenerateVerifier)
 *  - browser opened via xdg-open only when no SSH_* env vars are set
 *  - pasted input: if it parses as a URL with a non-empty ?code=, that code
 *    is used, otherwise the raw string (oauthMethod.SubmitAuthorizationCode)
 *  - token exchange POST https://oauth2.googleapis.com/token with
 *    client_secret in the body (AuthStyleInParams / client_secret_post)
 *  - userinfo GET https://www.googleapis.com/oauth2/v2/userinfo (email only)
 *  - token file ~/.gemini/antigravity-cli/antigravity-oauth-token,
 *    merged JSON, dir 0755, file 0600 (auth.cliFileTokenStorage)
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "https://antigravity.google/oauth-callback";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
/** OAuth/userinfo calls in agy use Go's default http client UA. */
const GO_UA = "Go-http-client/1.1";

/** Base scopes in binary order; `openid` is appended last when absent. */
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "openid",
];

export interface OauthClient {
  id: string;
  secret: string;
}

const AGY_PATH = join(homedir(), ".local", "bin", "agy");

/**
 * Client id/secret prefixes as paired in auth.getOauthParams (disassembly).
 * Only prefixes live in the repo — full credentials are read from the local
 * agy binary at runtime, so nothing secret is committed and updated CLI
 * builds keep working as long as the pairing prefixes hold.
 */
const KNOWN_PAIRINGS: Record<"consumer" | "gcp", { idPrefix: string; secretPrefix: string }> = {
  consumer: { idPrefix: "1071006060591-", secretPrefix: "GOCSPX-K58" },
  gcp: { idPrefix: "884354919052-", secretPrefix: "GOCSPX-9YQ" },
};

export type AuthMethod = keyof typeof KNOWN_PAIRINGS;

let cachedClients: Record<AuthMethod, OauthClient> | null = null;

/** Extract and pair the oauth client credentials embedded in the agy binary. */
export function oauthClients(): Record<AuthMethod, OauthClient> {
  if (cachedClients) return cachedClients;
  const path = process.env.AGY_PATH ?? AGY_PATH;
  if (!existsSync(path)) {
    throw new Error("agy CLI binary not found — install antigravity (or set AGY_PATH) to log in");
  }
  const bin = readFileSync(path, "latin1");
  // Client ids are 12–13 digits (consumer 13, gcp 12); GOCSPX secrets are
  // exactly 35 chars and sit adjacent in the string table, so the length
  // must be exact to keep them from merging into one match.
  const ids = [...bin.matchAll(/(?<!\d)\d{12,13}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g)].map((m) => m[0]);
  const secrets = [...bin.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)].map((m) => m[0]);
  const pairs = {} as Record<AuthMethod, OauthClient>;
  for (const method of Object.keys(KNOWN_PAIRINGS) as AuthMethod[]) {
    const { idPrefix, secretPrefix } = KNOWN_PAIRINGS[method];
    const id = ids.find((i) => i.startsWith(idPrefix));
    const secret = secrets.find((s) => s.startsWith(secretPrefix));
    if (!id || !secret) {
      throw new Error(`agy CLI binary has no recognizable ${method} oauth client — update nri's pairing prefixes`);
    }
    pairs[method] = { id, secret };
  }
  cachedClients = pairs;
  return pairs;
}

const TOKEN_DIR = join(homedir(), ".gemini", "antigravity-cli");
export const TOKEN_PATH = join(TOKEN_DIR, "antigravity-oauth-token");

export interface TokenFile {
  token?: {
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    expiry?: string; // RFC3339
  };
  auth_method?: string;
  [key: string]: unknown;
}

export function readTokenFile(): TokenFile | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as TokenFile;
  } catch {
    return null;
  }
}

/** cliFileTokenStorage.updateStoredToken: merge into existing JSON, dir 0755, file 0600. */
export function writeTokenFile(update: TokenFile): void {
  let merged: TokenFile = {};
  try {
    merged = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as TokenFile;
  } catch {
    /* no usable existing file — start fresh */
  }
  Object.assign(merged, update);
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o755 });
  writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
}

/** base64url without padding (Go base64.RawURLEncoding). */
function rawUrlEncode(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

/** x/oauth2 GenerateVerifier: 32 random bytes, RawURLEncoding (43 chars). */
function generateVerifier(): string {
  return rawUrlEncode(randomBytes(32));
}

/** auth.generateState: 16 random bytes, RawURLEncoding (22 chars). */
function generateState(): string {
  return rawUrlEncode(randomBytes(16));
}

/** x/oauth2 S256ChallengeFromVerifier. */
function s256Challenge(verifier: string): string {
  return rawUrlEncode(createHash("sha256").update(verifier).digest());
}

/** Go url.Values.Encode(): keys sorted alphabetically, space as '+'. */
function encodeQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]).replace(/%20/g, "+")}`)
    .join("&");
}

/** oauthMethod.StartInteractive: build the consent URL with PKCE S256. */
export function buildAuthUrl(
  method: AuthMethod,
  state: string,
  challenge: string,
): string {
  const client = oauthClients()[method];
  const query = encodeQuery({
    access_type: "offline",
    client_id: client.id,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  });
  return `${AUTH_URL}?${query}`;
}

/** auth.OpenBrowser: xdg-open, only when not in an SSH session. */
function openBrowser(url: string): void {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) return;
  try {
    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => stdout.write(`Failed to open browser — open the URL manually.\n`));
    child.unref();
  } catch {
    stdout.write(`Failed to open browser — open the URL manually.\n`);
  }
}

/** oauthMethod.SubmitAuthorizationCode: accept a pasted URL or raw code. */
function extractCode(input: string): string {
  const trimmed = input.trim();
  try {
    const code = new URL(trimmed).searchParams.get("code");
    if (code) return code;
  } catch {
    /* not a URL — raw code below */
  }
  return trimmed;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** conf.Exchange(ctx, code, VerifierOption(verifier)) — client_secret_post style. */
async function exchangeCode(
  method: AuthMethod,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const client = oauthClients()[method];
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": GO_UA,
    },
    body: encodeQuery({
      client_id: client.id,
      client_secret: client.secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`token exchange failed: ${detail}`);
  }
  return body;
}

/** auth.fetchUserInfo: GET userinfo with Bearer token, only the email is used. */
async function fetchUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}`, "User-Agent": GO_UA },
  });
  if (res.status !== 200) throw new Error(`userinfo returned status ${res.status}`);
  const body = (await res.json().catch(() => null)) as { email?: string } | null;
  return body?.email ?? null;
}

/**
 * The full `agy login` interactive flow (auth.oauthMethod via ChainedAuth):
 * build consent URL -> open browser (non-SSH) -> paste code -> exchange ->
 * persist token -> userinfo. Mirrors logs/errors of the original.
 */
export async function antigravityLogin(method: AuthMethod = "consumer"): Promise<void> {
  const verifier = generateVerifier();
  const state = generateState();
  const challenge = s256Challenge(verifier);
  const url = buildAuthUrl(method, state, challenge);

  stdout.write("Open the URL below in your browser:\n\n");
  stdout.write(`${url}\n\n`);
  openBrowser(url);

  const rl = createInterface({ input: stdin, output: stdout });
  let pasted: string;
  try {
    pasted = await rl.question("Paste the authorization code (or the full callback URL): ");
  } finally {
    rl.close();
  }
  const code = extractCode(pasted);
  if (!code) throw new Error("authorization code cannot be empty");

  const token = await exchangeCode(method, code, verifier);
  writeTokenFile({
    token: {
      access_token: token.access_token,
      token_type: token.token_type ?? "Bearer",
      ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      expiry: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    },
    auth_method: method,
  });
  if (!token.refresh_token) {
    stdout.write("warning: no refresh_token returned — re-run login when the token expires.\n");
  }

  const email = await fetchUserEmail(token.access_token!);
  if (email) stdout.write(`OAuth: authenticated successfully as ${email}\n`);
  stdout.write(`token saved -> ${TOKEN_PATH}\n`);
}

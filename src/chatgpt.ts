// Sign in with ChatGPT, plan usage for open-source apps:
// https://developers.openai.com/siwc/token-sharing-open-source

import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { createServer } from "node:http";
import { listen } from "./http.ts";
import { UserError, readJson, removeJson, writeJson, withLock } from "./store.ts";

export const API_BASE = "https://api.openai.com/v1";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const AGENT_NAME = "Grok Build";
const PREFERRED_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SIGN_IN_TIMEOUT_MS = 280_000; // grok allows an interactive sign-in 300s
const REFRESH_MARGIN_SECS = 300;
const RECENT_REFRESH_SECS = 60;
const CREDENTIALS = "chatgpt.json";
const HOST = "host.json";

export type Credentials = {
  email: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  earliest_refresh_at?: number; // unix seconds
  scopes: string[];
  saved_at: string;
};

export type PlanModel = {
  slug: string;
  name: string;
  description: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort?: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
  earliest_refresh_at?: number | string;
};

type IdTokenClaims = { iss: string; aud: string | string[]; exp: number; sub: string; nonce?: string; email?: string };

const base64url = (buf: Buffer): string => buf.toString("base64url");
const nowSecs = (): number => Math.floor(Date.now() / 1000);

export function account(): Credentials | undefined {
  return readJson<Credentials>(CREDENTIALS);
}

// Grok auth_provider contract: `headless` (GROK_AUTH_EXPIRED=1) is a silent refresh that must never
// prompt or hand back a token Grok already holds; otherwise a user may be waiting for a browser sign-in.
export async function accessToken(headless: boolean): Promise<{ access_token: string; expires_in: number }> {
  let creds = account();
  if (creds) {
    creds = await withLock("chatgpt-refresh", async () => {
      const current = account()!; // another process may have refreshed while we waited
      const refreshedRecently = nowSecs() - Date.parse(current.saved_at) / 1000 < RECENT_REFRESH_SECS;
      const fresh = current.expires_at - nowSecs() > REFRESH_MARGIN_SECS;
      const tooEarly = current.earliest_refresh_at !== undefined && nowSecs() < current.earliest_refresh_at;
      if (fresh && (!headless || refreshedRecently || tooEarly)) return current;
      try {
        return await refresh(current);
      } catch (err) {
        console.error(`token refresh failed: ${(err as Error).message}`);
        return undefined;
      }
    });
  }
  if (!creds) {
    if (headless) throw new UserError("not signed in");
    creds = await signIn((url) => console.error(`sign in with ChatGPT: ${url}`));
  }
  return { access_token: creds.access_token, expires_in: Math.max(creds.expires_at - nowSecs(), 0) };
}

export async function planModels(): Promise<PlanModel[]> {
  const { access_token } = await accessToken(false);
  const res = await fetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${access_token}` } });
  if (!res.ok) throw new Error(`model list returned ${res.status}`);
  type Row = {
    slug: string;
    display_name?: string;
    description?: string;
    context_window?: number;
    visibility?: string;
    default_reasoning_level?: string;
    supported_reasoning_levels?: { effort: string }[];
  };
  const { models = [] } = (await res.json()) as { models?: Row[] };
  return models
    .filter((m) => m.visibility === "list")
    .map((m) => ({
      slug: m.slug,
      name: m.display_name ?? m.slug,
      description: m.description ?? "",
      contextWindow: m.context_window ?? 200_000,
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
      defaultEffort: m.default_reasoning_level,
    }));
}

export async function signOut(): Promise<void> {
  const creds = account();
  if (!creds) return;
  const discovery = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as { revocation_endpoint?: string };
  if (discovery.revocation_endpoint) {
    const res = await postForm(discovery.revocation_endpoint, {
      token: creds.refresh_token,
      token_type_hint: "refresh_token",
      client_id: creds.client_id,
    });
    if (!res.ok) throw new Error(`revocation returned ${res.status}; credentials were kept so you can retry`);
  }
  removeJson(CREDENTIALS); // host.json stays: the host id belongs to this machine
}

export async function signIn(onUrl: (url: string) => void): Promise<Credentials> {
  const existing = account();
  const extAgentHostId = hostId();
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const { promise: callback, resolve, reject } = Promise.withResolvers<{ code: string; clientId?: string }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) return void res.writeHead(404).end();
    const finish = (status: number, message: string): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>grokdex</title><p style="font:16px system-ui;margin:3em">${message}</p>`);
    };
    const params = url.searchParams;
    if (params.get("state") !== state) return finish(400, "Sign-in failed: state mismatch. Close this tab and retry.");
    const error = params.get("error");
    if (error) {
      finish(400, "Sign-in was not completed. You can close this tab.");
      return reject(new UserError(error === "access_denied" ? "sign-in was declined" : `sign-in failed: ${error}`));
    }
    const code = params.get("code");
    if (!code) return finish(400, "Sign-in failed: missing authorization code.");
    finish(200, "Signed in with ChatGPT. You can close this tab.");
    resolve({ code, clientId: params.get("client_id") ?? undefined });
  });

  // Scheme, host and path must stay fixed between sign-ins; only the port may change.
  const port = await listen(server, PREFERRED_PORT).catch(() => listen(server, 0));
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const query = new URLSearchParams({
    client_id: existing?.client_id ?? "dynamic_agent_client",
    ext_agent_host_id: extAgentHostId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: API_BASE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (existing) {
    query.set("id_token_hint", existing.id_token);
    query.set("login_hint", existing.email);
  } else {
    query.set("agent_name_hint", AGENT_NAME);
  }
  const authorizeUrl = `${AUTHORIZE_URL}?${query}`;
  onUrl(authorizeUrl);
  openBrowser(authorizeUrl);

  const timeout = setTimeout(() => reject(new UserError("timed out waiting for the browser sign-in")), SIGN_IN_TIMEOUT_MS);
  try {
    const cb = await callback;
    const clientId = existing ? existing.client_id : cb.clientId;
    if (!clientId) throw new UserError("registration incomplete: the callback did not include a client id");
    if (existing && cb.clientId && cb.clientId !== existing.client_id) {
      throw new UserError("sign-in returned a different client id; run `grokdex remove --sign-out` and set up again");
    }
    const tokens = await requestTokens({
      grant_type: "authorization_code",
      client_id: clientId,
      code: cb.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: API_BASE,
    });
    if (!tokens.id_token || !tokens.refresh_token) throw new Error("token response is missing the id or refresh token");
    const claims = await verifyIdToken(tokens.id_token, clientId, nonce);
    const creds = credentialsFrom(tokens, {
      client_id: clientId,
      ext_agent_host_id: extAgentHostId,
      email: claims.email ?? existing?.email ?? "",
      subject: claims.sub,
      id_token: tokens.id_token,
      refresh_token: tokens.refresh_token,
    });
    writeJson(CREDENTIALS, creds);
    return creds;
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

function hostId(): string {
  const existing = readJson<{ ext_agent_host_id: string }>(HOST);
  if (existing) return existing.ext_agent_host_id;
  const id = `urn:uuid:${randomUUID()}`;
  writeJson(HOST, { ext_agent_host_id: id });
  return id;
}

async function refresh(creds: Credentials): Promise<Credentials> {
  const tokens = await requestTokens({
    grant_type: "refresh_token",
    client_id: creds.client_id,
    refresh_token: creds.refresh_token,
    resource: API_BASE,
  });
  const next = credentialsFrom(tokens, creds);
  writeJson(CREDENTIALS, next);
  return next;
}

function credentialsFrom(
  tokens: TokenResponse,
  previous: Pick<Credentials, "client_id" | "ext_agent_host_id" | "email" | "subject" | "id_token" | "refresh_token">,
): Credentials {
  const scopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean).sort();
  if (!scopes.includes(PLAN_SCOPE)) throw new UserError(`chatgpt plan usage was not granted (scopes: ${scopes.join(" ") || "none"})`);
  return {
    ...previous,
    id_token: tokens.id_token ?? previous.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? previous.refresh_token,
    expires_at: nowSecs() + tokens.expires_in,
    earliest_refresh_at: toEpochSecs(tokens.earliest_refresh_at),
    scopes,
    saved_at: new Date().toISOString(),
  };
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
}

async function requestTokens(form: Record<string, string>): Promise<TokenResponse> {
  const res = await postForm(TOKEN_URL, form);
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}: ${redact(text)}`);
  return JSON.parse(text) as TokenResponse;
}

function redact(text: string): string {
  return text.replace(/"(access_token|refresh_token|id_token)"\s*:\s*"[^"]*"/g, '"$1":"<redacted>"').slice(0, 500);
}

async function verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<IdTokenClaims> {
  const [headerB64, payloadB64, signatureB64] = idToken.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error("malformed id token");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString()) as { alg: string; kid?: string };
  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as IdTokenClaims;
  if (header.alg !== "RS256") throw new Error(`unexpected id token algorithm ${header.alg}`);

  const discovery = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
  const jwks = (await (await fetch(discovery.jwks_uri)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("id token signing key not found");
  const signed = Buffer.from(`${headerB64}.${payloadB64}`);
  if (!verify("RSA-SHA256", signed, createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signatureB64, "base64url"))) {
    throw new Error("id token signature is invalid");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw new Error(`unexpected id token issuer ${claims.iss}`);
  if (!audiences.includes(clientId)) throw new Error("id token audience does not match the client id");
  if (claims.exp <= nowSecs()) throw new Error("id token has expired");
  if (claims.nonce !== nonce) throw new Error("id token nonce mismatch");
  return claims;
}

function toEpochSecs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
}

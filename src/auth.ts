import { promises as fs } from "node:fs";
import path from "node:path";
import { OURA_TOKEN_URL, type Config } from "./config.js";
import type { TokenSet } from "./types.js";

export type FetchFn = typeof fetch;

export interface TokenProvider {
  /** A valid access token, refreshing first if it is about to expire. */
  getAccessToken(): Promise<string>;
  /** Called after a 401. Returns a new token, or null if refreshing isn't possible. */
  refresh(): Promise<string | null>;
}

/** Refresh this long before the stated expiry, to allow for clock skew. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export class AuthError extends Error {}

export async function readTokenFile(file: string): Promise<TokenSet | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as TokenSet;
    return parsed.access_token ? parsed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write tokens readable only by the current user. */
export async function writeTokenFile(file: string, tokens: TokenSet): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Turn an OAuth token endpoint response into a TokenSet. */
export function toTokenSet(body: Record<string, unknown>, now = Date.now()): TokenSet {
  if (typeof body.access_token !== "string") {
    throw new AuthError("Oura token response had no access_token");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expires_at: expiresIn ? now + expiresIn * 1000 : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    token_type: typeof body.token_type === "string" ? body.token_type : undefined,
  };
}

export async function requestToken(
  params: Record<string, string>,
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  const res = await fetchFn(OURA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AuthError(`Oura token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return toTokenSet(JSON.parse(text) as Record<string, unknown>);
}

/** Uses OURA_ACCESS_TOKEN as is. It can't be refreshed. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
  async refresh(): Promise<string | null> {
    return null;
  }
}

/**
 * Reads tokens saved by `oura-mcp auth` and refreshes them when they expire.
 * Oura refresh tokens are single use, so every new refresh token is saved
 * straight away.
 */
export class FileTokenProvider implements TokenProvider {
  private tokens: TokenSet | null = null;
  private inflight: Promise<string | null> | null = null;

  constructor(
    private readonly config: Pick<Config, "tokenFile" | "clientId" | "clientSecret">,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<TokenSet> {
    if (!this.tokens) this.tokens = await readTokenFile(this.config.tokenFile);
    if (!this.tokens) {
      throw new AuthError(
        `No Oura tokens found at ${this.config.tokenFile}. Run "npx oura-mcp auth" (or "npm run auth") first.`,
      );
    }
    return this.tokens;
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.load();
    if (tokens.expires_at && tokens.expires_at - EXPIRY_MARGIN_MS <= this.now()) {
      const refreshed = await this.refresh();
      if (refreshed) return refreshed;
    }
    return tokens.access_token;
  }

  refresh(): Promise<string | null> {
    // Share one refresh between concurrent callers: the refresh token is single use.
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<string | null> {
    // Re-read the file in case another process (or `oura-mcp auth`) updated it.
    this.tokens = null;
    const tokens = await this.load();
    if (!tokens.refresh_token) return null;
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret) {
      throw new AuthError(
        "The Oura access token has expired. Set OURA_CLIENT_ID and OURA_CLIENT_SECRET so it can be refreshed.",
      );
    }
    const fresh = await requestToken(
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      },
      this.fetchFn,
    );
    const merged: TokenSet = { ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token };
    await writeTokenFile(this.config.tokenFile, merged);
    this.tokens = merged;
    return merged.access_token;
  }
}

export function createTokenProvider(config: Config, fetchFn: FetchFn = fetch): TokenProvider {
  if (config.accessToken) return new StaticTokenProvider(config.accessToken);
  return new FileTokenProvider(config, fetchFn);
}

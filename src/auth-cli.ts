import { randomBytes } from "node:crypto";
import http from "node:http";
import { requestToken, writeTokenFile, type FetchFn } from "./auth.js";
import { DEFAULT_SCOPES, OURA_AUTHORIZE_URL, type Config } from "./config.js";

export function buildAuthorizeUrl(config: Config, state: string, scopes = DEFAULT_SCOPES): string {
  const url = new URL(OURA_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId ?? "");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * One-time local OAuth2 sign-in. Starts a small server on the redirect URI,
 * prints Oura's authorize link, swaps the returned code for tokens and saves
 * them to the token file.
 */
export async function runAuth(
  config: Config,
  opts: { fetchFn?: FetchFn; log?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.error(m));
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "Set OURA_CLIENT_ID and OURA_CLIENT_SECRET first. Create an app at https://cloud.ouraring.com/oauth/applications " +
        `with the redirect URI ${config.redirectUri}.`,
    );
  }
  const redirect = new URL(config.redirectUri);
  if (!["localhost", "127.0.0.1"].includes(redirect.hostname)) {
    throw new Error("OURA_REDIRECT_URI must point at localhost for the local sign-in helper.");
  }
  const state = randomBytes(16).toString("hex");
  const port = Number(redirect.port || 80);

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", config.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, message: string, err?: Error) => {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
        clearTimeout(timer);
        server.close();
        if (err) reject(err);
        else resolve();
      };
      if (url.searchParams.get("error")) {
        finish(400, "Oura sign-in was cancelled. You can close this tab.", new Error(`Oura returned: ${url.searchParams.get("error")}`));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        finish(400, "State mismatch. Please run the sign-in again.", new Error("OAuth state mismatch"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        finish(400, "No authorization code received.", new Error("No authorization code in callback"));
        return;
      }
      try {
        const tokens = await requestToken(
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
            client_id: config.clientId!,
            client_secret: config.clientSecret!,
          },
          opts.fetchFn,
        );
        await writeTokenFile(config.tokenFile, tokens);
        log(`Saved Oura tokens to ${config.tokenFile}`);
        finish(200, "Oura is connected. You can close this tab and return to the terminal.");
      } catch (err) {
        finish(500, "Token exchange failed. Check the terminal for details.", err as Error);
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the Oura sign-in to finish."));
    }, opts.timeoutMs ?? 5 * 60 * 1000);
    server.on("error", reject);
    server.listen(port, redirect.hostname, () => {
      log("Open this link in your browser and approve access:\n");
      log(buildAuthorizeUrl(config, state));
      log(`\nWaiting for Oura to redirect to ${config.redirectUri} ...`);
    });
  });
}

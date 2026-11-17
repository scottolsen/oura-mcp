import os from "node:os";
import path from "node:path";

export const OURA_API_BASE = "https://api.ouraring.com";
export const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";
/** Scopes needed for sleep, readiness and HRV data. */
export const DEFAULT_SCOPES = ["daily", "personal"];

export interface Config {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  tokenFile: string;
  accessToken?: string;
  timeZone?: string;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const blank = (v?: string) => (v && v.trim() !== "" ? v.trim() : undefined);
  return {
    clientId: blank(env.OURA_CLIENT_ID),
    clientSecret: blank(env.OURA_CLIENT_SECRET),
    redirectUri: blank(env.OURA_REDIRECT_URI) ?? DEFAULT_REDIRECT_URI,
    tokenFile: expandHome(
      blank(env.OURA_TOKEN_FILE) ?? path.join(os.homedir(), ".config", "oura-mcp", "tokens.json"),
    ),
    accessToken: blank(env.OURA_ACCESS_TOKEN),
    timeZone: blank(env.OURA_TIMEZONE),
  };
}

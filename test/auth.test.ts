import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileTokenProvider, StaticTokenProvider, toTokenSet, writeTokenFile } from "../src/auth.js";
import { buildAuthorizeUrl } from "../src/auth-cli.js";
import { loadConfig } from "../src/config.js";

async function tmpFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oura-mcp-"));
  return path.join(dir, "tokens.json");
}

describe("token handling", () => {
  it("turns expires_in into an absolute expiry", () => {
    expect(toTokenSet({ access_token: "a", refresh_token: "r", expires_in: 60 }, 1000)).toMatchObject({
      access_token: "a",
      refresh_token: "r",
      expires_at: 61000,
    });
    expect(() => toTokenSet({})).toThrow(/access_token/);
  });

  it("writes the token file readable only by the owner", async () => {
    const file = await tmpFile();
    await writeTokenFile(file, { access_token: "a" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("uses a valid token without refreshing", async () => {
    const file = await tmpFile();
    await writeTokenFile(file, { access_token: "a", refresh_token: "r", expires_at: Date.now() + 86_400_000 });
    const fetchFn = (async () => {
      throw new Error("should not be called");
    }) as typeof fetch;
    const provider = new FileTokenProvider({ tokenFile: file, clientId: "id", clientSecret: "s" }, fetchFn);
    expect(await provider.getAccessToken()).toBe("a");
  });

  it("refreshes an expired token once, even with concurrent callers, and saves the new single-use refresh token", async () => {
    const file = await tmpFile();
    await writeTokenFile(file, { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000 });
    const bodies: string[] = [];
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ access_token: "new", refresh_token: "r2", expires_in: 2591999 });
    }) as typeof fetch;
    const provider = new FileTokenProvider({ tokenFile: file, clientId: "id", clientSecret: "s" }, fetchFn);
    const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect([a, b]).toEqual(["new", "new"]);
    expect(bodies).toHaveLength(1);
    const params = new URLSearchParams(bodies[0]);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("r1");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.refresh_token).toBe("r2");
    expect(saved.access_token).toBe("new");
  });

  it("asks for client credentials when a refresh is needed without them", async () => {
    const file = await tmpFile();
    await writeTokenFile(file, { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000 });
    const provider = new FileTokenProvider({ tokenFile: file });
    await expect(provider.getAccessToken()).rejects.toThrow(/OURA_CLIENT_ID/);
  });

  it("points to the auth command when there are no tokens", async () => {
    const provider = new FileTokenProvider({ tokenFile: await tmpFile() });
    await expect(provider.getAccessToken()).rejects.toThrow(/oura-mcp auth/);
  });

  it("supports a static token that can't be refreshed", async () => {
    const p = new StaticTokenProvider("t");
    expect(await p.getAccessToken()).toBe("t");
    expect(await p.refresh()).toBeNull();
  });
});

describe("config and authorize URL", () => {
  it("reads env vars and builds the Oura authorize link", () => {
    const config = loadConfig({ OURA_CLIENT_ID: "abc", OURA_CLIENT_SECRET: "x", OURA_TOKEN_FILE: "/tmp/t.json" });
    expect(config.redirectUri).toBe("http://localhost:8787/callback");
    const url = new URL(buildAuthorizeUrl(config, "st"));
    expect(url.origin + url.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("daily personal");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("runAuth", () => {
  it("swaps the callback code for tokens and saves them", async () => {
    const { runAuth } = await import("../src/auth-cli.js");
    const file = await tmpFile();
    const config = loadConfig({
      OURA_CLIENT_ID: "abc",
      OURA_CLIENT_SECRET: "secret",
      OURA_TOKEN_FILE: file,
      OURA_REDIRECT_URI: "http://127.0.0.1:38787/callback",
    });
    let authorizeUrl = "";
    let tokenBody = "";
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      tokenBody = String(init?.body);
      return Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 100 });
    }) as typeof fetch;
    const done = runAuth(config, {
      fetchFn,
      timeoutMs: 5000,
      log: (m) => {
        if (m.startsWith("https://")) authorizeUrl = m;
      },
    });
    while (!authorizeUrl) await new Promise((r) => setTimeout(r, 10));
    const state = new URL(authorizeUrl).searchParams.get("state");

    const bad = await fetch(`http://127.0.0.1:38787/elsewhere`);
    expect(bad.status).toBe(404);
    const res = await fetch(`http://127.0.0.1:38787/callback?code=the-code&state=${state}`);
    expect(res.status).toBe(200);
    await done;

    const params = new URLSearchParams(tokenBody);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("the-code");
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:38787/callback");
    expect(JSON.parse(await readFile(file, "utf8")).refresh_token).toBe("ref");
  });

  it("rejects a callback with the wrong state", async () => {
    const { runAuth } = await import("../src/auth-cli.js");
    const config = loadConfig({
      OURA_CLIENT_ID: "abc",
      OURA_CLIENT_SECRET: "secret",
      OURA_TOKEN_FILE: await tmpFile(),
      OURA_REDIRECT_URI: "http://127.0.0.1:38788/callback",
    });
    let ready = false;
    const done = runAuth(config, { timeoutMs: 5000, log: () => (ready = true) });
    while (!ready) await new Promise((r) => setTimeout(r, 10));
    const [res, err] = await Promise.all([
      fetch("http://127.0.0.1:38788/callback?code=x&state=wrong"),
      done.catch((e) => e),
    ]);
    expect(res.status).toBe(400);
    expect(err.message).toMatch(/state mismatch/);
  });
});

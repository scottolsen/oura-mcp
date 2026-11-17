import { describe, expect, it, vi } from "vitest";
import { OuraClient, OuraApiError, retryDelayMs } from "../src/client.js";
import { dataset, fakeOura, sleepPeriod, staticTokens } from "./helpers.js";

describe("OuraClient", () => {
  it("follows next_token across pages and sends the bearer token", async () => {
    const data = dataset("2026-10-01", "2026-10-31", () => ({}));
    const { fetchFn, calls } = fakeOura(data, { pageSize: 10 });
    const client = new OuraClient(staticTokens, { fetchFn });
    const docs = await client.dailySleep("2026-10-01", "2026-10-31");
    expect(docs).toHaveLength(31);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls[1].url.searchParams.get("next_token")).toBe("10");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("widens the sleep query by a day each side so the last day isn't lost", async () => {
    const data = { sleep: [sleepPeriod("2026-11-15"), sleepPeriod("2026-11-16"), sleepPeriod("2026-11-17")], daily_sleep: [], daily_readiness: [] };
    const { fetchFn, calls } = fakeOura(data);
    const client = new OuraClient(staticTokens, { fetchFn });
    const docs = await client.sleepPeriods("2026-11-16", "2026-11-16");
    expect(docs.map((d) => d.day)).toEqual(["2026-11-16"]);
    expect(calls[0].url.searchParams.get("start_date")).toBe("2026-11-15");
    expect(calls[0].url.searchParams.get("end_date")).toBe("2026-11-17");
  });

  it("retries a 429 after Retry-After, then succeeds", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } });
      return Response.json({ data: [], next_token: null });
    }) as typeof fetch;
    const sleep = vi.fn(async () => {});
    const client = new OuraClient(staticTokens, { fetchFn, sleep });
    await client.dailyReadiness("2026-11-01", "2026-11-02");
    expect(n).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after maxRetries with a readable rate-limit error", async () => {
    const fetchFn = (async () => new Response("no", { status: 429 })) as typeof fetch;
    const client = new OuraClient(staticTokens, { fetchFn, sleep: async () => {}, maxRetries: 2 });
    await expect(client.dailySleep("2026-11-01", "2026-11-02")).rejects.toThrow(/rate limit/);
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    const seen: string[] = [];
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      seen.push(auth);
      return auth === "Bearer new"
        ? Response.json({ data: [], next_token: null })
        : new Response("expired", { status: 401 });
    }) as typeof fetch;
    const tokens = { getAccessToken: async () => "old", refresh: vi.fn(async () => "new") };
    const client = new OuraClient(tokens, { fetchFn });
    await client.dailySleep("2026-11-01", "2026-11-02");
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
  });

  it("explains a 403", async () => {
    const fetchFn = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const client = new OuraClient(staticTokens, { fetchFn });
    const err = await client.dailySleep("2026-11-01", "2026-11-02").catch((e) => e);
    expect(err).toBeInstanceOf(OuraApiError);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/daily" scope/);
  });

  it("backs off exponentially without Retry-After", () => {
    expect(retryDelayMs(null, 0)).toBe(1000);
    expect(retryDelayMs(null, 3)).toBe(8000);
    expect(retryDelayMs("5", 0)).toBe(5000);
  });
});

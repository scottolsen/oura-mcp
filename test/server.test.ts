import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { OuraClient } from "../src/client.js";
import { addDays } from "../src/dates.js";
import { createServer } from "../src/server.js";
import { dataset, fakeOura, staticTokens } from "./helpers.js";

// 8 PM Chicago time on Nov 16, 2026.
const NOW = new Date("2026-11-17T02:00:00Z");
const TODAY = "2026-11-16";

async function connect(data: ReturnType<typeof dataset>) {
  const { fetchFn } = fakeOura(data, { pageSize: 25 });
  const server = createServer(new OuraClient(staticTokens, { fetchFn }), "America/Chicago", () => NOW);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function json(result: Awaited<ReturnType<Client["callTool"]>>) {
  const text = (result.content as { type: string; text: string }[])[0].text;
  return { text, data: JSON.parse(text.slice(text.indexOf("\n\n") + 2)) };
}

describe("MCP server", () => {
  const full = dataset(addDays(TODAY, -200), TODAY, (i) => ({ hrv: 40 + (i % 5), rhr: 50 + (i % 3) }));

  it("lists the tools", async () => {
    const client = await connect(full);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "oura_daily_summary",
      "oura_get_daily_readiness",
      "oura_get_daily_sleep",
      "oura_get_sleep_periods",
      "oura_trends",
    ]);
  });

  it("summarises today (last night) with a 30-day comparison", async () => {
    const client = await connect(full);
    const { text, data } = json(await client.callTool({ name: "oura_daily_summary", arguments: {} }));
    expect(text).toMatch(/^Oura summary for 2026-11-16: HRV \d+ ms, resting HR \d+ bpm/);
    expect(data.day).toBe(TODAY);
    expect(data.vs_30_day_baseline.hrv_ms.baseline_average).toBeCloseTo(42, 0);
    expect(data.vs_30_day_baseline.resting_hr_bpm.status).toMatch(/range/);
  });

  it("falls back to the latest synced day when today has no data", async () => {
    const lagging = dataset(addDays(TODAY, -40), addDays(TODAY, -1), () => ({}));
    const client = await connect(lagging);
    const { text, data } = json(await client.callTool({ name: "oura_daily_summary", arguments: {} }));
    expect(text).toMatch(/No Oura data for 2026-11-16 yet/);
    expect(data.day).toBe("2026-11-15");
  });

  it("reports trends for 90 days with weekly buckets", async () => {
    const client = await connect(full);
    const { text, data } = json(await client.callTool({ name: "oura_trends", arguments: { days: 90 } }));
    expect(text).toMatch(/Oura trends 2026-08-19 to 2026-11-16 \(90 days, 90 with data\)/);
    expect(data.metrics).toHaveLength(6);
    expect(data.weekly.length).toBeGreaterThanOrEqual(13);
    expect(data.missing_days).toEqual([]);
  });

  it("strips sample arrays from raw sleep periods unless asked", async () => {
    const client = await connect(full);
    const { data } = json(
      await client.callTool({
        name: "oura_get_sleep_periods",
        arguments: { start_date: "2026-11-15", end_date: "2026-11-16" },
      }),
    );
    expect(data).toHaveLength(2);
    expect(data[0].hrv).toBeUndefined();
    expect(data[0].average_hrv).toBeDefined();
  });

  it("returns a tool error for a bad range", async () => {
    const client = await connect(full);
    const result = await client.callTool({
      name: "oura_get_daily_sleep",
      arguments: { start_date: "2026-11-16", end_date: "2026-11-01" },
    });
    expect(result.isError).toBe(true);
  });
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OuraClient } from "./client.js";
import { addDays, assertIsoDay, diffDays, todayIn } from "./dates.js";
import {
  buildDayRecords,
  buildTrendReport,
  dayVsBaseline,
  hasData,
  trendWindows,
  type DayRecord,
  type TrendReport,
} from "./metrics.js";
import type { SleepPeriod } from "./types.js";

export interface ToolContext {
  client: OuraClient;
  timeZone?: string;
  now?: () => Date;
}

const DAILY_BASELINE_DAYS = 30;
const MAX_RANGE_DAYS = 366;

const dateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Calendar date, YYYY-MM-DD");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(summary: string, data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function checkRange(start: string, end: string): void {
  assertIsoDay(start, "start_date");
  assertIsoDay(end, "end_date");
  if (start > end) throw new Error("start_date must be on or before end_date");
  if (diffDays(start, end) + 1 > MAX_RANGE_DAYS) {
    throw new Error(`Ranges are limited to ${MAX_RANGE_DAYS} days`);
  }
}

async function loadRecords(client: OuraClient, start: string, end: string): Promise<DayRecord[]> {
  const [periods, dailySleep, readiness] = await Promise.all([
    client.sleepPeriods(start, end),
    client.dailySleep(start, end),
    client.dailyReadiness(start, end),
  ]);
  return buildDayRecords(start, end, periods, dailySleep, readiness);
}

const fmt = (v: number | null, unit = "") => (v == null ? "n/a" : `${v}${unit}`);

export function formatDaySummary(r: DayRecord): string {
  return [
    `Oura summary for ${r.day}:`,
    `HRV ${fmt(r.hrv_ms, " ms")}, resting HR ${fmt(r.resting_hr_bpm, " bpm")},`,
    `sleep score ${fmt(r.sleep_score)}, readiness ${fmt(r.readiness_score)},`,
    `total sleep ${fmt(r.total_sleep_hours, " h")} at ${fmt(r.efficiency_pct, "%")} efficiency`,
    `(deep ${fmt(r.deep_min, " min")}, REM ${fmt(r.rem_min, " min")}, light ${fmt(r.light_min, " min")}, awake ${fmt(r.awake_min, " min")}).`,
  ].join(" ");
}

export function formatTrendSummary(t: TrendReport): string {
  const lines = [
    `Oura trends ${t.range.start} to ${t.range.end} (${t.range.days} days, ${t.days_with_data} with data):`,
  ];
  for (const m of t.metrics) {
    if (m.current.average == null) continue;
    const prior =
      m.vs_prior_period.change == null
        ? ""
        : `, ${m.vs_prior_period.change > 0 ? "+" : ""}${m.vs_prior_period.change} vs prior ${t.range.days} days (${m.vs_prior_period.assessment})`;
    const base =
      m.vs_baseline.baseline_average == null
        ? ""
        : `; baseline ${m.vs_baseline.baseline_average}, ${m.vs_baseline.status}`;
    lines.push(`- ${m.label}: avg ${m.current.average} (min ${m.current.min}, max ${m.current.max})${prior}${base}`);
  }
  return lines.join("\n");
}

/** Strip the large per-sample arrays from a sleep period unless asked for. */
function trimPeriod(p: SleepPeriod, includeSamples: boolean): Record<string, unknown> {
  if (includeSamples) return p;
  const { heart_rate, hrv, movement_30_sec, sleep_phase_5_min, sleep_phase_30_sec, ...rest } = p;
  void heart_rate;
  void hrv;
  void movement_30_sec;
  void sleep_phase_5_min;
  void sleep_phase_30_sec;
  return rest;
}

export async function dailySummary(ctx: ToolContext, date?: string) {
  const today = todayIn(ctx.timeZone, ctx.now?.() ?? new Date());
  const target = date ? assertIsoDay(date) : today;
  const start = addDays(target, -DAILY_BASELINE_DAYS);
  const records = await loadRecords(ctx.client, start, target);
  let day = records[records.length - 1];
  let note: string | undefined;

  if (!hasData(day)) {
    const latest = [...records].reverse().find(hasData);
    if (!date && latest) {
      note = `No Oura data for ${target} yet (the ring may not have synced). Showing the latest day with data, ${latest.day}.`;
      day = latest;
    } else {
      note = `No Oura data for ${target}. The ring may not have synced yet, or it wasn't worn.`;
    }
  }
  const baseline = records.filter((r) => r.day < day.day && r.day >= addDays(day.day, -DAILY_BASELINE_DAYS));
  return {
    ...(note ? { note } : {}),
    ...day,
    vs_30_day_baseline: dayVsBaseline(day, baseline),
  };
}

export async function trends(
  ctx: ToolContext,
  args: { days?: number; start_date?: string; end_date?: string; baseline_days?: number; include_daily?: boolean },
) {
  const today = todayIn(ctx.timeZone, ctx.now?.() ?? new Date());
  const end = args.end_date ? assertIsoDay(args.end_date, "end_date") : today;
  const start = args.start_date
    ? assertIsoDay(args.start_date, "start_date")
    : addDays(end, -((args.days ?? 30) - 1));
  checkRange(start, end);
  const baselineDays = args.baseline_days ?? 60;
  const { fetchStart } = trendWindows(start, end, baselineDays);
  const records = await loadRecords(ctx.client, fetchStart, end);
  return buildTrendReport(records, start, end, baselineDays, { includeDaily: args.include_daily });
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "oura_daily_summary",
    {
      title: "Oura daily summary",
      description:
        "One day's HRV (average over the main sleep, ms), resting heart rate (lowest during the main sleep, bpm), sleep score, readiness score, total sleep, efficiency, latency, sleep stages and bed times, plus how each compares with the previous 30 days. Oura files a night under the day you woke up, so the default (today) covers last night. If today hasn't synced yet and no date is given, the latest day with data is shown.",
      inputSchema: {
        date: dateArg.optional().describe("Day to summarize (YYYY-MM-DD). Defaults to today, i.e. last night's sleep."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ date }) => {
      try {
        const result = await dailySummary(ctx, date);
        return ok(`${result.note ? `${result.note}\n` : ""}${formatDaySummary(result)}`, result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "oura_trends",
    {
      title: "Oura trends",
      description:
        "Longer-term trends for HRV, resting heart rate, sleep score, readiness, total sleep and sleep efficiency over a range (default the last 30 days). For each metric: average, min, max, standard deviation, latest value, slope per week, change versus the equally long period just before, and comparison with a baseline window (default 60 days before the range) including a z-score and whether it's within the normal range. Ranges of 21+ days also get weekly averages. Days with no data are listed.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(2)
          .max(MAX_RANGE_DAYS)
          .optional()
          .describe("Length of the range ending on end_date, e.g. 7, 30 or 90. Ignored if start_date is given. Default 30."),
        start_date: dateArg.optional().describe("Custom range start (YYYY-MM-DD)."),
        end_date: dateArg.optional().describe("Range end (YYYY-MM-DD). Defaults to today."),
        baseline_days: z
          .number()
          .int()
          .min(7)
          .max(365)
          .optional()
          .describe("Days before the range used as the personal baseline. Default 60."),
        include_daily: z.boolean().optional().describe("Also return the per-day values, e.g. for charting."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const report = await trends(ctx, args);
        return ok(formatTrendSummary(report), report);
      } catch (err) {
        return fail(err);
      }
    },
  );

  const rangeSchema = {
    start_date: dateArg.describe("First day (YYYY-MM-DD), inclusive."),
    end_date: dateArg.describe("Last day (YYYY-MM-DD), inclusive."),
  };

  server.registerTool(
    "oura_get_sleep_periods",
    {
      title: "Oura sleep periods (raw)",
      description:
        "Raw detailed sleep periods from /v2/usercollection/sleep for days in the range (inclusive), including naps. Includes average_hrv, lowest_heart_rate, stage durations (seconds) and type (long_sleep, sleep, late_nap, rest). Per-sample HR/HRV/movement arrays are left out unless include_samples is true.",
      inputSchema: {
        ...rangeSchema,
        include_samples: z.boolean().optional().describe("Include 5-minute HR and HRV samples and phase strings."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ start_date, end_date, include_samples }) => {
      try {
        checkRange(start_date, end_date);
        const periods = await ctx.client.sleepPeriods(start_date, end_date);
        return ok(
          `${periods.length} sleep periods from ${start_date} to ${end_date}.`,
          periods.map((p) => trimPeriod(p, include_samples ?? false)),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "oura_get_daily_sleep",
    {
      title: "Oura daily sleep (raw)",
      description:
        "Raw daily sleep documents from /v2/usercollection/daily_sleep: sleep score and contributors (deep_sleep, efficiency, latency, rem_sleep, restfulness, timing, total_sleep) for each day in the range (inclusive).",
      inputSchema: rangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ start_date, end_date }) => {
      try {
        checkRange(start_date, end_date);
        const docs = await ctx.client.dailySleep(start_date, end_date);
        return ok(`${docs.length} daily sleep documents from ${start_date} to ${end_date}.`, docs);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "oura_get_daily_readiness",
    {
      title: "Oura daily readiness (raw)",
      description:
        "Raw daily readiness documents from /v2/usercollection/daily_readiness: readiness score, temperature deviation and contributors (activity_balance, body_temperature, hrv_balance, previous_day_activity, previous_night, recovery_index, resting_heart_rate, sleep_balance) for each day in the range (inclusive).",
      inputSchema: rangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ start_date, end_date }) => {
      try {
        checkRange(start_date, end_date);
        const docs = await ctx.client.dailyReadiness(start_date, end_date);
        return ok(`${docs.length} daily readiness documents from ${start_date} to ${end_date}.`, docs);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

import { describe, expect, it } from "vitest";
import {
  buildDayRecords,
  buildTrendReport,
  mainSleep,
  slopePerWeek,
  stats,
  weeklyBuckets,
} from "../src/metrics.js";
import { addDays } from "../src/dates.js";
import { dailySleep, dataset, readiness, sleepPeriod } from "./helpers.js";

describe("mainSleep", () => {
  it("prefers the longest long_sleep over naps and shorter sleeps", () => {
    const nap = sleepPeriod("2026-11-16", { type: "late_nap", total_sleep_duration: 40000, average_hrv: 99 });
    const short = sleepPeriod("2026-11-16", { type: "long_sleep", total_sleep_duration: 10000, average_hrv: 30 });
    const long = sleepPeriod("2026-11-16", { type: "long_sleep", total_sleep_duration: 26000, average_hrv: 52 });
    expect(mainSleep([nap, short, long])?.average_hrv).toBe(52);
  });

  it("falls back to a plain sleep period and ignores deleted and rest periods", () => {
    const deleted = sleepPeriod("2026-11-16", { type: "deleted", total_sleep_duration: 30000 });
    const rest = sleepPeriod("2026-11-16", { type: "rest", total_sleep_duration: 30000 });
    const sleep = sleepPeriod("2026-11-16", { type: "sleep", total_sleep_duration: 9000, average_hrv: 41 });
    expect(mainSleep([deleted, rest, sleep])?.average_hrv).toBe(41);
    expect(mainSleep([deleted, rest])).toBeNull();
  });
});

describe("buildDayRecords", () => {
  it("joins the three collections by day and converts units", () => {
    const [rec] = buildDayRecords(
      "2026-11-16",
      "2026-11-16",
      [sleepPeriod("2026-11-16"), sleepPeriod("2026-11-16", { type: "late_nap", total_sleep_duration: 1200 })],
      [dailySleep("2026-11-16", 82)],
      [readiness("2026-11-16", 77)],
    );
    expect(rec).toMatchObject({
      day: "2026-11-16",
      hrv_ms: 45,
      resting_hr_bpm: 50,
      average_hr_bpm: 56.3,
      sleep_score: 82,
      readiness_score: 77,
      total_sleep_hours: 7.5,
      time_in_bed_hours: 8,
      efficiency_pct: 90,
      latency_min: 10,
      deep_min: 90,
      rem_min: 105,
      light_min: 255,
      awake_min: 30,
      temperature_deviation_c: -0.1,
      naps: 1,
    });
  });

  it("fills missing days with nulls", () => {
    const recs = buildDayRecords("2026-11-14", "2026-11-16", [sleepPeriod("2026-11-15")], [], []);
    expect(recs.map((r) => r.day)).toEqual(["2026-11-14", "2026-11-15", "2026-11-16"]);
    expect(recs[0].hrv_ms).toBeNull();
    expect(recs[1].hrv_ms).toBe(45);
    expect(recs[2].sleep_score).toBeNull();
  });
});

describe("stats and slope", () => {
  it("skips nulls", () => {
    expect(stats([40, null, 50, 60])).toEqual({ average: 50, min: 40, max: 60, std_dev: 10, days_with_data: 3 });
    expect(stats([null, null]).average).toBeNull();
  });

  it("reports slope per week", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 40 + i }));
    expect(slopePerWeek(pts)).toBe(7);
    expect(slopePerWeek([{ x: 0, y: 1 }])).toBeNull();
  });
});

describe("buildTrendReport", () => {
  const end = "2026-11-16";
  const start = addDays(end, -6);

  function records(fn: Parameters<typeof dataset>[2]) {
    const d = dataset(addDays(start, -60), end, fn);
    return buildDayRecords(addDays(start, -60), end, d.sleep, d.daily_sleep, d.daily_readiness);
  }

  it("calls rising HRV and falling resting HR improvements", () => {
    const recs = records((_, day) =>
      day >= start ? { hrv: 60, rhr: 46 } : { hrv: 45 + (day.charCodeAt(9) % 3), rhr: 50 + (day.charCodeAt(9) % 2) },
    );
    const report = buildTrendReport(recs, start, end, 60);
    const hrv = report.metrics.find((m) => m.metric === "hrv_ms")!;
    const rhr = report.metrics.find((m) => m.metric === "resting_hr_bpm")!;
    expect(hrv.current.average).toBe(60);
    expect(hrv.vs_prior_period.direction).toBe("up");
    expect(hrv.vs_prior_period.assessment).toBe("improving");
    expect(hrv.vs_baseline.status).toBe("above normal range");
    expect(rhr.vs_prior_period.direction).toBe("down");
    expect(rhr.vs_prior_period.assessment).toBe("improving");
    expect(rhr.vs_baseline.status).toBe("below normal range");
    expect(report.range).toEqual({ start, end, days: 7 });
    expect(report.prior_period).toEqual({ start: addDays(start, -7), end: addDays(start, -1) });
    expect(report.weekly).toBeUndefined();
  });

  it("calls rising resting HR a decline and small changes stable", () => {
    const recs = records((_, day) => (day >= start ? { rhr: 56, hrv: 45.5 } : { rhr: 50, hrv: 45 }));
    const report = buildTrendReport(recs, start, end, 60);
    expect(report.metrics.find((m) => m.metric === "resting_hr_bpm")!.vs_prior_period.assessment).toBe("declining");
    expect(report.metrics.find((m) => m.metric === "hrv_ms")!.vs_prior_period.assessment).toBe("stable");
  });

  it("lists missing days and doesn't compare against a thin baseline", () => {
    const recs = records((i, day) => (day >= start && day !== addDays(end, -2) ? { hrv: 50 } : null));
    const report = buildTrendReport(recs, start, end, 60, { includeDaily: true });
    expect(report.days_with_data).toBe(6);
    expect(report.missing_days).toEqual([addDays(end, -2)]);
    const hrv = report.metrics.find((m) => m.metric === "hrv_ms")!;
    expect(hrv.vs_prior_period.assessment).toBe("not enough data");
    expect(hrv.vs_baseline.status).toBe("not enough data");
    expect(report.daily).toHaveLength(7);
  });

  it("adds weekly buckets for longer ranges", () => {
    const longStart = addDays(end, -27);
    const d = dataset(addDays(longStart, -60), end, (i) => ({ hrv: 40 + Math.floor(i / 7) }));
    const recs = buildDayRecords(addDays(longStart, -60), end, d.sleep, d.daily_sleep, d.daily_readiness);
    const report = buildTrendReport(recs, longStart, end, 60);
    expect(report.weekly).toHaveLength(4);
    expect(report.weekly![3].week_end).toBe(end);
    expect(weeklyBuckets(recs.slice(-10))).toHaveLength(2);
  });
});

import { addDays, diffDays, eachDay } from "./dates.js";
import type { DailyReadiness, DailySleep, SleepPeriod } from "./types.js";

/** One day's headline numbers. `null` means Oura had no value for that day. */
export interface DayRecord {
  day: string;
  hrv_ms: number | null;
  resting_hr_bpm: number | null;
  average_hr_bpm: number | null;
  sleep_score: number | null;
  readiness_score: number | null;
  total_sleep_hours: number | null;
  time_in_bed_hours: number | null;
  efficiency_pct: number | null;
  latency_min: number | null;
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  bedtime_start: string | null;
  bedtime_end: string | null;
  temperature_deviation_c: number | null;
  sleep_contributors: Record<string, number | null> | null;
  readiness_contributors: Record<string, number | null> | null;
  naps: number;
}

export type MetricKey =
  | "hrv_ms"
  | "resting_hr_bpm"
  | "sleep_score"
  | "readiness_score"
  | "total_sleep_hours"
  | "efficiency_pct";

interface MetricDef {
  key: MetricKey;
  label: string;
  /** Which way is better. */
  better: "higher" | "lower";
  /** Changes smaller than this (in the metric's unit) count as stable. */
  stableBand: number;
}

export const TREND_METRICS: MetricDef[] = [
  { key: "hrv_ms", label: "HRV (ms)", better: "higher", stableBand: 2 },
  { key: "resting_hr_bpm", label: "Resting heart rate (bpm)", better: "lower", stableBand: 1 },
  { key: "sleep_score", label: "Sleep score", better: "higher", stableBand: 2 },
  { key: "readiness_score", label: "Readiness score", better: "higher", stableBand: 2 },
  { key: "total_sleep_hours", label: "Total sleep (h)", better: "higher", stableBand: 0.25 },
  { key: "efficiency_pct", label: "Sleep efficiency (%)", better: "higher", stableBand: 1 },
];

const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const hours = (s: number | null | undefined) => (s == null ? null : round(s / 3600, 2));
const minutes = (s: number | null | undefined) => (s == null ? null : Math.round(s / 60));
const num = (v: number | null | undefined) => (typeof v === "number" ? v : null);

/**
 * The night that represents a day: the longest `long_sleep` period, else the
 * longest non-nap period. Naps and rest periods don't count toward HRV or
 * resting heart rate, matching how the Oura app reports them.
 */
export function mainSleep(periods: SleepPeriod[]): SleepPeriod | null {
  const usable = periods.filter((p) => p.type !== "deleted");
  const byLength = (a: SleepPeriod, b: SleepPeriod) =>
    (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0);
  const long = usable.filter((p) => p.type === "long_sleep").sort(byLength);
  if (long.length) return long[0];
  const sleep = usable.filter((p) => p.type === "sleep").sort(byLength);
  return sleep[0] ?? null;
}

export function buildDayRecords(
  start: string,
  end: string,
  periods: SleepPeriod[],
  dailySleep: DailySleep[],
  readiness: DailyReadiness[],
): DayRecord[] {
  const periodsByDay = groupBy(periods, (p) => p.day);
  const sleepByDay = new Map(dailySleep.map((d) => [d.day, d]));
  const readinessByDay = new Map(readiness.map((d) => [d.day, d]));

  return eachDay(start, end).map((day) => {
    const dayPeriods = periodsByDay.get(day) ?? [];
    const main = mainSleep(dayPeriods);
    const ds = sleepByDay.get(day);
    const rd = readinessByDay.get(day);
    return {
      day,
      hrv_ms: num(main?.average_hrv),
      resting_hr_bpm: num(main?.lowest_heart_rate),
      average_hr_bpm: main?.average_heart_rate == null ? null : round(main.average_heart_rate),
      sleep_score: num(ds?.score),
      readiness_score: num(rd?.score),
      total_sleep_hours: hours(main?.total_sleep_duration),
      time_in_bed_hours: hours(main?.time_in_bed),
      efficiency_pct: num(main?.efficiency),
      latency_min: minutes(main?.latency),
      deep_min: minutes(main?.deep_sleep_duration),
      rem_min: minutes(main?.rem_sleep_duration),
      light_min: minutes(main?.light_sleep_duration),
      awake_min: minutes(main?.awake_time),
      bedtime_start: main?.bedtime_start ?? null,
      bedtime_end: main?.bedtime_end ?? null,
      temperature_deviation_c: num(rd?.temperature_deviation),
      sleep_contributors: ds?.contributors ?? null,
      readiness_contributors: rd?.contributors ?? null,
      naps: dayPeriods.filter((p) => p !== main && p.type !== "deleted").length,
    };
  });
}

export function hasData(r: DayRecord): boolean {
  return (
    r.hrv_ms != null ||
    r.resting_hr_bpm != null ||
    r.sleep_score != null ||
    r.readiness_score != null ||
    r.total_sleep_hours != null
  );
}

export interface Stats {
  average: number | null;
  min: number | null;
  max: number | null;
  std_dev: number | null;
  days_with_data: number;
}

export function stats(values: (number | null)[]): Stats {
  const xs = values.filter((v): v is number => v != null);
  if (!xs.length) return { average: null, min: null, max: null, std_dev: null, days_with_data: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return {
    average: round(mean),
    min: round(Math.min(...xs)),
    max: round(Math.max(...xs)),
    std_dev: xs.length > 1 ? round(Math.sqrt(variance)) : null,
    days_with_data: xs.length,
  };
}

/** Least-squares slope, in units per week, over (day index, value) points. */
export function slopePerWeek(points: { x: number; y: number | null }[]): number | null {
  const pts = points.filter((p): p is { x: number; y: number } => p.y != null);
  if (pts.length < 3) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  return round((sxy / sxx) * 7, 2);
}

export type Assessment = "improving" | "declining" | "stable" | "not enough data";

function assess(def: MetricDef, change: number | null): Assessment {
  if (change == null) return "not enough data";
  if (Math.abs(change) < def.stableBand) return "stable";
  const up = change > 0;
  return up === (def.better === "higher") ? "improving" : "declining";
}

export interface MetricTrend {
  metric: MetricKey;
  label: string;
  better: "higher" | "lower";
  current: Stats;
  latest: { day: string; value: number } | null;
  trend_per_week: number | null;
  vs_prior_period: {
    prior_average: number | null;
    change: number | null;
    change_pct: number | null;
    direction: "up" | "down" | "flat" | "unknown";
    assessment: Assessment;
  };
  vs_baseline: {
    baseline_average: number | null;
    baseline_std_dev: number | null;
    difference: number | null;
    /** Standard deviations away from baseline. */
    z_score: number | null;
    status: "above normal range" | "below normal range" | "within normal range" | "not enough data";
    assessment: Assessment;
  };
}

/** Days needed in the baseline before comparing against it. */
const MIN_BASELINE_DAYS = 7;

export function metricTrend(
  def: MetricDef,
  current: DayRecord[],
  prior: DayRecord[],
  baseline: DayRecord[],
): MetricTrend {
  const cur = stats(current.map((r) => r[def.key]));
  const pri = stats(prior.map((r) => r[def.key]));
  const base = stats(baseline.map((r) => r[def.key]));

  const latestRec = [...current].reverse().find((r) => r[def.key] != null);
  const change =
    cur.average != null && pri.average != null ? round(cur.average - pri.average) : null;
  const changePct =
    change != null && pri.average ? round((change / pri.average) * 100) : null;

  const diff =
    cur.average != null && base.average != null && base.days_with_data >= MIN_BASELINE_DAYS
      ? round(cur.average - base.average)
      : null;
  const z = diff != null && base.std_dev ? round(diff / base.std_dev, 2) : null;

  return {
    metric: def.key,
    label: def.label,
    better: def.better,
    current: cur,
    latest: latestRec ? { day: latestRec.day, value: latestRec[def.key] as number } : null,
    trend_per_week: slopePerWeek(current.map((r, i) => ({ x: i, y: r[def.key] }))),
    vs_prior_period: {
      prior_average: pri.average,
      change,
      change_pct: changePct,
      direction:
        change == null ? "unknown" : Math.abs(change) < def.stableBand ? "flat" : change > 0 ? "up" : "down",
      assessment: assess(def, change),
    },
    vs_baseline: {
      baseline_average: base.days_with_data >= MIN_BASELINE_DAYS ? base.average : null,
      baseline_std_dev: base.days_with_data >= MIN_BASELINE_DAYS ? base.std_dev : null,
      difference: diff,
      z_score: z,
      status:
        diff == null
          ? "not enough data"
          : z == null
            ? Math.abs(diff) < def.stableBand
              ? "within normal range"
              : diff > 0
                ? "above normal range"
                : "below normal range"
            : z > 1
              ? "above normal range"
              : z < -1
                ? "below normal range"
                : "within normal range",
      assessment: assess(def, diff),
    },
  };
}

export interface WeekBucket {
  week_start: string;
  week_end: string;
  hrv_ms: number | null;
  resting_hr_bpm: number | null;
  sleep_score: number | null;
  readiness_score: number | null;
  total_sleep_hours: number | null;
  days_with_data: number;
}

/** Seven-day buckets counted back from the range's last day. */
export function weeklyBuckets(records: DayRecord[]): WeekBucket[] {
  const buckets: WeekBucket[] = [];
  for (let endIdx = records.length - 1; endIdx >= 0; endIdx -= 7) {
    const slice = records.slice(Math.max(0, endIdx - 6), endIdx + 1);
    buckets.unshift({
      week_start: slice[0].day,
      week_end: slice[slice.length - 1].day,
      hrv_ms: stats(slice.map((r) => r.hrv_ms)).average,
      resting_hr_bpm: stats(slice.map((r) => r.resting_hr_bpm)).average,
      sleep_score: stats(slice.map((r) => r.sleep_score)).average,
      readiness_score: stats(slice.map((r) => r.readiness_score)).average,
      total_sleep_hours: stats(slice.map((r) => r.total_sleep_hours)).average,
      days_with_data: slice.filter(hasData).length,
    });
  }
  return buckets;
}

export interface TrendReport {
  range: { start: string; end: string; days: number };
  prior_period: { start: string; end: string };
  baseline_period: { start: string; end: string; days: number };
  days_with_data: number;
  missing_days: string[];
  metrics: MetricTrend[];
  weekly?: WeekBucket[];
  daily?: Pick<
    DayRecord,
    "day" | "hrv_ms" | "resting_hr_bpm" | "sleep_score" | "readiness_score" | "total_sleep_hours" | "efficiency_pct"
  >[];
}

/** Window boundaries for a trend report. The prior period immediately precedes the range. */
export function trendWindows(start: string, end: string, baselineDays: number) {
  const days = diffDays(start, end) + 1;
  const prior = { start: addDays(start, -days), end: addDays(start, -1) };
  const baseline = { start: addDays(start, -baselineDays), end: addDays(start, -1), days: baselineDays };
  const fetchStart = prior.start < baseline.start ? prior.start : baseline.start;
  return { days, prior, baseline, fetchStart };
}

export function buildTrendReport(
  records: DayRecord[],
  start: string,
  end: string,
  baselineDays: number,
  opts: { includeDaily?: boolean } = {},
): TrendReport {
  const { days, prior, baseline } = trendWindows(start, end, baselineDays);
  const inRange = (r: DayRecord, s: string, e: string) => r.day >= s && r.day <= e;
  const current = records.filter((r) => inRange(r, start, end));
  const priorRecs = records.filter((r) => inRange(r, prior.start, prior.end));
  const baseRecs = records.filter((r) => inRange(r, baseline.start, baseline.end));

  const report: TrendReport = {
    range: { start, end, days },
    prior_period: prior,
    baseline_period: baseline,
    days_with_data: current.filter(hasData).length,
    missing_days: current.filter((r) => !hasData(r)).map((r) => r.day),
    metrics: TREND_METRICS.map((def) => metricTrend(def, current, priorRecs, baseRecs)),
  };
  if (days >= 21) report.weekly = weeklyBuckets(current);
  if (opts.includeDaily) {
    report.daily = current.map((r) => ({
      day: r.day,
      hrv_ms: r.hrv_ms,
      resting_hr_bpm: r.resting_hr_bpm,
      sleep_score: r.sleep_score,
      readiness_score: r.readiness_score,
      total_sleep_hours: r.total_sleep_hours,
      efficiency_pct: r.efficiency_pct,
    }));
  }
  return report;
}

/** How one day compares with the days before it (used by the daily summary). */
export function dayVsBaseline(day: DayRecord, baseline: DayRecord[]) {
  const out: Record<string, unknown> = {};
  for (const def of TREND_METRICS) {
    const value = day[def.key];
    const base = stats(baseline.map((r) => r[def.key]));
    if (value == null || base.average == null || base.days_with_data < MIN_BASELINE_DAYS) {
      out[def.key] = { value, baseline_average: base.average, status: "not enough data" };
      continue;
    }
    const diff = round(value - base.average);
    const z = base.std_dev ? round(diff / base.std_dev, 2) : null;
    out[def.key] = {
      value,
      baseline_average: base.average,
      difference: diff,
      z_score: z,
      status:
        z == null
          ? "within normal range"
          : z > 1
            ? "above normal range"
            : z < -1
              ? "below normal range"
              : "within normal range",
      assessment: assess(def, diff),
    };
  }
  return out;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

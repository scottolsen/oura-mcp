import type { DailyReadiness, DailySleep, SleepPeriod } from "../src/types.js";
import { eachDay } from "../src/dates.js";

export function sleepPeriod(day: string, overrides: Partial<SleepPeriod> = {}): SleepPeriod {
  return {
    id: `sleep-${day}-${overrides.type ?? "long_sleep"}-${overrides.total_sleep_duration ?? 27000}`,
    day,
    type: "long_sleep",
    bedtime_start: `${day}T00:00:00-06:00`,
    bedtime_end: `${day}T07:30:00-06:00`,
    average_hrv: 45,
    lowest_heart_rate: 50,
    average_heart_rate: 56.25,
    total_sleep_duration: 27000,
    time_in_bed: 28800,
    efficiency: 90,
    latency: 600,
    deep_sleep_duration: 5400,
    rem_sleep_duration: 6300,
    light_sleep_duration: 15300,
    awake_time: 1800,
    heart_rate: { interval: 300, items: [55, 54], timestamp: `${day}T00:00:00-06:00` },
    hrv: { interval: 300, items: [40, 50], timestamp: `${day}T00:00:00-06:00` },
    movement_30_sec: "1111",
    ...overrides,
  };
}

export function dailySleep(day: string, score: number | null = 80): DailySleep {
  return { id: `ds-${day}`, day, score, contributors: { total_sleep: 85, efficiency: 90 } };
}

export function readiness(day: string, score: number | null = 75): DailyReadiness {
  return {
    id: `rd-${day}`,
    day,
    score,
    temperature_deviation: -0.1,
    contributors: { hrv_balance: 70, resting_heart_rate: 90 },
  };
}

export interface Dataset {
  sleep: SleepPeriod[];
  daily_sleep: DailySleep[];
  daily_readiness: DailyReadiness[];
}

/** Build a dataset across a range with values produced per day index. */
export function dataset(
  start: string,
  end: string,
  fn: (i: number, day: string) => { hrv?: number; rhr?: number; score?: number; ready?: number } | null,
): Dataset {
  const out: Dataset = { sleep: [], daily_sleep: [], daily_readiness: [] };
  eachDay(start, end).forEach((day, i) => {
    const v = fn(i, day);
    if (!v) return;
    out.sleep.push(sleepPeriod(day, { average_hrv: v.hrv ?? 45, lowest_heart_rate: v.rhr ?? 50 }));
    out.daily_sleep.push(dailySleep(day, v.score ?? 80));
    out.daily_readiness.push(readiness(day, v.ready ?? 75));
  });
  return out;
}

export interface Recorded {
  url: URL;
  init?: RequestInit;
}

/**
 * A fake fetch that serves /v2/usercollection/* from a dataset, honouring
 * start_date/end_date (end exclusive for `sleep`, like the real endpoint has
 * been seen doing) and paging `pageSize` documents at a time.
 */
export function fakeOura(data: Dataset, opts: { pageSize?: number } = {}) {
  const calls: Recorded[] = [];
  const pageSize = opts.pageSize ?? 1000;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const collection = url.pathname.split("/").pop() as keyof Dataset;
    const docs = data[collection];
    if (!docs) return new Response("not found", { status: 404 });
    const start = url.searchParams.get("start_date") ?? "0000-00-00";
    const end = url.searchParams.get("end_date") ?? "9999-99-99";
    const inRange = (docs as { day: string }[]).filter((d) =>
      collection === "sleep" ? d.day >= start && d.day < end : d.day >= start && d.day <= end,
    );
    const offset = Number(url.searchParams.get("next_token") ?? 0);
    const page = inRange.slice(offset, offset + pageSize);
    const next = offset + pageSize < inRange.length ? String(offset + pageSize) : null;
    return Response.json({ data: page, next_token: next });
  }) as typeof fetch;
  return { fetchFn, calls };
}

export const staticTokens = {
  getAccessToken: async () => "test-token",
  refresh: async () => null,
};

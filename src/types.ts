/**
 * Subset of the Oura API v2 response models used by this server.
 * Field names follow https://cloud.ouraring.com/v2/docs. Durations are seconds.
 */

export interface ListResponse<T> {
  data: T[];
  next_token: string | null;
}

export type SleepType = "deleted" | "sleep" | "long_sleep" | "late_nap" | "rest";

export interface SleepPeriod {
  id: string;
  day: string;
  type: SleepType;
  bedtime_start: string;
  bedtime_end: string;
  average_breath?: number | null;
  average_heart_rate?: number | null;
  average_hrv?: number | null;
  lowest_heart_rate?: number | null;
  awake_time?: number | null;
  deep_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  rem_sleep_duration?: number | null;
  total_sleep_duration?: number | null;
  time_in_bed?: number | null;
  efficiency?: number | null;
  latency?: number | null;
  restless_periods?: number | null;
  [key: string]: unknown;
}

export interface DailySleep {
  id: string;
  day: string;
  score: number | null;
  timestamp?: string;
  contributors?: Record<string, number | null>;
}

export interface DailyReadiness {
  id: string;
  day: string;
  score: number | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
  timestamp?: string;
  contributors?: Record<string, number | null>;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds when the access token expires. */
  expires_at?: number;
  scope?: string;
  token_type?: string;
}

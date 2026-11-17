import { OURA_API_BASE } from "./config.js";
import { addDays } from "./dates.js";
import type { FetchFn, TokenProvider } from "./auth.js";
import type { DailyReadiness, DailySleep, ListResponse, SleepPeriod } from "./types.js";

export class OuraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl?: string;
  fetchFn?: FetchFn;
  /** Retries after a 429 or 5xx response. */
  maxRetries?: number;
  /** Wait function, replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Safety stop for runaway pagination. */
  maxPages?: number;
}

export type Collection = "sleep" | "daily_sleep" | "daily_readiness";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OuraClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPages: number;

  constructor(
    private readonly tokens: TokenProvider,
    opts: ClientOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? OURA_API_BASE;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxPages = opts.maxPages ?? 50;
  }

  /** GET a path, with auth, one retry after a token refresh, and backoff on 429/5xx. */
  async get<T>(path: string, query: Record<string, string | undefined>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);

    let token = await this.tokens.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.ok) return (await res.json()) as T;

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        const next = await this.tokens.refresh();
        if (next) {
          token = next;
          attempt--;
          continue;
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await this.sleep(retryDelayMs(res.headers.get("retry-after"), attempt));
        continue;
      }
      const body = (await res.text()).slice(0, 300);
      throw new OuraApiError(describeError(res.status, body), res.status);
    }
  }

  /** Every document in a collection, following next_token until the end. */
  async list<T>(collection: Collection, startDate: string, endDate: string): Promise<T[]> {
    const out: T[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.get<ListResponse<T>>(`/v2/usercollection/${collection}`, {
        start_date: startDate,
        end_date: endDate,
        next_token: nextToken,
      });
      out.push(...(res.data ?? []));
      if (!res.next_token) return out;
      nextToken = res.next_token;
    }
    throw new OuraApiError(`Stopped after ${this.maxPages} pages of ${collection}`, 0);
  }

  /**
   * Documents whose `day` falls in [start, end]. The query is widened by a day
   * on each side because the detailed sleep endpoint has been seen treating
   * end_date as exclusive; results are then filtered back to the range.
   */
  async listDays<T extends { day: string }>(
    collection: Collection,
    start: string,
    end: string,
  ): Promise<T[]> {
    const docs = await this.list<T>(collection, addDays(start, -1), addDays(end, 1));
    const seen = new Set<string>();
    return docs.filter((d) => {
      const id = (d as { id?: string }).id;
      if (id && seen.has(id)) return false;
      if (id) seen.add(id);
      return d.day >= start && d.day <= end;
    });
  }

  sleepPeriods(start: string, end: string): Promise<SleepPeriod[]> {
    return this.listDays<SleepPeriod>("sleep", start, end);
  }
  dailySleep(start: string, end: string): Promise<DailySleep[]> {
    return this.listDays<DailySleep>("daily_sleep", start, end);
  }
  dailyReadiness(start: string, end: string): Promise<DailyReadiness[]> {
    return this.listDays<DailyReadiness>("daily_readiness", start, end);
  }
}

export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000;
  return Math.min(1000 * 2 ** attempt, 30_000);
}

function describeError(status: number, body: string): string {
  switch (status) {
    case 401:
      return `Oura rejected the access token (401). Run "npx oura-mcp auth" again. ${body}`;
    case 403:
      return `Oura refused access (403). The token may be missing the "daily" scope, or the Oura membership may have lapsed. ${body}`;
    case 426:
      return `Oura says the Oura app needs updating before data is available (426). ${body}`;
    case 429:
      return `Oura rate limit hit (429: 5000 requests per 5 minutes). Try again shortly. ${body}`;
    default:
      return `Oura API error ${status}: ${body}`;
  }
}

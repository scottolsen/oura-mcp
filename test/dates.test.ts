import { describe, expect, it } from "vitest";
import { addDays, assertIsoDay, diffDays, eachDay, isIsoDay, todayIn } from "../src/dates.js";

describe("dates", () => {
  it("validates calendar dates", () => {
    expect(isIsoDay("2026-11-16")).toBe(true);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("11/16/2026")).toBe(false);
    expect(() => assertIsoDay("nope")).toThrow(/YYYY-MM-DD/);
  });

  it("adds and diffs days across month and DST boundaries", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(diffDays("2026-10-01", "2026-11-01")).toBe(31);
    expect(eachDay("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("works out today in a given time zone", () => {
    const now = new Date("2026-11-17T03:00:00Z"); // 9 PM on the 16th in Chicago
    expect(todayIn("America/Chicago", now)).toBe("2026-11-16");
    expect(todayIn("UTC", now)).toBe("2026-11-17");
  });
});

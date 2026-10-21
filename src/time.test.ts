import { describe, expect, test } from "bun:test";
import { window, zoned } from "./time";

describe("window", () => {
  test("runs from the day before's cutoff to the day's cutoff", () => {
    expect(window("2026-01-15", "18:30", "UTC")).toEqual({ from: "2026-01-14T18:30:00Z", to: "2026-01-15T18:30:00Z" });
  });

  test("follows the zone's offset", () => {
    expect(zoned("2026-01-15", "18:30", "Europe/Berlin").toISOString()).toBe("2026-01-15T17:30:00.000Z");
    expect(zoned("2026-07-15", "18:30", "Europe/Berlin").toISOString()).toBe("2026-07-15T16:30:00.000Z");
  });

  test("on Sunday after a Sunday–Thursday week, reaches back to Thursday", () => {
    const week = ["sun", "mon", "tue", "wed", "thu"];
    expect(window("2026-10-18", "18:30", "UTC", week).from).toBe("2026-10-15T18:30:00Z");
    expect(window("2026-10-19", "18:30", "UTC", week).from).toBe("2026-10-18T18:30:00Z");
    expect(window("2026-10-18", "18:30", "UTC").from).toBe("2026-10-17T18:30:00Z");
  });

  test("spans a DST change at its real length", () => {
    const w = window("2026-03-08", "09:00", "America/New_York");
    expect((Date.parse(w.to) - Date.parse(w.from)) / 36e5).toBe(23);
  });
});

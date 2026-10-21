// Days and windows in the project's time zone: what every source collects is "since the last issue's cutoff".

// The UTC instant of a wall-clock time in a time zone, DST included.
export function zoned(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t);
}

export const iso = (t: number | string) => new Date(t).toISOString().replace(".000Z", "Z");

export const daysBefore = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
export const today = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];

// The last issue day before `date`. Without `days` every day is one; with them, Sunday after a
// Sunday–Thursday week reaches back to Thursday, so Friday and Saturday's work isn't lost.
export function previousIssueDay(date: string, days?: readonly string[]) {
  for (let n = 1; n <= 7; n++) if (!days?.length || days.includes(weekdayOf(daysBefore(date, n)))) return daysBefore(date, n);
  return daysBefore(date, 1);
}

export function window(date: string, cutoff: string, tz: string, days?: readonly string[]) {
  return { from: iso(zoned(previousIssueDay(date, days), cutoff, tz).getTime()), to: iso(zoned(date, cutoff, tz).getTime()) };
}

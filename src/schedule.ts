import { Temporal } from "@js-temporal/polyfill";
import type { Series } from "./domain.js";
export function nextOccurrence(
  after: number,
  s: Pick<Series, "frequency" | "timezone" | "hour" | "minute" | "weekDay">,
): number {
  let date = Temporal.Instant.fromEpochMilliseconds(after)
    .toZonedDateTimeISO(s.timezone)
    .toPlainDate();
  if (s.frequency === "weekly")
    date = date.add({ days: (s.weekDay - date.dayOfWeek + 7) % 7 });
  const instant = () =>
    Temporal.ZonedDateTime.from(
      {
        timeZone: s.timezone,
        year: date.year,
        month: date.month,
        day: date.day,
        hour: s.hour,
        minute: s.minute,
      },
      { disambiguation: "compatible" },
    ).epochMilliseconds;
  if (instant() <= after)
    date = date.add({ days: s.frequency === "daily" ? 1 : 7 });
  return instant();
}

'use client';

/**
 * A timestamp in the viewer's timezone. The server renders in UTC (Vercel) and the browser in local time,
 * so the text legitimately differs between the two: suppressHydrationWarning keeps React from treating
 * that as a hydration error (#418) and re-rendering the whole page.
 */
export function LocalTime({ value, dateOnly = false }: { value: string | Date; dateOnly?: boolean }) {
  const d = new Date(value);
  return (
    <time dateTime={d.toISOString()} suppressHydrationWarning>
      {dateOnly ? d.toLocaleDateString() : d.toLocaleString()}
    </time>
  );
}

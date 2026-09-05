/**
 * Pure stamper that appends the wall-clock finish time to a tool result's content.
 * Agents carry no clock of their own: tool results are the one recurring channel through
 * which they can observe time passing, which is what turns a set_status ETA into a
 * measurement instead of a guess.
 * Functional core: the clock is injected, so the transformation is deterministic and testable.
 */

/** Structural text part — kept local so this module stays free of pi/SDK imports. */
type TextPart = { type: "text"; text: string };

/**
 * Local host time as HH:MM:SS, built from the Date getters rather than toLocaleTimeString
 * so the layout is fixed (no locale-dependent 12h/AM-PM or separator surprises).
 * Deliberately date-free (KISS): the cost is a wrong elapsed reading across midnight, which
 * is rare and never worth a date on every single tool result.
 */
function formatClockTime(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

/**
 * Returns the content with the stamp appended as its OWN trailing text part: existing parts
 * (including images) are never mutated or merged into, so the marker can never look like
 * part of the tool's own output. Generic in the part type to stay SDK-agnostic while
 * remaining assignable back to the caller's content array.
 *
 * @param finishedAt epoch milliseconds, supplied by the imperative shell.
 */
export function timestampToolResult<T>(
  content: readonly T[] | undefined,
  finishedAt: number,
): (T | TextPart)[] {
  const stamp: TextPart = {
    type: "text",
    text: `[finished ${formatClockTime(new Date(finishedAt))}]`,
  };
  return [...(content ?? []), stamp];
}

/**
 * Step through a fixed list of options, wrapping at both ends.
 *
 * One helper for both panel cycles (models and thinking levels), because "cycle" is the same
 * knowledge in both cases — only the list differs (DRY, without coupling the two domains).
 * A `current` that is not in the list means the caller is out of sync with the list (e.g. an
 * agent runs a model that is no longer enabled), so cycling starts at the near end instead of
 * failing: forward begins at the first entry, backward at the last.
 */
export function nextInCycle<T>(items: readonly T[], current: T | undefined, direction: 1 | -1): T | undefined {
	if (items.length === 0) return undefined;
	const index = current === undefined ? -1 : items.indexOf(current);
	if (index < 0) return direction === 1 ? items[0] : items[items.length - 1];
	return items[(index + direction + items.length) % items.length];
}

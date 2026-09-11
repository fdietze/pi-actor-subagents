/**
 * Parse the extension's single settings file (see index.ts for its location).
 *
 * The two fields deliberately fail in opposite directions:
 * - `caps` are ergonomic limits, so a missing or nonsensical field falls back to its default
 *   and a partial file still works. Refusing to run over a typo'd number helps nobody.
 * - `childExtensions` grants foreign code the child sessions' full process authority, so it is
 *   fail-closed: anything that is not exactly a list of non-empty strings grants nothing
 *   (Inversion — the failure to design out is "unreadable file silently loads something").
 */

/** Numeric limits of one swarm. */
export interface Caps {
	maxAgents: number; // excluding 'main'
	maxSpawnDepth: number;
}

export interface Settings {
	caps: Caps;
	/** Extension paths loaded into every child session, on top of its always-on tools. */
	childExtensions: string[];
}

/** Applied per field, so an unset or invalid single cap does not disturb the others. */
export const DEFAULT_CAPS: Caps = {
	maxAgents: 8,
	maxSpawnDepth: 3,
};

/** A limit is only usable as a count of agents or levels, hence positive integers only. */
function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function childExtensions(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) return [];
	return value;
}

/**
 * Parses the settings file's contents; unparseable text is treated as an empty file.
 * The file is flat (all three keys at the top level) because it is hand-edited; the `caps`
 * grouping exists only in the type, where it is what the engine is constructed from.
 */
export function parseSettings(json: string): Settings {
	let value: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed === "object" && parsed !== null) value = parsed as Record<string, unknown>;
	} catch {
		// Fall through to defaults; the file is the user's, not a contract we can repair.
	}
	return {
		caps: {
			maxAgents: positiveInt(value?.maxAgents, DEFAULT_CAPS.maxAgents),
			maxSpawnDepth: positiveInt(value?.maxSpawnDepth, DEFAULT_CAPS.maxSpawnDepth),
		},
		childExtensions: childExtensions(value?.childExtensions),
	};
}

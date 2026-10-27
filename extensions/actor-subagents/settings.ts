/**
 * Parse the extension's single settings file (see index.ts for its location).
 *
 * Each field fails in the direction its risk calls for:
 * - `caps` are ergonomic limits, so a missing or nonsensical field falls back to its default
 *   and a partial file still works. Refusing to run over a typo'd number helps nobody.
 * - `childExtensions` grants foreign code the child sessions' full process authority, so it is
 *   fail-closed: anything that is not exactly a list of non-empty strings grants nothing
 *   (Inversion — the failure to design out is "unreadable file silently loads something").
 * - `childExtensionStatusKeys` is display-only, so it fails open: anything that is not exactly a
 *   list of non-empty strings shows every key, as if unset.
 * - `spawnPolicyTimeoutMs` bounds a registered spawn policy's answer (api.ts); anything that is
 *   not a non-negative integer keeps the default bound, `0` waits without one.
 * - `promptCacheTtlMs` is display-only too: anything but a non-negative integer means the default.
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
	/** Child extension status keys kept for display; undefined keeps every key. */
	childExtensionStatusKeys: string[] | undefined;
	/** How long a spawn policy may take to answer one spawn (ms); 0 = no bound. */
	spawnPolicyTimeoutMs: number;
	/** The provider's prompt-cache lifetime, for list_subagents' cache column; 0 hides the column. */
	promptCacheTtlMs: number;
}

export const DEFAULT_SPAWN_POLICY_TIMEOUT_MS = 30_000;

function nonNegativeInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Applied per field, so an unset or invalid single cap does not disturb the others. */
export const DEFAULT_CAPS: Caps = {
	maxAgents: 8,
	maxSpawnDepth: 3,
};

/** Anthropic's default prompt-cache lifetime: a request within it reads the cache, later ones rebuild it. */
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;

/** A limit is only usable as a count of agents or levels, hence positive integers only. */
function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function childExtensions(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) return [];
	return value;
}

function childExtensionStatusKeys(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((entry) => typeof entry === "string" && entry.length > 0) ? value : undefined;
}

/**
 * Parses the settings file's contents; unparseable text is treated as an empty file.
 * The file is flat (all keys at the top level) because it is hand-edited; the `caps`
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
		childExtensionStatusKeys: childExtensionStatusKeys(value?.childExtensionStatusKeys),
		spawnPolicyTimeoutMs: nonNegativeInt(value?.spawnPolicyTimeoutMs, DEFAULT_SPAWN_POLICY_TIMEOUT_MS),
		promptCacheTtlMs: nonNegativeInt(value?.promptCacheTtlMs, DEFAULT_PROMPT_CACHE_TTL_MS),
	};
}

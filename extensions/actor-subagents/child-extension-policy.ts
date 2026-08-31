/**
 * Parse the explicit extension capability policy for child sessions.
 * Inversion + fail-closed security: any malformed shape grants no extension capability.
 */
export function parseChildExtensionPolicy(json: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return [];
	}
	const extensions = (value as { extensions?: unknown } | null)?.extensions;
	if (!Array.isArray(extensions)) return [];
	if (!extensions.every((entry) => typeof entry === "string" && entry.length > 0)) return [];
	return extensions;
}

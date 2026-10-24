/**
 * Footer statuses that a child session's extensions publish through Pi's standard
 * `ctx.ui.setStatus(key, text)`: an open key → text map, owned by the session (index.ts captures it
 * in the child's UI context) and only displayed, never interpreted. Pure and SDK-free.
 *
 * Parse, Don't Validate: text is normalized once, here at the write boundary, so the roster and
 * the LLM-facing listing can treat every stored value as short single-line plain text.
 */
export type ExtensionStatuses = Readonly<Record<string, string>>;

/** Per-entry cap in characters; a status is a glance, and every entry also reaches the LLM. */
export const EXTENSION_STATUS_MAX = 40;

// CSI (colors, cursor moves), OSC (hyperlinks, titles; BEL- or ST-terminated) and other
// two-byte escapes. Extensions style footer statuses with the theme, so ANSI is the norm.
// oxlint-disable-next-line no-control-regex -- matching escape sequences is the purpose
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
// Remaining C0/C1 control characters (newlines, tabs, a stray ESC) would break a single-line row.
// oxlint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Plain single-line text: escapes removed, control characters as spaces, whitespace collapsed,
 * capped by code points so an astral glyph (emoji) is never split.
 */
export function sanitizeStatusText(text: string): string {
	const plain = text.replace(ANSI_ESCAPE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	const chars = Array.from(plain);
	return chars.length > EXTENSION_STATUS_MAX ? `${chars.slice(0, EXTENSION_STATUS_MAX - 1).join("")}…` : plain;
}

/**
 * The statuses after one `setStatus(key, text)`. Returns the same object when nothing changed, so
 * the caller redraws only on real changes. Favor Immutability: a new object per change lets
 * renders hold a snapshot safely. Text that is empty after sanitizing clears the key, like
 * `undefined` does. Both arguments come from untyped extension code, so non-strings are treated
 * as a clear (text) or ignored (key), and the key is sanitized too: it reaches the LLM listing.
 * With `allowedKeys` (the `extensionStatusKeys` setting), every other key is ignored and the
 * entries are kept in the allowlist's order instead of sorted by key.
 */
export function withExtensionStatus(
	statuses: ExtensionStatuses,
	rawKey: unknown,
	text: unknown,
	allowedKeys?: readonly string[],
): ExtensionStatuses {
	const key = typeof rawKey === "string" ? sanitizeStatusText(rawKey) : "";
	if (key === "" || (allowedKeys && !allowedKeys.includes(key))) return statuses;
	const value = typeof text === "string" ? sanitizeStatusText(text) : "";
	if (value === "") {
		if (!(key in statuses)) return statuses;
		const { [key]: _removed, ...rest } = statuses;
		return rest;
	}
	if (statuses[key] === value) return statuses;
	// The display order is fixed here, once per change: allowlist order if given, else by key.
	// shortcut: integer-like keys ("1") always sort first in a JS object; use a Map if one appears.
	const entries = [...Object.entries(statuses).filter(([k]) => k !== key), [key, value] as const];
	entries.sort(([a], [b]) =>
		allowedKeys ? allowedKeys.indexOf(a) - allowedKeys.indexOf(b) : a.localeCompare(b),
	);
	return Object.fromEntries(entries);
}

/** Roster cell: values in stored order joined by spaces, like Pi's own footer status line. */
export function formatExtensionStatuses(statuses: ExtensionStatuses | undefined): string {
	return statuses ? Object.entries(statuses).map(([, text]) => text).join(" ") : "";
}

/**
 * LLM-facing form: `key: text` pairs. A bare glyph like "⏳2" means nothing to a model without
 * the name of the extension that set it.
 */
export function describeExtensionStatuses(statuses: ExtensionStatuses | undefined): string {
	return statuses ? Object.entries(statuses).map(([key, text]) => `${key}: ${text}`).join(", ") : "";
}

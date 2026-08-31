/**
 * Pure half of the tool-call preview rendered in agent-tools.ts (renderToolArgs): what to show
 * inline, what to show as a block, and how much of a block survives the collapsed view.
 * No pi/TUI dependency, fully testable.
 */

/**
 * Splits tool-call args into inline scalars ("key=value", joined on the title line for density) and string blocks
 * (rendered unindented below the title, each on its own line). No indents — they only waste
 * width. The free-text payload fields always get their own line (no length heuristic);
 * everything else stays inline.
 */
const BLOCK_FIELDS = new Set(["systemPrompt", "message", "content"]);
export function toolPreviewParts(args: Record<string, unknown>): {
	scalars: string[];
	blocks: { key: string; value: string }[];
} {
	const scalars: string[] = [];
	const blocks: { key: string; value: string }[] = [];
	for (const [key, value] of Object.entries(args ?? {})) {
		if (typeof value === "string" && BLOCK_FIELDS.has(key)) {
			blocks.push({ key, value });
		} else {
			scalars.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
	}
	return { scalars, blocks };
}

/**
 * Collapse one free-text block field (systemPrompt / message / content) for the COLLAPSED
 * tool-call preview: keep at most `maxLines` lines and `maxChars` characters. Returns the text
 * to show plus how much was hidden, so the renderer can append a "… +N lines" / expand hint.
 * The EXPANDED preview skips this and shows the full value. pi does not auto-collapse custom
 * renderCall output, so each block is truncated here explicitly.
 */
export function collapseBlock(
	value: string,
	maxLines: number,
	maxChars: number,
): { shown: string; hiddenLines: number; truncated: boolean } {
	const lines = value.split("\n");
	const head = lines.slice(0, maxLines);
	let shown = head.join("\n");
	let charCut = false;
	if (shown.length > maxChars) {
		shown = `${shown.slice(0, maxChars).trimEnd()}…`;
		charCut = true;
	}
	const hiddenLines = lines.length - head.length;
	return { shown, hiddenLines, truncated: charCut || hiddenLines > 0 };
}

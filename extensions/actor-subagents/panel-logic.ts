/** Pure helpers for the subagents panel — no pi/TUI dependency, fully testable. */
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	formatAgentMessageDisplay,
	parseRoutedAgentMessage,
} from "./agent-message.ts";
import { type AgentStatus, formatStatus } from "./agent-status.ts";
import { formatEtaSuffix } from "./eta.ts";
import { formatModelThinking, type ThinkingLevel } from "./thinking-level.ts";

export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

export function formatContext(u: ContextUsageLike | undefined): string {
	if (!u || u.tokens === null) return "—";
	// Fixed field widths so the display does not jump as the numbers grow.
	// Tokens used / context window only — the percentage is intentionally omitted from the roster.
	const used = k(u.tokens).padStart(5);
	const total = k(u.contextWindow).padEnd(4);
	return `${used}/${total}`;
}

/** Send targets of an agent from the message matrix, ordered by count desc (alpha tiebreak). */
export function sendTargets(
	matrix: Record<string, Record<string, number>>,
	name: string,
): { to: string; count: number }[] {
	const row = matrix[name];
	if (!row) return [];
	return Object.entries(row)
		.map(([to, count]) => ({ to, count }))
		.sort((a, b) => b.count - a.count || a.to.localeCompare(b.to));
}

/**
 * Roster cell of send targets: "➜main[3] ➜coder" (most-messaged first); "" when none.
 * The [count] is shown only when >1 message — a single message reads cleaner as plain "➜main".
 */
export function formatSendTargets(matrix: Record<string, Record<string, number>>, name: string): string {
	const t = sendTargets(matrix, name);
	if (t.length === 0) return "";
	return t.map((x) => (x.count > 1 ? `➜${x.to}[${x.count}]` : `➜${x.to}`)).join(" ");
}

export interface RosterEntry {
	name: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	context: string;
	/** Structured system status (agent-status.ts); the row renders label + tone from it. */
	status: AgentStatus;
	/** Agent-set freeform status (engine.setCustomStatus); shown after the system status. */
	customStatus?: string;
	/** Absolute ETA target (epoch ms); rendered in its own ETA column as clock time. */
	etaTs?: number;
	/** Send targets cell (formatSendTargets); appended in full, never truncated. */
	targets?: string;
}

/**
 * Swarm-wide scheduler state line, shown below the roster (panel) and footer. Expresses
 * the mode that /agents-pause and /agents-resume toggle plus the real activity count,
 * and makes paused mailbox behavior explicit. The fine-grained per-agent phase
 * (thinking/tool:.../idle) lives in the rows; this line is only the global mode.
 */
export function swarmStateLine(paused: boolean, runningCount: number): string {
	if (paused) return " ⏸ PAUSED — messages buffer · /agents-resume to continue ";
	return ` ▶ live · ${runningCount > 0 ? `${runningCount} working` : "idle"} `;
}

/**
 * Visual tone of a status: a failed turn gets a distinct (red) highlight, a running turn the
 * active-work highlight, everything else stays dim. Exhaustive over AgentStatus.kind, so a
 * new status cannot silently inherit a wrong tone. spawning and paused are stopped states
 * (awaiting a session / awaiting resume) and "truncated" is a resting outcome, so all three
 * dim like idle rather than showing as active work.
 */
export type StatusTone = "idle" | "busy" | "error";
export function statusTone(status: AgentStatus): StatusTone {
	switch (status.kind) {
		case "idle":
			return status.outcome === "error" ? "error" : "idle";
		case "working":
			return "busy";
		case "spawning":
		case "paused":
			return "idle";
	}
}

/**
 * Short model id for the roster: drop the "provider/" prefix. No hard cap — the model column
 * takes its natural width and is only truncated (line-level ellipsis) when the terminal is too
 * narrow, falling back to the column collapse order before that.
 */
export function shortModel(model: string | undefined): string {
	if (!model) return "";
	return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}

/** Compact model identity plus the effective effort Pi actually applies. */
export function formatModel(model: string | undefined, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelThinking(shortModel(model), thinkingLevel);
}

// ── responsive roster table (formatRoster) ──
//
// One single-line row per agent, columns aligned across rows. Reading order:
//   name · custom-status · system-status · eta · context · model · targets
// Protected columns (name, system-status, eta) are never hidden. The rest collapse — whole
// column dropped, all rows — when the terminal is too narrow, in this order:
//   model → targets → context → custom-status
// Alignment requires a roster-wide pass (column widths = max content across agents), so this
// replaces any per-row formatting. Layout math is plain-text (ASCII content + single-width
// glyphs); the status cell is styled only AFTER padding so ANSI never corrupts the widths.
// Callers still wrap each line in the ANSI-aware truncateToWidth as a final overflow guard.

const NAME_CAP = 24; // names beyond this are middle-elided (keeps the distinguishing tail)
export const CUSTOM_STATUS_MAX = 32; // hard cap on the agent-set status (also stated in the set_status prompt)
const SYS_STATUS_CAP = 18;

/** Truncate to width with a trailing ellipsis (plain-text width). */
function fitEnd(s: string, w: number): string {
	if (w <= 0) return "";
	if (s.length <= w) return s;
	return w === 1 ? "…" : `${s.slice(0, w - 1)}…`;
}

/** Truncate to width keeping head + tail (middle ellipsis) — for names, whose tail distinguishes. */
function fitMiddle(s: string, w: number): string {
	if (w <= 0) return "";
	if (s.length <= w) return s;
	if (w === 1) return "…";
	const keep = w - 1;
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ""}`;
}

interface ColSpec {
	key: string;
	// 0 = protected (never dropped); else the collapse order (1 dropped first … 4 dropped last).
	collapseRank: number;
	fit: "end" | "middle";
	cap?: number;
	cellOf: (e: RosterEntry) => string;
}

/**
 * Render the whole roster as aligned single-line rows (one string per agent, in input order).
 * `opts.selectedIndex` draws the ▸ cursor on that row (panel only; omit for the widget).
 * `opts.styleStatus` tones the system-status cell. Lines may still exceed `width` in the
 * degenerate case where the protected columns alone overflow — the caller's truncateToWidth clips.
 */
export function formatRoster(
	entries: RosterEntry[],
	width: number,
	opts: { selectedIndex?: number; styleStatus?: (label: string, tone: StatusTone) => string } = {},
): string[] {
	const styleStatus = opts.styleStatus ?? ((l) => l);
	// The ETA column exists only when at least one agent has set an ETA (otherwise wasted space).
	const hasEta = entries.some((e) => e.etaTs != null);

	const cols: ColSpec[] = [
		{ key: "name", collapseRank: 0, fit: "middle", cap: NAME_CAP, cellOf: (e) => e.name },
		{ key: "custom", collapseRank: 4, fit: "end", cap: CUSTOM_STATUS_MAX, cellOf: (e) => e.customStatus ?? "" },
		{ key: "status", collapseRank: 0, fit: "end", cap: SYS_STATUS_CAP, cellOf: (e) => formatStatus(e.status) },
		...(hasEta
			? [{ key: "eta", collapseRank: 0, fit: "end", cellOf: (e: RosterEntry) => (e.etaTs != null ? formatEtaSuffix(e.etaTs) : "") } as ColSpec]
			: []),
		{ key: "context", collapseRank: 3, fit: "end", cellOf: (e) => e.context },
		{ key: "model", collapseRank: 1, fit: "end", cellOf: (e) => formatModel(e.model, e.thinkingLevel) },
		{ key: "targets", collapseRank: 2, fit: "end", cellOf: (e) => e.targets ?? "" },
	];

	// Natural width per column = widest content across agents, clamped to its cap.
	const widthOf = new Map<string, number>();
	for (const c of cols) {
		let w = 0;
		for (const e of entries) w = Math.max(w, c.cellOf(e).length);
		widthOf.set(c.key, c.cap != null ? Math.min(w, c.cap) : w);
	}

	// Drop any collapsible column that is empty for every agent (e.g. no one has send targets).
	let visible = cols.filter((c) => c.collapseRank === 0 || (widthOf.get(c.key) ?? 0) > 0);

	const GAP = 1; // single space between columns
	const PREFIX = 2; // cursor + space
	const lineWidth = (set: ColSpec[]) =>
		PREFIX + set.reduce((sum, c) => sum + (widthOf.get(c.key) ?? 0), 0) + GAP * Math.max(0, set.length - 1);

	// Collapse the lowest-priority column until the row fits; protected columns are never dropped.
	while (lineWidth(visible) > width) {
		const victim = visible
			.filter((c) => c.collapseRank > 0)
			.sort((a, b) => a.collapseRank - b.collapseRank)[0];
		if (!victim) break; // only protected columns left — final guard clips the line
		visible = visible.filter((c) => c !== victim);
	}

	return entries.map((e, i) => {
		const cursor = opts.selectedIndex === i ? "▸" : " ";
		const cells = visible.map((c) => {
			const w = widthOf.get(c.key) ?? 0;
			const fitted = (c.fit === "middle" ? fitMiddle : fitEnd)(c.cellOf(e), w).padEnd(w);
			// Tone styling keys off the SYSTEM status only, applied after padding so widths stay exact.
			return c.key === "status" ? styleStatus(fitted, statusTone(e.status)) : fitted;
		});
		return `${cursor} ${cells.join(" ")}`.replace(/ +$/, "");
	});
}

// ── agent_history: a windowed, text-only transcript dump for inspecting any agent ──

type HistMessage = {
	role?: string;
	content?: unknown;
	customType?: string;
	details?: unknown;
};

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Concatenated thinking text of an assistant message ("" if none). */
function thinkingText(m: HistMessage): string {
	if (!Array.isArray(m.content)) return "";
	return (m.content as { type?: string; thinking?: string }[])
		.filter((p) => p?.type === "thinking")
		.map((p) => p.thinking ?? "")
		.join("");
}

/**
 * Render a window of an agent's transcript as plain text. A single slice primitive covers
 * beginning/middle/end: offset>=0 counts from the start (0 = beginning, the default),
 * offset<0 counts from the end (-30 = last 30). The header reports total + the shown range
 * so callers can page deterministically. The system prompt is included only when the window
 * covers index 0 (so the default offset:0 yields the agent's task + first exchange).
 * Thinking blocks are shown only when not hidden (aligned with the main UI's hideThinkingBlock).
 * Tool results are truncated hard (they are the bloat); message text is kept fuller.
 */
export function formatHistory(opts: {
	name: string;
	systemPrompt?: string;
	messages: HistMessage[];
	offset?: number;
	limit?: number;
	hideThinking?: boolean;
}): string {
	const { name, systemPrompt, messages, hideThinking } = opts;
	const total = messages.length;
	const limit = Math.max(1, opts.limit ?? 30);
	const raw = opts.offset ?? 0;
	const start = raw >= 0 ? Math.min(raw, total) : Math.max(0, total + raw);
	const end = Math.min(start + limit, total);
	const lines: string[] = [`agent ${name} · ${total} messages · showing [${start}, ${end})`];
	if (start === 0 && systemPrompt) lines.push("── system ──", trunc(systemPrompt, 800));
	for (let i = start; i < end; i++) {
		const m = messages[i];
		const role = m.role ?? "?";
		if (role === "assistant") {
			if (!hideThinking) {
				const th = thinkingText(m);
				if (th) lines.push(`#${i} assistant·thinking: ${trunc(th, 800)}`);
			}
			const txt = messageText(m.content);
			if (txt) lines.push(`#${i} assistant: ${trunc(txt, 800)}`);
			for (const c of toolCalls(m)) lines.push(`#${i} ⚙ ${c.name}(${trunc(JSON.stringify(c.arguments), 200)})`);
		} else if (role === "toolResult") {
			lines.push(`#${i} ⚙→ ${trunc(messageText(m.content), 200)}`);
		} else if (role === "user") {
			lines.push(`#${i} user: ${trunc(messageText(m.content), 800)}`);
		} else if (role === "custom" && m.customType === AGENT_MESSAGE_CUSTOM_TYPE) {
			const routed = parseRoutedAgentMessage(m.details);
			const display = routed
				? formatAgentMessageDisplay(routed)
				: { label: "agent message", body: messageText(m.content) };
			lines.push(`#${i} ${display.label}: ${trunc(display.body, 800)}`);
		} else {
			lines.push(`#${i} ${role}: ${trunc(messageText(m.content), 200)}`);
		}
	}
	if (end - start === 0) lines.push("(no messages in range)");
	return lines.join("\n");
}

export function moveSelection(current: number, delta: number, count: number): number {
	if (count <= 0) return 0;
	const next = current + delta;
	if (next < 0) return 0;
	if (next > count - 1) return count - 1;
	return next;
}

/**
 * Rows the panel may occupy: the bottom half of the terminal, leaving the main chat visible
 * above it. This mirrors pi-tui's percentage sizing exactly (`floor(reference * percent / 100)`;
 * see docs/tui.md and `parseSizeValue` in pi-tui's tui.js). A one-row floor matches pi's overlay
 * clamp for degenerate terminal sizes.
 *
 * Single source of truth — index.ts sizes the overlay with it and panel.ts sizes its transcript
 * with it, so the two cannot disagree and clip the chatbox (KISS, DRY).
 */
export function panelRows(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows / 2));
}

/**
 * Transcript height = whatever the panel's rows leave after its fixed chrome (header, roster,
 * state line, separator, chatbox, hint). Running as an overlay makes the real terminal height
 * available, so the transcript grows with the window instead of sitting at a hardcoded size.
 * Never returns less than `min`: a two-line transcript is useless, and the overlay clips.
 */
export function transcriptViewport(rows: number, chromeLines: number, min = 3): number {
	return Math.max(min, rows - chromeLines);
}

/** Extract plain text from message.content (string or part array). */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as { type?: string; text?: string }[])
			.filter((p) => p?.type === "text")
			.map((p) => p.text ?? "")
			.join("");
	}
	return "";
}

/** Tool-call names from an assistant message as "⚙ name" labels. */
export interface ToolCallPart {
	id: string;
	name: string;
	arguments: unknown;
}

/** Extract tool calls from an assistant message (id/name/arguments). */
export function toolCalls(m: { role?: string; content?: unknown }): ToolCallPart[] {
	if (m.role === "assistant" && Array.isArray(m.content)) {
		return (m.content as { type?: string; id?: string; name?: string; arguments?: unknown }[])
			.filter((p) => p?.type === "toolCall")
			.map((p) => ({ id: p.id ?? "", name: p.name ?? "tool", arguments: p.arguments }));
	}
	return [];
}

export function chatboxToRoute(selected: string | undefined, text: string): { to: string; content: string } | null {
	if (!selected) return null;
	const content = text.trim();
	if (!content) return null;
	return { to: selected, content };
}

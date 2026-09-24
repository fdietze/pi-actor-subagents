/**
 * Pure formatting for the read-only observability of the agents.
 * No pi/TUI dependency; the strings are rendered into the UI in index.ts.
 */
import type { OrderedAgent } from "./agent-order.ts";
import { type AgentStatus, formatStatus } from "./agent-status.ts";
import type { AgentRecord, ControlResult, EngineResumeResult, Reaction } from "./engine.ts";
import { formatCustomStatus } from "./eta.ts";
import { formatModelThinking } from "./thinking-level.ts";

/** Compact relative age: 3s / 4m / 2h. */
function formatAge(ms: number): string {
	const s = Math.floor(Math.max(0, ms) / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

/** Relation of an agent to the viewer, for orientation in deep hierarchies. */
function relTo(a: AgentRecord, viewer: string, viewerParent: string | undefined): string {
	if (a.name === viewer) return "self";
	if (a.spawnedBy === viewer) return "child";
	if (a.name === viewerParent) return "parent";
	if (viewerParent !== undefined && a.spawnedBy === viewerParent) return "peer";
	return "other";
}

/**
 * Roster as seen by `viewer` (the calling agent). Surfaces live health/progress
 * signals (spawning vs idle, context pressure, staleness) and the relation to the
 * viewer so an agent can decide: message, wait, or wind down. `now` is injected
 * for testability.
 *
 * Takes the spawn-tree order from orderAgents, whose depth becomes the name indent (one space
 * per level). main is listed here, so it renders at indent 0 and its children at 1.
 */
export function formatSnapshot(
	ordered: OrderedAgent<AgentRecord>[],
	viewer: string,
	// The effective status comes from the engine (Engine.status): a record alone cannot tell
	// whether a paused ancestor holds it.
	status: (a: AgentRecord) => AgentStatus,
	now: number = Date.now(),
): string {
	if (ordered.length === 0) return "no agents";
	const agents = ordered.map((o) => o.agent);
	// Columns are sized from the widest actual cell (clamped), not from a guessed constant:
	// padding alone leaves one long status shifting every later column on every other row,
	// while a fixed narrow column would routinely cut off the ETA. The clamp keeps a single
	// pathological name or status from stretching the whole table (Margin of Safety).
	const NAME_CAP = 20;
	const STATUS_CAP = 56;
	const clip = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}\u2026` : s);
	const fit = (s: string, w: number) => clip(s, w).padEnd(w);
	// The indent sits on top of the name cap, so nesting never costs name characters.
	const nameCell = (o: OrderedAgent<AgentRecord>) => `${" ".repeat(o.depth)}${clip(o.agent.name, NAME_CAP)}`;
	const viewerParent = agents.find((a) => a.name === viewer)?.spawnedBy;
	// Custom status (with any ETA) shown right after the system status, matching the TUI roster ("idle · ...").
	const statusOf = (a: AgentRecord) => {
		const customDisplay = formatCustomStatus(a.customStatus, a.etaTs);
		const label = formatStatus(status(a));
		return customDisplay ? `${label} · ${customDisplay}` : label;
	};
	const widest = (lengths: number[], cap: number) => Math.min(cap, Math.max(...lengths));
	const nameW = Math.max(...ordered.map((o) => nameCell(o).length));
	const statusW = widest(
		agents.map((a) => statusOf(a).length),
		STATUS_CAP,
	);
	const rows = ordered.map((o) => {
		const a = o.agent;
		const status = statusOf(a);
		const u = a.view?.getContextUsage();
		const ctx = u && u.percent != null ? `${Math.round(u.percent)}%` : "--";
		const rel = relTo(a, viewer, viewerParent);
		const queued = a.pending && a.buffer && a.buffer.length > 0 ? `, ${a.buffer.length} queued` : "";
		const model = formatModelThinking(a.model, a.thinkingLevel);
		// The foreground agent's turns are pi's own, not this engine's, and it has no spawner —
		// printing "turns:0 (by main)" for it would state two things that are not true.
		const isMain = a.name === "main";
		const turns = isMain ? "-" : String(a.turns);
		const origin = isMain ? "(foreground)" : `(by ${a.spawnedBy}${queued})`;
		return (
			`  ${nameCell(o).padEnd(nameW)} ${rel.padEnd(6)} ${fit(status, statusW)} ` +
			`turns:${turns.padEnd(3)} ctx:${ctx.padEnd(4)} last ${formatAge(now - a.lastActivity).padEnd(4)} ` +
			`${model}  ${origin}`
		);
	});
	return ["agents:", ...rows].join("\n");
}

/** Normalizes the target list: trims, drops empties, dedupes. */
export function normalizeTargets(to: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of to) {
		const name = raw.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}

/** Per-target result of a batch kill (kill_subagent takes an array of names). */
export interface KillOutcome {
	target: string;
	ok: boolean;
	reason?: string;
	/** Every name taken down for this target, including the target itself (kill cascades to the subtree). */
	killed?: string[];
}

/**
 * Per-target result of a multicast send: the message's fate, plus — for a delivered one — what
 * the bounded wait observed of the receiver. The two axes stay separate all the way to the text.
 */
export type MulticastRouteOutcome =
	| { target: string; outcome: "delivered"; reaction: Reaction }
	| { target: string; outcome: "buffered" }
	| { target: string; outcome: "failed"; reason: string };

/**
 * Receiver liveness as reported back to a sender, in the roster's own vocabulary plus one
 * refinement: an agent that sat out the whole window without starting a turn is annotated as not
 * having reacted. Only an actually elapsed window earns that annotation — an unwatched or
 * killed receiver says what it is instead of being guessed at.
 */
export function formatReceiverStatus(reaction: Reaction): string {
	if (reaction.observed === "gone") return "gone";
	const label = formatStatus(reaction.status);
	const stillIdle = reaction.status.kind === "idle" && reaction.status.outcome === undefined;
	return reaction.observed === "unmoved" && stillIdle ? `${label} (no reaction)` : label;
}

/**
 * Summarizes delivered, paused-buffered, and failed routes without conflating them, and reports
 * the receiver's state per target — state only, no advice on what the sender should do about it.
 */
export function formatMulticastResult(results: MulticastRouteOutcome[]): string {
	if (results.length === 0) return "error: no targets";
	const delivered: string[] = [];
	const buffered: string[] = [];
	const failed: string[] = [];
	for (const result of results) {
		if (result.outcome === "delivered") delivered.push(`${result.target} (${formatReceiverStatus(result.reaction)})`);
		else if (result.outcome === "buffered") buffered.push(`${result.target} (paused)`);
		else failed.push(`${result.target}: ${result.reason}`);
	}
	const parts: string[] = [];
	if (delivered.length) parts.push(`sent to ${delivered.join(", ")}`);
	if (buffered.length) parts.push(`buffered for ${buffered.join(", ")}`);
	if (failed.length) parts.push(`failed: ${failed.join("; ")}`);
	return parts.join(" · ");
}

const PAST_TENSE = { pause: "paused", resume: "resumed", kill: "killed" } as const;

/**
 * One text shape for every control operation: what actually changed, then per-target notes
 * (a success the caller would otherwise misread) and refusals. `details` describe the change and
 * are shown only when something changed, so zeros never claim work that did not happen.
 */
export function formatControlResult(
	action: keyof typeof PAST_TENSE,
	result: ControlResult,
	details: string[] = [],
): string {
	if (result.results.length === 0) return `no agents to ${action}`;
	const parts = result.affected.length
		? [`${PAST_TENSE[action]} ${result.affected.join(", ")}`, ...details]
		: [`nothing ${PAST_TENSE[action]}`];
	const notes = result.results.filter((r) => r.ok && r.reason).map((r) => `${r.target}: ${r.reason}`);
	const failed = result.results.filter((r) => !r.ok).map((r) => `${r.target}: ${r.reason}`);
	if (notes.length) parts.push(notes.join("; "));
	if (failed.length) parts.push(`failed: ${failed.join("; ")}`);
	return parts.join(" · ");
}

/** The resume text: the shared control shape plus what the resume released and re-triggered. */
export function formatResumeResult(result: EngineResumeResult): string {
	const noun = result.interrupted.length === 1 ? "agent" : "agents";
	return formatControlResult("resume", result, [
		`released ${result.bufferedMessages} buffered messages`,
		`retriggered ${result.interrupted.length} interrupted ${noun}`,
	]);
}

/** Summarizes a kill result compactly (for the tool response). */
export function formatKillResult(results: KillOutcome[]): string {
	if (results.length === 0) return "error: no targets";
	// Name the cascaded descendants explicitly: silently killing agents the caller never
	// named would be a surprise (The Map Is Not the Territory).
	const killed = results
		.filter((r) => r.ok)
		.map((r) => {
			const extra = (r.killed ?? []).filter((n) => n !== r.target);
			return extra.length ? `${r.target} (+${extra.join(", ")})` : r.target;
		});
	const failed = results.filter((r) => !r.ok).map((r) => `${r.target}: ${r.reason}`);
	const parts: string[] = [];
	if (killed.length) parts.push(`killed ${killed.join(", ")}`);
	if (failed.length) parts.push(`failed: ${failed.join("; ")}`);
	return parts.join(" · ");
}

/**
 * Pure formatting for the read-only observability of the agents.
 * No pi/TUI dependency; the strings are rendered into the UI in index.ts.
 */
import { agentStatus, formatStatus } from "./agent-status.ts";
import type { AgentRecord, AgentEvent, RouteResult } from "./engine.ts";
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
 */
export function formatSnapshot(
	agents: AgentRecord[],
	turnsUsed: number,
	turnBudget: number,
	viewer: string,
	paused: boolean = false,
	now: number = Date.now(),
): string {
	if (agents.length === 0) return "no agents";
	// Columns are sized from the widest actual cell (clamped), not from a guessed constant:
	// padding alone leaves one long status shifting every later column on every other row,
	// while a fixed narrow column would routinely cut off the ETA. The clamp keeps a single
	// pathological name or status from stretching the whole table (Margin of Safety).
	const NAME_CAP = 20;
	const STATUS_CAP = 56;
	const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}\u2026` : s.padEnd(w));
	const viewerParent = agents.find((a) => a.name === viewer)?.spawnedBy;
	// Custom status (with any ETA) shown right after the system status, matching the TUI roster ("idle · ...").
	const statusOf = (a: AgentRecord) => {
		const customDisplay = formatCustomStatus(a.customStatus, a.etaTs);
		const label = formatStatus(agentStatus(a));
		return customDisplay ? `${label} · ${customDisplay}` : label;
	};
	const widest = (lengths: number[], cap: number) => Math.min(cap, Math.max(...lengths));
	const nameW = widest(
		agents.map((a) => a.name.length),
		NAME_CAP,
	);
	const statusW = widest(
		agents.map((a) => statusOf(a).length),
		STATUS_CAP,
	);
	const rows = agents.map((a) => {
		const status = statusOf(a);
		const u = a.view?.getContextUsage();
		const ctx = u && u.percent != null ? `${Math.round(u.percent)}%` : "--";
		const rel = relTo(a, viewer, viewerParent);
		const queued = a.pending && a.buffer && a.buffer.length > 0 ? `, ${a.buffer.length} queued` : "";
		const model = formatModelThinking(a.model, a.thinkingLevel);
		// Only the foreground agent runs turns outside the budget accounting, and it has no
		// spawner — printing "turns:0 (by main)" for it would state two things that are not true.
		const isMain = a.name === "main";
		const turns = isMain ? "-" : String(a.turns);
		const origin = isMain ? "(foreground)" : `(by ${a.spawnedBy}${queued})`;
		return (
			`  ${fit(a.name, nameW)} ${rel.padEnd(6)} ${fit(status, statusW)} ` +
			`turns:${turns.padEnd(3)} ctx:${ctx.padEnd(4)} last ${formatAge(now - a.lastActivity).padEnd(4)} ` +
			`${model}  ${origin}`
		);
	});
	const scheduler = paused
		? `agents (budget ${turnsUsed}/${turnBudget}; PAUSED — messages are buffering; /agents-resume to continue):`
		: `agents (budget ${turnsUsed}/${turnBudget}):`;
	return [scheduler, ...rows].join("\n");
}

export function formatFeedLines(events: AgentEvent[]): string[] {
	return events.map((e) => {
		switch (e.type) {
			// main is the foreground chat, not something anyone spawned: it registers itself as
			// its own spawner, and "(by main)" would read as if it had a parent.
			case "spawn":
				return e.name === "main" ? "start   main (foreground)" : `spawn   ${e.name} (by ${e.by})`;
			case "route":
				return `route   ${e.from} -> ${e.to}${e.buffered ? " (buffered)" : ""}: ${e.preview}`;
			case "turn":
				return `turn    ${e.name}`;
			// Named agents mean a per-agent pause/resume; an empty list means the whole swarm.
			case "pause":
				return e.names.length ? `pause   ${e.names.join(", ")} (${e.reason})` : `pause   (swarm paused: ${e.reason})`;
			case "resume":
				return e.names.length ? `resume  ${e.names.join(", ")}` : `resume  (swarm live)`;
			case "kill":
				return `kill    ${e.name}`;
			case "error":
				return `error   ${e.name}: ${e.reason}`;
		}
	});
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

/** Per-target result of a batch kill (kill_agent takes an array of names). */
export interface KillOutcome {
	target: string;
	ok: boolean;
	reason?: string;
	/** Every name taken down for this target, including the target itself (kill cascades to the subtree). */
	killed?: string[];
}

export type MulticastRouteOutcome = RouteResult & { target: string };

/** Summarizes delivered, paused-buffered, and failed routes without conflating them. */
export function formatMulticastResult(results: MulticastRouteOutcome[]): string {
	if (results.length === 0) return "error: no targets";
	const delivered: string[] = [];
	const buffered: string[] = [];
	const failed: string[] = [];
	for (const result of results) {
		if (result.outcome === "delivered") delivered.push(result.target);
		else if (result.outcome === "buffered") buffered.push(result.target);
		else failed.push(`${result.target}: ${result.reason}`);
	}
	const parts: string[] = [];
	if (delivered.length) parts.push(`sent to ${delivered.join(", ")}`);
	if (buffered.length) parts.push(`buffered for ${buffered.join(", ")} (agents paused)`);
	if (failed.length) parts.push(`failed: ${failed.join("; ")}`);
	return parts.join(" · ");
}

export interface ResumeSummary {
	wasPaused: boolean;
	bufferedMessages: number;
	retriggered: number;
	/** A named resume hit the swarm-wide budget pause, which only a full resume can re-arm. */
	blockedByBudget?: boolean;
}

/**
 * Human-readable projection of the structured resume result.
 *
 * Resuming a swarm that was never paused does nothing at all — no inbox is released, no
 * agent is re-triggered and the budget keeps counting. Reporting those zeros next to
 * "budget re-armed" claimed work that did not happen, so that case gets its own short line.
 */
export function formatResumeSummary(summary: ResumeSummary): string {
	if (summary.blockedByBudget)
		return "swarm is paused on the turn budget · /agents-resume without names to re-arm and continue";
	if (!summary.wasPaused) return "agents already live · nothing to resume";
	const noun = summary.retriggered === 1 ? "agent" : "agents";
	return [
		"agents resumed",
		`released ${summary.bufferedMessages} buffered messages`,
		`retriggered ${summary.retriggered} interrupted ${noun}`,
		"budget re-armed",
	].join(" · ");
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

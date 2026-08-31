/**
 * The status vocabulary of an agent: one sum type, its derivation from the raw record
 * fields, and its rendering. Pure, SDK-free.
 *
 * Make illegal states unrepresentable + parse, don't validate: the status is derived ONCE
 * into `AgentStatus` and every consumer (roster label, panel tone, snapshot) switches on
 * `kind` instead of re-parsing the rendered label string. Adding a status therefore becomes
 * a compile error in every consumer instead of silently falling into a default branch.
 */

/** What an agent is doing right now, within a running turn. */
export type AgentActivity = "thinking" | "writing" | "tool";

/**
 * Terminal reason of an agent's last turn (mirror of pi-ai's StopReason; redeclared here to
 * keep the extension SDK-free). Only the idle-time outcomes matter for the status: "error"
 * (failed after the SDK exhausted its retries) and "length" (output truncated at max tokens).
 * "toolUse" never reaches idle (the agent keeps working), "aborted" is covered by pause/kill.
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * The four mutually exclusive things an agent can be, in precedence order:
 * spawning (session still starting) · paused (stopped mid-turn, awaiting resume) ·
 * working (a turn is running) · idle (turn finished, waiting for input).
 * `outcome` reports a noteworthy terminal reason of the finished turn.
 */
export type AgentStatus =
	| { kind: "spawning" }
	| { kind: "paused" }
	| { kind: "working"; phase: AgentActivity; tool?: string }
	| { kind: "idle"; outcome?: "error" | "truncated" };

/** The record fields the status is derived from (structural, so any record shape fits). */
export interface StatusInputs {
	pending?: boolean;
	/** The phase of the running turn; undefined means no turn is running. */
	activity?: AgentActivity;
	currentTool?: string;
	pausedMidTurn?: boolean;
	stopReason?: StopReason;
}

/**
 * Single source of truth for an agent's status, shared by the agent-facing roster
 * (list_agents) and the TUI panel so the vocabulary stays consistent.
 */
export function agentStatus(r: StatusInputs): AgentStatus {
	if (r.pending) return { kind: "spawning" };
	if (r.pausedMidTurn) return { kind: "paused" };
	if (!r.activity) {
		// Idle: surface a noteworthy terminal outcome of the last turn, else plain idle.
		if (r.stopReason === "error") return { kind: "idle", outcome: "error" };
		if (r.stopReason === "length") return { kind: "idle", outcome: "truncated" };
		return { kind: "idle" };
	}
	return { kind: "working", phase: r.activity, tool: r.currentTool };
}

/**
 * Render a status as the short label shown in the roster:
 * spawning · paused · thinking · writing · tool:<name> · idle · error · truncated
 */
export function formatStatus(s: AgentStatus): string {
	switch (s.kind) {
		case "spawning":
			return "spawning";
		case "paused":
			return "paused";
		case "working":
			return s.phase === "tool" ? (s.tool ? `tool:${s.tool}` : "tool") : s.phase;
		case "idle":
			return s.outcome ?? "idle";
	}
}

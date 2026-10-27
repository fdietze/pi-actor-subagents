/**
 * One agent as the API's `list()` reports it, with its usage read from the live transcript.
 * Pure: shared by api.ts and the `list_subagents` usage column (feed.ts), so neither depends on
 * the other.
 */
import type { AgentRecord } from "./agent-record.ts";
import type { AgentStatus } from "./agent-status.ts";
import type { ThinkingLevel } from "./thinking-level.ts";

export type AgentInfo = {
	/** Includes the foreground as `main` (its own parent, depth 0, no session transcript). */
	name: string;
	parent: string;
	/** "" while the agent is still spawning (a reserved name without a session yet). */
	sessionId: string;
	/** "(spawning)" while the agent is still spawning. */
	model: string;
	thinkingLevel: ThinkingLevel | undefined;
	state: "spawning" | "running" | "idle" | "paused";
	idleSinceMs?: number;
	lastRequestAt?: number;
	contextTokens?: number;
	costUsd?: number;
	policyMeta?: unknown;
};

type AssistantLike = { role?: string; timestamp?: number; usage?: { cost?: { total?: number } } };

/** `status` is the engine's (engine.status), so a paused ancestor's hold reads as paused. */
export function agentInfo(rec: AgentRecord, status: AgentStatus, now: number): AgentInfo {
	const state = rec.pending
		? "spawning"
		: status.kind === "paused"
			? "paused"
			: status.kind === "idle"
				? "idle"
				: "running";
	const assistants = ((rec.view?.getMessages?.() ?? []) as AssistantLike[]).filter((m) => m.role === "assistant");
	return {
		name: rec.name,
		parent: rec.spawnedBy,
		sessionId: rec.sessionId ?? "",
		model: rec.model,
		thinkingLevel: rec.thinkingLevel,
		state,
		idleSinceMs: state === "idle" ? now - rec.lastActivity : undefined,
		lastRequestAt: assistants.at(-1)?.timestamp,
		contextTokens: rec.view?.getContextUsage()?.tokens ?? undefined,
		costUsd: assistants.length ? assistants.reduce((sum, m) => sum + (m.usage?.cost?.total ?? 0), 0) : undefined,
		policyMeta: rec.policyMeta,
	};
}

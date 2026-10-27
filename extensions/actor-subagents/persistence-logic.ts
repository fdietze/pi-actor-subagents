/**
 * Pure persistence helpers — no pi/SDK/fs dependency, fully testable.
 * Message-shape logic for restoring subagent sessions from disk and serializing the
 * membership roster. Shapes mirror panel-logic.ts (assistant content = part array with
 * {type:"toolCall", id, name}; toolResult message = {role, toolCallId}).
 * Design: ../../../DESIGN.md
 */

import { isLifecycleNotice } from "./agent-message.ts";
import { isThinkingLevel, type ThinkingLevel } from "./thinking-level.ts";

export interface RawMessage {
	role?: string;
	customType?: string;
	details?: unknown;
	content?: unknown;
	toolCallId?: string;
	stopReason?: string;
}

interface ToolCallPart {
	type?: string;
	id?: string;
	name?: string;
}

/** Tool-call {id,name} parts of an assistant message (empty for non-assistant). */
function assistantToolCalls(m: RawMessage): { id: string; name: string }[] {
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	return (m.content as ToolCallPart[])
		.filter((p) => p?.type === "toolCall" && typeof p.id === "string")
		.map((p) => ({ id: p.id as string, name: p.name ?? "tool" }));
}

/**
 * Derive an agent's restored status from its transcript tail.
 * idle = the agent finished its turn: the last message is an assistant answer with no
 * tool calls and a normal stop reason. Everything else means it was mid-turn (trailing
 * toolResult the model still owes a reply to, dangling tool calls, or aborted/error) →
 * pausedMidTurn, so resume re-triggers it.
 * Silent lifecycle notices are skipped (actionable scheduler errors are not): they are appended silently (spawner.ts `append`) to a settled
 * session, so a trailing notice is not input the agent owes a reply to.
 */
export function deriveStatus(messages: RawMessage[]): "idle" | "pausedMidTurn" {
	const answerable = messages.filter((m) => !(m.role === "custom" && isLifecycleNotice(m.customType, m.details)));
	const last = answerable[answerable.length - 1];
	if (last === undefined) return "idle";
	if (
		last.role === "assistant" &&
		assistantToolCalls(last).length === 0 &&
		last.stopReason !== "aborted" &&
		last.stopReason !== "error"
	) {
		return "idle";
	}
	return "pausedMidTurn";
}

export interface RosterEntry {
	name: string;
	spawnedBy: string;
	depth: number;
	model: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt: string;
	sessionFile: string;
	/** The spawn policy's tool allowlist (api.ts PolicyAccept.tools); restored as it was. */
	tools?: string[];
	/** The spawn policy's meta, as JSON. */
	meta?: unknown;
	/** The agent ran with a spawn-policy tool guard, which only the policy can re-attach. */
	guarded?: true;
}

/** A JSON copy of `value`, or undefined when it has none (a cycle, a BigInt, a bare function). */
function jsonCopy(value: unknown): unknown {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Roster entries from engine records; only agents with a real session file persist. */
export function serializeRoster(
	agents: Array<{
		name: string;
		spawnedBy: string;
		depth: number;
		model: string;
		thinkingLevel?: ThinkingLevel;
		systemPrompt?: string;
		sessionFile?: string;
		policyTools?: string[];
		policyMeta?: unknown;
		policyGuarded?: true;
	}>,
): RosterEntry[] {
	return agents
		.filter((a) => a.name !== "main" && typeof a.sessionFile === "string")
		.map((a) => {
			// Copied here so one value that is not JSON cannot keep the whole roster from being written.
			const meta = a.policyMeta === undefined ? undefined : jsonCopy(a.policyMeta);
			return {
				name: a.name,
				spawnedBy: a.spawnedBy,
				depth: a.depth,
				model: a.model,
				...(a.thinkingLevel ? { thinkingLevel: a.thinkingLevel } : {}),
				systemPrompt: a.systemPrompt ?? "",
				sessionFile: a.sessionFile as string,
				...(a.policyTools ? { tools: [...a.policyTools] } : {}),
				...(meta !== undefined ? { meta } : {}),
				...(a.policyGuarded ? { guarded: true as const } : {}),
			};
		});
}

/**
 * Where a restored agent hangs in the spawn tree, given its persisted parent and that parent's
 * depth when the parent is live (undefined when it is not).
 *
 * Invariant kept here: every agent's `spawnedBy` is a live agent or 'main'. A parent that was
 * not restored (session file gone, model unavailable, reopen failed) would leave a dangling
 * parent, so main adopts the orphan — the ancestry walk then always ends at main, and pausing
 * main's direct children holds the whole restored swarm (Correctness by Construction). Relies on
 * the roster listing parents before their children, which holds because it is written in spawn
 * order and a child is only ever spawned by a live parent.
 */
export function restoredPlacement(
	spawnedBy: string,
	parentDepth: number | undefined,
): { spawnedBy: string; depth: number } {
	if (spawnedBy !== "main" && parentDepth !== undefined) return { spawnedBy, depth: parentDepth + 1 };
	return { spawnedBy: "main", depth: 1 };
}

/**
 * Convert a validated roster entry into the SDK-facing creation spec.
 * DRY: restoration forwards the same persisted level even when an empty transcript
 * contains no evidence from which the effective level could be reconstructed.
 */
export function sessionSpecFromRoster<T>(entry: RosterEntry, model: T) {
	return {
		name: entry.name,
		systemPrompt: entry.systemPrompt,
		spawnedBy: entry.spawnedBy,
		model,
		...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		// Fail closed: a restricted agent comes back with the same allowlist.
		...(entry.tools ? { tools: entry.tools } : {}),
	};
}

/** Parse + validate roster JSON; drops malformed entries, returns [] on any error. */
export function parseRoster(json: string): RosterEntry[] {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	return data.filter(
		(e): e is RosterEntry =>
			!!e &&
			typeof e.name === "string" &&
			typeof e.spawnedBy === "string" &&
			typeof e.depth === "number" &&
			typeof e.model === "string" &&
			(e.thinkingLevel === undefined || isThinkingLevel(e.thinkingLevel)) &&
			typeof e.systemPrompt === "string" &&
			typeof e.sessionFile === "string" &&
			// An unreadable restriction drops the entry rather than restoring the agent unrestricted.
			(e.tools === undefined ||
				(Array.isArray(e.tools) && e.tools.every((t: unknown) => typeof t === "string" && t.length > 0))) &&
			(e.guarded === undefined || e.guarded === true),
	);
}

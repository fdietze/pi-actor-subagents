/**
 * Subagents orchestration — SDK-free, so it stays headless-testable.
 * index.ts injects the real pi/SDK adapters (createSession, resolveModel, ...).
 * Design: ../../../DESIGN.md
 */
import type { RoutedAgentMessage } from "./agent-message.ts";
import type { StopReason } from "./agent-status.ts";
import type { AgentHandle, AgentRecord, AgentView, Engine } from "./engine.ts";
import { unknownModelMessage } from "./resolve-model.ts";
import { formatModelThinking, type ThinkingLevel } from "./thinking-level.ts";

export type { ThinkingLevel } from "./thinking-level.ts";

/** Terminal stopReason of the last assistant message in a transcript (undefined if none). */
function lastStopReason(messages: unknown[]): StopReason | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: StopReason };
		if (m.role === "assistant") return m.stopReason;
	}
	return undefined;
}

/** Minimal slice of an AgentSession that the orchestration needs. */
export interface SessionLike {
	/** Deliver peer traffic without representing it as a human-authored user message. */
	sendAgentMessage(
		message: RoutedAgentMessage,
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> | void;
	/** Deliver a real user-role turn (the panel's chatbox types AS the human, not as a peer). */
	sendUserMessage(text: string): Promise<void> | void;
	abort(): Promise<void> | void;
	/**
	 * Cancel a running bash command. abort() alone stops the agent loop but leaves an in-flight
	 * bash running, so every abort path pairs the two to actually stop the work.
	 */
	abortBash(): Promise<void> | void;
	/** Emit child extension session_shutdown before disposal. */
	shutdown(): Promise<void> | void;
	/** Permanently release the SDK session's listeners and resources. */
	dispose(): void;
	/** Effective level after Pi clamps the request to the model's capabilities. */
	readonly thinkingLevel: ThinkingLevel;
	/** Swap the model of the live session; the next LLM call uses it. */
	setModel(model: unknown): Promise<void>;
	/** Request an effort level; read `thinkingLevel` back for what the model actually allows. */
	setThinkingLevel(level: ThinkingLevel): void;
	subscribe(listener: (e: { type: string; message?: unknown; assistantMessageEvent?: unknown }) => void): () => void;
	readonly messages: unknown[];
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

/** Resolved model: provider/id for display + opaque SDK model object for createSession. */
export interface ResolvedModel {
	provider: string;
	id: string;
	model: unknown;
}

export interface SpawnSpec {
	name: string;
	systemPrompt: string;
	model?: string;
	/** Optional override; omitted means inherit the spawning agent's effective level. */
	thinkingLevel?: ThinkingLevel;
	/** Optional first message: delivered atomically to the new agent right after spawn. */
	message?: string;
}

export interface SpawnerDeps {
	engine: Engine;
	/** Resolve "provider/id" or undefined (=> inherit); undefined if unknown. */
	resolveModel: (ref: string | undefined) => ResolvedModel | undefined;
	/** Available models as "provider/id" (auth configured) — listed in the unknown-model error
	 * so a bad overrideModel self-corrects in one bounce instead of hallucinating again. */
	listAvailableModels?: () => string[];
	/**
	 * Create an isolated background agent session (SDK adapter in index.ts).
	 * Returns the live session plus its on-disk JSONL path (for the persistence roster;
	 * undefined for in-memory sessions).
	 */
	createSession: (spec: {
		name: string;
		systemPrompt: string;
		spawnedBy: string;
		model: unknown;
		thinkingLevel?: ThinkingLevel;
	}) => Promise<{ session: SessionLike; sessionFile?: string }>;
	/** Called after every relevant activity (e.g. refresh the status footer). */
	onActivity?: () => void;
}

/** Metadata to re-register an agent from a rehydrated (disk-loaded) session on restart. */
export interface RestoreSpec {
	name: string;
	spawnedBy: string;
	depth: number;
	model: string; // "provider/id" display string
	systemPrompt: string;
	sessionFile: string;
	session: SessionLike;
	/** Derived from the transcript tail: true => resume re-triggers it; false => idle. */
	pausedMidTurn: boolean;
}

export interface Spawner {
	spawnAgent: (spec: SpawnSpec, spawnerName: string) => Promise<{ ok: boolean; msg: string }>;
	/** Re-register an agent from a restored session (used by restart resume). */
	restoreAgent: (spec: RestoreSpec) => void;
}

/**
 * Build one idempotent teardown for a child SDK session.
 * Correctness by construction: the cached promise permits exactly one ordered pass even when
 * concurrent shutdown paths race. Every step runs so an abort failure cannot leak extensions.
 */
function createSessionCloser(session: SessionLike, detach: () => void = () => {}): () => Promise<void> {
	let closing: Promise<void> | undefined;
	return () => {
		if (closing) return closing;
		closing = (async () => {
			let failure: unknown;
			const attempt = async (action: () => Promise<void> | void): Promise<void> => {
				try {
					await action();
				} catch (error) {
					failure ??= error;
				}
			};
			// Bash before abort: abort() waits for the session to go idle, which a running bash
			// command would otherwise stretch out for as long as it takes.
			await attempt(() => session.abortBash());
			await attempt(() => session.abort());
			await attempt(detach);
			await attempt(() => session.shutdown());
			await attempt(() => session.dispose());
			if (failure) throw failure;
		})();
		return closing;
	};
}

export function createSpawner(deps: SpawnerDeps): Spawner {
	const { engine, resolveModel, createSession, onActivity, listAvailableModels } = deps;

	// Subscribe to a background session's lifecycle to enforce the turn budget and
	// track the turn phase.
	// streamingRef.msg holds the current turn's in-progress assistant message so the panel can
	// seed it on switch (view.getStreamingMessage). The partial lives only here mid-turn.
	const subscribeBackground = (name: string, session: SessionLike, streamingRef: { msg: unknown }): (() => void) => {
		return session.subscribe((ev) => {
			if (ev.type === "turn_start") {
				const r = engine.recordTurnStart(name);
				if (r.abort) void session.abort();
			}
			if (ev.type === "message_start" || ev.type === "message_update") {
				const msg = ev.message as { role?: string } | undefined;
				if (msg?.role === "assistant") streamingRef.msg = msg;
			}
			// Clear at message_end, where Pi commits the assistant message into session.messages.
			// Holding it until agent_end would leave the message BOTH committed and "streaming"
			// for the whole tool-execution window (e.g. while a bash call runs), and the panel would
			// render it twice: Pi emits a fresh copy on each message_update but the raw final object
			// at message_end, so the two are never reference-equal and the panel's identity dedup
			// cannot fire. This mirrors Pi's own main chat (streamingMessage = undefined at message_end).
			if (ev.type === "message_end") {
				const msg = ev.message as { role?: string } | undefined;
				if (msg?.role === "assistant") streamingRef.msg = undefined;
			}
			if (ev.type === "agent_start" || ev.type === "message_start") engine.beginTurn(name);
			// Refine the phase from streaming sub-events: reasoning vs answer text.
			if (ev.type === "message_update") {
				const sub = (ev.assistantMessageEvent as { type?: string } | undefined)?.type;
				if (sub === "thinking_start") engine.setActivity(name, "thinking");
				else if (sub === "text_start" || sub === "toolcall_start") engine.setActivity(name, "writing");
			}
			if (ev.type === "tool_execution_start")
				engine.setActivity(name, "tool", (ev as { toolName?: string }).toolName);
			if (ev.type === "agent_end") {
				streamingRef.msg = undefined; // safety net: clear any partial left if message_end was skipped
				engine.endTurn(name);
				// Surface the turn's terminal outcome at idle (error after retries / truncated).
				engine.setStopReason(name, lastStopReason(session.messages));
			}
			onActivity?.();
		});
	};

	// Wire a live session into engine plumbing: the message handle, the panel view, and the
	// lifecycle subscription (turn budget + streaming). Shared by fresh spawn and restore so
	// both paths behave identically.
	const wire = (
		name: string,
		session: SessionLike,
		systemPrompt: string,
	): { handle: AgentHandle; view: AgentView; close: () => Promise<void>; reconfigure: NonNullable<AgentRecord["reconfigure"]> } => {
		const handle: AgentHandle = {
			// Fire-and-forget: Pi's custom-message delivery awaits the prompted turn. Awaiting it
			// would block the caller (e.g. the spawn_subagent tool) until the target agent finishes.
			// Kick the turn and return; a
			// late failure surfaces as an engine error event (visible in /subagents-feed + panel).
			// deliverAs "steer": if the target is mid-turn, deliver at the next turn boundary
			// (after the current tool calls, before the next LLM call) instead of waiting for it
			// to fully stop. The child-only in-memory steeringMode "all" makes several queued
			// messages arrive at that boundary. Idle targets start a turn immediately.
			deliver: async (message) => {
				void Promise.resolve(session.sendAgentMessage(message, { deliverAs: "steer" })).catch((e) =>
					engine.reportError(name, e instanceof Error ? e.message : String(e)),
				);
			},
			// A human-authored turn, steered in like peer traffic so a busy agent picks it up at its
			// next turn boundary instead of only when it fully stops. Fire-and-forget for the same
			// reason as deliver: awaiting it would block the caller until the agent finishes.
			deliverUser: async (text) => {
				void Promise.resolve(session.sendUserMessage(text)).catch((e) =>
					engine.reportError(name, e instanceof Error ? e.message : String(e)),
				);
			},
			// Bash first: abort() ends the agent loop but a tool already running keeps going, so a
			// pause that leaves a build or test run alive would not be a pause at all.
			abort: async () => {
				await session.abortBash();
				await session.abort();
			},
		};
		const streamingRef: { msg: unknown } = { msg: undefined };
		const view: AgentView = {
			getMessages: () => session.messages,
			// Only the spawn prompt — not the full session.systemPrompt (infra preamble, AGENTS.md,
			// skills, etc.).
			getSystemPrompt: () => systemPrompt,
			getContextUsage: () => session.getContextUsage(),
			getStreamingMessage: () => streamingRef.msg,
			subscribe: (l) => session.subscribe(l),
		};
		const detach = subscribeBackground(name, session, streamingRef);
		// Retune adapter: apply what was asked, then report what the session ENDED UP with. The
		// level is read back because a model clamps an effort it cannot deliver, and the order
		// matters — the model must be in place before its clamping can be observed.
		const reconfigure: NonNullable<AgentRecord["reconfigure"]> = async (change) => {
			if (change.model) await session.setModel(change.model.model);
			if (change.thinkingLevel) session.setThinkingLevel(change.thinkingLevel);
			return { model: change.model?.display, thinkingLevel: session.thinkingLevel };
		};
		return { handle, view, close: createSessionCloser(session, detach), reconfigure };
	};

	const restoreAgent = (spec: RestoreSpec): void => {
		const { handle, view, close, reconfigure } = wire(spec.name, spec.session, spec.systemPrompt);
		engine.addAgent({
			name: spec.name,
			model: spec.model,
			thinkingLevel: spec.session.thinkingLevel,
			handle,
			view,
			close,
			reconfigure,
			systemPrompt: spec.systemPrompt,
			sessionFile: spec.sessionFile,
			spawnedBy: spec.spawnedBy,
			depth: spec.depth,
			createdAt: Date.now(),
			turns: 0,
			lastActivity: Date.now(),
			pausedMidTurn: spec.pausedMidTurn,
		});
	};

	const spawnAgent = async (spec: SpawnSpec, spawnerName: string): Promise<{ ok: boolean; msg: string }> => {
		const spawner = engine.get(spawnerName);
		const inheritRef = spec.model ?? spawner?.model;
		// The Map Is Not the Territory: inherit the observed effective level, not prior intent.
		const thinkingLevel = spec.thinkingLevel ?? spawner?.thinkingLevel;

		// 1) Reserve the name synchronously (atomic: duplicate/cap/depth) — closes races.
		const reserved = engine.reserve(spec.name, spawnerName);
		if (!reserved.ok) return { ok: false, msg: `error: ${reserved.reason}` };
		// Identity, not just the name, distinguishes this reservation from a later re-spawn.
		const reservation = engine.get(spec.name);

		const resolved = resolveModel(inheritRef);
		if (!resolved) {
			engine.release(spec.name);
			return { ok: false, msg: `error: ${unknownModelMessage(inheritRef, listAvailableModels?.() ?? [])}` };
		}

		// 2) Slow session creation (await). A concurrent send_message buffers meanwhile.
		let session: SessionLike;
		let sessionFile: string | undefined;
		try {
			({ session, sessionFile } = await createSession({
				name: spec.name,
				systemPrompt: spec.systemPrompt,
				spawnedBy: spawnerName,
				model: resolved.model,
				thinkingLevel,
			}));
		} catch (e) {
			if (engine.get(spec.name) === reservation) engine.release(spec.name);
			return { ok: false, msg: `error: failed to start '${spec.name}': ${e instanceof Error ? e.message : String(e)}` };
		}

		// A kill can win while session creation awaits. Close the orphan rather than attaching
		// it to a later reservation with the same name (Second-Order Thinking: avoid hidden work).
		if (engine.get(spec.name) !== reservation) {
			try {
				await createSessionCloser(session)();
			} catch {
				/* The reservation is already gone; best-effort cleanup cannot change that outcome. */
			}
			return { ok: false, msg: `error: spawn of '${spec.name}' was cancelled` };
		}

		// 3) Complete the reservation (flushes any buffered messages to the session).
		const { handle, view, close, reconfigure } = wire(spec.name, session, spec.systemPrompt);
		engine.attach(spec.name, {
			model: `${resolved.provider}/${resolved.id}`,
			thinkingLevel: session.thinkingLevel,
			handle,
			view,
			// Ordered child runtime cleanup is shared by kill and foreground shutdown.
			close,
			reconfigure,
			// Persisted to roster.json so a restart can rebuild this agent.
			systemPrompt: spec.systemPrompt,
			sessionFile,
		});

		// 4) Deliver the optional first message atomically (no race; the agent is registered).
		let sent = "";
		if (spec.message) {
			const outcome = await engine.route(spawnerName, spec.name, spec.message);
			if (outcome.outcome === "delivered") sent = " + sent initial message";
			else if (outcome.outcome === "buffered") sent = " + buffered initial message (agents paused)";
			else sent = ` (initial message NOT delivered: ${outcome.reason})`;
		}
		const model = formatModelThinking(`${resolved.provider}/${resolved.id}`, session.thinkingLevel);
		return { ok: true, msg: `spawned '${spec.name}' (model ${model})${sent}` };
	};

	return { spawnAgent, restoreAgent };
}

/**
 * Subagents orchestration — SDK-free, so it stays headless-testable.
 * index.ts injects the real pi/SDK adapters (createSession, resolveModel, ...).
 * Design: ../../../DESIGN.md
 */
import type { ExtensionStatuses } from "./extension-status.ts";
import type { RoutedAgentMessage } from "./agent-message.ts";
import { type Caller, decideSpawn, type SpawnPolicy } from "./api.ts";
import { formatStatusDetail, type StopReason } from "./agent-status.ts";
import type { AgentHandle, AgentRecord, AgentView } from "./agent-record.ts";
import type { Engine } from "./engine.ts";
import { formatReceiverStatus } from "./feed.ts";
import { unknownModelMessage } from "./resolve-model.ts";
import { formatModelThinking, type ThinkingLevel } from "./thinking-level.ts";
import type { ToolGuard } from "./tool-guard.ts";

export type { ThinkingLevel } from "./thinking-level.ts";

/** Terminal outcome of the last assistant message in a transcript (undefined if none). */
function lastAssistantOutcome(
	messages: unknown[],
): { stopReason: StopReason | undefined; errorMessage: string | undefined } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: StopReason; errorMessage?: string };
		if (message.role === "assistant") {
			return { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	return undefined;
}

/**
 * Is this the agent ending its turn: an assistant message that calls no tools? A failed provider
 * attempt is not, because Pi may retry it within the same run (agent-session.js _prepareRetry).
 */
function isFinalAnswer(message: unknown): boolean {
	const m = message as { role?: string; stopReason?: StopReason; content?: unknown } | undefined;
	if (m?.role !== "assistant" || m.stopReason === "error") return false;
	return !(Array.isArray(m.content) && m.content.some((c) => (c as { type?: string }).type === "toolCall"));
}

/** Minimal slice of an AgentSession that the orchestration needs. */
export interface SessionLike {
	/** Deliver peer traffic without representing it as a human-authored user message. */
	sendAgentMessage(
		message: RoutedAgentMessage,
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> | void;
	/** Append peer-format text to the transcript without starting a turn (only while not streaming). */
	appendAgentMessage(message: RoutedAgentMessage): Promise<void> | void;
	/** Is a run active (Pi's isStreaming: from the prompt's hand-off until agent_settled)? */
	readonly isStreaming: boolean;
	/** Deliver a real user-role turn (the panel's chatbox types AS the human, not as a peer). */
	sendUserMessage(text: string): Promise<void> | void;
	/**
	 * Stop the run and wait until the session is idle. Pi's abort signal also kills a running bash
	 * tool's process tree (pi-coding-agent core/tools/bash.js).
	 */
	abort(): Promise<void> | void;
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
	/** The session's definition of a tool (with its renderers), or undefined if it has none. */
	getToolDefinition(name: string): unknown;
	readonly messages: unknown[];
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	/** Current `ctx.ui.setStatus` entries of the session's extensions (extension-status.ts). */
	getExtensionStatuses(): ExtensionStatuses;
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
	/** Opaque task card, passed through to the spawn policy only. */
	task?: unknown;
}

export interface SpawnerDeps {
	engine: Engine;
	/** Resolve "provider/id" or undefined (=> inherit); undefined if unknown. */
	resolveModel: (ref: string | undefined) => ResolvedModel | undefined;
	/** Available models as "provider/id" (auth configured) — listed in the unknown-model error
	 * so a bad spawn `model` self-corrects in one bounce instead of hallucinating again. */
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
		/** Tool allowlist set by the spawn policy; undefined keeps the full default toolset. */
		tools?: string[];
		toolGuard?: ToolGuard;
	}) => Promise<{ session: SessionLike; sessionFile?: string; sessionId?: string }>;
	/** Called after every relevant activity (e.g. refresh the status footer). */
	onActivity?: () => void;
	/** The registered spawn policy (api.ts), read per spawn; none means the child inherits the spawner's model and effort. */
	spawnPolicy?: () => SpawnPolicy | undefined;
	/** Working directory reported to the policy as `caller.cwd`. */
	cwd?: () => string;
	/** How long one policy call may take (ms); 0 or absent = no bound. Read per spawn. */
	spawnPolicyTimeoutMs?: () => number;
}

/** Metadata to re-register an agent from a rehydrated (disk-loaded) session on restart. */
export interface RestoreSpec {
	name: string;
	spawnedBy: string;
	depth: number;
	model: string; // "provider/id" display string
	systemPrompt: string;
	sessionFile: string;
	sessionId?: string;
	session: SessionLike;
	/** Derived from the transcript tail: true => resume re-triggers it; false => idle. */
	pausedMidTurn: boolean;
	/** The spawn policy's persisted state (see AgentRecord). */
	policyTools?: string[];
	policyMeta?: unknown;
	policyGuarded?: true;
	/** Set when the agent must not run (its guard was not re-attached): restored paused and blocked. */
	runBlock?: string;
}

export interface Spawner {
	/** `rejected` marks a refusal by the spawn policy (the tool reports it as an error). */
	spawnAgent: (spec: SpawnSpec, spawnerName: string) => Promise<{ ok: boolean; msg: string; rejected?: true }>;
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
		let failure: unknown;
		// Detach synchronously, before anything is awaited (Correctness by Construction): the closer
		// runs on a removed record, so no event of this dying session may reach the engine, where a
		// re-spawned namesake would own the name. Engine.killSubtree relies on this to cut off a
		// whole subtree at once (AgentRecord.close).
		try {
			detach();
		} catch (error) {
			failure = error;
		}
		closing = (async () => {
			const attempt = async (action: () => Promise<void> | void): Promise<void> => {
				try {
					await action();
				} catch (error) {
					failure ??= error;
				}
			};
			await attempt(() => session.abort());
			await attempt(() => session.shutdown());
			await attempt(() => session.dispose());
			if (failure) throw failure;
		})();
		return closing;
	};
}

export function createSpawner(deps: SpawnerDeps): Spawner {
	const { engine, resolveModel, createSession, onActivity, listAvailableModels } = deps;

	// Subscribe to a background session's lifecycle to refuse a paused agent's turns and
	// track the turn phase.
	// streamingRef.msg holds the current turn's in-progress assistant message so the panel can
	// seed it on switch (view.getStreamingMessage). The partial lives only here mid-turn.
	//
	// run.abortRequested records that WE aborted the current logical run (a pause or a refused
	// turn). The SDK can file such a run as an "error" — a provider call that fails on the
	// already aborted signal after a cancelled tool — so the settled outcome of that run is
	// "aborted": a deliberate stop must not enter the error state or notify the parent. Our own fact
	// decides, not the SDK's wording (The Map Is Not the Territory). agent_start clears it, so an
	// abort that hit no run cannot mask an error in the next one.
	//
	// run.idle records that the agent ended its turn: its last assistant message called no tools,
	// or the run settled. The agent's status line (set_status) describes the state it rested in, so
	// the next accepted turn_start clears it (Correctness by Construction: a resting status like
	// 'waiting for critic' cannot outlive the wait). The boundary is the agent's own end of turn, not
	// agent_start: a message steered in right after a final answer continues the same run without a
	// new agent_start, and agent_start also repeats for every retry attempt. A refused turn of a paused
	// agent keeps the status. Pi awaits extension handlers before emitting agent_settled to listeners,
	// so a late settle can set idle during the next run's work; that only delays the clearing to the
	// next turn, which is accepted over extra tracking (KISS).
	const subscribeBackground = (
		name: string,
		session: SessionLike,
		streamingRef: { msg: unknown },
		run: { abortRequested: boolean; idle: boolean },
	): (() => void) => {
		return session.subscribe((ev) => {
			if (ev.type === "agent_start") run.abortRequested = false;
			// The engine refuses a stopped agent's turn itself, through the agent's `handle.abort` (which marks
			// `run.abortRequested`), so every abort it starts is tracked (engine.ts startAbort).
			if (ev.type === "turn_start" && !engine.recordTurnStart(name) && run.idle) {
				run.idle = false;
				engine.setCustomStatus(name, undefined);
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
				if (isFinalAnswer(ev.message)) run.idle = true;
			}
			// Only an assistant message opens a phase: a message_start for a silently appended notice
			// (or the run's own prompt) is not work, and must not mark an idle agent as thinking.
			if (ev.type === "agent_start" || (ev.type === "message_start" && (ev.message as { role?: string } | undefined)?.role === "assistant"))
				engine.beginTurn(name);
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
			}
			if (ev.type === "agent_settled") {
				run.idle = true;
				// The SDK emits agent_end for every retry attempt. Only agent_settled closes the
				// logical run, so deriving its outcome here produces one parent notice.
				const outcome = lastAssistantOutcome(session.messages);
				const stopReason = run.abortRequested && outcome?.stopReason === "error" ? "aborted" : outcome?.stopReason;
				engine.setStopReason(name, stopReason, outcome?.errorMessage);
				engine.flushNotices(name);
			}
			onActivity?.();
		});
	};

	// Wire a live session into engine plumbing: the message handle, the panel view, and the
	// lifecycle subscription (turn gating + streaming). Shared by fresh spawn and restore so
	// both paths behave identically.
	const wire = (
		name: string,
		session: SessionLike,
		systemPrompt: string,
	): { handle: AgentHandle; view: AgentView; close: () => Promise<void>; reconfigure: NonNullable<AgentRecord["reconfigure"]> } => {
		const run = { abortRequested: false, idle: true };
		// Turns handed to the session whose promise has not settled yet. Pi resolves a prompted
		// delivery only after its run settles, and a user message runs a preflight before its run
		// is marked active, so this covers the gap from hand-off to isStreaming. It cannot stick: it
		// counts promises, and every promise settles.
		let handoffs = 0;
		// A late failure is reported only while this session still backs the agent: names are
		// reused, so a killed agent's failure must not land on a re-spawned namesake.
		const reportError = (error: unknown): void => {
			if (engine.get(name)?.handle !== handle) return;
			engine.reportError(name, error instanceof Error ? error.message : String(error));
		};
		const handOff = async (send: () => Promise<void> | void): Promise<void> => {
			handoffs++;
			try {
				await send();
			} finally {
				handoffs--;
				engine.flushNotices(name);
			}
		};
		const handle: AgentHandle = {
			// Fire-and-forget: Pi's custom-message delivery awaits the prompted turn. Awaiting it
			// would block the caller (e.g. the spawn_subagent tool) until the target agent finishes.
			// Kick the turn and return; a
			// late failure surfaces as an engine error event (visible in the panel).
			// deliverAs "steer": if the target is mid-turn, deliver at the next turn boundary
			// (after the current tool calls, before the next LLM call) instead of waiting for it
			// to fully stop. The child-only in-memory steeringMode "all" makes several queued
			// messages arrive at that boundary. Idle targets start a turn immediately.
			deliver: async (message) => {
				void handOff(() => session.sendAgentMessage(message, { deliverAs: "steer" })).catch(reportError);
			},
			// A human-authored turn, steered in like peer traffic so a busy agent picks it up at its
			// next turn boundary instead of only when it fully stops. The promise resolves with the
			// prompted turn; the engine calls this fire-and-forget and reports a late failure.
			deliverUser: (text) => handOff(() => session.sendUserMessage(text)),
			append: (message) => {
				void Promise.resolve(session.appendAgentMessage(message)).catch(() => {
					/* see Engine.flushNotices: a lost notice is state the pull tools still show */
				});
			},
			busy: () => session.isStreaming || handoffs > 0,
			abort: async () => {
				run.abortRequested = true;
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
			getExtensionStatuses: () => session.getExtensionStatuses(),
			getStreamingMessage: () => streamingRef.msg,
			getToolDefinition: (toolName) => session.getToolDefinition(toolName),
			subscribe: (l) => session.subscribe(l),
		};
		const detach = subscribeBackground(name, session, streamingRef, run);
		// Retune adapter: apply what was asked, then report what the session ENDED UP with. The
		// level is read back because a model clamps an effort it cannot deliver, and the order
		// matters — the model must be in place before its clamping can be observed.
		// An omitted level means "keep the current one" (the tool contract). pi's setModel instead
		// applies the human's configured default level, so the current level is captured first and
		// re-requested after the switch; the new model still clamps it.
		const reconfigure: NonNullable<AgentRecord["reconfigure"]> = async (change) => {
			const level = change.thinkingLevel ?? session.thinkingLevel;
			if (change.model) await session.setModel(change.model.model);
			session.setThinkingLevel(level);
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
			sessionId: spec.sessionId,
			spawnedBy: spec.spawnedBy,
			depth: spec.depth,
			createdAt: Date.now(),
			turns: 0,
			lastActivity: Date.now(),
			pausedMidTurn: spec.pausedMidTurn,
			...(spec.policyTools ? { policyTools: spec.policyTools } : {}),
			...(spec.policyMeta !== undefined ? { policyMeta: spec.policyMeta } : {}),
			...(spec.policyGuarded ? { policyGuarded: true as const } : {}),
			// Its own pause: resuming its parent must not release it either (Engine.resume).
			...(spec.runBlock !== undefined ? { runBlock: spec.runBlock, paused: "restore" } : {}),
		});
	};

	const spawnAgent: Spawner["spawnAgent"] = async (spec, spawnerName) => {
		const spawner = engine.get(spawnerName);
		let inheritRef = spec.model ?? spawner?.model;
		// The Map Is Not the Territory: inherit the observed effective level, not prior intent.
		let thinkingLevel = spec.thinkingLevel ?? spawner?.thinkingLevel;

		// 1) Reserve the name synchronously (atomic: duplicate/cap/depth) — closes races.
		const reserved = engine.reserve(spec.name, spawnerName);
		if (!reserved.ok) return { ok: false, msg: `error: ${reserved.reason}` };
		// Identity, not just the name, distinguishes this reservation from a later re-spawn.
		const reservation = engine.get(spec.name);

		// 1b) The spawn policy, if one is registered, decides model and effort (after the reservation,
		// so a refused name or a full swarm never reaches it). A refusal frees the name.
		let message = spec.message;
		let tools: string[] | undefined;
		let toolGuard: ToolGuard | undefined;
		let policyMeta: unknown;
		const policy = deps.spawnPolicy?.();
		if (policy) {
			const caller: Caller = {
				name: spawnerName,
				sessionId: spawner?.sessionId ?? "",
				model: spawner?.model ?? "",
				thinkingLevel: spawner?.thinkingLevel,
				policyMeta: spawner?.policyMeta,
				cwd: deps.cwd?.() ?? process.cwd(),
			};
			const { name, systemPrompt, model, task } = spec;
			const args = { name, systemPrompt, message: spec.message ?? "", model, thinkingLevel: spec.thinkingLevel, task };
			// Never throws: a throwing, hanging or malformed policy is a refusal with a reason.
			const decided = await decideSpawn(policy, args, caller, deps.spawnPolicyTimeoutMs?.() ?? 0);
			// A kill (or a kill and re-spawn) of this name can land during the policy call; the
			// reservation is then gone or someone else's, so nothing is created and nothing released.
			if (engine.get(spec.name) !== reservation) return { ok: false, msg: `error: spawn of '${spec.name}' was cancelled` };
			if ("reject" in decided) {
				engine.release(spec.name);
				return { ok: false, rejected: true, msg: `error: ${decided.reject}` };
			}
			const decision = decided.accept;
			if (decision.model !== undefined) inheritRef = decision.model;
			if (decision.thinkingLevel !== undefined) thinkingLevel = decision.thinkingLevel;
			if (decision.briefAppend) message = message ? `${message}\n\n${decision.briefAppend}` : decision.briefAppend;
			tools = decision.tools;
			toolGuard = decision.toolGuard;
			policyMeta = decision.meta;
		}

		const resolved = resolveModel(inheritRef);
		if (!resolved) {
			// The policy await above lets a kill or re-spawn of this name land first.
			if (engine.get(spec.name) === reservation) engine.release(spec.name);
			return { ok: false, msg: `error: ${unknownModelMessage(inheritRef, listAvailableModels?.() ?? [])}` };
		}

		// 2) Slow session creation (await). A concurrent send_message buffers meanwhile.
		let session: SessionLike;
		let sessionFile: string | undefined;
		let sessionId: string | undefined;
		try {
			({ session, sessionFile, sessionId } = await createSession({
				name: spec.name,
				systemPrompt: spec.systemPrompt,
				spawnedBy: spawnerName,
				model: resolved.model,
				thinkingLevel,
				...(tools ? { tools } : {}),
				...(toolGuard ? { toolGuard } : {}),
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
			sessionId,
			policyMeta,
			...(tools ? { policyTools: tools } : {}),
			...(toolGuard ? { policyGuarded: true as const } : {}),
		});

		// 4) Deliver the optional first message atomically (no race; the agent is registered).
		let sent = "";
		if (message) {
			// Captured before delivery so the wait can see a reaction that already happened.
			const sinceEvent = engine.events.length;
			const outcome = await engine.route(spawnerName, spec.name, message);
			if (outcome.outcome === "delivered") {
				// Same bounded observation as send_message: the spawner learns whether the new agent
				// actually started on its task, without waiting for it to finish.
				const reaction = await engine.awaitReaction(spec.name, sinceEvent);
				sent = ` + sent initial message (${formatReceiverStatus(reaction)})`;
			} else if (outcome.outcome === "buffered") sent = ` + buffered initial message (${formatStatusDetail(outcome.status)})`;
			else sent = ` (initial message NOT delivered: ${outcome.reason})`;
		}
		const model = formatModelThinking(`${resolved.provider}/${resolved.id}`, session.thinkingLevel);
		return { ok: true, msg: `spawned '${spec.name}' (model ${model})${sent}` };
	};

	return { spawnAgent, restoreAgent };
}

/**
 * Subagents Engine — pure policy + registry, no pi-SDK dependency.
 * Design: ../../../DESIGN.md
 */
import {
	createRoutedAgentMessage,
	mergeRoutedAgentMessages,
	type RoutedAgentMessage,
} from "./agent-message.ts";
import type { AgentActivity, StopReason } from "./agent-status.ts";
import type { ThinkingLevel } from "./thinking-level.ts";

export interface AgentHandle {
	/** Delivers structured peer traffic; the adapter projects it into Pi's custom message. */
	deliver(message: RoutedAgentMessage): Promise<void>;
	/** Aborts this agent's running turn. */
	abort(): Promise<void>;
}

/** Live view of an agent for the panel. Optional, purely additive. */
export interface AgentView {
	getMessages(): unknown[];
	/** The system prompt the agent runs with (shown at the top of the transcript). */
	getSystemPrompt?(): string;
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	/**
	 * The in-progress assistant message of the current turn, or undefined when idle. Lives only
	 * in the event stream (session.messages gets it at message_end), so the panel seeds it on
	 * switch — otherwise a slow-thinking agent shows no "Thinking..." until its next delta event.
	 */
	getStreamingMessage?(): unknown;
	// Listener receives the full session event; `message` carries streaming deltas
	// (used by the panel for live streaming). Loosely typed to stay SDK-free.
	subscribe(listener: (e: { type: string; message?: unknown; assistantMessageEvent?: unknown }) => void): () => void;
}

/**
 * What a session runs after a retune, as the session itself reports it: the model that was
 * applied and the EFFECTIVE thinking level, which the model may have clamped down from the
 * requested one. Recording the observation rather than the request keeps the roster honest
 * (The Map Is Not the Territory).
 */
export interface AgentTuning {
	model?: string; // "provider/id", display only
	thinkingLevel?: ThinkingLevel;
}

/** A model to switch to: the display ref plus the opaque SDK model object it resolved to. */
export interface ModelChange {
	display: string;
	model: unknown;
}

export type RetuneResult = { ok: true; tuning: AgentTuning } | { ok: false; reason: string };

export interface AgentRecord {
	name: string;
	model: string; // "provider/id", display only
	/** Effective Pi level after the target model clamps the requested effort. */
	thinkingLevel?: ThinkingLevel;
	handle: AgentHandle;
	/** Optional live view of transcript/context/events (for the panel). */
	view?: AgentView;
	spawnedBy: string;
	depth: number; // main = 0
	createdAt: number;
	turns: number;
	lastActivity: number;
	/** System prompt the agent runs with (the spawn prompt, not the infra preamble). Persisted to roster.json so a restart can rebuild the session. */
	systemPrompt?: string;
	/** Absolute path of this agent's session JSONL on disk (undefined for 'main' + in-memory). */
	sessionFile?: string;
	/**
	 * Phase of the running turn (reasoning vs answer text vs tool run); undefined means no
	 * turn is running. Single field for "is it working" AND "at what": a separate streaming
	 * flag could contradict the phase, so that illegal state is now unrepresentable.
	 */
	activity?: AgentActivity;
	/** Agent-set semantic status, appended to the system status (in-memory; resets on restart). */
	customStatus?: string;
	/** Absolute target time (epoch ms) for the agent's ETA, rendered as clock time. Set via set_status's etaMinutes; cleared when omitted. In-memory; resets on restart. */
	etaTs?: number;
	/** Tool name while `activity === "tool"`. */
	currentTool?: string;
	/** Terminal reason of the last finished turn; drives the idle-time status (error/truncated). Cleared when a new turn starts. */
	stopReason?: StopReason;
	/**
	 * Set when the swarm was paused while this agent was mid-turn. Marks it for re-triggering
	 * on resume; survives the agent_end of an allowed-to-complete turn (endTurn must NOT clear
	 * it). Cleared by resume().
	 */
	pausedMidTurn?: boolean;
	/** Reservation intermediate state: name taken, session still being created. */
	pending?: boolean;
	/** Messages buffered while pending (flushed to the session on attach). */
	buffer?: RoutedAgentMessage[];
	/** Idempotent ordered runtime teardown — awaited on kill or foreground shutdown. */
	close?: () => Promise<void>;
	/**
	 * Swap the live session's model and/or thinking level (SDK adapter in spawner.wire).
	 * Absent for 'main' (pi owns the foreground model) and for a still-pending reservation,
	 * which is exactly what makes those two cases unretunable without a separate flag.
	 */
	reconfigure?: (change: { model?: ModelChange; thinkingLevel?: ThinkingLevel }) => Promise<AgentTuning>;
	/** Messages buffered while the swarm is paused. Released on resume. */
	pausedInbox?: RoutedAgentMessage[];
}

export interface Caps {
	maxAgents: number; // excluding 'main'
	maxSpawnDepth: number;
	turnBudget: number; // global across all background agents
}

export type AgentEvent =
	| { type: "spawn"; name: string; by: string; ts: number }
	// `buffered` distinguishes a message parked in a paused inbox from one handed to the
	// target session: the feed must not claim delivery for something that has not moved yet.
	| { type: "route"; from: string; to: string; preview: string; buffered: boolean; ts: number }
	| { type: "turn"; name: string; ts: number }
	| { type: "pause"; reason: PauseReason; ts: number }
	| { type: "resume"; ts: number }
	| { type: "kill"; name: string; ts: number }
	| { type: "error"; name: string; reason: string; ts: number };

/**
 * Why the swarm is paused. Only "budget" escalates to 'main' — a manual /agents-pause is the
 * human's own doing, and "restored" is how a rebuilt swarm comes up after a restart.
 */
export type PauseReason = "manual" | "budget" | "restored";

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** Kill reports every name it took down, because killing a parent takes its subtree with it. */
export type KillResult = { ok: true; killed: string[] } | { ok: false; reason: string };

/** Structured routing result; callers never infer delivery state from display prose. */
export type RouteResult =
	| { outcome: "delivered" }
	| { outcome: "buffered"; reason: "paused" }
	| { outcome: "failed"; reason: string };

/** Counts work released by resume without claiming asynchronous delivery completed. */
export interface EngineResumeResult {
	wasPaused: boolean;
	bufferedMessages: number;
}

const RESERVED = new Set(["main"]);
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class Engine {
	readonly events: AgentEvent[] = [];
	private readonly agents = new Map<string, AgentRecord>();
	private readonly listeners = new Set<(e: AgentEvent) => void>();
	// Graph tracking (in-memory, survives /reload via the singleton, resets on pi restart).
	private readonly messageEdges = new Map<string, Map<string, number>>(); // from -> (to -> count)
	private readonly spawnParent = new Map<string, string>(); // child -> parent (main = root, no entry)
	private paused = false;
	private pauseReason: PauseReason | undefined;
	private turnsUsed = 0;
	private readonly caps: Caps;

	// Note: no TS parameter properties — Node's strip-only mode (node --test on .ts)
	// does not support them.
	constructor(caps: Caps) {
		this.caps = caps;
	}

	private emit(e: AgentEvent): void {
		this.events.push(e);
		for (const l of this.listeners) l(e);
	}

	subscribe(l: (e: AgentEvent) => void): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	has(name: string): boolean {
		return this.agents.has(name);
	}

	get(name: string): AgentRecord | undefined {
		return this.agents.get(name);
	}

	list(): AgentRecord[] {
		return [...this.agents.values()];
	}

	get budget(): { used: number; total: number } {
		return { used: this.turnsUsed, total: this.caps.turnBudget };
	}

	canSpawn(name: string, spawnerDepth: number): CheckResult {
		if (RESERVED.has(name)) return { ok: false, reason: `name '${name}' is reserved` };
		if (!NAME_RE.test(name)) return { ok: false, reason: `invalid name '${name}' (use [a-zA-Z0-9_-])` };
		if (this.agents.has(name)) return { ok: false, reason: `agent '${name}' already exists` };
		const backgroundCount = [...this.agents.values()].filter((a) => a.name !== "main").length;
		if (backgroundCount >= this.caps.maxAgents) {
			return { ok: false, reason: `max agents reached (${this.caps.maxAgents})` };
		}
		if (spawnerDepth + 1 > this.caps.maxSpawnDepth) {
			return { ok: false, reason: `max spawn depth reached (${this.caps.maxSpawnDepth})` };
		}
		return { ok: true };
	}

	addAgent(rec: AgentRecord): void {
		this.agents.set(rec.name, rec);
		this.emit({ type: "spawn", name: rec.name, by: rec.spawnedBy, ts: Date.now() });
	}

	// --- Atomic reservation (prevents spawn/send, duplicate and cap races) ---
	// canSpawn (sync) is separated from the slow session creation by an await;
	// reserve locks the name synchronously, attach fills in the real session afterwards.

	/** Reserves an agent name synchronously. Buffers messages until attach. */
	reserve(name: string, spawnerName: string): CheckResult {
		const spawner = this.agents.get(spawnerName);
		const depth = spawner ? spawner.depth : 0;
		const check = this.canSpawn(name, depth);
		if (!check.ok) return check;
		// Full clean slate for a re-spawned name: drop its old incoming + outgoing edges.
		this.messageEdges.delete(name);
		for (const targets of this.messageEdges.values()) targets.delete(name);
		this.spawnParent.set(name, spawnerName);
		const buffer: RoutedAgentMessage[] = [];
		const record: AgentRecord = {
			name,
			model: "(spawning)",
			handle: {
				deliver: async (message) => {
					buffer.push(message);
				},
				abort: async () => {},
			},
			spawnedBy: spawnerName,
			depth: depth + 1,
			createdAt: Date.now(),
			turns: 0,
			lastActivity: Date.now(),
			pending: true,
			buffer,
		};
		this.agents.set(name, record);
		this.emit({ type: "spawn", name, by: spawnerName, ts: Date.now() });
		return { ok: true };
	}

	/** Completes a reservation: set the real session data + flush the buffer. */
	attach(
		name: string,
		opts: {
			model: string;
			thinkingLevel?: ThinkingLevel;
			handle: AgentHandle;
			view?: AgentView;
			close?: () => Promise<void>;
			reconfigure?: AgentRecord["reconfigure"];
			systemPrompt?: string;
			sessionFile?: string;
		},
	): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		rec.model = opts.model;
		rec.thinkingLevel = opts.thinkingLevel;
		rec.handle = opts.handle;
		rec.view = opts.view;
		rec.close = opts.close;
		rec.reconfigure = opts.reconfigure;
		rec.systemPrompt = opts.systemPrompt;
		rec.sessionFile = opts.sessionFile;
		rec.pending = false;
		const buffered = rec.buffer ?? [];
		rec.buffer = undefined;
		for (const t of buffered) void opts.handle.deliver(t);
	}

	/** Release a reservation (session creation failed). */
	release(name: string): void {
		this.agents.delete(name);
	}

	/** Close a removed record without letting one faulty child block registry cleanup. */
	private async closeRecord(rec: AgentRecord): Promise<void> {
		try {
			await rec.close?.();
		} catch (error) {
			this.emit({
				type: "error",
				name: rec.name,
				reason: `runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
				ts: Date.now(),
			});
		}
	}

	/** Terminate an agent and await its runtime teardown. 'main' is off-limits. */
	/**
	 * Kill an agent AND its whole subtree, deepest first.
	 *
	 * The spawn tree is the ownership structure: a child exists to serve its spawner, and its
	 * only upward channel is that spawner. Orphaning it leaves an agent nobody reads, still
	 * holding one of the `maxAgents` slots and still able to burn turn budget — a leak with no
	 * reader (Second-Order Thinking). Killing individual leaves stays possible: name them.
	 */
	async kill(name: string): Promise<KillResult> {
		if (name === "main") return { ok: false, reason: "cannot kill 'main'" };
		const rec = this.agents.get(name);
		if (!rec) return { ok: false, reason: `unknown agent '${name}'` };

		// Post-order: descendants precede their parent, so no record is closed while a live
		// child could still be routing into it.
		const subtree: AgentRecord[] = [];
		const collect = (parent: string) => {
			for (const candidate of this.agents.values()) {
				// 'main' is its own spawner; guarding against that keeps the walk from looping.
				if (candidate.name !== "main" && candidate.spawnedBy === parent) collect(candidate.name);
			}
			const r = this.agents.get(parent);
			if (r) subtree.push(r);
		};
		collect(name);

		// Inversion: remove first so no new message can enter a runtime while it closes.
		for (const r of subtree) this.agents.delete(r.name);
		for (const r of subtree) {
			await this.closeRecord(r);
			this.emit({ type: "kill", name: r.name, ts: Date.now() });
		}
		return { ok: true, killed: subtree.map((r) => r.name) };
	}

	/**
	 * Retune a live agent and adopt what its session reports back.
	 *
	 * Applies immediately and does not wait for a boundary: a turn already running may finish on
	 * the old model, the next one uses the new. Refusing while busy would push callers into the
	 * polling loop the prompts forbid, and aborting the turn would burn work.
	 */
	async retune(name: string, change: { model?: ModelChange; thinkingLevel?: ThinkingLevel }): Promise<RetuneResult> {
		if (name === "main") return { ok: false, reason: "cannot retune 'main' (use pi's own model controls)" };
		const rec = this.agents.get(name);
		if (!rec) return { ok: false, reason: `unknown agent '${name}'` };
		if (!rec.reconfigure) return { ok: false, reason: `agent '${name}' is still spawning` };
		try {
			const tuning = await rec.reconfigure(change);
			if (tuning.model) rec.model = tuning.model;
			rec.thinkingLevel = tuning.thinkingLevel;
			rec.lastActivity = Date.now();
			return { ok: true, tuning };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Kill all agents except 'main'. Returns the names of those killed. */
	async killAll(): Promise<string[]> {
		const killed: string[] = [];
		for (const name of [...this.agents.keys()]) {
			if (name === "main") continue;
			if ((await this.kill(name)).ok) killed.push(name);
		}
		return killed;
	}

	/**
	 * Close all child runtimes without emitting kill events. Foreground replacement uses this
	 * path so persisted membership remains authoritative and can be restored in the next session.
	 */
	async shutdownAll(): Promise<void> {
		const records = [...this.agents.values()].filter((rec) => rec.name !== "main");
		for (const rec of records) this.agents.delete(rec.name);
		await Promise.all(records.map((rec) => this.closeRecord(rec)));
	}

	isPaused(): boolean {
		return this.paused;
	}

	/**
	 * Pause the swarm. Marks every agent that is currently mid-turn as `pausedMidTurn` so
	 * resume can re-trigger their interrupted work; idle agents are left alone. Cause-agnostic:
	 * covers /agents-pause, the turn budget and a restored swarm uniformly.
	 */
	pause(reason: PauseReason = "manual"): void {
		this.paused = true;
		this.pauseReason = reason;
		for (const rec of this.agents.values()) {
			// A set activity IS "mid-turn" — that is exactly whose work resume must re-trigger.
			if (rec.name !== "main" && rec.activity !== undefined) rec.pausedMidTurn = true;
		}
		this.emit({ type: "pause", reason, ts: Date.now() });
	}

	/**
	 * Resume a paused swarm. A no-op when the swarm is already live: re-arming the budget
	 * there would silently reset the safety valve, so any caller could poll it away
	 * (Inversion: the failure mode to exclude is a swarm that never reaches its budget stop).
	 */
	resume(): EngineResumeResult {
		if (!this.paused) return { wasPaused: false, bufferedMessages: 0 };
		let bufferedMessages = 0;
		const wasPaused = true;
		this.paused = false;
		this.pauseReason = undefined;
		this.turnsUsed = 0;
		for (const rec of this.agents.values()) rec.pausedMidTurn = false;

		// Release paused inboxes in FIFO order. Delivery is intentionally fire-and-forget,
		// so the result counts released messages rather than claiming they completed.
		for (const rec of this.agents.values()) {
			const inbox = rec.pausedInbox;
			if (inbox && inbox.length > 0) {
				rec.pausedInbox = undefined;
				bufferedMessages += inbox.length;
				// KISS + Inversion: one atomic batch preserves every message and avoids racing
				// several idle-session starts, which can accept the first prompt and drop the rest.
				void rec.handle.deliver(mergeRoutedAgentMessages(inbox));
			}
		}

		this.emit({ type: "resume", ts: Date.now() });
		return { wasPaused, bufferedMessages };
	}

	async route(from: string, to: string, content: string): Promise<RouteResult> {
		const target = this.agents.get(to);
		if (!target) return { outcome: "failed", reason: `unknown agent '${to}'` };
		const message = createRoutedAgentMessage(from, content);
		// One tail for both outcomes: a paused swarm parks the message, a live one hands it over.
		// Everything after that (edge count, activity, feed event) is identical, so it is written once.
		const buffered = this.paused;
		if (buffered) (target.pausedInbox ??= []).push(message);
		else await target.handle.deliver(message);
		target.lastActivity = Date.now();
		// Count the message edge for the relationship graph.
		let targets = this.messageEdges.get(from);
		if (!targets) {
			targets = new Map<string, number>();
			this.messageEdges.set(from, targets);
		}
		targets.set(to, (targets.get(to) ?? 0) + 1);
		const preview = content.length > 60 ? `${content.slice(0, 60)}...` : content;
		this.emit({ type: "route", from, to, preview, buffered, ts: Date.now() });
		return buffered ? { outcome: "buffered", reason: "paused" } : { outcome: "delivered" };
	}

	/** Adjacency matrix of message counts: from -> (to -> count). Plain snapshot copy. */
	getMessageMatrix(): Record<string, Record<string, number>> {
		const out: Record<string, Record<string, number>> = {};
		for (const [from, targets] of this.messageEdges) {
			out[from] = Object.fromEntries(targets);
		}
		return out;
	}

	/** Spawn tree as child -> parent. Plain snapshot copy ('main' has no parent). */
	getSpawnTree(): Record<string, string> {
		return Object.fromEntries(this.spawnParent);
	}

	/** Call before every background turn. abort=true => caller must call session.abort(). */
	recordTurnStart(name: string): { abort: boolean; reason?: string } {
		if (this.paused) {
			return {
				abort: true,
				reason: this.pauseReason === "budget" ? `turn budget exhausted (${this.caps.turnBudget})` : "agents paused",
			};
		}
		this.turnsUsed++;
		const rec = this.agents.get(name);
		if (rec) {
			rec.turns++;
			rec.lastActivity = Date.now();
		}
		this.emit({ type: "turn", name, ts: Date.now() });
		// Pause-by-blocking: the turn that REACHES the budget is allowed to complete
		// (abort:false). Only subsequent turn_starts hit the paused guard above and abort.
		// This stops agents at clean turn boundaries instead of cutting an in-flight turn.
		// pi's SDK exposes no "stop after current turn" hook (agent-core shouldStopAfterTurn
		// is internal), so blocking the next turn_start is the closest reachable equivalent.
		if (this.turnsUsed >= this.caps.turnBudget) this.pause("budget");
		return { abort: false };
	}

	/** Report an async failure (e.g. a fire-and-forget delivery turn that later threw). */
	reportError(name: string, reason: string): void {
		// A failed turn may never fire agent_end, so close the turn here to avoid the status
		// sticking at thinking/writing/tool.
		this.endTurn(name);
		// Surface the failure as the idle "error" status (this is the thrown-exception path; the
		// SDK's retry-exhausted path goes through setStopReason at agent_end). Order matters:
		// endTurn does NOT clear stopReason, so set it after.
		this.setStopReason(name, "error");
		this.emit({ type: "error", name, reason, ts: Date.now() });
	}

	/** Record the terminal reason of an agent's last turn (shown at idle via agentStatus). */
	setStopReason(name: string, reason: StopReason | undefined): void {
		const rec = this.agents.get(name);
		if (rec) rec.stopReason = reason;
	}

	/** A turn started: enter its opening phase and drop the previous turn's outcome. */
	beginTurn(name: string): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		// A new turn supersedes the previous outcome, so the stale stopReason goes.
		rec.stopReason = undefined;
		rec.activity = "thinking";
		rec.currentTool = undefined;
		rec.lastActivity = Date.now();
	}

	/** The turn ended: no phase to report, so the record reads as idle. Keeps stopReason. */
	endTurn(name: string): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		rec.activity = undefined;
		rec.currentTool = undefined;
	}

	/**
	 * Set the agent-set semantic status line (empty string clears) plus its optional ETA.
	 * One call fully specifies the visible status: etaTs === undefined clears any prior ETA.
	 */
	setCustomStatus(name: string, status: string | undefined, etaTs?: number): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		rec.customStatus = status || undefined;
		rec.etaTs = etaTs;
	}

	/** Set the fine-grained phase within a turn (thinking/writing/tool). */
	setActivity(name: string, activity: AgentActivity, tool?: string): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		rec.activity = activity;
		rec.currentTool = activity === "tool" ? tool : undefined;
		rec.lastActivity = Date.now();
	}
}


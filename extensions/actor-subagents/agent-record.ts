/**
 * An agent as the engine registers it: the record plus the session-side capabilities it holds
 * (handle, live view, retune adapter) and the tuning types that adapter speaks.
 */
import type { RoutedAgentMessage } from "./agent-message.ts";
import type { AgentActivity, StopReason } from "./agent-status.ts";
import type { ThinkingLevel } from "./thinking-level.ts";

export interface AgentHandle {
	/** Delivers structured peer traffic; the adapter projects it into Pi's custom message. */
	deliver(message: RoutedAgentMessage): Promise<void>;
	/**
	 * Delivers a human-authored user turn (the panel's chatbox). Absent while the agent is
	 * still a reservation — no session exists yet to receive a user message, and that absence
	 * is what makes the "still spawning" case unrepresentable as a silently dropped message.
	 */
	deliverUser?(text: string): Promise<void>;
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
	/**
	 * The agent's definition of a tool by name, or undefined when the session does not know it.
	 * The panel needs it to render a tool CALL the way the main chat does (the tool's own
	 * renderCall instead of the bare name). Optional and opaque: an agent restored without a
	 * live session simply has no definitions to offer, and the engine stays SDK-free.
	 */
	getToolDefinition?(name: string): unknown;
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
	 * Set when this agent was paused mid-turn (or restored from a transcript that ended mid-turn).
	 * Marks it for re-triggering on resume; survives the agent_end of an allowed-to-complete turn
	 * (endTurn must NOT clear it). Cleared by resume().
	 */
	pausedMidTurn?: boolean;
	/**
	 * This agent's OWN pause flag, set by pause() and cleared by resume(). Whether the agent is
	 * stopped is derived: it is paused while this flag is set on it or on any ancestor (see
	 * pausedBy in spawn-tree.ts). Read the effective state through the engine, never from this field alone.
	 */
	paused?: boolean;
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
	/** Messages buffered while this agent is paused. Released on resume. */
	pausedInbox?: RoutedAgentMessage[];
}

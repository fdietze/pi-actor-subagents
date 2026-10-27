/**
 * Subagents Engine — the stateful agent registry and its orchestration (spawn, route, pause,
 * kill, turn bookkeeping), no pi-SDK dependency. The pure tree and authority rules it applies
 * live in spawn-tree.ts and authorize.ts.
 * Design: ../../../DESIGN.md
 */
import {
	createRoutedAgentMessage,
	mergeRoutedAgentMessages,
	type RoutedAgentMessage,
	SCHEDULER,
} from "./agent-message.ts";
import type { AgentEvent } from "./agent-event.ts";
import { AbortTracker } from "./abort-tracker.ts";
import { authorityOf, authorize, NON_AGENT_ACTORS } from "./authorize.ts";
import type { AgentHandle, AgentRecord, AgentTuning, AgentView, ModelChange } from "./agent-record.ts";
import { type AgentActivity, type AgentStatus, agentStatus, type StopReason } from "./agent-status.ts";
import type { CheckResult, ControlResult, EngineResumeResult, TargetOutcome } from "./control-result.ts";
import type { Caps } from "./settings.ts";
import { type LifecycleChange, lifecycleNotices } from "./lifecycle-notice.ts";
import { childrenOf, pauseHolder, subtreePostOrder } from "./spawn-tree.ts";
import type { ThinkingLevel } from "./thinking-level.ts";

export type RetuneResult = { ok: true; tuning: AgentTuning } | { ok: false; reason: string };

/**
 * Structured routing result: the MESSAGE's fate only. The RECEIVER's liveness is the separate,
 * orthogonal axis reported by `awaitReaction` (see `Reaction`), so neither answer has to be
 * inferred from the other — or from display prose.
 */
export type RouteResult =
	| { outcome: "delivered" }
	// `status` says why it was parked (normally the pause and who set it).
	| { outcome: "buffered"; status: AgentStatus }
	| { outcome: "failed"; reason: string };

/**
 * How long a sender waits for a delivered-to agent to REACT (start a turn or fail) before
 * reporting what it sees. Short on purpose: it observes pickup, never completion, so the
 * fire-and-forget actor model stays intact.
 */
export const REACTION_TIMEOUT_MS = 3000;

/**
 * What a bounded reaction wait OBSERVED, kept apart from what the agent IS (`AgentStatus`).
 * The distinction matters because only one of these cases licenses the claim "it did not react":
 * a full window that elapsed while the agent never moved. Folding that claim into the status
 * itself would make an unwatched or already-finished agent look stuck (The Map Is Not the
 * Territory).
 */
export type Reaction =
	/** A turn started or an error arrived — or the agent was already mid-turn. It is alive. */
	| { observed: "moving"; status: AgentStatus }
	/** The whole window elapsed with no turn and no error: it took the message and sat still. */
	| { observed: "unmoved"; status: AgentStatus }
	/** No window was watched at all (see `awaitReaction` on 'main'): the status is a bare snapshot. */
	| { observed: "unwatched"; status: AgentStatus }
	/** The agent no longer exists (killed while we waited); it has no status to report. */
	| { observed: "gone" };

/**
 * Outcome of handing the panel's chatbox text to an agent as a real user turn. A refusal
 * carries the reason to display; nothing is ever silently dropped.
 */
export type DeliverUserResult = { outcome: "delivered" } | { outcome: "refused"; reason: string };

// 'main' is the foreground chat, the non-agent actors appear as provenance (`by`), and
// "scheduler" is the engine's own sender voice: an agent by any of these names would be
// indistinguishable from them.
const RESERVED = new Set(["main", SCHEDULER, ...NON_AGENT_ACTORS]);
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** A record as a lifecycle-notice target: itself and the parent to tell. */
const asTarget = (rec: AgentRecord) => ({ name: rec.name, parent: rec.spawnedBy });

/** Feed preview of a message body: one short excerpt, never the whole payload. */
const previewOf = (content: string): string => (content.length > 60 ? `${content.slice(0, 60)}...` : content);

export class Engine {
	readonly events: AgentEvent[] = [];
	private readonly agents = new Map<string, AgentRecord>();
	private readonly listeners = new Set<(e: AgentEvent) => void>();
	// Graph tracking (in-memory, survives /reload via the singleton, resets on pi restart).
	private readonly messageEdges = new Map<string, Map<string, number>>(); // from -> (to -> count)
	private readonly caps: Caps;
	// Aborts started by startAbort() (pause, refused turn) and not yet finished, per agent record:
	// identity, not name, so a killed agent's late abort never stops a re-spawned namesake. resume() waits for them: an abort
	// that lands after the agent runs again would kill the turn resume just started.
	private readonly aborts = new AbortTracker<AgentRecord>();

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

	/** The spawn limit canSpawn enforces, exposed so the UI can show it next to the live count. */
	get maxAgents(): number {
		return this.caps.maxAgents;
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
		this.emit({ type: "spawn", name: rec.name, by: rec.spawnedBy, childSessionId: rec.sessionId, ts: Date.now() });
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
			sessionId?: string;
			policyMeta?: unknown;
			policyTools?: string[];
			policyGuarded?: true;
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
		rec.sessionId = opts.sessionId;
		rec.policyMeta = opts.policyMeta;
		rec.policyTools = opts.policyTools;
		rec.policyGuarded = opts.policyGuarded;
		rec.pending = false;
		this.emit({ type: "attach", name, by: rec.spawnedBy, childSessionId: rec.sessionId, ts: Date.now() });
		const buffered = rec.buffer ?? [];
		rec.buffer = undefined;
		// A pause can land while the session is being created. The reservation's messages join the
		// paused inbox, ahead of anything buffered later, so resume releases them as one ordered batch
		// instead of as turns that recordTurnStart would refuse.
		if (this.isStopped(rec)) rec.pausedInbox = [...buffered, ...(rec.pausedInbox ?? [])];
		else for (const t of buffered) void opts.handle.deliver(t);
		// A reservation cannot append, so notices for it waited here.
		this.flushNotices(name);
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

	/**
	 * `by` kills the named agents in its subtree, each AND its whole subtree, deepest first,
	 * awaiting each runtime teardown. `affected` names every agent taken down, since that is more
	 * than the caller named. There is no "all" default: a kill cannot be undone.
	 *
	 * The spawn tree is the ownership structure: a child exists to serve its spawner, and its
	 * only upward channel is that spawner. Orphaning it leaves an agent nobody reads, still
	 * holding one of the `maxAgents` slots and still able to run turns — a leak with no
	 * reader (Second-Order Thinking). Killing individual leaves stays possible: name them.
	 */
	async kill(by: string, names: string[]): Promise<ControlResult> {
		const results: TargetOutcome[] = [];
		const affected: string[] = [];
		const killed: { name: string; parent: string }[] = [];
		for (const target of names) {
			// Already taken down with an ancestor named earlier in this call: done, not unknown.
			if (affected.includes(target)) {
				results.push({ target, ok: true });
				continue;
			}
			const check = authorize(this.agents, by, target);
			if (!check.ok) {
				results.push({ target, ok: false, reason: check.reason });
				continue;
			}
			results.push({ target, ok: true });
			// The parent is read before the record goes away.
			killed.push({ name: target, parent: this.agents.get(target)?.spawnedBy ?? "main" });
			affected.push(...(await this.killSubtree(by, target)));
		}
		// Announced after the whole operation, so a parent taken down by it is no longer live.
		this.announce({ kind: "killed", by, targets: killed });
		return { results, affected };
	}

	/** Kill `name` and its subtree (post-order), returning every name taken down. */
	private async killSubtree(by: string, name: string): Promise<string[]> {
		const subtree = subtreePostOrder(this.agents, name);

		// Inversion: remove first so no new message can enter a runtime while it closes.
		for (const r of subtree) this.agents.delete(r.name);
		// Start every teardown before the first await: each `close` detaches its session synchronously
		// (AgentRecord.close), so no event of any of them can reach a re-spawned namesake meanwhile.
		const closing = subtree.map((r) => this.closeRecord(r));
		for (const [i, r] of subtree.entries()) {
			await closing[i];
			this.emit({ type: "kill", name: r.name, by, ts: Date.now() });
		}
		return subtree.map((r) => r.name);
	}

	/**
	 * Retune a live agent and adopt what its session reports back.
	 *
	 * Applies immediately and does not wait for a boundary: a turn already running may finish on
	 * the old model, the next one uses the new. Refusing while busy would push callers into the
	 * polling loop the prompts forbid, and aborting the turn would burn work.
	 */
	async retune(
		by: string,
		name: string,
		change: { model?: ModelChange; thinkingLevel?: ThinkingLevel },
	): Promise<RetuneResult> {
		if (name === "main") return { ok: false, reason: "cannot retune 'main' (use pi's own model controls)" };
		// An agent may tune itself: escalating its own effort is its call, unlike stopping itself.
		const check = authorize(this.agents, by, name, "self");
		if (!check.ok) return check;
		const rec = this.agents.get(name);
		if (!rec?.reconfigure) return { ok: false, reason: `agent '${name}' is still spawning` };
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

	/** `by` (main's authority) kills all agents except 'main': main's children, each with its subtree. */
	killAll(by: string): Promise<ControlResult> {
		return this.kill(by, childrenOf(this.agents, "main").map((rec) => rec.name));
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

	/** Every agent except 'main'. */
	private background(): AgentRecord[] {
		return [...this.agents.values()].filter((rec) => rec.name !== "main");
	}

	/**
	 * Resolve the targets of a pause or resume: the named agents, or `by`'s direct children when
	 * none are named — their subtrees follow through the derived pause, and a flag set by a lower
	 * owner is left alone. Each name gets its outcome; only the authorized ones are returned to act on.
	 */
	private controlTargets(by: string, names?: string[]): { results: TargetOutcome[]; recs: AgentRecord[] } {
		const targets =
			names && names.length > 0 ? names : childrenOf(this.agents, authorityOf(by)).map((rec) => rec.name);
		const results: TargetOutcome[] = [];
		const recs: AgentRecord[] = [];
		for (const target of targets) {
			const check = authorize(this.agents, by, target);
			results.push(check.ok ? { target, ok: true } : { target, ok: false, reason: check.reason });
			const rec = this.agents.get(target);
			if (check.ok && rec) recs.push(rec);
		}
		return { results, recs };
	}

	/** Names of the paused background agents (effective state, see pauseHolder). */
	pausedAgents(): string[] {
		return this.background()
			.filter((rec) => this.isAgentPaused(rec))
			.map((rec) => rec.name);
	}

	/** Is this agent paused — its own or an ancestor's flag? The state users see and control. */
	private isAgentPaused(rec: AgentRecord): boolean {
		return pauseHolder(this.agents, rec) !== undefined;
	}

	/**
	 * Is this agent stopped: paused, OR an abort we started is still in flight? The single gate
	 * for delivery and turns. It is wider than paused because a resume takes effect at call time
	 * while the agent's abort may still be landing; a message or turn let through in that window
	 * would be killed by the late abort. The waiting resume releases what buffered meanwhile.
	 */
	private isStopped(rec: AgentRecord): boolean {
		return this.isAgentPaused(rec) || this.aborts.pending((r) => r === rec).length > 0;
	}

	/**
	 * The one way the engine aborts an agent's session (pause, refused turn): tracked, so the agent
	 * counts as stopped until the abort lands (`isStopped`), and a failure becomes an agent error
	 * instead of an unhandled rejection.
	 */
	private startAbort(rec: AgentRecord): void {
		this.aborts.track(
			rec,
			() => rec.handle.abort(),
			(error) => this.reportFailureOf(rec, error, "abort failed"),
		);
	}

	/**
	 * Report a late async failure of `rec`'s runtime, unless `rec` is gone: names are reused, so a
	 * killed agent's failure must not land on a re-spawned namesake (records are the identity).
	 */
	private reportFailureOf(rec: AgentRecord, error: unknown, context?: string): void {
		if (this.agents.get(rec.name) !== rec) return;
		const message = error instanceof Error ? error.message : String(error);
		this.reportError(rec.name, context ? `${context}: ${message}` : message);
	}

	/** The agent's status with its effective pause and its cause folded in; the only status to display. */
	status(rec: AgentRecord): AgentStatus {
		const holder = pauseHolder(this.agents, rec);
		const by = holder === undefined ? undefined : this.agents.get(holder)?.paused;
		const pause = by === undefined ? undefined : { by, ...(holder !== rec.name ? { holder } : {}) };
		return agentStatus({ ...rec, pause });
	}

	/** The agent's status as the engine sees it, with its pause state folded in. */
	statusOf(name: string): AgentStatus | undefined {
		const rec = this.agents.get(name);
		return rec ? this.status(rec) : undefined;
	}

	/**
	 * Wait, bounded, for a just-messaged agent to REACT: its next turn start (it picked the
	 * message up) or an error (it is broken). Resolves with the fresh status, or undefined if the
	 * agent is gone by then.
	 *
	 * Why this exists: route() returns synchronously, and a kicked idle agent's turn has not
	 * started yet at that instant — its snapshot still reads "idle", which is indistinguishable
	 * from an agent that will never move. Waiting for the turn to START (never to finish) buys that
	 * distinction without breaking the fire-and-forget architecture.
	 */
	async awaitReaction(
		name: string,
		sinceEvent: number,
		timeoutMs: number = REACTION_TIMEOUT_MS,
	): Promise<Reaction> {
		const settle = (observed: "moving" | "unmoved" | "unwatched"): Reaction => {
			const status = this.statusOf(name);
			return status ? { observed, status } : { observed: "gone" };
		};
		// 'main' never emits a `turn` event: only background sessions run through recordTurnStart,
		// the sole emitter. Waiting on the foreground would therefore always burn the full timeout,
		// and it is pointless anyway — 'main' is the human's own chat, not a receiver that can be
		// stuck or broken. Its record's activity is tracked live, so the snapshot is already honest,
		// and "unwatched" keeps the caller from reading that snapshot as an observation.
		if (name === "main") return settle("unwatched");
		// The event log closes the race with the delivery that triggers the reaction: `sinceEvent` is
		// taken BEFORE routing, so a turn or failure that lands between delivery and this call is
		// found here instead of being waited out. (A synchronous delivery failure does exactly that.)
		// The mark is what scopes the observation to THIS delivery; reactions are matched by agent
		// name, so a mark from before some other delivery would credit that agent's older work here.
		const reacted = (e: AgentEvent): boolean =>
			(e.type === "turn" || e.type === "error" || e.type === "kill") && e.name === name;
		for (let i = Math.max(0, sinceEvent); i < this.events.length; i++) {
			const event = this.events[i];
			if (event && reacted(event)) return settle("moving");
		}
		const rec = this.agents.get(name);
		if (!rec) return { observed: "gone" };
		// Already mid-turn: it is demonstrably alive, and its steered message is picked up at the next
		// turn boundary. Waiting for that boundary would cost the full window to learn nothing new.
		if (rec.activity !== undefined) return settle("moving");
		return new Promise<Reaction>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (observed: "moving" | "unmoved") => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer); // never leave a timer (or a listener) behind
				unsubscribe();
				resolve(settle(observed));
			};
			const unsubscribe = this.subscribe((e) => {
				if (reacted(e)) finish("moving");
			});
			timer = setTimeout(() => finish("unmoved"), timeoutMs);
		});
	}

	/** Names of the background agents that are effectively paused right now. */
	private pausedSet(): Set<string> {
		return new Set(this.pausedAgents());
	}

	/**
	 * `by` pauses agents in its subtree — the named ones, or its direct children when none are
	 * named — by setting their own flag. `affected` lists every agent that went from running to
	 * paused, which is the targets plus their subtrees; their running turns are aborted. Aborting
	 * AFTER the flag is set means a turn cut here cannot start a successor. Whoever of them is
	 * mid-turn is marked `pausedMidTurn` so resume re-triggers that work.
	 * Pausing an already paused agent succeeds and changes nothing.
	 *
	 * Nothing flagged means no event: a mistyped or already-paused name must not show up in the
	 * feed as a pause that happened.
	 */
	pause(by: string, names?: string[]): ControlResult {
		const { results, recs } = this.controlTargets(by, names);
		const before = this.pausedSet();
		const flagged: AgentRecord[] = [];
		for (const rec of recs) {
			// Checked per step, so a name given twice is flagged once.
			if (rec.paused !== undefined) continue;
			rec.paused = by;
			flagged.push(rec);
		}
		if (flagged.length === 0) return { results, affected: [] };
		const newlyPaused = this.background().filter((rec) => !before.has(rec.name) && this.isAgentPaused(rec));
		// A set activity IS "mid-turn" — that is exactly whose work resume must re-trigger.
		for (const rec of newlyPaused) if (rec.activity !== undefined) rec.pausedMidTurn = true;
		for (const rec of newlyPaused) this.startAbort(rec);
		this.emit({ type: "pause", names: flagged.map((rec) => rec.name), by, ts: Date.now() });
		this.announce({ kind: "paused", by, targets: flagged.map(asTarget) });
		return { results, affected: newlyPaused.map((rec) => rec.name) };
	}

	/**
	 * `by` resumes agents in its subtree — the named ones, or its direct children when none are
	 * named — by clearing only their own flag. Every agent that thereby went from paused to running
	 * gets its buffered inbox released as one ordered batch; an agent still held by another flag
	 * (its own or an ancestor's) stays paused and keeps its inbox, and a target held by an ancestor
	 * says so. `interrupted` lists the released agents that were paused mid-turn, for the caller to
	 * re-trigger.
	 *
	 * The resume takes effect at call time: flags, `affected` and the event are decided
	 * synchronously, so pause and resume calls linearize in call order (Correctness by
	 * Construction). Only the side effects — inbox release and `interrupted` — wait for the
	 * released agents' outstanding aborts, so the typical "pause, correct via send_message,
	 * resume" sequence cannot have a late abort kill the resumed turn (Inversion). They then apply
	 * to the agents still running at that point: one paused again meanwhile keeps its inbox and
	 * its pausedMidTurn mark for the next resume. A slow abort of an agent that stays paused cannot
	 * hold this resume up.
	 *
	 * Nothing cleared means no event.
	 */
	async resume(by: string, names?: string[]): Promise<EngineResumeResult> {
		const { results, recs } = this.controlTargets(by, names);
		const before = this.pausedSet();
		// A name given twice clears once; a blocked agent (runBlock) keeps its pause.
		const cleared = [...new Set(recs)].filter((rec) => rec.paused !== undefined && rec.runBlock === undefined);
		for (const rec of cleared) rec.paused = undefined;
		for (const result of results) {
			const rec = this.agents.get(result.target);
			if (result.ok && rec?.runBlock !== undefined) {
				result.ok = false;
				result.reason = rec.runBlock;
				continue;
			}
			const holder = result.ok && rec ? pauseHolder(this.agents, rec) : undefined;
			if (holder) result.reason = `still held by '${holder}'`;
		}
		if (cleared.length === 0) return { results, affected: [], interrupted: [], bufferedMessages: 0 };

		const released = this.background().filter((rec) => before.has(rec.name) && !this.isAgentPaused(rec));
		this.emit({ type: "resume", names: cleared.map((rec) => rec.name), by, ts: Date.now() });
		this.announce({
			kind: "resumed",
			by,
			targets: cleared.map((rec) => ({ ...asTarget(rec), holder: pauseHolder(this.agents, rec) })),
		});

		// The released agents that still run now: not killed (or respawned) and not paused again.
		const running = () => released.filter((rec) => this.agents.get(rec.name) === rec && !this.isAgentPaused(rec));
		// Re-scan after every wait: a pause and resume in between can start a new abort. No await
		// follows the last scan, so nothing can land between it and the release below.
		for (;;) {
			const live = new Set(running());
			const pending = this.aborts.pending((rec) => live.has(rec));
			if (pending.length === 0) break;
			await Promise.all(pending);
		}
		const interrupted: string[] = [];
		let bufferedMessages = 0;
		for (const rec of running()) {
			if (rec.pausedMidTurn) interrupted.push(rec.name);
			rec.pausedMidTurn = false;
			// Release paused inboxes in FIFO order. Delivery is intentionally fire-and-forget,
			// so the result counts released messages rather than claiming they completed.
			const inbox = rec.pausedInbox;
			if (inbox && inbox.length > 0) {
				rec.pausedInbox = undefined;
				bufferedMessages += inbox.length;
				// KISS + Inversion: one atomic batch preserves every message and avoids racing
				// several idle-session starts, which can accept the first prompt and drop the rest.
				void rec.handle.deliver(mergeRoutedAgentMessages(inbox)).catch((error) => this.reportFailureOf(rec, error));
			}
		}

		return { results, affected: released.map((rec) => rec.name), interrupted, bufferedMessages };
	}

	async route(from: string, to: string, content: string, actionable?: true): Promise<RouteResult> {
		const target = this.agents.get(to);
		if (!target) return { outcome: "failed", reason: `unknown agent '${to}'` };
		const message = createRoutedAgentMessage(from, content, actionable);
		// One tail for both outcomes: a paused target parks the message, a live one takes it.
		// Everything after that (edge count, activity, feed event) is identical, so it is written once.
		// The pause state is read ONCE, before the delivery await, and the reported outcome comes from
		// that same decision: a pause landing while `deliver` is in flight must not turn a message the
		// session already has into a "buffered" report (the map has to match what actually happened).
		const paused = this.isStopped(target);
		if (paused) (target.pausedInbox ??= []).push(message);
		else await target.handle.deliver(message);
		target.lastActivity = Date.now();
		this.countEdge(from, to);
		this.emit({ type: "route", from, to, preview: previewOf(content), buffered: paused, ts: Date.now() });
		return paused ? { outcome: "buffered", status: this.status(target) } : { outcome: "delivered" };
	}

	/**
	 * Deliver panel-typed text to an agent as a real user turn (not peer traffic), reported
	 * through the same feed and message graph as a route so the human's input stays visible.
	 * Refuses instead of buffering: user text has no place in the paused inbox (which carries
	 * structured peer messages), and a paused agent would abort the triggered turn.
	 */
	deliverUser(to: string, text: string): DeliverUserResult {
		// 'main' IS the chat the human is typing in; there is no child session to hand a turn to.
		if (to === "main") return { outcome: "refused", reason: "'main' is the chat you are typing in" };
		const target = this.agents.get(to);
		if (!target) return { outcome: "refused", reason: `unknown agent '${to}'` };
		if (!target.handle.deliverUser) return { outcome: "refused", reason: `'${to}' is still spawning` };
		if (this.isAgentPaused(target))
			return { outcome: "refused", reason: `'${to}' is paused — resume it first` };
		if (this.isStopped(target))
			return { outcome: "refused", reason: `'${to}' is still stopping — try again in a moment` };
		void target.handle.deliverUser(text).catch((error) => this.reportFailureOf(target, error));
		target.lastActivity = Date.now();
		this.countEdge("main", to);
		this.emit({ type: "route", from: "main", to, preview: previewOf(text), buffered: false, ts: Date.now() });
		return { outcome: "delivered" };
	}

	/** Count one message edge for the relationship graph. */
	private countEdge(from: string, to: string): void {
		let targets = this.messageEdges.get(from);
		if (!targets) {
			targets = new Map<string, number>();
			this.messageEdges.set(from, targets);
		}
		targets.set(to, (targets.get(to) ?? 0) + 1);
	}

	/**
	 * Names that currently exist as message endpoints: every agent record (including ones still
	 * spawning or paused) plus the reserved "main" chat, which is always a valid target. The roster
	 * uses it to hide historical message edges pointing at agents that are gone.
	 */
	liveNames(): Set<string> {
		return new Set(["main", ...this.agents.keys()]);
	}

	/** Adjacency matrix of message counts: from -> (to -> count). Plain snapshot copy. */
	getMessageMatrix(): Record<string, Record<string, number>> {
		const out: Record<string, Record<string, number>> = {};
		for (const [from, targets] of this.messageEdges) {
			out[from] = Object.fromEntries(targets);
		}
		return out;
	}

	/**
	 * Spawn tree of the live agents as child -> parent ('main' has no parent). Derived from each
	 * record's `spawnedBy`, the one parent representation (DRY), so it cannot drift from the
	 * records the pause and kill walks read.
	 */
	getSpawnTree(): Record<string, string> {
		return Object.fromEntries(this.background().map((rec) => [rec.name, rec.spawnedBy]));
	}

	/**
	 * Gate one background turn at its start; returns whether the engine refused it. pi's SDK exposes
	 * no "do not start" hook, so a stopped agent's turn is aborted at its start instead.
	 *
	 * The refusal's abort goes through the same tracker as a pause's, so every abort the engine
	 * starts makes the agent count as stopped until it lands: a resume in that window waits for it
	 * instead of steering its nudge into the dying run.
	 */
	recordTurnStart(name: string): boolean {
		const rec = this.agents.get(name);
		if (!rec) return false;
		if (this.isStopped(rec)) {
			// The refused turn's input (e.g. an extension's sendMessage with triggerTurn, or a hand-off
			// that raced a pause) is already in the transcript; resume must re-trigger it or the agent
			// never reads it.
			rec.pausedMidTurn = true;
			this.startAbort(rec);
			return true;
		}
		rec.turns++;
		rec.lastActivity = Date.now();
		this.emit({ type: "turn", name, ts: Date.now() });
		return false;
	}

	/** Report an async failure (e.g. a fire-and-forget delivery turn that later threw). */
	reportError(name: string, reason: string): void {
		// A failed delivery may emit no session lifecycle event, so close the turn here to avoid
		// the status sticking at thinking/writing/tool.
		this.endTurn(name);
		// Order matters: endTurn does NOT clear stopReason, so the error state is entered after it.
		this.setStopReason(name, "error", reason);
	}

	/**
	 * Record the terminal reason of an agent's last turn (shown at idle via agentStatus), and emit
	 * the `error` event when this is the TRANSITION into the error state.
	 *
	 * One emit site for both ways an agent breaks — a thrown exception (reportError) and a logical
	 * run the SDK settled after exhausting retries — so consumers see the failure once per failed run
	 * regardless of which path produced it. `beginTurn` clears stopReason, so the next failure is a
	 * fresh transition; a repeated error report within the same errored state stays silent instead
	 * of notifying the parent again for the same failure.
	 */
	setStopReason(name: string, reason: StopReason | undefined, detail?: string): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		const entersError = reason === "error" && rec.stopReason !== "error";
		rec.stopReason = reason;
		if (reason !== "error") rec.errorReason = undefined;
		if (!entersError) return;
		rec.errorReason = detail ?? "the turn failed after the SDK's retries";
		this.emit({ type: "error", name, reason: rec.errorReason, ts: Date.now() });
		this.announce({ kind: "error", target: asTarget(rec), reason: rec.errorReason });
	}

	/** Tell the parents what a lifecycle change did to their children (lifecycle-notice.ts decides). */
	private announce(change: LifecycleChange): void {
		const notices = lifecycleNotices(change, new Set(this.agents.keys()), new Date());
		for (const { to, content } of notices) {
			if (change.kind === "error") {
				// KISS: errors use ordinary routing, including steering and paused/stopping buffers.
				// A real delivery failure is the parent's own error, never a replay of the child's.
				const parent = this.agents.get(to);
				void this.route(SCHEDULER, to, content, true).catch((error) => {
					if (parent) this.reportFailureOf(parent, error);
				});
			} else this.notify(to, createRoutedAgentMessage(SCHEDULER, content));
		}
	}

	/**
	 * Hand `name` a message it reads at its next turn, without starting one. A running (or handed)
	 * turn must not receive it — Pi would append it mid-run, possibly between a tool call and its
	 * result — so it waits in the agent's notice queue until flushNotices. Pause does not bypass
	 * that busy gate. Once not busy, a paused recipient can take a silent append: control notices
	 * are facts, not active traffic, and do not belong in the paused inbox.
	 */
	notify(name: string, message: RoutedAgentMessage): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		(rec.notices ??= []).push(message);
		this.flushNotices(name);
	}

	/** Append the queued notices once the agent is not busy; call it whenever a run or hand-off settles. */
	flushNotices(name: string): void {
		const rec = this.agents.get(name);
		const notices = rec?.notices;
		if (!rec?.handle.append || !notices || rec.handle.busy?.()) return;
		rec.notices = undefined;
		try {
			rec.handle.append(mergeRoutedAgentMessages(notices));
		} catch {
			/* Silent control notices are best-effort: a dead session may lose one, including a kill
			   fact that current-state pull tools cannot reconstruct. No retry or turn is requested. */
		}
	}

	/** A turn started: enter its opening phase and drop the previous turn's outcome. */
	beginTurn(name: string): void {
		const rec = this.agents.get(name);
		if (!rec) return;
		// A new turn supersedes the previous outcome, so the stale stopReason goes.
		rec.stopReason = undefined;
		rec.errorReason = undefined;
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


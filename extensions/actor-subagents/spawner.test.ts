import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutedAgentMessage, type RoutedAgentMessage } from "./agent-message.ts";
import { Engine } from "./engine.ts";
import { createSpawner, type SessionLike, type ThinkingLevel } from "./spawner.ts";

class FakeSession implements SessionLike {
	delivered: RoutedAgentMessage[] = [];
	userMessages: string[] = [];
	aborted = 0;
	messages: unknown[] = [];
	lastDeliverAs: string | undefined;
	lifecycle: string[] = [];
	thinkingLevel: ThinkingLevel = "high";
	/** Models the fake was switched to, in order (retune assertions read this). */
	models: unknown[] = [];
	async setModel(model: unknown) {
		this.models.push(model);
	}
	setThinkingLevel(level: ThinkingLevel) {
		// Mirrors pi: the session reports the level it ended up with, which the panel/roster adopt.
		this.thinkingLevel = level;
	}
	getContextUsage() {
		return { tokens: 0, contextWindow: 1000, percent: 0 };
	}
	/** Mimics a live session that picks a delivered message up and starts a turn on it. */
	autoReact = false;
	private listeners: ((e: { type: string; message?: unknown }) => void)[] = [];
	async sendAgentMessage(message: RoutedAgentMessage, options?: { deliverAs?: "steer" | "followUp" }) {
		this.delivered.push(message);
		this.lastDeliverAs = options?.deliverAs;
		// Asynchronously, like the real session: the turn cannot have started when route() returns.
		if (this.autoReact)
			setTimeout(() => {
				this.emit("agent_start");
				this.emit("turn_start");
			}, 0);
	}
	async sendUserMessage(text: string) {
		this.userMessages.push(text);
	}
	async abort() {
		this.aborted++;
		this.lifecycle.push("abort");
	}
	abortBash() {
		this.lifecycle.push("abortBash");
	}
	async shutdown() {
		this.lifecycle.push("shutdown");
	}
	dispose() {
		this.lifecycle.push("dispose");
	}
	subscribe(l: (e: { type: string; message?: unknown }) => void) {
		this.listeners.push(l);
		return () => void this.lifecycle.push("detach");
	}
	emit(type: string, message?: unknown) {
		for (const l of this.listeners) l({ type, message });
	}
}

function withMain(engine: Engine, inbox: RoutedAgentMessage[]) {
	engine.addAgent({
		name: "main",
		model: "test/m",
		thinkingLevel: "xhigh" as const,
		handle: { deliver: async (t) => void inbox.push(t), abort: async () => {} },
		spawnedBy: "main",
		depth: 0,
		createdAt: 0,
		turns: 0,
		lastActivity: 0,
		});
}

test("smoke: spawn -> deliver -> reply -> budget abort -> pause", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 2 });
	const userInbox: RoutedAgentMessage[] = [];
	withMain(engine, userInbox);

	const sessions = new Map<string, FakeSession>();
	const spawner = createSpawner({
		engine,
		resolveModel: (ref) => (ref === "bad/x" ? undefined : { provider: "test", id: "m", model: {} }),
		createSession: async (spec) => {
			const s = new FakeSession();
			sessions.set(spec.name, s);
			return { session: s, sessionFile: `/tmp/${spec.name}.jsonl` };
		},
	});

	// spawn echo
	const r = await spawner.spawnAgent({ name: "echo", systemPrompt: "reply to sender" }, "main");
	assert.equal(r.ok, true);
	assert.equal(engine.has("echo"), true);
	assert.equal(engine.get("echo")?.depth, 1);

	// main -> echo
	const rt = await engine.route("main", "echo", "ping");
	assert.deepEqual(rt, { outcome: "delivered" });
	assert.deepEqual(sessions.get("echo")?.delivered, [createRoutedAgentMessage("main", "ping")]);
	// Inter-agent delivery uses steer (next-boundary), not followUp.
	assert.equal(sessions.get("echo")?.lastDeliverAs, "steer");

	// echo -> main (the reply path)
	await engine.route("echo", "main", "pong");
	assert.deepEqual(userInbox, [createRoutedAgentMessage("echo", "pong")]);

	// turn phase tracked from session events
	sessions.get("echo")?.emit("agent_start");
	assert.equal(engine.get("echo")?.activity, "thinking");
	sessions.get("echo")?.emit("agent_end");
	assert.equal(engine.get("echo")?.activity, undefined);

	// turn budget: 3rd turn_start exceeds budget(2) and aborts the session
	const echo = sessions.get("echo");
	echo?.emit("turn_start");
	echo?.emit("turn_start");
	echo?.emit("turn_start");
	assert.ok((echo?.aborted ?? 0) >= 1);

	// pausing buffers routing
	engine.pause();
	const blocked = await engine.route("main", "echo", "again");
	// The budget stop already holds here, and that swarm-wide cause outranks the manual pause:
	// only a full resume can release this message.
	assert.deepEqual(blocked, { outcome: "buffered", reason: "budget" });
});

test("spawn confirms the new agent reacted and reports its observed status", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "test", id: "m", model: {} }),
		createSession: async () => {
			const session = new FakeSession();
			session.autoReact = true;
			return { session };
		},
	});

	const result = await spawner.spawnAgent({ name: "worker", systemPrompt: "work", message: "do it" }, "main");

	// The status is the one observed AFTER the wait: at delivery the child was still idle.
	assert.match(result.msg, /sent initial message \(thinking\)/);
});

test("spawn reports an initial message as buffered while the swarm-wide pause holds", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const session = new FakeSession();
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "test", id: "m", model: {} }),
		createSession: async () => ({ session }),
	});
	// A restored (or budget-stopped) swarm blocks every agent, including ones spawned afterwards.
	// A manual pause names existing agents instead, so it deliberately does not cover new ones.
	engine.pauseSwarm("restored");

	const started = Date.now();
	const result = await spawner.spawnAgent(
		{ name: "waiting", systemPrompt: "wait", message: "start later" },
		"main",
	);

	assert.equal(result.ok, true);
	// A parked message can trigger no turn, so this path must not spend the confirmation window.
	assert.ok(Date.now() - started < 1000);
	assert.match(result.msg, /buffered initial message \(agents paused: restored\)/);
	assert.doesNotMatch(result.msg, /sent initial message/);
	assert.deepEqual(session.delivered, []);
	assert.deepEqual(engine.get("waiting")?.pausedInbox, [createRoutedAgentMessage("main", "start later")]);
});

test("spawn passes an explicit thinking override and records Pi's effective level", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	let requested: ThinkingLevel | undefined;
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "openai-codex", id: "gpt-5.6-sol", model: {} }),
		createSession: async (spec) => {
			requested = spec.thinkingLevel;
			const session = new FakeSession();
			session.thinkingLevel = "xhigh"; // Pi clamps the requested max to the model's capabilities.
			return { session };
		},
	});

	const result = await spawner.spawnAgent(
		{ name: "scout", systemPrompt: "inspect", thinkingLevel: "max" },
		"main",
	);

	assert.equal(requested, "max");
	assert.equal(engine.get("scout")?.thinkingLevel, "xhigh");
	assert.match(result.msg, /openai-codex\/gpt-5\.6-sol@xhigh/);
});

test("nested children inherit their parent's effective thinking level", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const requested: Array<ThinkingLevel | undefined> = [];
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "test", id: "m", model: {} }),
		createSession: async (spec) => {
			requested.push(spec.thinkingLevel);
			const session = new FakeSession();
			session.thinkingLevel = spec.thinkingLevel ?? "medium";
			return { session };
		},
	});

	await spawner.spawnAgent({ name: "lead", systemPrompt: "lead" }, "main");
	await spawner.spawnAgent({ name: "worker", systemPrompt: "work" }, "lead");

	assert.deepEqual(requested, ["xhigh", "xhigh"]);
	assert.equal(engine.get("worker")?.thinkingLevel, "xhigh");
});

test("restored agents expose the reopened session's effective thinking level", () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const session = new FakeSession();
	session.thinkingLevel = "low";
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "test", id: "m", model: {} }),
		createSession: async () => ({ session: new FakeSession() }),
	});

	spawner.restoreAgent({
		name: "restored",
		spawnedBy: "main",
		depth: 1,
		model: "test/m",
		systemPrompt: "resume",
		sessionFile: "/tmp/restored.jsonl",
		session,
		pausedMidTurn: false,
	});

	assert.equal(engine.get("restored")?.thinkingLevel, "low");
});

test("view.getStreamingMessage tracks the in-progress assistant message, cleared on agent_end", async () => {
	// Regression: the panel seeds "Thinking..." on switch from this; without it a slow-thinking
	// agent shows no label until its next delta event arrives (seconds later).
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const sessions = new Map<string, FakeSession>();
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async (spec) => {
			const s = new FakeSession();
			sessions.set(spec.name, s);
			return { session: s };
		},
	});
	await spawner.spawnAgent({ name: "echo", systemPrompt: "r" }, "main");
	const view = engine.get("echo")?.view;
	assert.equal(view?.getStreamingMessage?.(), undefined); // idle

	const partial = { role: "assistant", content: [{ type: "thinking", thinking: "..." }] };
	sessions.get("echo")?.emit("message_update", partial);
	assert.equal(view?.getStreamingMessage?.(), partial); // mid-turn

	sessions.get("echo")?.emit("agent_end");
	assert.equal(view?.getStreamingMessage?.(), undefined); // finalized into session.messages
});

test("getStreamingMessage clears at message_end, not only agent_end (no double-render during tool exec)", async () => {
	// A tool-calling turn commits the assistant message at message_end, then runs the tool before
	// agent_end. Pi emits a fresh copy per update but the raw final object at message_end, so the
	// two are never reference-equal and the panel cannot dedup by identity. If the streaming ref
	// were held past message_end, the same message would be BOTH committed and "streaming" for the
	// whole tool window and render twice. Clearing at message_end closes that window.
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const sessions = new Map<string, FakeSession>();
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async (spec) => {
			const s = new FakeSession();
			sessions.set(spec.name, s);
			return { session: s };
		},
	});
	await spawner.spawnAgent({ name: "echo", systemPrompt: "r" }, "main");
	const view = engine.get("echo")?.view;

	const partial = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] };
	sessions.get("echo")?.emit("message_update", partial);
	assert.equal(view?.getStreamingMessage?.(), partial); // mid-turn

	// Distinct final object, mirroring Pi's message_end emitting the raw result (not a copy).
	const final = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash" }] };
	sessions.get("echo")?.emit("message_end", final);
	assert.equal(view?.getStreamingMessage?.(), undefined); // committed → not streaming, during tool exec

	sessions.get("echo")?.emit("tool_execution_start");
	assert.equal(view?.getStreamingMessage?.(), undefined); // still nothing streaming while bash runs
});

test("deliver is fire-and-forget: does not await the target's turn", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	// Agent-message delivery never resolves (simulates a long-running turn). spawnAgent with an
	// initial message must still resolve — otherwise the spawn_subagent tool would hang.
	class BlockingSession extends FakeSession {
		async sendAgentMessage() {
			// A never-resolving delivery IS a running turn, so it announces one like a real session
			// would; otherwise the spawn's reaction window would be spent here for nothing.
			setTimeout(() => {
				this.emit("agent_start");
				this.emit("turn_start");
			}, 0);
			return new Promise<void>(() => {});
		}
	}
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => ({ session: new BlockingSession() }),
	});
	const r = await spawner.spawnAgent({ name: "slow", systemPrompt: "r", message: "go" }, "main");
	assert.equal(r.ok, true);
	assert.match(r.msg, /sent initial message \(thinking\)/);
});

test("deliver failure surfaces as an engine error event", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	class FailingSession extends FakeSession {
		async sendAgentMessage(): Promise<void> {
			throw new Error("boom");
		}
	}
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => ({ session: new FailingSession() }),
	});
	// The failure lands between delivery and the reaction wait; the wait must find it in the event
	// log rather than sitting out its whole window (which would make this spawn feel hung).
	const r = await spawner.spawnAgent({ name: "bad", systemPrompt: "r", message: "go" }, "main");
	assert.match(r.msg, /sent initial message \(error\)/);
	const err = engine.events.find((e) => e.type === "error");
	assert.ok(err, "expected an error event");
	assert.equal((err as { name: string }).name, "bad");
	assert.match((err as { reason: string }).reason, /boom/);
});

test("spawn rejects unknown model", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	const spawner = createSpawner({
		engine,
		resolveModel: (ref) => (ref ? { provider: "t", id: "m", model: {} } : undefined),
		createSession: async () => ({ session: new FakeSession() }),
	});
	// spawner 'ghost' not registered -> depth 0, no inherited model, no ref -> unknown model
	const r = await spawner.spawnAgent({ name: "x", systemPrompt: "r" }, "ghost");
	assert.equal(r.ok, false);
	assert.match(r.msg, /unknown model/i);
});

test("spawn rejects duplicate name", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	const userInbox: RoutedAgentMessage[] = [];
	withMain(engine, userInbox);
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => ({ session: new FakeSession() }),
	});
	assert.equal((await spawner.spawnAgent({ name: "dup", systemPrompt: "r" }, "main")).ok, true);
	const second = await spawner.spawnAgent({ name: "dup", systemPrompt: "r" }, "main");
	assert.equal(second.ok, false);
	assert.match(second.msg, /already exists/i);
});

test("spawn enforces max depth via spawner depth", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 2, turnBudget: 5 });
	const userInbox: RoutedAgentMessage[] = [];
	withMain(engine, userInbox);
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => ({ session: new FakeSession() }),
	});
	// main(0) -> a(1) -> b(2) ok; b spawning would be depth 3 > 2
	await spawner.spawnAgent({ name: "a", systemPrompt: "r" }, "main");
	await spawner.spawnAgent({ name: "b", systemPrompt: "r" }, "a");
	const tooDeep = await spawner.spawnAgent({ name: "c", systemPrompt: "r" }, "b");
	assert.equal(tooDeep.ok, false);
	assert.match(tooDeep.msg, /depth/i);
});

test("kill closes a child session exactly once in abortBash-abort-detach-shutdown-dispose order", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const session = new FakeSession();
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => ({ session }),
	});
	await spawner.spawnAgent({ name: "child", systemPrompt: "r" }, "main");
	const close = engine.get("child")?.close;
	assert.ok(close);
	await Promise.all([close(), close()]);

	const result = await engine.kill("child");

	assert.equal(result.ok, true);
	assert.deepEqual(session.lifecycle, ["abortBash", "abort", "detach", "shutdown", "dispose"]);
});

test("a child killed while session creation is pending closes the orphan runtime", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const session = new FakeSession();
	let finishCreation!: (value: { session: FakeSession }) => void;
	const creation = new Promise<{ session: FakeSession }>((resolve) => {
		finishCreation = resolve;
	});
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => creation,
	});
	const spawning = spawner.spawnAgent({ name: "child", systemPrompt: "r" }, "main");
	assert.equal(engine.get("child")?.pending, true);
	await engine.kill("child");

	finishCreation({ session });
	const result = await spawning;

	assert.equal(result.ok, false);
	assert.equal(engine.has("child"), false);
	assert.deepEqual(session.lifecycle, ["abortBash", "abort", "shutdown", "dispose"]);
});

test("a spawned agent can be retuned in place, and the roster adopts the session's level", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 10 });
	withMain(engine, []);
	const sessions = new Map<string, FakeSession>();
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "test", id: "m", model: {} }),
		createSession: async (spec) => {
			const s = new FakeSession();
			sessions.set(spec.name, s);
			return { session: s };
		},
	});
	await spawner.spawnAgent({ name: "echo", systemPrompt: "reply" }, "main");

	const opus = { opus: true };
	const result = await engine.retune("echo", { model: { display: "test/opus", model: opus }, thinkingLevel: "low" });
	assert.equal(result.ok, true);
	// The change reached the live session (no respawn: the same FakeSession instance is retuned).
	assert.deepEqual(sessions.get("echo")?.models, [opus]);
	assert.equal(engine.get("echo")?.model, "test/opus");
	assert.equal(engine.get("echo")?.thinkingLevel, "low");
});

test("aborting an agent interrupts its running bash before stopping the agent loop", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const session = new FakeSession();
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => ({ session }),
	});
	await spawner.spawnAgent({ name: "child", systemPrompt: "r" }, "main");
	// This is the path /subagents-pause and the per-agent pause take.
	await engine.get("child")?.handle.abort();
	assert.deepEqual(session.lifecycle, ["abortBash", "abort"]);
});

test("panel input reaches the child as a real user message", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	withMain(engine, []);
	const session = new FakeSession();
	const spawner = createSpawner({
		engine,
		resolveModel: () => ({ provider: "t", id: "m", model: {} }),
		createSession: async () => ({ session }),
	});
	await spawner.spawnAgent({ name: "child", systemPrompt: "r" }, "main");
	assert.deepEqual(engine.deliverUser("child", "try the other approach"), { outcome: "delivered" });
	await Promise.resolve();
	assert.deepEqual(session.userMessages, ["try the other approach"]);
	assert.deepEqual(session.delivered, [], "user text must not be projected as peer traffic");
});

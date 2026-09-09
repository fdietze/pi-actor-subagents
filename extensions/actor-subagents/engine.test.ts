import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutedAgentMessage, type RoutedAgentMessage } from "./agent-message.ts";
import { agentStatus, formatStatus } from "./agent-status.ts";
import { Engine, type AgentHandle } from "./engine.ts";

const fakeHandle = (): AgentHandle => ({
	deliver: async () => {},
	abort: async () => {},
});

const caps = { maxAgents: 2, maxSpawnDepth: 2, turnBudget: 5 };

function mainRecord() {
	return {
		name: "main",
		model: "anthropic/x",
		handle: fakeHandle(),
		spawnedBy: "main",
		depth: 0,
		createdAt: 0,
		turns: 0,
		lastActivity: 0,
	};
}

test("reportError ends the turn and surfaces the error status", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "w", depth: 1 });
	e.setActivity("w", "thinking");
	assert.equal(formatStatus(agentStatus(e.get("w")!)), "thinking");
	e.reportError("w", "boom");
	const rec = e.get("w")!;
	assert.equal(rec.activity, undefined);
	assert.equal(formatStatus(agentStatus(rec)), "error"); // failure visible at idle, not silently "idle"
	assert.equal(e.events.at(-1)?.type, "error");
});

test("entering the error state emits one event per failed turn, on both failure paths", () => {
	// The parent notification hangs off this event, so it must fire once for a thrown exception AND
	// once for a turn the SDK stopped retrying (agent_end -> setStopReason), and not repeat while
	// the agent simply stays errored.
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "w", depth: 1 });
	const errors = () => e.events.filter((ev) => ev.type === "error");

	e.setStopReason("w", "error"); // retries-exhausted path: no exception was ever thrown
	assert.equal(errors().length, 1);
	e.setStopReason("w", "error"); // still the same failure -> no second wake-up
	e.reportError("w", "boom"); // ditto via the exception path
	assert.equal(errors().length, 1);

	e.beginTurn("w"); // a new turn supersedes the outcome, so the next failure is a new transition
	e.reportError("w", "boom");
	assert.equal(errors().length, 2);
	assert.equal(errors().at(-1)?.reason, "boom");
});

test("addAgent registers and has/get work, emits spawn event", () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	assert.equal(e.has("main"), true);
	assert.equal(e.get("main")?.depth, 0);
	assert.equal(e.list().length, 1);
	assert.equal(e.events.at(-1)?.type, "spawn");
});

test("canSpawn rejects duplicate name", () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	const r = e.canSpawn("main", 0);
	assert.equal(r.ok, false);
	assert.match((r as { reason: string }).reason, /already exists|reserved/);
});

test("canSpawn rejects reserved name and invalid name", () => {
	const e = new Engine(caps);
	assert.equal(e.canSpawn("main", 0).ok, false); // reserved
	assert.equal(e.canSpawn("has space", 0).ok, false);
	assert.equal(e.canSpawn("", 0).ok, false);
});

test("canSpawn enforces maxAgents (excluding main)", () => {
	const e = new Engine(caps); // maxAgents = 2
	e.addAgent(mainRecord());
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "b", depth: 1 });
	const r = e.canSpawn("c", 0);
	assert.equal(r.ok, false);
	assert.match((r as { reason: string }).reason, /max agents/i);
});

test("canSpawn enforces maxSpawnDepth", () => {
	const e = new Engine(caps); // maxSpawnDepth = 2
	const r = e.canSpawn("deep", 2); // spawnerDepth 2 -> child depth 3 > 2
	assert.equal(r.ok, false);
	assert.match((r as { reason: string }).reason, /depth/i);
});

test("route delivers structured agent message to existing agent when idle", async () => {
	const e = new Engine(caps);
	let delivered: RoutedAgentMessage | undefined;
	const handle: AgentHandle = {
		deliver: async (message) => {
			delivered = message;
		},
		abort: async () => {},
	};
	e.addAgent({ ...mainRecord(), name: "coder", handle, depth: 1 });
	const r = await e.route("main", "coder", "fix the bug");
	assert.deepEqual(r, { outcome: "delivered" });
	assert.deepEqual(delivered, createRoutedAgentMessage("main", "fix the bug"));
	assert.equal(e.events.at(-1)?.type, "route");
});

test("route reports delivery when the target is already mid-turn", async () => {
	const e = new Engine(caps);
	const handle: AgentHandle = {
		deliver: async () => {},
		abort: async () => {},
	};
	e.addAgent({ ...mainRecord(), name: "busy", handle, depth: 1 });
	e.setActivity("busy", "tool", "bash");
	const r = await e.route("main", "busy", "hi");
	assert.deepEqual(r, { outcome: "delivered" });
});

test("route fails for unknown agent", async () => {
	const e = new Engine(caps);
	const r = await e.route("main", "ghost", "hi");
	assert.deepEqual(r, { outcome: "failed", reason: "unknown agent 'ghost'" });
});

test("route buffers while paused", async () => {
	const e = new Engine(caps);
	let delivered: RoutedAgentMessage | undefined;
	const handle: AgentHandle = {
		deliver: async (message) => {
			delivered = message;
		},
		abort: async () => {},
	};
	e.addAgent({
		name: "coder",
		model: "openai/gpt-4o",
		handle,
		spawnedBy: "main",
		depth: 1,
		createdAt: Date.now(),
		turns: 0,
		lastActivity: Date.now(),
	});

	e.pause();
	const r = await e.route("main", "coder", "hi");

	assert.deepEqual(r, { outcome: "buffered", reason: "manual" });
	assert.equal(delivered, undefined); // Should not deliver
	assert.deepEqual(e.get("coder")?.pausedInbox, [createRoutedAgentMessage("main", "hi")]);
	assert.equal(e.events.at(-1)?.type, "route"); // Verify edge count and route event still fired
});

test("recordTurnStart counts turns and aborts when budget exhausted", () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 2 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	assert.equal(e.recordTurnStart("a").abort, false);
	assert.equal(e.recordTurnStart("a").abort, false);
	const third = e.recordTurnStart("a");
	assert.equal(third.abort, true);
	assert.match(third.reason ?? "", /budget/i);
	assert.equal(e.get("a")?.turns, 2);
	assert.equal(e.budget.used, 2);
});

test("recordTurnStart aborts while paused", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.pause();
	const r = e.recordTurnStart("a");
	assert.equal(r.abort, true);
	assert.match(r.reason ?? "", /paused/i);
});

test("resume clears the budget stop and resets the turn count", () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 1 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.recordTurnStart("a"); // reaches the budget -> swarm-wide stop
	assert.deepEqual(e.resume(), { wasPaused: true, bufferedMessages: 0, budgetRearmed: true });
	assert.equal(e.isPaused(), false);
	assert.equal(e.budget.used, 0);
	assert.equal(e.events.at(-1)?.type, "resume");
	assert.deepEqual(e.resume(), { wasPaused: false, bufferedMessages: 0, budgetRearmed: false });
	assert.equal(e.recordTurnStart("a").abort, false);
});

test("a manual pause/resume cycle does NOT re-arm the budget", () => {
	// Inversion: the valve must not be resettable by a verb that anyone (including main via
	// resume_subagents) can call without the budget ever having tripped.
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 10 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.recordTurnStart("a");
	e.recordTurnStart("a");
	e.pause(["a"]);
	assert.deepEqual(e.resume(), { wasPaused: true, bufferedMessages: 0, budgetRearmed: false });
	assert.equal(e.budget.used, 2);
	assert.equal(e.get("a")?.paused, false);
});

test("resume on a live swarm is a no-op: the budget is NOT re-armed", () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 10 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.recordTurnStart("a");
	e.recordTurnStart("a");
	const before = e.events.length;
	// Re-arming here would let any caller poll the safety valve away.
	assert.deepEqual(e.resume(), { wasPaused: false, bufferedMessages: 0, budgetRearmed: false });
	assert.equal(e.budget.used, 2);
	assert.equal(e.events.length, before, "no resume event for a swarm that was never paused");
});

test("freeze-by-blocking: budget-reaching turn completes, next is blocked, swarm freezes", () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 2 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	assert.equal(e.recordTurnStart("a").abort, false); // used 1
	assert.equal(e.isPaused(), false);
	assert.equal(e.recordTurnStart("a").abort, false); // used 2 == budget: completes, then freezes
	assert.equal(e.isPaused(), true);
	assert.equal(e.events.at(-1)?.type, "pause");
	assert.equal((e.events.at(-1) as { reason?: string }).reason, "budget");
	const blocked = e.recordTurnStart("a"); // next turn blocked
	assert.equal(blocked.abort, true);
	assert.match(blocked.reason ?? "", /budget/i);
});

test("pause marks only mid-turn agents as pausedMidTurn; manual pause reason", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "busy", depth: 1, activity: "thinking" });
	e.addAgent({ ...mainRecord(), name: "done", depth: 1 });
	e.pause();
	assert.equal(e.get("busy")?.pausedMidTurn, true);
	assert.equal(e.get("done")?.pausedMidTurn, undefined);
	assert.equal((e.events.at(-1) as { type: string; reason?: string }).reason, "manual");
	// pausedMidTurn survives the natural agent_end of an allowed-to-complete turn.
	e.endTurn("busy");
	assert.equal(e.get("busy")?.pausedMidTurn, true);
	// Both are stopped, so both read as paused; only 'busy' is re-triggered on resume.
	assert.equal(formatStatus(agentStatus(e.get("busy")!)), "paused");
	assert.equal(formatStatus(agentStatus(e.get("done")!)), "paused");
	assert.equal(e.get("done")?.pausedMidTurn, undefined);
});

test("resume clears the pausedMidTurn flags", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "busy", depth: 1, activity: "thinking" });
	e.pause();
	assert.equal(e.get("busy")?.pausedMidTurn, true);
	e.resume();
	assert.equal(e.get("busy")?.pausedMidTurn, false);
});

test("setCustomStatus sets and clears; no-op on unknown name", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.setCustomStatus("a", "working");
	assert.equal(e.get("a")?.customStatus, "working");
	e.setCustomStatus("a", "");
	assert.equal(e.get("a")?.customStatus, undefined);
	assert.doesNotThrow(() => e.setCustomStatus("ghost", "x"));
});

test("setStopReason sets it; a new turn (setStreaming true) clears it", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.setStopReason("a", "error");
	assert.equal(e.get("a")?.stopReason, "error");
	assert.equal(formatStatus(agentStatus(e.get("a")!)), "error");
	e.beginTurn("a"); // new turn starts -> stale outcome cleared
	assert.equal(e.get("a")?.stopReason, undefined);
	e.endTurn("a");
	assert.equal(formatStatus(agentStatus(e.get("a")!)), "idle");
	assert.doesNotThrow(() => e.setStopReason("ghost", "error"));
});

test("beginTurn opens the thinking phase, endTurn closes the turn", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.beginTurn("a");
	assert.equal(e.get("a")?.activity, "thinking");
	e.setActivity("a", "tool", "bash");
	e.endTurn("a");
	assert.equal(e.get("a")?.activity, undefined);
	assert.equal(e.get("a")?.currentTool, undefined);
});

test("addAgent preserves optional view", () => {
	const e = new Engine(caps);
	const msgs: unknown[] = [{ role: "user", content: "hi" }];
	const view = {
		getMessages: () => msgs,
		getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0.05 }),
		subscribe: () => () => {},
	};
	e.addAgent({ ...mainRecord(), name: "a", depth: 1, view });
	assert.equal(e.get("a")?.view?.getMessages().length, 1);
	assert.equal(e.get("a")?.view?.getContextUsage()?.contextWindow, 200000);
});

test("reserve blocks duplicate, counts toward cap; release frees a slot", () => {
	const e = new Engine({ maxAgents: 2, maxSpawnDepth: 3, turnBudget: 5 });
	assert.equal(e.reserve("a", "main").ok, true);
	assert.equal(e.reserve("a", "main").ok, false); // duplicate (R2)
	assert.equal(e.reserve("b", "main").ok, true);
	const capped = e.reserve("c", "main"); // a+b = max (R3)
	assert.equal(capped.ok, false);
	assert.match((capped as { reason: string }).reason, /max agents/);
	e.release("a");
	assert.equal(e.has("a"), false);
	assert.equal(e.reserve("c", "main").ok, true);
});

test("route to a pending agent buffers; attach flushes to the real handle (R1)", async () => {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	e.reserve("a", "main");
	const r = await e.route("main", "a", "ping");
	assert.deepEqual(r, { outcome: "delivered" }); // no longer unknown
	const delivered: RoutedAgentMessage[] = [];
	e.attach("a", {
		model: "test/m",
		thinkingLevel: "xhigh",
		handle: { deliver: async (message) => void delivered.push(message), abort: async () => {} },
	});
	assert.deepEqual(delivered, [createRoutedAgentMessage("main", "ping")]); // buffer flushed
	assert.equal(e.get("a")?.pending, false);
	assert.equal(e.get("a")?.model, "test/m");
	assert.equal(e.get("a")?.thinkingLevel, "xhigh");
});

test("kill awaits the agent's ordered runtime close, removes it, and emits a kill event", async () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	const lifecycle: string[] = [];
	const handle: AgentHandle = {
		deliver: async () => {},
		abort: async () => void lifecycle.push("legacy abort must not run"),
	};
	e.reserve("a", "main");
	e.attach("a", {
		model: "test/m",
		handle,
		close: async () => {
			await Promise.resolve();
			lifecycle.push("closed");
		},
	});
	const r = await e.kill("a");
	assert.equal(r.ok, true);
	assert.deepEqual(lifecycle, ["closed"]);
	assert.equal(e.has("a"), false);
	assert.equal(e.events.at(-1)?.type, "kill");
});

test("kill cascades to the whole subtree, deepest first", async () => {
	const e = new Engine({ maxAgents: 9, maxSpawnDepth: 9, turnBudget: 9 });
	const closed: string[] = [];
	const withClose = (name: string, parent: string, depth: number) => ({
		...mainRecord(),
		name,
		spawnedBy: parent,
		depth,
		close: async () => {
			closed.push(name);
		},
	});
	e.addAgent(mainRecord());
	e.addAgent(withClose("parent", "main", 1));
	e.addAgent(withClose("child", "parent", 2));
	e.addAgent(withClose("grandchild", "child", 3));
	e.addAgent(withClose("sibling", "main", 1)); // untouched: not in the subtree

	const r = await e.kill("parent");
	assert.equal(r.ok, true);
	assert.deepEqual((r as { killed: string[] }).killed, ["grandchild", "child", "parent"]);
	// Post-order: no record is closed while a live descendant could still route into it.
	assert.deepEqual(closed, ["grandchild", "child", "parent"]);
	assert.deepEqual(
		e.list().map((a) => a.name),
		["main", "sibling"],
	);
	assert.deepEqual(
		e.events.filter((ev) => ev.type === "kill").map((ev) => (ev as { name: string }).name),
		["grandchild", "child", "parent"],
	);
});

test("kill refuses 'main' and unknown agents", async () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	const u = await e.kill("main");
	assert.equal(u.ok, false);
	assert.match((u as { reason: string }).reason, /main/);
	const x = await e.kill("ghost");
	assert.equal(x.ok, false);
	assert.match((x as { reason: string }).reason, /unknown/);
	assert.equal(e.has("main"), true);
});

test("killAll removes every agent except 'main' and returns their names", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 2, turnBudget: 5 });
	e.addAgent(mainRecord());
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "b", depth: 1 });
	const killed = await e.killAll();
	assert.deepEqual(killed.sort(), ["a", "b"]);
	assert.equal(e.has("main"), true);
	assert.equal(e.list().length, 1);
});

test("shutdownAll closes background runtimes without recording explicit kills", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 2, turnBudget: 5 });
	e.addAgent(mainRecord());
	const closed: string[] = [];
	for (const name of ["a", "b"]) {
		e.reserve(name, "main");
		e.attach(name, {
			model: "test/m",
			handle: fakeHandle(),
			close: async () => void closed.push(name),
		});
	}
	const killEventsBefore = e.events.filter((event) => event.type === "kill").length;

	await e.shutdownAll();

	assert.deepEqual(closed.sort(), ["a", "b"]);
	assert.equal(e.list().length, 1);
	assert.equal(e.has("main"), true);
	assert.equal(e.events.filter((event) => event.type === "kill").length, killEventsBefore);
});

test("getMessageMatrix counts edges; multicast counts one per target", async () => {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 50 });
	e.addAgent(mainRecord());
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "b", depth: 1 });
	await e.route("main", "a", "one");
	await e.route("main", "a", "two");
	await e.route("main", "b", "hi"); // multicast = caller loops route per target
	await e.route("a", "b", "back");
	const m = e.getMessageMatrix();
	assert.equal(m.main?.a, 2);
	assert.equal(m.main?.b, 1);
	assert.equal(m.a?.b, 1);
	// snapshot is a copy, not a live reference
	m.main.a = 999;
	assert.equal(e.getMessageMatrix().main.a, 2);
});

test("reserve records the spawn parent (child -> parent)", () => {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 5 });
	e.addAgent(mainRecord());
	e.reserve("a", "main");
	e.attach("a", { model: "test/m", handle: fakeHandle() });
	e.reserve("b", "a");
	const tree = e.getSpawnTree();
	assert.equal(tree.a, "main");
	assert.equal(tree.b, "a");
	assert.equal(tree.main, undefined); // main is the root
});

test("re-spawning a killed name clears its incoming + outgoing edges and overwrites its parent", async () => {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3, turnBudget: 50 });
	e.addAgent(mainRecord());
	e.reserve("a", "main");
	e.attach("a", { model: "test/m", handle: fakeHandle() });
	e.reserve("w", "a");
	e.attach("w", { model: "test/m", handle: fakeHandle() });
	await e.route("main", "w", "out-from-main"); // incoming edge main->w
	await e.route("w", "a", "out-from-w"); // outgoing edge w->a
	await e.kill("w");
	// re-spawn 'w' under a different parent
	e.reserve("w", "main");
	const m = e.getMessageMatrix();
	assert.equal(m.main?.w, undefined); // incoming edge cleared
	assert.equal(m.w, undefined); // outgoing edges cleared
	assert.equal(e.getSpawnTree().w, "main"); // parent overwritten (was 'a')
});

test("resume releases a paused inbox as one ordered batch", async () => {
	const e = new Engine(caps);
	const delivered: RoutedAgentMessage[] = [];
	const handle: AgentHandle = {
		deliver: async (message) => {
			delivered.push(message);
		},
		abort: async () => {},
	};
	e.addAgent({
		name: "coder",
		model: "openai/gpt-4o",
		handle,
		spawnedBy: "main",
		depth: 1,
		createdAt: Date.now(),
		turns: 0,
		lastActivity: Date.now(),
	});

	e.pause();
	await e.route("main", "coder", "ping 1");
	await e.route("main", "coder", "ping 2");

	assert.deepEqual(delivered, []); // Buffered

	assert.deepEqual(e.resume(), { wasPaused: true, bufferedMessages: 2, budgetRearmed: false });

	assert.deepEqual(delivered, [
		{ parts: [{ from: "main", content: "ping 1" }, { from: "main", content: "ping 2" }] },
	]);
	assert.equal(e.get("coder")?.pausedInbox, undefined);
});

test("deadlock: budget-reaching turn's route buffers, idle recipient receives on resume", async () => {
	const e = new Engine({ ...caps, turnBudget: 1 });
	const delivered: RoutedAgentMessage[] = [];
	
	e.addAgent({
		name: "explore",
		model: "openai/gpt-4o",
		handle: { deliver: async () => {}, abort: async () => {} },
		spawnedBy: "main",
		depth: 1,
		createdAt: Date.now(),
		turns: 0,
		lastActivity: Date.now(),
	});
	
	e.addAgent({
		name: "exploit",
		model: "openai/gpt-4o",
		handle: { deliver: async (message) => { delivered.push(message); }, abort: async () => {} },
		spawnedBy: "main",
		depth: 1,
		createdAt: Date.now(),
		turns: 0,
		lastActivity: Date.now(),
	});

	// explore starts its turn - reaches budget limit (1/1)
	const startResult = e.recordTurnStart("explore");
	assert.equal(startResult.abort, false); // allowed to complete
	assert.equal(e.isPaused(), true); // swarm is now paused

	// explore sends message to exploit during its budget-reaching turn
	const routeResult = await e.route("explore", "exploit", "do the work");
	// The swarm-wide cause is named, not the generic "paused": only a full resume re-arms it.
	assert.deepEqual(routeResult, { outcome: "buffered", reason: "budget" });
	assert.deepEqual(delivered, []); // exploit didn't receive it yet

	// User resumes the swarm
	e.resume();

	// exploit gets the message flushed
	assert.deepEqual(delivered, [createRoutedAgentMessage("explore", "do the work")]);
});

test("retune applies the change and adopts the level the session reports back", async () => {
	const e = new Engine(caps);
	const applied: unknown[] = [];
	e.addAgent({
		...mainRecord(),
		name: "w",
		depth: 1,
		thinkingLevel: "low",
		// The session clamps 'max' to 'high' — the record must show what happened, not what was asked.
		reconfigure: async (change) => {
			applied.push(change);
			return { model: change.model?.display, thinkingLevel: "high" };
		},
	});
	const r = await e.retune("w", { model: { display: "anthropic/opus", model: {} }, thinkingLevel: "max" });
	assert.equal(r.ok, true);
	assert.equal(e.get("w")?.model, "anthropic/opus");
	assert.equal(e.get("w")?.thinkingLevel, "high");
	assert.equal(applied.length, 1);
});

test("retune refuses main, unknown agents and still-spawning reservations", async () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	e.reserve("pending", "main"); // reservation has no reconfigure until attach
	assert.match(((await e.retune("main", { thinkingLevel: "high" })) as { reason: string }).reason, /cannot retune 'main'/);
	assert.match(((await e.retune("ghost", { thinkingLevel: "high" })) as { reason: string }).reason, /unknown agent/);
	assert.match(((await e.retune("pending", { thinkingLevel: "high" })) as { reason: string }).reason, /still spawning/);
});

test("a failing session retune is reported, not thrown", async () => {
	const e = new Engine(caps);
	e.addAgent({
		...mainRecord(),
		name: "w",
		depth: 1,
		reconfigure: async () => {
			throw new Error("provider rejected the model");
		},
	});
	const r = await e.retune("w", { thinkingLevel: "high" });
	assert.equal(r.ok, false);
	assert.match((r as { reason: string }).reason, /provider rejected/);
});

// ── per-agent manual pause ──

test("pause(names) stops only the named agents; the rest keep running", async () => {
	const e = new Engine(caps);
	const delivered: string[] = [];
	const rec = (name: string) => ({
		...mainRecord(),
		name,
		depth: 1,
		handle: {
			deliver: async () => {
				delivered.push(name);
			},
			abort: async () => {},
		},
	});
	e.addAgent(rec("a"));
	e.addAgent(rec("b"));

	assert.deepEqual(e.pause(["a"]), ["a"]);
	// The SWARM is not stopped by one manual pause; the paused agent is reported separately.
	assert.equal(e.isPaused(), false);
	assert.deepEqual(e.pausedAgents(), ["a"]);
	assert.equal(e.recordTurnStart("a").abort, true);
	assert.equal(e.recordTurnStart("b").abort, false);
	assert.deepEqual(await e.route("main", "a", "hi"), { outcome: "buffered", reason: "manual" });
	assert.deepEqual(await e.route("main", "b", "hi"), { outcome: "delivered" });
	assert.deepEqual(delivered, ["b"]);
	assert.equal(formatStatus(agentStatus(e.get("a")!)), "paused"); // idle-but-paused reads as paused
	assert.equal(formatStatus(agentStatus(e.get("b")!)), "idle");
	assert.deepEqual(e.events.at(-1), { type: "route", from: "main", to: "b", preview: "hi", buffered: false, ts: e.events.at(-1)!.ts });
});

test("pause() without names pauses every background agent but never 'main'", () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	assert.deepEqual(e.pause(), ["a"]);
	assert.equal(e.get("main")?.paused, undefined);
	const event = e.events.at(-1) as { type: string; reason: string; names: string[] };
	assert.deepEqual({ type: event.type, reason: event.reason, names: event.names }, { type: "pause", reason: "manual", names: [] });
	assert.deepEqual(e.pause(["a"]), [], "an already paused agent is not reported as newly paused");
});

test("resume(names) releases only those agents and does NOT re-arm the budget", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 10 });
	const delivered: RoutedAgentMessage[] = [];
	e.addAgent({
		...mainRecord(),
		name: "a",
		depth: 1,
		handle: {
			deliver: async (message) => {
				delivered.push(message);
			},
			abort: async () => {},
		},
	});
	e.addAgent({ ...mainRecord(), name: "b", depth: 1, activity: "thinking" });
	e.recordTurnStart("a"); // burns budget
	e.pause();

	assert.deepEqual(e.resume(["a"]), { wasPaused: true, bufferedMessages: 0, budgetRearmed: false });
	assert.equal(e.budget.used, 1, "a named resume must not reset the safety valve");
	assert.equal(e.get("a")?.paused, false);
	assert.equal(e.get("b")?.paused, true, "unnamed agents stay paused");
	assert.equal(e.get("b")?.pausedMidTurn, true);
	assert.deepEqual(e.pausedAgents(), ["b"]);
	const event = e.events.at(-1) as { type: string; names: string[] };
	assert.deepEqual({ type: event.type, names: event.names }, { type: "resume", names: ["a"] });

	await e.route("main", "a", "back to work");
	assert.deepEqual(delivered, [createRoutedAgentMessage("main", "back to work")]);
	assert.deepEqual(
		e.resume(["ghost"]),
		{ wasPaused: false, bufferedMessages: 0, budgetRearmed: false },
		"unknown names resume nothing",
	);
});

test("resume(names) is refused while the swarm is budget-paused", () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 1 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.recordTurnStart("a"); // reaches the budget -> swarm-wide pause
	assert.deepEqual(e.resume(["a"]), {
		wasPaused: false,
		bufferedMessages: 0,
		budgetRearmed: false,
		blockedByBudget: true,
	});
	assert.equal(e.recordTurnStart("a").abort, true, "the budget pause still holds");
	// Only the full resume re-arms it.
	assert.deepEqual(e.resume(), { wasPaused: true, bufferedMessages: 0, budgetRearmed: true });
	assert.equal(e.recordTurnStart("a").abort, false);
});

test("resume() without names clears every manual pause", () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5, turnBudget: 10 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "b", depth: 1 });
	e.pause();
	assert.deepEqual(e.resume(), { wasPaused: true, bufferedMessages: 0, budgetRearmed: false });
	assert.deepEqual(e.pausedAgents(), []);
	assert.equal(e.isPaused(), false);
});

test("pauseSwarm('restored') blocks every agent until a full resume", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1, activity: "tool" });
	e.pauseSwarm("restored");
	assert.equal(e.isPaused(), true);
	assert.equal(e.get("a")?.pausedMidTurn, true);
	assert.equal(e.recordTurnStart("a").abort, true);
	const event = e.events.at(-1) as { type: string; reason: string; names: string[] };
	assert.deepEqual({ type: event.type, reason: event.reason, names: event.names }, { type: "pause", reason: "restored", names: [] });
});

// ── panel input: a real user turn, never silently swallowed ──

test("deliverUser hands the text to the session and reports it like a route", () => {
	const e = new Engine(caps);
	const seen: string[] = [];
	e.addAgent({
		...mainRecord(),
		name: "a",
		depth: 1,
		handle: {
			deliver: async () => {},
			deliverUser: async (text) => {
				seen.push(text);
			},
			abort: async () => {},
		},
	});
	assert.deepEqual(e.deliverUser("a", "do this"), { outcome: "delivered" });
	assert.deepEqual(seen, ["do this"]);
	const event = e.events.at(-1) as { type: string; from: string; to: string; buffered: boolean };
	assert.deepEqual({ type: event.type, from: event.from, to: event.to, buffered: event.buffered }, {
		type: "route",
		from: "main",
		to: "a",
		buffered: false,
	});
	assert.equal(e.getMessageMatrix().main?.a, 1);
});

test("deliverUser refuses unknown, still-spawning and paused agents instead of dropping text", () => {
	const e = new Engine(caps);
	e.reserve("pending", "main"); // reservation: no session to receive a user turn yet
	e.addAgent({ ...mainRecord(), name: "a", depth: 1, handle: { deliver: async () => {}, deliverUser: async () => {}, abort: async () => {} } });
	e.pause(["a"]);
	const refusal = (to: string) => {
		const r = e.deliverUser(to, "x");
		assert.equal(r.outcome, "refused");
		return (r as { reason: string }).reason;
	};
	assert.match(refusal("ghost"), /unknown agent/);
	assert.match(refusal("pending"), /still spawning/);
	assert.match(refusal("a"), /paused/);
});

test("a pause that changes nothing emits no event", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.pause(["a"]);
	const before = e.events.length;
	assert.deepEqual(e.pause(["a"]), []); // already paused
	assert.deepEqual(e.pause(["typo"]), []); // unknown name
	assert.equal(e.events.length, before, "the feed must not show a pause that did not happen");
});

test("a reservation that completes while paused parks its buffer instead of delivering it", async () => {
	const e = new Engine(caps);
	const delivered: RoutedAgentMessage[] = [];
	e.addAgent(mainRecord());
	e.reserve("late", "main");
	await e.route("main", "late", "before the pause"); // buffered in the reservation
	e.pause(["late"]);
	await e.route("main", "late", "after the pause"); // buffered in the paused inbox
	e.attach("late", {
		model: "test/m",
		handle: {
			deliver: async (message) => {
				delivered.push(message);
			},
			abort: async () => {},
		},
	});
	// Delivering here would start a turn that recordTurnStart aborts, losing the messages.
	assert.deepEqual(delivered, []);
	assert.deepEqual(e.get("late")?.pausedInbox, [
		createRoutedAgentMessage("main", "before the pause"),
		createRoutedAgentMessage("main", "after the pause"),
	]);
	e.resume(["late"]);
	assert.equal(delivered.length, 1); // released as one ordered batch
});

test("deliverUser refuses 'main': the human is already typing in that chat", () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	const r = e.deliverUser("main", "hi");
	assert.equal(r.outcome, "refused");
	assert.match((r as { reason: string }).reason, /main/);
});

// --- Reaction observation (awaitReaction) --------------------------------------------------
// route() returns before the target's turn can start, so "delivered + idle" alone cannot tell a
// working agent from one that never moves. awaitReaction supplies that second axis.

/** Fails loudly instead of hanging when a call that must not block does block. */
async function withoutWaiting<T>(what: string, work: Promise<T>): Promise<T> {
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		watchdog = setTimeout(() => reject(new Error(`${what} waited instead of returning`)), 2000);
	});
	try {
		return await Promise.race([work, guard]);
	} finally {
		if (watchdog) clearTimeout(watchdog);
	}
}

test("awaitReaction reports the target as moving when it starts its turn", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "w", depth: 1 });
	const pending = e.awaitReaction("w", e.events.length, 60_000);
	e.setActivity("w", "thinking"); // the session's agent_start
	e.recordTurnStart("w"); // emits the `turn` event the wait listens for
	assert.deepEqual(await withoutWaiting("awaitReaction", pending), {
		observed: "moving",
		status: { kind: "working", phase: "thinking", tool: undefined },
	});
});

test("awaitReaction reports a failing turn as moving with the error status", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "w", depth: 1 });
	const pending = e.awaitReaction("w", e.events.length, 60_000);
	e.reportError("w", "boom");
	assert.deepEqual(await withoutWaiting("awaitReaction", pending), {
		observed: "moving",
		status: { kind: "idle", outcome: "error" },
	});
});

test("awaitReaction sees a reaction that happened before the wait started", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "w", depth: 1 });
	// The real gap: delivery can fail (or a turn can start) between route() and the wait. The
	// event log, read from the pre-delivery mark, closes it — otherwise this costs a full window.
	const sinceEvent = e.events.length;
	e.reportError("w", "delivery failed");
	assert.deepEqual(await withoutWaiting("awaitReaction", e.awaitReaction("w", sinceEvent, 60_000)), {
		observed: "moving",
		status: { kind: "idle", outcome: "error" },
	});
});

test("awaitReaction ignores a reaction that is older than the mark", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "w", depth: 1 });
	e.recordTurnStart("w"); // work the agent did BEFORE this message was routed to it
	e.endTurn("w");
	// The mark is what scopes the observation to one delivery: without it, a multicast whose first
	// target is slow to route would credit this agent's earlier turn as a reaction to our message.
	const sinceEvent = e.events.length;
	assert.deepEqual(await e.awaitReaction("w", sinceEvent, 20), { observed: "unmoved", status: { kind: "idle" } });
});

test("awaitReaction reports an unmoved target and ignores other agents' turns", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "quiet", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "noisy", depth: 1 });
	const pending = e.awaitReaction("quiet", e.events.length, 20);
	e.recordTurnStart("noisy"); // someone else reacting must not end this wait
	// "unmoved + idle" is the signal the whole wait exists for: it took the message and sat still.
	assert.deepEqual(await pending, { observed: "unmoved", status: { kind: "idle" } });
});

test("awaitReaction reports the agent as gone when it is killed mid-wait", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "doomed", depth: 1 });
	const pending = e.awaitReaction("doomed", e.events.length, 60_000);
	await e.kill("doomed");
	assert.deepEqual(await withoutWaiting("awaitReaction", pending), { observed: "gone" });
});

test("awaitReaction returns at once for an agent that is already working", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "busy", depth: 1 });
	e.setActivity("busy", "writing");
	// A mid-turn agent is demonstrably alive; waiting for its next turn boundary would spend the
	// whole window to learn nothing new.
	assert.deepEqual(await withoutWaiting("awaitReaction", e.awaitReaction("busy", e.events.length, 60_000)), {
		observed: "moving",
		status: { kind: "working", phase: "writing", tool: undefined },
	});
});

test("awaitReaction never waits on 'main' and does not claim to have watched it", async () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	// The foreground emits no turn events, so its idle snapshot must not be read as "no reaction".
	assert.deepEqual(await withoutWaiting("awaitReaction", e.awaitReaction("main", e.events.length, 60_000)), {
		observed: "unwatched",
		status: { kind: "idle" },
	});
});

test("statusOf folds the swarm-wide pause into the per-record status", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	assert.deepEqual(e.statusOf("a"), { kind: "idle" });
	e.pauseSwarm("budget");
	// agentStatus() alone cannot see budgetPaused: that state lives on the engine, by design.
	assert.deepEqual(agentStatus(e.get("a")!), { kind: "idle" });
	assert.deepEqual(e.statusOf("a"), { kind: "paused" });
	assert.equal(e.statusOf("ghost"), undefined);
});

test("route reports the fate decided at delivery, not the pause state after it", async () => {
	const e = new Engine(caps);
	let release: (() => void) | undefined;
	e.addAgent({
		...mainRecord(),
		name: "slow",
		depth: 1,
		handle: {
			deliver: () => new Promise<void>((resolve) => (release = resolve)),
			abort: async () => {},
		},
	});
	const routed = e.route("main", "slow", "hi");
	e.pause(["slow"]); // pause lands while the handle is still delivering
	release?.();
	// The session already has the message, so calling it "buffered" would be a lie.
	assert.deepEqual(await routed, { outcome: "delivered" });
	assert.equal(e.get("slow")?.pausedInbox, undefined);
});

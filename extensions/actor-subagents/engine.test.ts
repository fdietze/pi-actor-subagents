import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutedAgentMessage, type RoutedAgentMessage } from "./agent-message.ts";
import { agentStatus, formatStatus } from "./agent-status.ts";
import type { AgentHandle } from "./agent-record.ts";
import type { EngineResumeResult } from "./control-result.ts";
import { Engine } from "./engine.ts";
import { errorNotification } from "./error-notification.ts";
import { formatSendTargets } from "./panel-logic.ts";

const fakeHandle = (): AgentHandle => ({
	deliver: async () => {},
	abort: async () => {},
});

const caps = { maxAgents: 2, maxSpawnDepth: 2 };

/** The work a resume released, without the per-target outcomes. */
const released = ({ affected, interrupted, bufferedMessages }: EngineResumeResult) => ({ affected, interrupted, bufferedMessages });

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

test("entering the error state emits one event per failed run, on both failure paths", () => {
	// The parent notification hangs off this event, so it must fire once for a thrown exception AND
	// once for a logical run the SDK settled after retries, and not repeat while
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

	e.pause("main");
	const r = await e.route("main", "coder", "hi");

	assert.deepEqual(r, { outcome: "buffered" });
	assert.equal(delivered, undefined); // Should not deliver
	assert.deepEqual(e.get("coder")?.pausedInbox, [createRoutedAgentMessage("main", "hi")]);
	assert.equal(e.events.at(-1)?.type, "route"); // Verify edge count and route event still fired
});

test("recordTurnStart counts the agent's turns without limiting them", () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	for (let i = 0; i < 5; i++) assert.equal(e.recordTurnStart("a").abort, false);
	assert.equal(e.get("a")?.turns, 5);
});

test("recordTurnStart aborts while paused", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.pause("main");
	const r = e.recordTurnStart("a");
	assert.equal(r.abort, true);
	assert.match(r.reason ?? "", /paused/i);
});

test("resume lifts a pause and lets turns run again", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.pause("main", ["a"]);
	assert.deepEqual(released(await e.resume("main")), { affected: ["a"], interrupted: [], bufferedMessages: 0 });
	assert.deepEqual(e.pausedAgents(), []);
	assert.equal(e.events.at(-1)?.type, "resume");
	assert.deepEqual(released(await e.resume("main")), { affected: [], interrupted: [], bufferedMessages: 0 });
	assert.equal(e.recordTurnStart("a").abort, false);
});

test("resume on a live swarm is a no-op and emits nothing", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.recordTurnStart("a");
	const before = e.events.length;
	assert.deepEqual(released(await e.resume("main")), { affected: [], interrupted: [], bufferedMessages: 0 });
	assert.equal(e.events.length, before, "no resume event for a swarm that was never paused");
});

test("pause marks only mid-turn agents as pausedMidTurn", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "busy", depth: 1, activity: "thinking" });
	e.addAgent({ ...mainRecord(), name: "done", depth: 1 });
	e.pause("main");
	assert.equal(e.get("busy")?.pausedMidTurn, true);
	assert.equal(e.get("done")?.pausedMidTurn, undefined);
	// pausedMidTurn survives the natural agent_end of an allowed-to-complete turn.
	e.endTurn("busy");
	assert.equal(e.get("busy")?.pausedMidTurn, true);
	// Both are stopped, so both read as paused; only 'busy' is re-triggered on resume.
	assert.equal(formatStatus(agentStatus(e.get("busy")!)), "paused");
	assert.equal(formatStatus(agentStatus(e.get("done")!)), "paused");
	assert.equal(e.get("done")?.pausedMidTurn, undefined);
});

test("resume clears the pausedMidTurn flags", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "busy", depth: 1, activity: "thinking" });
	e.pause("main");
	assert.equal(e.get("busy")?.pausedMidTurn, true);
	await e.resume("main");
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
	const e = new Engine({ maxAgents: 2, maxSpawnDepth: 3 });
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
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3 });
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
	const r = await e.kill("main", ["a"]);
	assert.deepEqual(r, { results: [{ target: "a", ok: true }], affected: ["a"] });
	assert.deepEqual(lifecycle, ["closed"]);
	assert.equal(e.has("a"), false);
	assert.equal(e.events.at(-1)?.type, "kill");
});

test("kill cascades to the whole subtree, deepest first", async () => {
	const e = new Engine({ maxAgents: 9, maxSpawnDepth: 9 });
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

	// Naming a descendant of an earlier target too is done, not unknown.
	const r = await e.kill("main", ["parent", "child"]);
	assert.deepEqual(r.results, [{ target: "parent", ok: true }, { target: "child", ok: true }]);
	assert.deepEqual(r.affected, ["grandchild", "child", "parent"]);
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
	assert.deepEqual((await e.kill("main", ["main", "ghost"])).results, [
		{ target: "main", ok: false, reason: "'main' is not in your subtree" },
		{ target: "ghost", ok: false, reason: "unknown agent 'ghost'" },
	]);
	assert.equal(e.has("main"), true);
});

test("killAll removes every agent except 'main' and returns their names", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 2 });
	e.addAgent(mainRecord());
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "b", depth: 1 });
	const { affected } = await e.killAll();
	assert.deepEqual(affected.sort(), ["a", "b"]);
	assert.equal(e.has("main"), true);
	assert.equal(e.list().length, 1);
});

test("shutdownAll closes background runtimes without recording explicit kills", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 2 });
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
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3 });
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

test("liveNames keeps history but drops killed agents, so the roster hides dead targets", async () => {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3 });
	e.addAgent(mainRecord());
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "helper", depth: 1 });
	await e.route("a", "helper", "hi");
	await e.route("a", "main", "done");
	await e.kill("main", ["helper"]);
	// Engine history is deliberately unchanged by the kill.
	assert.equal(e.getMessageMatrix().a?.helper, 1);
	assert.deepEqual([...e.liveNames()].sort(), ["a", "main"]);
	assert.equal(formatSendTargets(e.getMessageMatrix(), "a", e.liveNames()), "\u279cmain");
});

test("reserve records the spawn parent (child -> parent)", () => {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3 });
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
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 3 });
	e.addAgent(mainRecord());
	e.reserve("a", "main");
	e.attach("a", { model: "test/m", handle: fakeHandle() });
	e.reserve("w", "a");
	e.attach("w", { model: "test/m", handle: fakeHandle() });
	await e.route("main", "w", "out-from-main"); // incoming edge main->w
	await e.route("w", "a", "out-from-w"); // outgoing edge w->a
	await e.kill("main", ["w"]);
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

	e.pause("main");
	await e.route("main", "coder", "ping 1");
	await e.route("main", "coder", "ping 2");

	assert.deepEqual(delivered, []); // Buffered

	assert.deepEqual(released(await e.resume("main")), { affected: ["coder"], interrupted: [], bufferedMessages: 2 });

	assert.deepEqual(delivered, [
		{ parts: [{ from: "main", content: "ping 1" }, { from: "main", content: "ping 2" }] },
	]);
	assert.equal(e.get("coder")?.pausedInbox, undefined);
});

test("a route issued while the target is paused buffers and lands on resume", async () => {
	const e = new Engine({ ...caps });
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

	assert.equal(e.recordTurnStart("explore").abort, false);
	e.pause("main");

	// explore sends to exploit while the pause holds
	const routeResult = await e.route("explore", "exploit", "do the work");
	assert.deepEqual(routeResult, { outcome: "buffered" });
	assert.deepEqual(delivered, []); // exploit didn't receive it yet

	// User resumes the swarm
	await e.resume("main");

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
	const r = await e.retune("main", "w", { model: { display: "anthropic/opus", model: {} }, thinkingLevel: "max" });
	assert.equal(r.ok, true);
	assert.equal(e.get("w")?.model, "anthropic/opus");
	assert.equal(e.get("w")?.thinkingLevel, "high");
	assert.equal(applied.length, 1);
});

test("retune refuses main, unknown agents and still-spawning reservations", async () => {
	const e = new Engine(caps);
	e.addAgent(mainRecord());
	e.reserve("pending", "main"); // reservation has no reconfigure until attach
	assert.match(((await e.retune("main", "main", { thinkingLevel: "high" })) as { reason: string }).reason, /cannot retune 'main'/);
	assert.match(((await e.retune("main", "ghost", { thinkingLevel: "high" })) as { reason: string }).reason, /unknown agent/);
	assert.match(((await e.retune("main", "pending", { thinkingLevel: "high" })) as { reason: string }).reason, /still spawning/);
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
	const r = await e.retune("main", "w", { thinkingLevel: "high" });
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

	assert.deepEqual(e.pause("main", ["a"]).affected, ["a"]);
	assert.deepEqual(e.pausedAgents(), ["a"]);
	assert.equal(e.recordTurnStart("a").abort, true);
	assert.equal(e.recordTurnStart("b").abort, false);
	assert.deepEqual(await e.route("main", "a", "hi"), { outcome: "buffered" });
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
	assert.deepEqual(e.pause("main").affected, ["a"]);
	assert.equal(e.get("main")?.paused, undefined);
	const event = e.events.at(-1) as { type: string; names: string[] };
	assert.deepEqual({ type: event.type, names: event.names }, { type: "pause", names: ["a"] });
	assert.deepEqual(e.pause("main", ["a"]).affected, [], "an already paused agent is not reported as newly paused");
});

test("resume(names) releases only those agents", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5 });
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
	e.recordTurnStart("a");
	e.pause("main");

	assert.deepEqual(released(await e.resume("main", ["a"])), { affected: ["a"], interrupted: [], bufferedMessages: 0 });
	assert.equal(e.get("a")?.turns, 1, "per-agent turn telemetry survives a resume");
	assert.equal(e.get("a")?.paused, false);
	assert.equal(e.get("b")?.paused, true, "unnamed agents stay paused");
	assert.equal(e.get("b")?.pausedMidTurn, true);
	assert.deepEqual(e.pausedAgents(), ["b"]);
	const event = e.events.at(-1) as { type: string; names: string[] };
	assert.deepEqual({ type: event.type, names: event.names }, { type: "resume", names: ["a"] });

	await e.route("main", "a", "back to work");
	assert.deepEqual(delivered, [createRoutedAgentMessage("main", "back to work")]);
	assert.deepEqual(
		released(await e.resume("main", ["ghost"])),
		{ affected: [], interrupted: [], bufferedMessages: 0 },
		"unknown names resume nothing",
	);
});

test("resume() without names clears every pause", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	e.addAgent({ ...mainRecord(), name: "b", depth: 1 });
	e.pause("main");
	assert.deepEqual(released(await e.resume("main")), { affected: ["a", "b"], interrupted: [], bufferedMessages: 0 });
	assert.deepEqual(e.pausedAgents(), []);
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
	e.pause("main", ["a"]);
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
	e.pause("main", ["a"]);
	const before = e.events.length;
	assert.deepEqual(e.pause("main", ["a"]).affected, []); // already paused
	assert.deepEqual(e.pause("main", ["typo"]).affected, []); // unknown name
	assert.equal(e.events.length, before, "the feed must not show a pause that did not happen");
});

test("a reservation that completes while paused parks its buffer instead of delivering it", async () => {
	const e = new Engine(caps);
	const delivered: RoutedAgentMessage[] = [];
	e.addAgent(mainRecord());
	e.reserve("late", "main");
	await e.route("main", "late", "before the pause"); // buffered in the reservation
	e.pause("main", ["late"]);
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
	await e.resume("main", ["late"]);
	assert.equal(delivered.length, 1); // released as one ordered batch
});

test("deliverUser refuses 'main': the human is already typing in that chat", async () => {
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
	await e.kill("main", ["doomed"]);
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

test("statusOf reports a paused agent as paused", () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	assert.deepEqual(e.statusOf("a"), { kind: "idle" });
	e.pause("main", ["a"]);
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
	e.pause("main", ["slow"]); // pause lands while the handle is still delivering
	release?.();
	// The session already has the message, so calling it "buffered" would be a lie.
	assert.deepEqual(await routed, { outcome: "delivered" });
	assert.equal(e.get("slow")?.pausedInbox, undefined);
});

// ── derived pause: an agent is paused while it or any ancestor carries its own flag ──

/** main -> a -> b -> c, each recording what its handle is handed. */
function chain() {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 5 });
	const delivered: Record<string, RoutedAgentMessage[]> = { a: [], b: [], c: [] };
	e.addAgent(mainRecord());
	for (const [name, parent, depth] of [["a", "main", 1], ["b", "a", 2], ["c", "b", 3]] as const) {
		e.addAgent({
			...mainRecord(),
			name,
			spawnedBy: parent,
			depth,
			handle: {
				deliver: async (message) => {
					delivered[name]?.push(message);
				},
				abort: async () => {},
			},
		});
	}
	return { e, delivered };
}

test("pausing an agent holds its whole subtree and reports every agent that stopped", async () => {
	const { e, delivered } = chain();
	e.setActivity("b", "tool", "bash");
	assert.deepEqual(e.pause("main", ["a"]).affected, ["a", "b", "c"], "the caller aborts the whole subtree");
	assert.equal(e.get("c")?.paused, undefined, "only the named agent carries its own flag");
	assert.deepEqual(e.pausedAgents(), ["a", "b", "c"]);
	assert.equal(e.get("b")?.pausedMidTurn, true, "a mid-turn descendant is marked for re-triggering");
	assert.equal(e.get("c")?.pausedMidTurn, undefined);
	assert.equal(e.recordTurnStart("c").abort, true);
	assert.deepEqual(await e.route("main", "c", "hold"), { outcome: "buffered" });
	assert.deepEqual(delivered.c, []);
	assert.deepEqual(e.statusOf("c"), { kind: "paused" });
	assert.deepEqual(e.status(e.get("c")!), { kind: "paused" });
	const event = e.events.filter((ev) => ev.type === "pause").at(-1) as { names: string[] };
	assert.deepEqual(event.names, ["a"], "the event names the flag that changed");
});

test("resuming an ancestor releases every descendant it held, each inbox as one batch", async () => {
	const { e, delivered } = chain();
	e.setActivity("b", "thinking");
	e.pause("main", ["a"]);
	e.endTurn("b"); // the aborted turn ends
	await e.route("main", "c", "one");
	await e.route("b", "c", "two");
	assert.deepEqual(released(await e.resume("main", ["a"])), { affected: ["a", "b", "c"], interrupted: ["b"], bufferedMessages: 2 });
	assert.deepEqual(delivered.c, [{ parts: [{ from: "main", content: "one" }, { from: "b", content: "two" }] }]);
	assert.equal(e.get("b")?.pausedMidTurn, false);
	assert.deepEqual(e.pausedAgents(), []);
});

test("an agent paused by its own parent stays paused across an ancestor's pause and resume", async () => {
	const { e, delivered } = chain();
	assert.deepEqual(e.pause("main", ["b"]).affected, ["b", "c"]);
	assert.deepEqual(e.pause("main", ["a"]).affected, ["a"], "b and c were already stopped");
	await e.route("main", "c", "later");
	assert.deepEqual(released(await e.resume("main", ["a"])), { affected: ["a"], interrupted: [], bufferedMessages: 0 });
	assert.deepEqual(e.pausedAgents(), ["b", "c"], "b's own flag still holds b and c");
	assert.deepEqual(delivered.c, []);
	assert.deepEqual(released(await e.resume("main", ["b"])), { affected: ["b", "c"], interrupted: [], bufferedMessages: 1 });
	assert.deepEqual(delivered.c, [{ parts: [{ from: "main", content: "later" }] }]);
});

test("resuming a descendant an ancestor still holds clears its flag but releases nothing", async () => {
	const { e, delivered } = chain();
	e.pause("main", ["b"]);
	e.pause("main", ["a"]);
	await e.route("main", "b", "wait");
	assert.deepEqual(released(await e.resume("main", ["b"])), { affected: [], interrupted: [], bufferedMessages: 0 });
	assert.equal(e.get("b")?.paused, false);
	assert.deepEqual(e.pausedAgents(), ["a", "b", "c"], "a still holds its subtree");
	assert.equal(e.events.at(-1)?.type, "resume", "a cleared flag is a change worth reporting");
	assert.deepEqual(delivered.b, []);
	assert.equal(e.get("b")?.pausedInbox?.length, 1, "the inbox waits for the agent to run again");
	assert.deepEqual((await e.resume("main", ["a"])).affected, ["a", "b", "c"]);
	assert.equal(delivered.b.length, 1);
});

test("an agent spawned under a paused ancestor comes up paused", async () => {
	const { e } = chain();
	e.pause("main", ["a"]);
	assert.equal(e.reserve("d", "b").ok, true);
	await e.route("b", "d", "first task");
	const handed: RoutedAgentMessage[] = [];
	e.attach("d", {
		model: "test/m",
		handle: {
			deliver: async (message) => {
				handed.push(message);
			},
			abort: async () => {},
		},
	});
	assert.deepEqual(handed, [], "the reservation buffer joins the paused inbox instead");
	assert.equal(e.recordTurnStart("d").abort, true);
	assert.deepEqual((await e.resume("main", ["a"])).affected, ["a", "b", "c", "d"]);
	assert.deepEqual(handed, [{ parts: [{ from: "b", content: "first task" }] }]);
});

test("the spawn tree is derived from the live records", async () => {
	// chain() registers through addAgent, the restore path, so restored parents are covered too.
	const { e } = chain();
	assert.deepEqual(e.getSpawnTree(), { a: "main", b: "a", c: "b" });
	assert.equal(errorNotification({ name: "c", reason: "boom" }, e.getSpawnTree(), e.liveNames())?.to, "b");
	await e.kill("main", ["b"]);
	assert.deepEqual(e.getSpawnTree(), { a: "main" }, "killed agents leave no stale parent entries");
});

// ── authority: who spawns, owns ──

test("control operations reach only the acting agent's strict descendants", async () => {
	const { e } = chain(); // main -> a -> b -> c
	e.addAgent({ ...mainRecord(), name: "peer", depth: 1 });
	const refused = (name: string) => ({ target: name, ok: false, reason: `'${name}' is not in your subtree` });
	assert.deepEqual(e.pause("b", ["a", "b", "peer", "main"]).results, [refused("a"), refused("b"), refused("peer"), refused("main")]);
	assert.deepEqual(e.pause("b", ["ghost"]).results, [{ target: "ghost", ok: false, reason: "unknown agent 'ghost'" }]);
	assert.deepEqual(e.pausedAgents(), [], "a refused pause changes nothing");
	assert.deepEqual(e.pause("a", ["c"]), { results: [{ target: "c", ok: true }], affected: ["c"] }, "a grandchild is in the subtree");
	assert.deepEqual((await e.resume("peer", ["c"])).results, [refused("c")]);
	assert.deepEqual((await e.kill("b", ["a"])).results, [refused("a")]);
	assert.deepEqual((await e.kill("peer", ["main"])).results, [refused("main")]);
	assert.deepEqual((await e.kill("a", ["b"])).affected, ["c", "b"]);
	assert.deepEqual((await e.kill("main", ["peer"])).affected, ["peer"], "main owns every agent");
});

test("retune reaches the acting agent itself and its descendants", async () => {
	const e = new Engine({ maxAgents: 8, maxSpawnDepth: 5 });
	const tunable = (name: string, spawnedBy: string, depth: number) => ({
		...mainRecord(),
		name,
		spawnedBy,
		depth,
		reconfigure: async () => ({ thinkingLevel: "high" as const }),
	});
	e.addAgent(tunable("a", "main", 1));
	e.addAgent(tunable("b", "a", 2));
	e.addAgent(tunable("peer", "main", 1));
	assert.equal((await e.retune("a", "a", { thinkingLevel: "high" })).ok, true, "self");
	assert.equal((await e.retune("a", "b", { thinkingLevel: "high" })).ok, true, "child");
	assert.deepEqual(await e.retune("b", "a", { thinkingLevel: "high" }), { ok: false, reason: "'a' is not in your subtree" });
	assert.deepEqual(await e.retune("a", "peer", { thinkingLevel: "high" }), { ok: false, reason: "'peer' is not in your subtree" });
});

test("pause and resume without names act on the caller's direct children and leave lower owners' pauses alone", async () => {
	const { e } = chain(); // main -> a -> b -> c
	e.pause("b", ["c"]); // b's own decision about its child
	assert.deepEqual(e.pause("main").affected, ["a", "b"], "a's subtree follows; c was already paused");
	assert.equal(e.get("b")?.paused, undefined, "only the direct child carries main's flag");
	const resumed = await e.resume("main");
	assert.deepEqual(resumed.results, [{ target: "a", ok: true }]);
	assert.deepEqual(resumed.affected, ["a", "b"]);
	assert.deepEqual(e.pausedAgents(), ["c"], "the pause b set is b's to lift");
	assert.deepEqual(e.pause("c").results, [], "an agent without children has nothing to pause");
});

test("a resumed target still held by an ancestor says so", async () => {
	const { e } = chain();
	e.pause("a", ["b"]);
	e.pause("main", ["a"]);
	assert.deepEqual((await e.resume("a", ["b"])).results, [{ target: "b", ok: true, reason: "still paused by 'a'" }]);
});

test("resume waits for a pause's abort to finish before the agent runs again", async () => {
	const e = new Engine(caps);
	const log: string[] = [];
	let finishAbort: (() => void) | undefined;
	e.addAgent({
		...mainRecord(),
		name: "w",
		depth: 1,
		activity: "tool",
		handle: {
			deliver: async () => {
				log.push("delivered");
			},
			// A slow abort, like a bash cancellation that takes a while.
			abort: () =>
				new Promise<void>((resolve) => {
					finishAbort = () => {
						log.push("aborted");
						resolve();
					};
				}),
		},
	});
	e.pause("main", ["w"]);
	await e.route("main", "w", "correction");
	const resumed = e.resume("main", ["w"]);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(log, [], "nothing is released while the abort is still running");
	// The resume already took effect in call order; only its side effects wait.
	assert.deepEqual(e.pausedAgents(), []);
	// A message arriving meanwhile waits too: a live delivery would start a turn the late abort kills.
	assert.deepEqual(await e.route("main", "w", "meanwhile"), { outcome: "buffered" });
	assert.equal(e.recordTurnStart("w").abort, true, "no turn starts while our abort is in flight");
	finishAbort?.();
	assert.deepEqual((await resumed).affected, ["w"]);
	assert.deepEqual(log, ["aborted", "delivered"], "the late abort cannot hit the resumed turn");
});

test("a failing pause abort is reported as an agent error, not thrown", async () => {
	const e = new Engine(caps);
	e.addAgent({
		...mainRecord(),
		name: "w",
		depth: 1,
		handle: { deliver: async () => {}, abort: async () => Promise.reject(new Error("stuck")) },
	});
	e.pause("main", ["w"]);
	await e.resume("main", ["w"]);
	const error = e.events.find((ev) => ev.type === "error") as { reason: string } | undefined;
	assert.equal(error?.reason, "abort failed: stuck");
});

test("a slow abort elsewhere does not hold up an unrelated resume", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	// b's abort never finishes.
	e.addAgent({ ...mainRecord(), name: "b", depth: 1, handle: { deliver: async () => {}, abort: () => new Promise<void>(() => {}) } });
	e.pause("main", ["a", "b"]);
	const resumed = await Promise.race([
		e.resume("main", ["a"]),
		new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
	]);
	assert.notEqual(resumed, "hung");
	assert.deepEqual(e.pausedAgents(), ["b"]);
});

test("a slow abort under a lower owner's own pause does not hold up the ancestor's resume", async () => {
	const e = new Engine({ maxAgents: 5, maxSpawnDepth: 5 });
	e.addAgent({ ...mainRecord(), name: "a", depth: 1 });
	// b's abort never finishes; b stays paused by its own flag after a resumes.
	e.addAgent({
		...mainRecord(),
		name: "b",
		spawnedBy: "a",
		depth: 2,
		handle: { deliver: async () => {}, abort: () => new Promise<void>(() => {}) },
	});
	e.pause("a", ["b"]);
	e.pause("main", ["a"]);
	const resumed = await Promise.race([
		e.resume("main", ["a"]),
		new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
	]);
	assert.notEqual(resumed, "hung");
	assert.deepEqual(e.pausedAgents(), ["b"]);
});

test("a pause issued right after a resume wins, and its abort is not undone", async () => {
	const e = new Engine(caps);
	e.addAgent({ ...mainRecord(), name: "a", depth: 1, handle: { deliver: async () => {}, abort: () => new Promise<void>(() => {}) } });
	const resumed = e.resume("main", ["a"]); // a is live: nothing to wait for, decided at once
	e.pause("main", ["a"]); // same tick, its abort never finishes
	assert.deepEqual((await resumed).affected, []);
	assert.deepEqual(e.pausedAgents(), ["a"], "call order holds: resume, then pause");
});

test("a pause racing an in-flight resume wins in call order", async () => {
	// The live repro: pause, resume, pause issued together while beta's bash abort takes seconds.
	const e = new Engine(caps);
	const delivered: RoutedAgentMessage[] = [];
	const aborts: (() => void)[] = [];
	e.addAgent({
		...mainRecord(),
		name: "beta",
		depth: 1,
		activity: "tool",
		handle: {
			deliver: async (message) => {
				delivered.push(message);
			},
			abort: () => new Promise<void>((resolve) => aborts.push(resolve)),
		},
	});
	assert.deepEqual(e.pause("main", ["beta"]).affected, ["beta"]);
	await e.route("main", "beta", "buffered while paused");
	const resumed = e.resume("main", ["beta"]);
	assert.deepEqual(e.pause("main", ["beta"]).affected, ["beta"], "the resume already cleared the flag: this pause acts");
	for (const finish of aborts) finish();
	const result = await resumed;
	assert.deepEqual(result.affected, ["beta"], "the resume happened, before the pause");
	assert.deepEqual({ interrupted: result.interrupted, bufferedMessages: result.bufferedMessages }, { interrupted: [], bufferedMessages: 0 });
	assert.deepEqual(e.pausedAgents(), ["beta"], "the last call was a pause");
	assert.deepEqual(delivered, [], "the paused agent keeps its inbox");
	assert.equal(e.get("beta")?.pausedInbox?.length, 1);
	assert.equal(e.get("beta")?.pausedMidTurn, true, "its interrupted work is still marked for the next resume");
	const next = await e.resume("main", ["beta"]);
	assert.deepEqual({ interrupted: next.interrupted, bufferedMessages: next.bufferedMessages }, { interrupted: ["beta"], bufferedMessages: 1 });
});

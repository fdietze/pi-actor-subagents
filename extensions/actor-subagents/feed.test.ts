import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatSnapshot,
	normalizeTargets,
	formatMulticastResult,
	formatResumeResult,
	formatControlResult,
} from "./feed.ts";
import { type AgentStatus, agentStatus } from "./agent-status.ts";
import type { AgentRecord, Reaction } from "./engine.ts";
import type { OrderedAgent } from "./agent-order.ts";

const rec = (over: Partial<AgentRecord>): AgentRecord => ({
	name: "a",
	model: "anthropic/x",
	handle: { deliver: async () => {}, abort: async () => {} },
	spawnedBy: "main",
	depth: 1,
	createdAt: 0,
	turns: 0,
	lastActivity: 0,
	...over,
});

// formatSnapshot consumes the spawn-tree order; these tests supply it as main + one level of
// children, which is what orderAgents produces for a flat swarm.
const flat = (agents: AgentRecord[]): OrderedAgent<AgentRecord>[] =>
	agents.map((agent) => ({ agent, depth: agent.name === "main" ? 0 : 1 }));
const snapshot = (agents: AgentRecord[], viewer: string, now?: number): string =>
	formatSnapshot(flat(agents), viewer, agentStatus, now);

test("formatSnapshot lists each agent with status and turns", () => {
	const agents = [
		rec({ name: "main", depth: 0, model: "anthropic/opus" }),
		rec({ name: "coder", activity: "thinking", turns: 4 }),
	];
	const out = snapshot(agents, "main");
	assert.match(out, /main/);
	assert.match(out, /coder/);
	assert.match(out, /thinking/); // mid-turn, opening phase
	assert.match(out, /idle/);
	assert.match(out, /turns:4/);
});

test("formatSnapshot keeps columns aligned when one status is long", () => {
	const agents = [
		rec({ name: "a", turns: 1 }),
		rec({ name: "b", activity: "thinking", customStatus: "running the whole test suite", etaTs: 0 }),
	];
	const lines = snapshot(agents, "main").split("\n").slice(1);
	// The ETA must survive (it is the point of the column) and 'turns:' must start at one column.
	assert.match(lines[1], /ETA ~/);
	assert.equal(lines[0].indexOf("turns:"), lines[1].indexOf("turns:"));
});

test("formatSnapshot does not invent a turn count or a spawner for main", () => {
	// main's turns are pi's own, not the engine's, and it has no spawner; "turns:0 (by main)" would lie.
	const out = snapshot([rec({ name: "main", depth: 0 })], "main");
	assert.match(out, /turns:-/);
	assert.match(out, /\(foreground\)/);
	assert.doesNotMatch(out, /\(by main\)/);
});

test("formatSnapshot shows model and effective thinking level together", () => {
	const out = snapshot(
		[rec({ name: "scout", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh" })],
		"main",
	);
	assert.match(out, /openai-codex\/gpt-5\.6-sol@xhigh/);
});

test("formatSnapshot appends the agent-set custom status after the system status", () => {
	const agents = [rec({ name: "coder", customStatus: "parsing files" })];
	const out = snapshot(agents, "main");
	assert.match(out, /idle · parsing files/);
});

test("formatSnapshot renders the ETA as absolute clock time after the custom status", () => {
	const now = new Date();
	now.setHours(15, 0, 0, 0);
	const agents = [rec({ name: "coder", customStatus: "running tests", etaTs: now.getTime() + 20 * 60000 })];
	const out = snapshot(agents, "main", now.getTime());
	assert.match(out, /idle · running tests · ETA ~15:20/);
});

test("formatSnapshot omits the ETA when etaTs is unset", () => {
	const out = snapshot([rec({ name: "coder", customStatus: "running tests" })], "main");
	assert.doesNotMatch(out, /ETA/);
});

test("formatSnapshot renders fine-grained activity (writing / tool:name)", () => {
	const agents = [
		rec({ name: "w", activity: "writing" }),
		rec({ name: "t", activity: "tool", currentTool: "bash" }),
	];
	const out = snapshot(agents, "main");
	assert.match(out, /writing/);
	assert.match(out, /tool:bash/);
});

test("formatSnapshot shows pending agents as spawning (not idle) with queue count", () => {
	const agents = [
		rec({
			name: "coder",
			pending: true,
			buffer: [{ parts: [{ from: "main", content: "a" }] }, { parts: [{ from: "main", content: "b" }] }],
		}),
	];
	const out = snapshot(agents, "main");
	assert.match(out, /spawning/);
	assert.doesNotMatch(out, /idle/);
	assert.match(out, /2 queued/);
});

test("formatSnapshot marks relation to the viewer", () => {
	// tree: main -> lead -> worker ; viewer = lead
	const agents = [
		rec({ name: "main", depth: 0, spawnedBy: "main" }),
		rec({ name: "lead", spawnedBy: "main" }),
		rec({ name: "sibling", spawnedBy: "main" }),
		rec({ name: "worker", spawnedBy: "lead" }),
	];
	const out = snapshot(agents, "lead");
	assert.match(out, /lead .*self/);
	assert.match(out, /main .*parent/);
	assert.match(out, /sibling .*peer/);
	assert.match(out, /worker .*child/);
});

test("formatSnapshot shows context percent and relative age", () => {
	const withCtx = rec({
		name: "coder",
		lastActivity: 5_000,
		view: {
			getMessages: () => [],
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 42 }),
			subscribe: () => () => {},
		},
	});
	const out = snapshot([withCtx], "main", 10_000);
	assert.match(out, /ctx:42%/);
	assert.match(out, /last 5s/);
});

test("normalizeTargets: dedupe, trim, drop empty", () => {
	assert.deepEqual(normalizeTargets(["echo"]), ["echo"]);
	assert.deepEqual(normalizeTargets(["echo", "planner"]), ["echo", "planner"]);
	assert.deepEqual(normalizeTargets(["a", "a", " b ", ""]), ["a", "b"]);
	assert.deepEqual(normalizeTargets(["main", "critic", "main"]), ["main", "critic"]);
});

test("formatMulticastResult distinguishes delivered, paused-buffered, and failed routes", () => {
	assert.equal(
		formatMulticastResult([
			{ target: "a", outcome: "delivered", reaction: { observed: "moving", status: { kind: "working", phase: "thinking" } } },
		]),
		"sent to a (thinking)",
	);
	assert.equal(
		formatMulticastResult([
			{
				target: "a",
				outcome: "delivered",
				reaction: { observed: "moving", status: { kind: "working", phase: "tool", tool: "bash" } },
			},
			{ target: "b", outcome: "buffered" },
			{ target: "x", outcome: "failed", reason: "unknown agent 'x'" },
		]),
		"sent to a (tool:bash) · buffered for b (paused) · failed: x: unknown agent 'x'",
	);
	assert.equal(formatMulticastResult([]), "error: no targets");
});

test("formatMulticastResult reports each receiver state a delivered message can land in", () => {
	const sentTo = (reaction: Reaction) => formatMulticastResult([{ target: "a", outcome: "delivered", reaction }]);
	const unmoved = (status: AgentStatus): Reaction => ({ observed: "unmoved", status });
	// Only an elapsed window with a still-idle agent earns the "no reaction" annotation: that gap
	// is the signal the sender needs, and claiming it anywhere else would be a false alarm.
	assert.equal(sentTo(unmoved({ kind: "idle" })), "sent to a (idle (no reaction))");
	assert.equal(sentTo(unmoved({ kind: "idle", outcome: "error" })), "sent to a (error)");
	assert.equal(sentTo(unmoved({ kind: "paused" })), "sent to a (paused)"); // paused mid-window
	assert.equal(sentTo({ observed: "unwatched", status: { kind: "idle" } }), "sent to a (idle)");
	assert.equal(sentTo({ observed: "moving", status: { kind: "idle", outcome: "truncated" } }), "sent to a (truncated)");
	assert.equal(sentTo({ observed: "moving", status: { kind: "spawning" } }), "sent to a (spawning)");
	assert.equal(sentTo({ observed: "moving", status: { kind: "working", phase: "writing" } }), "sent to a (writing)");
	// Delivered, then killed while we watched: the message's fate and the agent's fate differ.
	assert.equal(sentTo({ observed: "gone" }), "sent to a (gone)");
});

test("formatResumeResult reports what changed, released and retriggered, then notes and refusals", () => {
	const ok = (target: string, reason?: string) => ({ target, ok: true, ...(reason ? { reason } : {}) });
	assert.equal(
		formatResumeResult({ results: [ok("a")], affected: ["a", "b"], interrupted: ["b"], bufferedMessages: 2 }),
		"resumed a, b · released 2 buffered messages · retriggered 1 interrupted agent",
	);
	// Nothing set running: reporting zeros would claim work that did not happen.
	assert.equal(
		formatResumeResult({
			results: [ok("b", "still paused by 'a'"), { target: "x", ok: false, reason: "'x' is not in your subtree" }],
			affected: [],
			interrupted: [],
			bufferedMessages: 0,
		}),
		"nothing resumed · b: still paused by 'a' · failed: x: 'x' is not in your subtree",
	);
	assert.equal(formatControlResult("pause", { results: [], affected: [] }), "no agents to pause");
	assert.equal(formatControlResult("pause", { results: [ok("a")], affected: ["a", "b"] }), "paused a, b");
});

test("formatControlResult reports a kill's whole cascade and its refusals", () => {
	assert.equal(
		formatControlResult("kill", {
			results: [{ target: "parent", ok: true }, { target: "x", ok: false, reason: "'x' is not in your subtree" }],
			affected: ["grandchild", "child", "parent"],
		}),
		"killed grandchild, child, parent · failed: x: 'x' is not in your subtree",
	);
});

test("formatSnapshot indents each agent by its spawn-tree depth", () => {
	const out = formatSnapshot(
		[
			{ agent: rec({ name: "main", depth: 0 }), depth: 0 },
			{ agent: rec({ name: "lead" }), depth: 1 },
			{ agent: rec({ name: "helper", spawnedBy: "lead" }), depth: 2 },
		],
		"main",
		agentStatus,
	).split("\n");
	assert.match(out[1], /^ {2}main /);
	assert.match(out[2], /^ {3}lead /);
	assert.match(out[3], /^ {4}helper /);
});

test("formatSnapshot keeps the columns aligned across indent levels", () => {
	const rows = formatSnapshot(
		[
			{ agent: rec({ name: "main", depth: 0 }), depth: 0 },
			{ agent: rec({ name: "deep", spawnedBy: "lead" }), depth: 3 },
		],
		"main",
		agentStatus,
	).split("\n").slice(1);
	assert.equal(rows[0].indexOf("turns:"), rows[1].indexOf("turns:"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatSnapshot,
	normalizeTargets,
	formatMulticastResult,
	formatKillResult,
	formatResumeSummary,
} from "./feed.ts";
import type { AgentStatus } from "./agent-status.ts";
import type { AgentRecord, PauseReason, Reaction } from "./engine.ts";

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

test("formatSnapshot lists each agent with status and turns", () => {
	const agents = [
		rec({ name: "main", depth: 0, model: "anthropic/opus" }),
		rec({ name: "coder", activity: "thinking", turns: 4 }),
	];
	const out = formatSnapshot(agents, "main");
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
	const lines = formatSnapshot(agents, "main").split("\n").slice(1);
	// The ETA must survive (it is the point of the column) and 'turns:' must start at one column.
	assert.match(lines[1], /ETA ~/);
	assert.equal(lines[0].indexOf("turns:"), lines[1].indexOf("turns:"));
});

test("formatSnapshot does not invent a turn count or a spawner for main", () => {
	// main's turns are pi's own, not the engine's, and it has no spawner; "turns:0 (by main)" would lie.
	const out = formatSnapshot([rec({ name: "main", depth: 0 })], "main");
	assert.match(out, /turns:-/);
	assert.match(out, /\(foreground\)/);
	assert.doesNotMatch(out, /\(by main\)/);
});

test("formatSnapshot exposes the paused scheduler and buffering behavior", () => {
	const out = formatSnapshot([rec({ name: "scout" })], "main", true);
	assert.match(out, /PAUSED/);
	assert.match(out, /messages are buffering/);
	assert.match(out, /subagents-resume/);
});

test("formatSnapshot shows model and effective thinking level together", () => {
	const out = formatSnapshot(
		[rec({ name: "scout", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh" })],
		"main",
	);
	assert.match(out, /openai-codex\/gpt-5\.6-sol@xhigh/);
});

test("formatSnapshot appends the agent-set custom status after the system status", () => {
	const agents = [rec({ name: "coder", customStatus: "parsing files" })];
	const out = formatSnapshot(agents, "main");
	assert.match(out, /idle · parsing files/);
});

test("formatSnapshot renders the ETA as absolute clock time after the custom status", () => {
	const now = new Date();
	now.setHours(15, 0, 0, 0);
	const agents = [rec({ name: "coder", customStatus: "running tests", etaTs: now.getTime() + 20 * 60000 })];
	const out = formatSnapshot(agents, "main", false, now.getTime());
	assert.match(out, /idle · running tests · ETA ~15:20/);
});

test("formatSnapshot omits the ETA when etaTs is unset", () => {
	const out = formatSnapshot([rec({ name: "coder", customStatus: "running tests" })], "main");
	assert.doesNotMatch(out, /ETA/);
});

test("formatSnapshot renders fine-grained activity (writing / tool:name)", () => {
	const agents = [
		rec({ name: "w", activity: "writing" }),
		rec({ name: "t", activity: "tool", currentTool: "bash" }),
	];
	const out = formatSnapshot(agents, "main");
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
	const out = formatSnapshot(agents, "main");
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
	const out = formatSnapshot(agents, "lead");
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
	const out = formatSnapshot([withCtx], "main", false, 10_000);
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
			{ target: "b", outcome: "buffered", reason: "manual" },
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

test("formatMulticastResult names the pause cause that parked a message", () => {
	const buffered = (reason: PauseReason) => formatMulticastResult([{ target: "a", outcome: "buffered", reason }]);
	assert.equal(buffered("manual"), "buffered for a (paused)");
	assert.equal(buffered("restored"), "buffered for a (paused after restore)");
});

test("formatResumeSummary reports released buffer and retriggers, or why nothing happened", () => {
	assert.equal(
		formatResumeSummary({ wasPaused: true, bufferedMessages: 2, retriggered: 1 }),
		"agents resumed · released 2 buffered messages · retriggered 1 interrupted agent",
	);
	// A live swarm is not resumed at all: reporting zeros would claim work that did not happen.
	assert.equal(
		formatResumeSummary({ wasPaused: false, bufferedMessages: 0, retriggered: 0 }),
		"agents already live · nothing to resume",
	);
	assert.equal(
		formatResumeSummary({ wasPaused: true, bufferedMessages: 0, retriggered: 0 }),
		"agents resumed · released 0 buffered messages · retriggered 0 interrupted agents",
	);
	// A named resume cannot lift the swarm-wide restored pause; say what actually helps.
	assert.match(
		formatResumeSummary({ wasPaused: false, bufferedMessages: 0, retriggered: 0, blockedByRestoredPause: true }),
		/paused after restore · \/subagents-resume without names/,
	);
});

test("formatKillResult names cascaded descendants, not just the named target", () => {
	assert.equal(
		formatKillResult([{ target: "parent", ok: true, killed: ["grandchild", "child", "parent"] }]),
		"killed parent (+grandchild, child)",
	);
	// A leaf kill stays plain: nothing extra came down with it.
	assert.equal(formatKillResult([{ target: "leaf", ok: true, killed: ["leaf"] }]), "killed leaf");
});

test("formatKillResult: killed + failed split", () => {
	assert.equal(formatKillResult([{ target: "a", ok: true }]), "killed a");
	assert.equal(
		formatKillResult([
			{ target: "a", ok: true },
			{ target: "main", ok: false, reason: "cannot kill 'main'" },
		]),
		"killed a · failed: main: cannot kill 'main'",
	);
	assert.equal(formatKillResult([]), "error: no targets");
});

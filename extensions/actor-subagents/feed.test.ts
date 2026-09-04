import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatSnapshot,
	formatFeedLines,
	normalizeTargets,
	formatMulticastResult,
	formatKillResult,
	formatResumeSummary,
} from "./feed.ts";
import type { AgentRecord, AgentEvent } from "./engine.ts";

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
	const out = formatSnapshot(agents, 4, 100, "main");
	assert.match(out, /main/);
	assert.match(out, /coder/);
	assert.match(out, /thinking/); // mid-turn, opening phase
	assert.match(out, /idle/);
	assert.match(out, /4/);
});

test("formatSnapshot keeps columns aligned when one status is long", () => {
	const agents = [
		rec({ name: "a", turns: 1 }),
		rec({ name: "b", activity: "thinking", customStatus: "running the whole test suite", etaTs: 0 }),
	];
	const lines = formatSnapshot(agents, 0, 100, "main").split("\n").slice(1);
	// The ETA must survive (it is the point of the column) and 'turns:' must start at one column.
	assert.match(lines[1], /ETA ~/);
	assert.equal(lines[0].indexOf("turns:"), lines[1].indexOf("turns:"));
});

test("formatSnapshot does not invent a turn count or a spawner for main", () => {
	// main runs outside the background turn budget and has no spawner; "turns:0 (by main)" would lie.
	const out = formatSnapshot([rec({ name: "main", depth: 0 })], 0, 100, "main");
	assert.match(out, /turns:-/);
	assert.match(out, /\(foreground\)/);
	assert.doesNotMatch(out, /\(by main\)/);
});

test("formatSnapshot exposes the paused scheduler and buffering behavior", () => {
	const out = formatSnapshot([rec({ name: "scout" })], 0, 100, "main", true);
	assert.match(out, /PAUSED/);
	assert.match(out, /messages are buffering/);
	assert.match(out, /agents-resume/);
});

test("formatSnapshot shows model and effective thinking level together", () => {
	const out = formatSnapshot(
		[rec({ name: "scout", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh" })],
		0,
		100,
		"main",
	);
	assert.match(out, /openai-codex\/gpt-5\.6-sol@xhigh/);
});

test("formatSnapshot appends the agent-set custom status after the system status", () => {
	const agents = [rec({ name: "coder", customStatus: "parsing files" })];
	const out = formatSnapshot(agents, 0, 100, "main");
	assert.match(out, /idle · parsing files/);
});

test("formatSnapshot renders the ETA as absolute clock time after the custom status", () => {
	const now = new Date();
	now.setHours(15, 0, 0, 0);
	const agents = [rec({ name: "coder", customStatus: "running tests", etaTs: now.getTime() + 20 * 60000 })];
	const out = formatSnapshot(agents, 0, 100, "main", false, now.getTime());
	assert.match(out, /idle · running tests · ETA ~15:20/);
});

test("formatSnapshot omits the ETA when etaTs is unset", () => {
	const out = formatSnapshot([rec({ name: "coder", customStatus: "running tests" })], 0, 100, "main");
	assert.doesNotMatch(out, /ETA/);
});

test("formatSnapshot renders fine-grained activity (writing / tool:name)", () => {
	const agents = [
		rec({ name: "w", activity: "writing" }),
		rec({ name: "t", activity: "tool", currentTool: "bash" }),
	];
	const out = formatSnapshot(agents, 0, 100, "main");
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
	const out = formatSnapshot(agents, 0, 100, "main");
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
	const out = formatSnapshot(agents, 0, 100, "lead");
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
	const out = formatSnapshot([withCtx], 0, 100, "main", false, 10_000);
	assert.match(out, /ctx:42%/);
	assert.match(out, /last 5s/);
});

test("formatFeedLines renders one line per event newest-aware", () => {
	const events: AgentEvent[] = [
		{ type: "spawn", name: "coder", by: "main", ts: 0 },
		{ type: "route", from: "main", to: "coder", preview: "do x", buffered: false, ts: 0 },
		{ type: "pause", reason: "manual", names: [], ts: 0 },
		{ type: "error", name: "coder", reason: "boom", ts: 0 },
	];
	const lines = formatFeedLines(events);
	assert.equal(lines.length, 4);
	assert.match(lines[0], /spawn.*coder/);
	assert.match(lines[1], /main.*->.*coder/);
	assert.match(lines[2], /pause.*manual/i);
	assert.match(lines[3], /error.*coder.*boom/);
	assert.doesNotMatch(lines[1], /buffered/);
});

test("formatFeedLines names the agents of a per-agent pause/resume", () => {
	const lines = formatFeedLines([
		{ type: "pause", reason: "manual", names: ["coder", "tester"], ts: 0 },
		{ type: "resume", names: ["coder"], ts: 0 },
		{ type: "resume", names: [], ts: 0 },
	]);
	assert.match(lines[0], /pause\s+coder, tester \(manual\)/);
	assert.match(lines[1], /resume\s+coder/);
	assert.match(lines[2], /swarm live/);
});

test("formatFeedLines does not present main as spawned by itself", () => {
	const lines = formatFeedLines([{ type: "spawn", name: "main", by: "main", ts: 0 }]);
	assert.equal(lines[0], "start   main (foreground)");
});

test("formatFeedLines marks a buffered route so a paused swarm never looks delivered", () => {
	const lines = formatFeedLines([
		{ type: "route", from: "main", to: "coder", preview: "do x", buffered: true, ts: 0 },
	]);
	assert.match(lines[0], /main -> coder \(buffered\): do x/);
});

test("normalizeTargets: dedupe, trim, drop empty", () => {
	assert.deepEqual(normalizeTargets(["echo"]), ["echo"]);
	assert.deepEqual(normalizeTargets(["echo", "planner"]), ["echo", "planner"]);
	assert.deepEqual(normalizeTargets(["a", "a", " b ", ""]), ["a", "b"]);
	assert.deepEqual(normalizeTargets(["main", "critic", "main"]), ["main", "critic"]);
});

test("formatMulticastResult distinguishes delivered, paused-buffered, and failed routes", () => {
	assert.equal(formatMulticastResult([{ target: "a", outcome: "delivered" }]), "sent to a");
	assert.equal(
		formatMulticastResult([
			{ target: "a", outcome: "delivered" },
			{ target: "b", outcome: "buffered", reason: "paused" },
			{ target: "x", outcome: "failed", reason: "unknown agent 'x'" },
		]),
		"sent to a · buffered for b (agents paused) · failed: x: unknown agent 'x'",
	);
	assert.equal(formatMulticastResult([]), "error: no targets");
});

test("formatResumeSummary reports scheduler, released buffer, retriggers, and budget", () => {
	assert.equal(
		formatResumeSummary({ wasPaused: true, bufferedMessages: 2, retriggered: 1 }),
		"agents resumed · released 2 buffered messages · retriggered 1 interrupted agent · budget re-armed",
	);
	// A live swarm is not resumed at all: claiming a re-armed budget here would be false.
	assert.equal(
		formatResumeSummary({ wasPaused: false, bufferedMessages: 0, retriggered: 0 }),
		"agents already live · nothing to resume",
	);
	// A named resume cannot lift the swarm-wide budget stop; say what actually helps.
	assert.match(
		formatResumeSummary({ wasPaused: false, bufferedMessages: 0, retriggered: 0, blockedByBudget: true }),
		/turn budget/,
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

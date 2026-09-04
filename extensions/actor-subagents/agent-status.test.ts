import { test } from "node:test";
import assert from "node:assert/strict";
import { agentStatus, formatStatus } from "./agent-status.ts";

test("agentStatus: spawning and paused take precedence over the turn phase", () => {
	assert.deepEqual(agentStatus({ pending: true, activity: "thinking", pausedMidTurn: true }), { kind: "spawning" });
	assert.deepEqual(agentStatus({ pausedMidTurn: true, activity: "tool", currentTool: "bash" }), {
		kind: "paused",
	});
	assert.deepEqual(agentStatus({ activity: "writing" }), {
		kind: "working",
		phase: "writing",
		tool: undefined,
	});
});

test("agentStatus: idle carries the terminal outcome (error/truncated) of the last turn", () => {
	assert.deepEqual(agentStatus({ stopReason: "error" }), { kind: "idle", outcome: "error" });
	assert.deepEqual(agentStatus({ stopReason: "length" }), { kind: "idle", outcome: "truncated" });
	assert.deepEqual(agentStatus({ stopReason: "stop" }), { kind: "idle" });
	assert.deepEqual(agentStatus({ stopReason: "aborted" }), { kind: "idle" });
	assert.deepEqual(agentStatus({}), { kind: "idle" });
	// While streaming, the live phase wins over any stale stopReason.
	assert.deepEqual(agentStatus({ activity: "thinking", stopReason: "error" }), {
		kind: "working",
		phase: "thinking",
		tool: undefined,
	});
});

test("formatStatus renders the roster label for every status", () => {
	assert.equal(formatStatus({ kind: "spawning" }), "spawning");
	assert.equal(formatStatus({ kind: "paused" }), "paused");
	assert.equal(formatStatus({ kind: "working", phase: "thinking" }), "thinking");
	assert.equal(formatStatus({ kind: "working", phase: "writing" }), "writing");
	assert.equal(formatStatus({ kind: "working", phase: "tool", tool: "bash" }), "tool:bash");
	assert.equal(formatStatus({ kind: "working", phase: "tool" }), "tool");
	assert.equal(formatStatus({ kind: "idle" }), "idle");
	assert.equal(formatStatus({ kind: "idle", outcome: "error" }), "error");
	assert.equal(formatStatus({ kind: "idle", outcome: "truncated" }), "truncated");
});

test("a manually paused agent reads as paused, not idle", () => {
	assert.deepEqual(agentStatus({ paused: true }), { kind: "paused" });
	// Spawning still wins: there is no session to pause yet.
	assert.deepEqual(agentStatus({ paused: true, pending: true }), { kind: "spawning" });
});

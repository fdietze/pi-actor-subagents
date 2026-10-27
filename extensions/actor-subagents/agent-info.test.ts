import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInfo } from "./agent-info.ts";
import type { AgentRecord } from "./agent-record.ts";
import { agentStatus } from "./agent-status.ts";

const now = 1_000_000;
const rec = (over: Partial<AgentRecord>): AgentRecord => ({
	name: "w",
	model: "test/m",
	handle: { deliver: async () => {}, abort: async () => {} },
	spawnedBy: "main",
	depth: 1,
	createdAt: 0,
	turns: 0,
	lastActivity: now - 4000,
	...over,
});

test("agentInfo reads usage from the live transcript and the state from the status", () => {
	const view = {
		getMessages: () => [
			{ role: "assistant", timestamp: now - 8000, usage: { cost: { total: 0.5 } } },
			{ role: "user", timestamp: now - 7000 },
			{ role: "assistant", timestamp: now - 6000, usage: { cost: { total: 1.25 } } },
		],
		getContextUsage: () => ({ tokens: 143_000, contextWindow: 200_000, percent: 70 }),
		subscribe: () => () => {},
	};
	const idle = rec({ sessionId: "s1", view: view as never });
	assert.deepEqual(agentInfo(idle, agentStatus(idle), now), {
		name: "w",
		parent: "main",
		sessionId: "s1",
		model: "test/m",
		thinkingLevel: undefined,
		state: "idle",
		idleSinceMs: 4000,
		lastRequestAt: now - 6000,
		contextTokens: 143_000,
		costUsd: 1.75,
		policyMeta: undefined,
	});
	const running = rec({ activity: "tool" });
	assert.equal(agentInfo(running, agentStatus(running), now).state, "running");
	assert.equal(agentInfo(running, agentStatus(running), now).idleSinceMs, undefined);
	const spawning = rec({ pending: true });
	assert.equal(agentInfo(spawning, agentStatus(spawning), now).state, "spawning");
});

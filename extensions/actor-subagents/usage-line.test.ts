import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRecord } from "./agent-record.ts";
import { agentStatus } from "./agent-status.ts";
import { formatSnapshot } from "./feed.ts";

const now = 10_000_000;
const rec = (over: Partial<AgentRecord>): AgentRecord => ({
	name: "w",
	model: "anthropic/x",
	handle: { deliver: async () => {}, abort: async () => {} },
	spawnedBy: "main",
	depth: 1,
	createdAt: 0,
	turns: 3,
	lastActivity: now - 4 * 60_000,
	...over,
});
const view = (lastRequestAgoMs: number, tokens: number | null, cost: number) => ({
	getMessages: () => [{ role: "assistant", timestamp: now - lastRequestAgoMs, usage: { cost: { total: cost } } }],
	getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 70 }),
	subscribe: () => () => {},
});
const FIVE_MINUTES = 5 * 60_000;
const line = (r: AgentRecord, cacheTtlMs = FIVE_MINUTES) =>
	formatSnapshot([{ agent: r, depth: 1 }], "main", agentStatus, now, cacheTtlMs).split("\n")[1] ?? "";

test("list_subagents shows cache warmth, context size and cost, after the row's own `last` age", () => {
	const out = line(rec({ view: view(4 * 60_000, 143_000, 2.1) }));
	assert.match(out, /last 4m .* cache=warm\(1m left\) ctx=143k \$2\.10$/);
	assert.doesNotMatch(out, /idle=/, "the idle time is the row's `last` age already");
});

test("the cache reads cold once its lifetime has passed", () => {
	assert.match(line(rec({ view: view(6 * 60_000, 900, 0) })), /cache=cold ctx=900 \$0\.00$/);
	assert.match(line(rec({ view: view(6 * 60_000, 900, 0) }), 60 * 60_000), /cache=warm\(54m left\)/);
});

test("without a known cache lifetime the cache warmth is left out", () => {
	const out = line(rec({ view: view(4 * 60_000, 143_000, 2.1) }), 0);
	assert.match(out, /\(by main\) {2}ctx=143k \$2\.10$/);
	assert.match(formatSnapshot([{ agent: rec({ view: view(60_000, 1, 0) }), depth: 1 }], "main", agentStatus, now), /\(by main\) {2}ctx=1 \$0\.00$/m);
});

test("a running agent shows no cache warmth (its request is under way), and missing data is left out", () => {
	const out = line(rec({ activity: "thinking", view: view(10_000, null, 0.5) }));
	assert.doesNotMatch(out, /cache=/);
	assert.match(out, /\(by main\) {2}\$0\.50$/);
	assert.doesNotMatch(out, /ctx=/);
	assert.match(line(rec({ paused: "user", view: view(10_000, null, 0.5) })), /cache=warm\(4m left\) \$0\.50$/, "a paused agent's cache keeps ageing");
	assert.doesNotMatch(line(rec({})), /cache=|\$/);
});

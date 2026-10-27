import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoutedAgentMessage, mergeRoutedAgentMessages, toCustomAgentMessage } from "./agent-message.ts";
import {
	deriveStatus,
	parseRoster,
	type RawMessage,
	restoredPlacement,
	serializeRoster,
	sessionSpecFromRoster,
} from "./persistence-logic.ts";

const assistant = (calls: { id: string; name?: string }[], stopReason?: string): RawMessage => ({
	role: "assistant",
	content: [
		{ type: "text", text: "..." },
		...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name ?? "bash" })),
	],
	stopReason,
});
const toolResult = (id: string): RawMessage => ({ role: "toolResult", toolCallId: id });
const user = (): RawMessage => ({ role: "user", content: "hi" });

test("deriveStatus: clean assistant answer -> idle", () => {
	assert.equal(deriveStatus([user(), assistant([])]), "idle");
});

test("deriveStatus: empty -> idle", () => {
	assert.equal(deriveStatus([]), "idle");
});

test("deriveStatus: trailing tool_use -> pausedMidTurn", () => {
	assert.equal(deriveStatus([assistant([{ id: "t1" }])]), "pausedMidTurn");
});

test("deriveStatus: trailing toolResult (model owes reply) -> pausedMidTurn", () => {
	assert.equal(deriveStatus([assistant([{ id: "t1" }]), toolResult("t1")]), "pausedMidTurn");
});

test("deriveStatus: aborted/error stop reason -> pausedMidTurn", () => {
	assert.equal(deriveStatus([assistant([], "aborted")]), "pausedMidTurn");
	assert.equal(deriveStatus([assistant([], "error")]), "pausedMidTurn");
});

test("deriveStatus: trailing lifecycle notices are skipped", () => {
	const custom = (from: string): RawMessage => ({
		role: "custom",
		customType: "agent-message",
		details: { parts: [{ from, content: "x" }] },
	});
	assert.equal(deriveStatus([user(), assistant([]), custom("scheduler"), custom("scheduler")]), "idle");
	assert.equal(deriveStatus([assistant([], "aborted"), custom("scheduler")]), "pausedMidTurn");
	// A peer message starts a turn, so an unanswered one is interrupted work.
	assert.equal(deriveStatus([user(), assistant([]), custom("a")]), "pausedMidTurn");
});

test("roster round-trip serialize -> parse", () => {
	const agents = [
		{ name: "main", spawnedBy: "main", depth: 0, model: "x/y", sessionFile: "/m" },
		{
			name: "a",
			spawnedBy: "main",
			depth: 1,
			model: "p/q",
			thinkingLevel: "xhigh" as const,
			systemPrompt: "do x",
			sessionFile: "/a.jsonl",
		},
		{ name: "pending", spawnedBy: "main", depth: 1, model: "(spawning)" }, // no sessionFile -> dropped
	];
	const roster = serializeRoster(agents);
	assert.equal(roster.length, 1);
	assert.equal(roster[0].name, "a");
	assert.equal(roster[0].thinkingLevel, "xhigh");
	const json = JSON.stringify(roster);
	assert.deepEqual(parseRoster(json), roster);
});

test("empty-session restore forwards the persisted thinking level without transcript evidence", () => {
	const [entry] = parseRoster(
		JSON.stringify([
			{
				name: "empty",
				spawnedBy: "main",
				depth: 1,
				model: "p/q",
				thinkingLevel: "xhigh",
				systemPrompt: "wait",
				sessionFile: "/empty.jsonl",
			},
		]),
	);
	assert.deepEqual(sessionSpecFromRoster(entry, { id: "resolved" }), {
		name: "empty",
		systemPrompt: "wait",
		spawnedBy: "main",
		model: { id: "resolved" },
		thinkingLevel: "xhigh",
	});
});

test("parseRoster accepts old entries without a level and rejects unknown levels", () => {
	const oldEntry = {
		name: "a",
		spawnedBy: "main",
		depth: 1,
		model: "p/q",
		systemPrompt: "do x",
		sessionFile: "/a.jsonl",
	};
	assert.deepEqual(parseRoster(JSON.stringify([oldEntry])), [oldEntry]);
	assert.deepEqual(parseRoster(JSON.stringify([{ ...oldEntry, thinkingLevel: "ultra" }])), []);
});

test("parseRoster: malformed -> []", () => {
	assert.deepEqual(parseRoster("not json"), []);
	assert.deepEqual(parseRoster("{}"), []);
	assert.deepEqual(parseRoster('[{"name":"a"}]'), []); // missing required fields
});

test("restoredPlacement keeps a live parent and lets main adopt an orphan", () => {
	assert.deepEqual(restoredPlacement("main", 0), { spawnedBy: "main", depth: 1 });
	// main needs no record to be a valid parent: it is the root.
	assert.deepEqual(restoredPlacement("main", undefined), { spawnedBy: "main", depth: 1 });
	assert.deepEqual(restoredPlacement("lead", 1), { spawnedBy: "lead", depth: 2 });
	// The parent was not restored: main adopts the orphan, so no spawnedBy dangles.
	assert.deepEqual(restoredPlacement("gone", undefined), { spawnedBy: "main", depth: 1 });
});

test("restore treats unanswered actionable scheduler input as interrupted without reclassifying legacy notices", () => {
	const notice = createRoutedAgentMessage("scheduler", "paused");
	const error = createRoutedAgentMessage("scheduler", "failed", true);
	const custom = (m: ReturnType<typeof createRoutedAgentMessage>): RawMessage => ({ role: "custom", ...toCustomAgentMessage(m) });
	assert.equal(deriveStatus([assistant([]), custom(notice)]), "idle");
	assert.equal(deriveStatus([assistant([]), custom(error)]), "pausedMidTurn");
	assert.equal(deriveStatus([assistant([]), custom(mergeRoutedAgentMessages([notice, error]))]), "pausedMidTurn");
	assert.equal(deriveStatus([custom(error), assistant([]), custom(notice)]), "idle");
});

test("a spawn policy's allowlist, meta and guard flag persist with the agent", () => {
	const base = { name: "w", spawnedBy: "main", depth: 1, model: "a/b", systemPrompt: "p", sessionFile: "/s/w.jsonl" };
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const roster = serializeRoster([
		{ ...base, policyTools: ["read", "grep"], policyMeta: { tier: "T1", at: [1, 2] }, policyGuarded: true },
		{ ...base, name: "plain" },
		// Not JSON: dropped, so one odd value cannot keep the whole roster from being written.
		{ ...base, name: "odd", policyMeta: cyclic },
	]);
	assert.deepEqual(roster[0], { ...base, tools: ["read", "grep"], meta: { tier: "T1", at: [1, 2] }, guarded: true });
	assert.deepEqual(roster[1], { ...base, name: "plain" });
	assert.deepEqual(roster[2], { ...base, name: "odd" });
	assert.deepEqual(parseRoster(JSON.stringify(roster)), roster);
	const [entry] = parseRoster(JSON.stringify(roster));
	assert.deepEqual(sessionSpecFromRoster(entry!, "m").tools, ["read", "grep"]);
	assert.equal("tools" in sessionSpecFromRoster(roster[1]!, "m"), false);
});

test("parseRoster drops an entry whose restriction it cannot read, so it never comes back unrestricted", () => {
	const base = { name: "w", spawnedBy: "main", depth: 1, model: "a/b", systemPrompt: "p", sessionFile: "/s/w.jsonl" };
	for (const bad of [{ tools: "read" }, { tools: ["read", 3] }, { tools: [""] }, { guarded: "yes" }, { guarded: 1 }]) {
		assert.deepEqual(parseRoster(JSON.stringify([{ ...base, ...bad }])), [], JSON.stringify(bad));
	}
});

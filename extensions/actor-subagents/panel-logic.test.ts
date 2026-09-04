import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatContext,
	formatRoster,
	moveSelection,
	transcriptViewport,
	messageText,
	toolCalls,
	shortModel,
	statusTone,
	swarmStateLine,
	sendTargets,
	formatSendTargets,
	formatHistory,
	formatModel,
	panelRows,
} from "./panel-logic.ts";

const histMsgs = [
	{ role: "user", content: "start task" },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret reasoning" },
			{ type: "text", text: "on it" },
			{ type: "toolCall", id: "t1", name: "send_message", arguments: { to: "main", content: "hi" } },
		],
	},
	{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "sent to main" }] },
	{ role: "assistant", content: [{ type: "text", text: "done" }] },
];

test("formatHistory: default offset 0 shows beginning + system prompt + header total", () => {
	const out = formatHistory({ name: "comic", systemPrompt: "be funny", messages: histMsgs, limit: 2 });
	assert.match(out, /agent comic · 4 messages · showing \[0, 2\)/);
	assert.match(out, /── system ──\nbe funny/);
	assert.match(out, /#0 user: start task/);
	assert.doesNotMatch(out, /#3/); // limited to 2
});

test("formatHistory: negative offset shows the tail, no system prompt", () => {
	const out = formatHistory({ name: "comic", systemPrompt: "be funny", messages: histMsgs, offset: -1 });
	assert.match(out, /showing \[3, 4\)/);
	assert.match(out, /#3 assistant: done/);
	assert.doesNotMatch(out, /── system ──/); // window does not cover index 0
});

test("formatHistory: thinking shown/hidden per flag; tool calls + results rendered", () => {
	const shown = formatHistory({ name: "a", messages: histMsgs, offset: 1, limit: 2 });
	assert.match(shown, /assistant·thinking: secret reasoning/);
	assert.match(shown, /⚙ send_message\(/);
	assert.match(shown, /⚙→ sent to main/);
	const hidden = formatHistory({ name: "a", messages: histMsgs, offset: 1, limit: 2, hideThinking: true });
	assert.doesNotMatch(hidden, /secret reasoning/);
	assert.match(hidden, /assistant: on it/);
});

test("formatHistory labels peer traffic as a subagent message, not a user message", () => {
	const out = formatHistory({
		name: "coder",
		messages: [
			{
				role: "custom",
				customType: "agent-message",
				content: "[message from reviewer]: Found it.",
				details: { parts: [{ from: "reviewer", content: "Found it." }] },
			},
		],
	});
	assert.match(out, /#0 subagent: reviewer: Found it\./);
	assert.doesNotMatch(out, /#0 user:/);
});

test("formatContext renders tokens/window only (no percentage), dash when unknown", () => {
	assert.match(formatContext({ tokens: 12000, contextWindow: 200000, percent: 6 }), /12k\/200k/);
	assert.doesNotMatch(formatContext({ tokens: 12000, contextWindow: 200000, percent: 6 }), /%/);
	assert.equal(formatContext({ tokens: null, contextWindow: 200000, percent: null }), "—");
	assert.equal(formatContext(undefined), "—");
	assert.doesNotMatch(formatContext({ tokens: 15000, contextWindow: 200000, percent: 7 }), /·/);
});

test("sendTargets: ordered by count desc, alpha tiebreak; empty when none", () => {
	const matrix = { a: { main: 3, coder: 3, zed: 1 }, b: {} };
	assert.deepEqual(sendTargets(matrix, "a"), [
		{ to: "coder", count: 3 },
		{ to: "main", count: 3 },
		{ to: "zed", count: 1 },
	]);
	assert.deepEqual(sendTargets(matrix, "b"), []);
	assert.deepEqual(sendTargets(matrix, "missing"), []);
});

test("formatSendTargets: ➜name[count], count omitted for a single message; '' when none", () => {
	const matrix = { a: { main: 3, coder: 1 } };
	assert.equal(formatSendTargets(matrix, "a"), "➜main[3] ➜coder");
	assert.equal(formatSendTargets(matrix, "none"), "");
});

// ── formatRoster: responsive aligned single-line table ──
const idle = { kind: "idle" } as const;
const re = (over: Record<string, unknown> = {}) => ({ name: "a", model: "x/y", context: "", status: idle, ...over });

test("formatRoster: aligns the status column across rows (shared name-column width)", () => {
	const rows = formatRoster([re({ name: "ab" }), re({ name: "abcdef", status: { kind: "working", phase: "thinking" } })], 200);
	assert.equal(rows[0].indexOf("idle"), rows[1].indexOf("thinking")); // same x → aligned
});

test("formatRoster: name middle-ellipsis keeps the distinguishing tail (shared-prefix names stay distinct)", () => {
	const rows = formatRoster(
		[re({ name: "risk-R-UniformApp-pipeline-5" }), re({ name: "risk-R-UniformApp-pipeline-7" })],
		200,
	);
	assert.notEqual(rows[0], rows[1]); // tails preserved → distinguishable
	assert.match(rows[0], /…/); // middle ellipsis applied (name > cap 24)
	assert.match(rows[0], /5\b/);
	assert.match(rows[1], /7\b/);
});

test("formatRoster: custom status leads, system status trails, both present", () => {
	const row = formatRoster([re({ customStatus: "parsing files" })], 200)[0];
	assert.match(row, /parsing files.*idle/);
});

test("formatRoster: ETA renders in its own column; column absent when no agent has one", () => {
	const eta = new Date();
	eta.setHours(15, 20, 0, 0);
	assert.match(formatRoster([re({ etaTs: eta.getTime() })], 200)[0], /ETA ~15:20/);
	assert.doesNotMatch(formatRoster([re({})], 200)[0], /ETA/);
});

test("formatRoster: ETA column padded blank for agents without one when another has it", () => {
	const eta = new Date();
	eta.setHours(15, 20, 0, 0);
	const rows = formatRoster([re({ name: "a", etaTs: eta.getTime() }), re({ name: "b" })], 200);
	assert.match(rows[0], /ETA ~15:20/);
	assert.doesNotMatch(rows[1], /ETA/);
});

test("formatRoster: collapse order under narrowing width is model → targets → context → custom", () => {
	const e = re({
		name: "agent",
		customStatus: "running tests",
		status: { kind: "working", phase: "tool", tool: "bash" },
		context: "15k/200k (7%)",
		model: "anthropic/opus",
		targets: "➜main[3]",
	});
	const at = (w: number) => formatRoster([e], w)[0];
	// full row (computed width 59): everything present
	assert.match(at(59), /opus/);
	assert.match(at(59), /➜main\[3\]/);
	// model dropped first
	assert.doesNotMatch(at(55), /opus/);
	assert.match(at(55), /➜main\[3\]/);
	// then targets
	assert.doesNotMatch(at(50), /➜main/);
	assert.match(at(50), /15k\/200k/);
	// then context
	assert.doesNotMatch(at(40), /15k\/200k/);
	assert.match(at(40), /running tests/);
	// then custom — only protected (name + system status) survive
	assert.doesNotMatch(at(25), /running tests/);
	assert.match(at(25), /tool:bash/);
	assert.match(at(25), /agent/);
});

test("formatRoster: custom status capped at 32 with a trailing ellipsis", () => {
	const row = formatRoster([re({ customStatus: "x".repeat(50) })], 200)[0];
	assert.match(row, /x{31}…/); // 31 chars + ellipsis = 32
	assert.doesNotMatch(row, /x{33}/);
});

test("formatRoster: rows are flush left — no cursor indent column", () => {
	const rows = formatRoster([re({ name: "a" }), re({ name: "b" })], 200, { selectedIndex: 1 });
	assert.match(rows[0], /^a/);
	assert.match(rows[1], /^b/);
});

test("formatRoster: the selected row is styled as a whole and keeps its status cell plain", () => {
	const rows = formatRoster([re({ name: "a" }), re({ name: "b", status: { kind: "working", phase: "thinking" } })], 200, {
		selectedIndex: 1,
		styleStatus: (l, tone) => `[${tone}]${l}`,
		styleSelected: (line) => `<${line}>`,
	});
	assert.match(rows[0], /\[idle\]/); // unselected rows still get the status tone
	assert.match(rows[1], /^<b/);
	assert.doesNotMatch(rows[1], /\[busy\]/); // a status background would end the row highlight early
	assert.match(rows[1], />$/);
});

test("formatRoster: tone keys off the system status — idle stays idle despite a custom status", () => {
	const row = formatRoster([re({ customStatus: "waiting" })], 200, {
		styleStatus: (l, tone) => (tone === "busy" ? `BUSY[${l}]` : l),
	})[0];
	assert.doesNotMatch(row, /BUSY/);
});

test("formatRoster: passes the error tone to the styler", () => {
	const row = formatRoster([re({ status: { kind: "idle", outcome: "error" }, customStatus: "drafting joke" })], 200, {
		styleStatus: (l, tone) => `[${tone}]${l}`,
	})[0];
	assert.match(row, /\[error\]/);
	assert.match(row, /drafting joke/);
});

test("formatRoster: model id and effective thinking level are shown together", () => {
	const row = formatRoster(
		[re({ model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh", status: { kind: "working", phase: "thinking" } })],
		200,
	)[0];
	assert.match(row, /gpt-5\.6-sol@xhigh/);
});

test("swarmStateLine: paused buffering vs live with activity count", () => {
	assert.match(swarmStateLine(true, 3), /PAUSED/);
	assert.match(swarmStateLine(true, 3), /messages buffer/);
	assert.match(swarmStateLine(true, 3), /agents-resume/);
	assert.match(swarmStateLine(false, 2), /live · 2 working/);
	assert.match(swarmStateLine(false, 0), /live · idle/);
	assert.doesNotMatch(swarmStateLine(false, 0), /running/);
});


test("statusTone: a failed turn is its own tone, truncated dims like idle, work is busy", () => {
	assert.equal(statusTone({ kind: "idle", outcome: "error" }), "error");
	assert.equal(statusTone({ kind: "idle", outcome: "truncated" }), "idle");
	assert.equal(statusTone({ kind: "idle" }), "idle");
	assert.equal(statusTone({ kind: "paused" }), "idle");
	assert.equal(statusTone({ kind: "spawning" }), "idle");
	assert.equal(statusTone({ kind: "working", phase: "thinking" }), "busy");
	assert.equal(statusTone({ kind: "working", phase: "tool", tool: "bash" }), "busy");
});

test("shortModel drops the provider prefix, no truncation (model column sizes itself)", () => {
	assert.equal(shortModel("anthropic/opus"), "opus");
	assert.equal(shortModel("local-model"), "local-model");
	assert.equal(shortModel(undefined), "");
	assert.equal(shortModel("x/" + "a".repeat(40)), "a".repeat(40));
});

test("formatModel appends an effective level when present", () => {
	assert.equal(formatModel("openai-codex/gpt-5.6-sol", "xhigh"), "gpt-5.6-sol@xhigh");
	assert.equal(formatModel("anthropic/opus", undefined), "opus");
});

test("moveSelection clamps at both ends", () => {
	assert.equal(moveSelection(0, -1, 3), 0);
	assert.equal(moveSelection(0, 1, 3), 1);
	assert.equal(moveSelection(2, 1, 3), 2);
	assert.equal(moveSelection(0, 1, 0), 0); // empty
});

test("panelRows uses pi's exact 50% overlay rounding and one-row floor", () => {
	assert.equal(panelRows(40), 20);
	assert.equal(panelRows(41), 20); // pi-tui floors percentage dimensions
	assert.equal(panelRows(1), 1);
});

test("transcriptViewport takes what the chrome leaves, with a floor", () => {
	assert.equal(transcriptViewport(40, 12), 28);
	assert.equal(transcriptViewport(10, 12), 3); // chrome alone overflows -> floor
	assert.equal(transcriptViewport(10, 12, 5), 5);
});

test("messageText extracts string or text parts", () => {
	assert.equal(messageText("hi"), "hi");
	assert.equal(
		messageText([
			{ type: "text", text: "a" },
			{ type: "image", data: "x" },
			{ type: "text", text: "b" },
		]),
		"ab",
	);
	assert.equal(messageText(undefined), "");
});

test("toolCalls extracts id/name/arguments from assistant content", () => {
	const m = {
		role: "assistant",
		content: [
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "c1", name: "send_message", arguments: { to: "main", content: "hi" } },
		],
	};
	assert.deepEqual(toolCalls(m), [{ id: "c1", name: "send_message", arguments: { to: "main", content: "hi" } }]);
	assert.deepEqual(toolCalls({ role: "user", content: "hi" }), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseBlock, toolPreviewParts } from "./tool-preview.ts";

test("toolPreviewParts: systemPrompt/message/content are always blocks, others inline", () => {
	const { scalars, blocks } = toolPreviewParts({
		name: "w1",
		model: "x/y",
		offset: -10,
		to: ["a", "b"],
		systemPrompt: "you are w1", // short, still a block (field-based, no length logic)
		message: "go",
	});
	assert.deepEqual(scalars, ["name=w1", "model=x/y", "offset=-10", 'to=["a","b"]']);
	assert.deepEqual(blocks, [
		{ key: "systemPrompt", value: "you are w1" },
		{ key: "message", value: "go" },
	]);
});

test("toolPreviewParts: a long non-payload field stays inline (no length heuristic)", () => {
	const longStatus = "x".repeat(80);
	const { scalars, blocks } = toolPreviewParts({ status: longStatus });
	assert.deepEqual(scalars, [`status=${longStatus}`]);
	assert.equal(blocks.length, 0);
});

test("toolPreviewParts: no args -> empty", () => {
	const { scalars, blocks } = toolPreviewParts({});
	assert.equal(scalars.length, 0);
	assert.equal(blocks.length, 0);
});

test("collapseBlock: short value passes through untouched", () => {
	const r = collapseBlock("one line", 3, 200);
	assert.deepEqual(r, { shown: "one line", hiddenLines: 0, truncated: false });
});

test("collapseBlock: keeps first maxLines, reports hidden line count", () => {
	const r = collapseBlock("a\nb\nc\nd\ne", 2, 200);
	assert.equal(r.shown, "a\nb");
	assert.equal(r.hiddenLines, 3);
	assert.equal(r.truncated, true);
});

test("collapseBlock: a single over-long line is char-truncated with ellipsis", () => {
	const r = collapseBlock("x".repeat(300), 3, 50);
	assert.equal(r.shown, `${"x".repeat(50)}…`);
	assert.equal(r.hiddenLines, 0);
	assert.equal(r.truncated, true);
});

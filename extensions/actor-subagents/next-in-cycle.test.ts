import assert from "node:assert/strict";
import { test } from "node:test";
import { nextInCycle } from "./next-in-cycle.ts";

test("cycling wraps in both directions", () => {
	const items = ["a", "b", "c"];
	assert.equal(nextInCycle(items, "a", 1), "b");
	assert.equal(nextInCycle(items, "c", 1), "a");
	assert.equal(nextInCycle(items, "a", -1), "c");
	assert.equal(nextInCycle(items, "b", -1), "a");
});

test("an unknown or missing current starts at the near end", () => {
	const items = ["a", "b", "c"];
	assert.equal(nextInCycle(items, "zzz", 1), "a");
	assert.equal(nextInCycle(items, "zzz", -1), "c");
	assert.equal(nextInCycle(items, undefined, 1), "a");
	assert.equal(nextInCycle(items, undefined, -1), "c");
});

test("an empty list has nothing to cycle to", () => {
	assert.equal(nextInCycle([], "a", 1), undefined);
	assert.equal(nextInCycle([], undefined, 1), undefined);
});

test("a single entry cycles to itself", () => {
	assert.equal(nextInCycle(["only"], "only", 1), "only");
	assert.equal(nextInCycle(["only"], "only", -1), "only");
});

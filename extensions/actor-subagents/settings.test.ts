import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAPS, parseSettings } from "./settings.ts";

test("an empty or unreadable settings file yields the defaults and no child extensions", () => {
	for (const input of ["", "not json", "{}", "null", "[]"]) {
		assert.deepEqual(parseSettings(input), { caps: DEFAULT_CAPS, childExtensions: [] }, input);
	}
});

test("caps are honored per field, so a partial file keeps the other defaults", () => {
	assert.deepEqual(parseSettings(JSON.stringify({ maxAgents: 20 })).caps, {
		...DEFAULT_CAPS,
		maxAgents: 20,
	});
	assert.deepEqual(parseSettings(JSON.stringify({ maxSpawnDepth: 1, turnBudget: 5 })).caps, {
		...DEFAULT_CAPS,
		maxSpawnDepth: 1,
		turnBudget: 5,
	});
});

test("a cap that is not a positive integer falls back to its default", () => {
	for (const maxAgents of [0, -1, 2.5, "4", null, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(parseSettings(JSON.stringify({ maxAgents })).caps.maxAgents, DEFAULT_CAPS.maxAgents);
	}
	// Nesting the caps (the shape the type uses internally) is not the file format.
	assert.deepEqual(parseSettings(JSON.stringify({ caps: { maxAgents: 20 } })).caps, DEFAULT_CAPS);
});

test("child extensions accept only a list of non-empty strings", () => {
	assert.deepEqual(
		parseSettings(JSON.stringify({ childExtensions: ["/one.ts", "npm:@scope/two"] })).childExtensions,
		["/one.ts", "npm:@scope/two"],
	);
	assert.deepEqual(parseSettings(JSON.stringify({ childExtensions: [] })).childExtensions, []);
});

test("child extensions fail closed for missing, malformed, or mixed entries", () => {
	for (const childExtensions of [undefined, "/one.ts", ["/one.ts", 2], [""], [null], { path: "/one.ts" }]) {
		assert.deepEqual(parseSettings(JSON.stringify({ childExtensions })).childExtensions, []);
	}
});

test("valid caps and child extensions are read from the same file", () => {
	assert.deepEqual(
		parseSettings(JSON.stringify({ maxAgents: 3, childExtensions: ["/one.ts"] })),
		{ caps: { ...DEFAULT_CAPS, maxAgents: 3 }, childExtensions: ["/one.ts"] },
	);
});

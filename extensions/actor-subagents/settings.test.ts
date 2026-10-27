import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAPS, parseSettings } from "./settings.ts";

test("an empty or unreadable settings file yields the defaults and no child extensions", () => {
	for (const input of ["", "not json", "{}", "null", "[]"]) {
		assert.deepEqual(
			parseSettings(input),
			{ caps: DEFAULT_CAPS, childExtensions: [], childExtensionStatusKeys: undefined, childSystemPrompt: "replace" },
			input,
		);
	}
});

test("caps are honored per field, so a partial file keeps the other defaults", () => {
	assert.deepEqual(parseSettings(JSON.stringify({ maxAgents: 20 })).caps, {
		...DEFAULT_CAPS,
		maxAgents: 20,
	});
	assert.deepEqual(parseSettings(JSON.stringify({ maxSpawnDepth: 1 })).caps, {
		...DEFAULT_CAPS,
		maxSpawnDepth: 1,
	});
});

test("an unknown key is ignored rather than carried into the caps", () => {
	assert.deepEqual(parseSettings(JSON.stringify({ turnBudget: 5, whatever: true })).caps, DEFAULT_CAPS);
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
		{ caps: { ...DEFAULT_CAPS, maxAgents: 3 }, childExtensions: ["/one.ts"], childExtensionStatusKeys: undefined, childSystemPrompt: "replace" },
	);
});

test("extension status keys are a list of non-empty strings, otherwise every key is shown", () => {
	assert.deepEqual(parseSettings(JSON.stringify({ childExtensionStatusKeys: ["bash-async"] })).childExtensionStatusKeys, [
		"bash-async",
	]);
	assert.deepEqual(parseSettings(JSON.stringify({ childExtensionStatusKeys: [] })).childExtensionStatusKeys, []);
	for (const childExtensionStatusKeys of ["bash-async", [""], [1], null]) {
		assert.equal(parseSettings(JSON.stringify({ childExtensionStatusKeys })).childExtensionStatusKeys, undefined);
	}
});

test("childSystemPrompt defaults to replace, the child's prompt being only its agent preamble", () => {
	assert.equal(parseSettings("{}").childSystemPrompt, "replace");
	assert.equal(parseSettings(JSON.stringify({ maxAgents: 3 })).childSystemPrompt, "replace");
});

test("childSystemPrompt accepts replace and append", () => {
	assert.equal(parseSettings(JSON.stringify({ childSystemPrompt: "replace" })).childSystemPrompt, "replace");
	assert.equal(parseSettings(JSON.stringify({ childSystemPrompt: "append" })).childSystemPrompt, "append");
});

test("an invalid childSystemPrompt falls back to replace", () => {
	for (const childSystemPrompt of ["Append", "prepend", "", 1, true, null, ["append"], { mode: "append" }]) {
		assert.equal(parseSettings(JSON.stringify({ childSystemPrompt })).childSystemPrompt, "replace", String(childSystemPrompt));
	}
});

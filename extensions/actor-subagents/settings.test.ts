import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAPS, DEFAULT_SPAWN_POLICY_TIMEOUT_MS, parseSettings } from "./settings.ts";

test("an empty or unreadable settings file yields the defaults and no child extensions", () => {
	for (const input of ["", "not json", "{}", "null", "[]"]) {
		assert.deepEqual(
			parseSettings(input),
			{
				caps: DEFAULT_CAPS,
				childExtensions: [],
				childExtensionStatusKeys: undefined,
				spawnPolicyTimeoutMs: DEFAULT_SPAWN_POLICY_TIMEOUT_MS,
			},
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
		{
			caps: { ...DEFAULT_CAPS, maxAgents: 3 },
			childExtensions: ["/one.ts"],
			childExtensionStatusKeys: undefined,
			spawnPolicyTimeoutMs: DEFAULT_SPAWN_POLICY_TIMEOUT_MS,
		},
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

test("the spawn policy timeout defaults to 30 s, takes a non-negative integer, and 0 means no bound", () => {
	assert.equal(DEFAULT_SPAWN_POLICY_TIMEOUT_MS, 30_000);
	assert.equal(parseSettings(JSON.stringify({ spawnPolicyTimeoutMs: 5000 })).spawnPolicyTimeoutMs, 5000);
	assert.equal(parseSettings(JSON.stringify({ spawnPolicyTimeoutMs: 0 })).spawnPolicyTimeoutMs, 0);
	for (const spawnPolicyTimeoutMs of [-1, 2.5, "100", null, Number.POSITIVE_INFINITY]) {
		assert.equal(
			parseSettings(JSON.stringify({ spawnPolicyTimeoutMs })).spawnPolicyTimeoutMs,
			DEFAULT_SPAWN_POLICY_TIMEOUT_MS,
			String(spawnPolicyTimeoutMs),
		);
	}
});

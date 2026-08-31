import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChildExtensionPolicy } from "./child-extension-policy.ts";

test("child extension policy accepts only a non-empty string list", () => {
	assert.deepEqual(
		parseChildExtensionPolicy(JSON.stringify({ extensions: ["/one.ts", "npm:@scope/two"] })),
		["/one.ts", "npm:@scope/two"],
	);
});

test("child extension policy fails closed for missing, malformed, or mixed entries", () => {
	assert.deepEqual(parseChildExtensionPolicy("not json"), []);
	assert.deepEqual(parseChildExtensionPolicy("{}"), []);
	assert.deepEqual(parseChildExtensionPolicy(JSON.stringify({ extensions: ["/one.ts", 2] })), []);
	assert.deepEqual(parseChildExtensionPolicy(JSON.stringify({ extensions: [""] })), []);
});
